/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import TransportStream from "winston-transport";
import { ensureError, stepThrottle } from "./SystemFunctions";
import type { ThrottleState } from "./SystemFunctions";

// The triple-beam MESSAGE symbol. Under the logger-level format chain
// (redaction → timestamp → json()), winston hands each transport an info
// whose info[MESSAGE] is the exact single-line JSON string the Console
// transport prints verbatim — redaction applied, timestamp set, printf
// tokens left literal. That is the line Loki should index; info.message
// is only the raw message text and would drop every structured field.
const MESSAGE = Symbol.for("message");

export interface LokiTransportOptions {
  /** Fully resolved Loki push endpoint (e.g. http://loki:3100/loki/api/v1/push). */
  url: string;
  /** Static, low-cardinality stream labels — one stream for the whole process. */
  labels: Record<string, string>;
}

/**
 * Ships the winston log stream to a Loki HTTP push endpoint.
 *
 * Entries are accumulated and pushed as
 * `{ streams: [{ stream: labels, values: [[nsTimestamp, line], ...] }] }`
 * batches (int64 nanosecond timestamps, per the Loki push API), flushed on
 * whichever limit hits first: the interval, the entry count, or the
 * estimated byte size. A failed push drops its batch and
 * reports through a throttled, direct console.error — never through the
 * winston logger (which would re-enter this transport) and never
 * unhandled (index.ts treats unhandledRejection as fatal). A down Loki
 * therefore cannot grow memory, retry-loop, or crash the process.
 */
export class LokiTransport extends TransportStream {
  private static readonly FLUSH_INTERVAL_MS = 5_000;
  private static readonly MAX_BATCH_ENTRIES = 256;
  private static readonly MAX_BATCH_BYTES = 64 * 1024;
  // Per-push bound. Node's fetch (undici) has no app-level timeout by
  // default — a black-holed Loki endpoint (SYN-accepted, never answered)
  // would otherwise hold the in-flight push for undici's implicit ~300 s
  // headersTimeout, and close() could spend its entire shutdown budget
  // waiting on it. 5 s is long for a healthy LAN endpoint, short for a
  // failure: an aborted push takes the same reportFailure path as any
  // other (throttled warn, batch dropped, no retry loop).
  private static readonly PUSH_TIMEOUT_MS = 5_000;
  // Re-warn cadence for push failures (the MqttNetworking.logThrottledRejection
  // pattern): first failure logged, repeats suppressed in the window, the
  // window's next log carries suppressedCount. Time-based so the warn rate
  // is independent of the failure rate.
  private static readonly FAILURE_REWARN_INTERVAL_MS = 60_000;

  private readonly url: string;
  private readonly labels: Record<string, string>;
  private entries: Array<[string, string]> = [];
  private byteLength = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  // Serialized flush chain. It must never reject: a rejected chain would
  // silently skip every later task (the PrometheusWriter.queueConfigWrite
  // invariant), so performFlush catches its own errors.
  private flushChain: Promise<void> = Promise.resolve();
  private isClosed = false;
  private closePromise: Promise<void> | undefined;
  // stepThrottle state for the push-failure reports (lastWarnMs 0 is the
  // fresh-state sentinel, so the first failure always fires).
  private failureState: ThrottleState = { lastWarnMs: 0, suppressedCount: 0 };
  // Any failed push (reported or suppressed) arms this; the next successful
  // push reports the recovery once and disarms it, so "the failure warnings
  // stopped" is distinguishable from "Loki is back".
  private hasPushFailed = false;
  // One-shot reports: a stuck endpoint must not re-log the same notice per
  // batch or per dropped entry.
  private closeTimeoutReported = false;
  private droppedAfterCloseReported = false;
  // Set when the close() drain settles on its own; the timeout race consults
  // it to distinguish "flushed" from "gave up waiting".
  private closeDrained = false;
  // Entries claimed by an in-flight push: gone from `entries` but not yet
  // delivered, so the close-timeout report counts them too.
  private inFlightEntries = 0;

  constructor(options: LokiTransportOptions) {
    super();
    this.url = options.url;
    this.labels = options.labels;
    this.flushTimer = setInterval(() => this.tickFlush(), LokiTransport.FLUSH_INTERVAL_MS);
    // Never hold the event loop open: without unref, a config with lokiUrl
    // set keeps the process (and jest) alive after everything else has
    // shut down.
    this.flushTimer.unref();
  }

  public log(info: Record<PropertyKey, unknown>, callback: () => void): void {
    try {
      if (this.isClosed) {
        // The Console transport still gets the line; only the Loki copy is
        // gone. Report the asymmetry once, not per entry.
        if (!this.droppedAfterCloseReported) {
          this.droppedAfterCloseReported = true;
          console.warn(
            "[loki] transport is closed; this and any subsequent entries will only reach the console"
          );
        }
        return;
      }
      const line =
        typeof info[MESSAGE] === "string" ? (info[MESSAGE] as string) : JSON.stringify(info);
      const ts =
        typeof info.timestamp === "string" ? (info.timestamp as string) : new Date().toISOString();
      this.entries.push([ts, line]);
      // +32 ≈ the ["ts", line] pair's JSON overhead (brackets, quotes, comma).
      this.byteLength += line.length + 32;
      if (
        this.entries.length >= LokiTransport.MAX_BATCH_ENTRIES ||
        this.byteLength >= LokiTransport.MAX_BATCH_BYTES
      ) {
        this.enqueueFlush();
      }
    } catch (err) {
      // Never throw into the winston stream: a transport exception would
      // surface as an uncaught exception in the logger's write path — but a
      // silent drop leaves no trace anywhere either, so route it through the
      // same throttled direct-console report as a push failure (never the
      // winston logger: recursion).
      this.reportFailure(err, 0, "failed to buffer a log entry");
    } finally {
      // Synchronous callback — no backpressure; the bounded batch IS the
      // flow control.
      callback();
    }
  }

  private tickFlush(): void {
    if (this.isClosed || this.entries.length === 0) {
      return;
    }
    this.enqueueFlush();
  }

  private enqueueFlush(): void {
    // The outer catch is defense in depth — performFlush handles its own
    // errors — but without it the chain could still reject and poison every
    // later task.
    this.flushChain = this.flushChain
      .then(() => this.performFlush())
      .catch((err: unknown) => this.reportFailure(err, 0));
  }

  private async performFlush(): Promise<void> {
    if (this.entries.length === 0) {
      return;
    }
    // Claim the batch before the await so new log() calls start a fresh
    // batch; on failure the claimed batch is dropped, never retried.
    const batch = this.entries;
    this.entries = [];
    this.byteLength = 0;
    this.inFlightEntries = batch.length;
    try {
      // The push API wants { streams: [{ stream, values }] } — a bare
      // { stream, values } top level is a 422 ("at least one valid stream is
      // required") — and int64 nanosecond timestamps: entries arrive as
      // ISO-8601 strings (the format chain's timestamp or the toISOString
      // fallback), so both conversions happen here, at flush time.
      const values = batch.map(([ts, line]) => {
        const ms = Date.parse(ts);
        // info.timestamp is always parseable; a failure would mean a
        // hand-built record, so fall back to now rather than poison the
        // whole batch.
        const ns = Number.isFinite(ms) ? Math.floor(ms * 1_000_000) : Date.now() * 1_000_000;
        return [String(ns), line] as [string, string];
      });
      const body = JSON.stringify({ streams: [{ stream: this.labels, values }] });
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(LokiTransport.PUSH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Loki push rejected with HTTP ${response.status}`);
      }
      // The response carries no data we need; release the socket.
      await response.body?.cancel().catch(() => undefined);
      // First success after any failure is the recovery point: report it
      // once, so operators can tell "Loki is back" from "nothing to push".
      if (this.hasPushFailed) {
        this.hasPushFailed = false;
        console.info("[loki] push to this endpoint succeeded after earlier failure(s)");
      }
    } catch (err) {
      this.reportFailure(err, batch.length);
    } finally {
      this.inFlightEntries = 0;
    }
  }

  /**
   * Flush any pending batch and stop the interval. Bounded (resolves within
   * ~timeoutMs even if the push hangs — when the drain outlives the budget
   * the unflushed remainder is reported through a one-shot console.error
   * instead of being silently lost), idempotent (a second close races the
   * same cached promise), and never rejects: index.ts awaits it last on
   * shutdown and a throwing close would mask the real shutdown error.
   */
  public close(timeoutMs: number = 2_000): Promise<void> {
    if (this.closePromise) {
      return this.withCloseTimeout(this.closePromise, timeoutMs);
    }
    this.isClosed = true;
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.closePromise = (async () => {
      // Let any in-flight winston stream delivery reach log() first (the
      // same double-tick settle the Logger tests use for the Console
      // transport) so the final drain sees the very last records.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Drain the serialized chain, then one more pass for entries queued
      // while the last flush was in flight.
      await this.flushChain;
      if (this.entries.length > 0) {
        this.enqueueFlush();
        await this.flushChain;
      }
      // The drain settled on its own: the timeout race below can then tell
      // "flushed" from "gave up waiting".
      this.closeDrained = true;
    })();
    return this.withCloseTimeout(this.closePromise, timeoutMs);
  }

  /**
   * Bound the close wait. If the drain does not settle within timeoutMs the
   * race resolves anyway (close() must stay bounded), but the loss must not
   * be silent: whatever is still queued — plus a possibly in-flight batch —
   * may never reach Loki, and shutdown is exactly when the interesting
   * lines are. One report per transport: a second close() racing the same
   * drain must not re-report, and a late drain settling after the report
   * must not retract it.
   */
  private withCloseTimeout(drain: Promise<void>, timeoutMs: number): Promise<void> {
    return Promise.race([drain, this.closeTimeout(timeoutMs)]).then(() => {
      if (this.closeDrained || this.closeTimeoutReported) {
        return;
      }
      this.closeTimeoutReported = true;
      const queued = this.entries.length;
      const inFlight = this.inFlightEntries;
      const total = queued + inFlight;
      console.error(
        `[loki] close timed out after ${timeoutMs}ms with ${total} entr${
          total === 1 ? "y" : "ies"
        } undelivered (${queued} queued, ${inFlight} in flight) — they may not have reached Loki`
      );
    });
  }

  private closeTimeout(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      // An abandoned timeout (the drain won the race) must not keep the
      // event loop open.
      timer.unref?.();
    });
  }

  /**
   * Throttled, direct-to-console push-failure reporting. Deliberately NOT
   * routed through the winston logger: logging here would re-enter THIS
   * transport (recursion and unbounded queue growth against a down Loki),
   * and at shutdown the pipeline may already be closing. First-occurrence
   * / re-warn / suppressedCount semantics come from stepThrottle
   * (SystemFunctions); the recovery latch is the extra arm on top.
   */
  private reportFailure(
    err: unknown,
    droppedEntries: number,
    context: string = "push to this endpoint failed"
  ): void {
    // Every failure arms the recovery signal, reported or suppressed.
    this.hasPushFailed = true;
    const step = stepThrottle(this.failureState, Date.now(), LokiTransport.FAILURE_REWARN_INTERVAL_MS);
    if (!step.fire) {
      return;
    }
    const detail = ensureError(err).message;
    const dropped = droppedEntries > 0 ? `; dropped ${droppedEntries} entrie(s)` : "";
    const suppressedNote =
      step.suppressedCount > 0 ? ` (${step.suppressedCount} earlier failure(s) suppressed)` : "";
    console.error(`[loki] ${context}: ${detail}${dropped}${suppressedNote}`);
  }
}
