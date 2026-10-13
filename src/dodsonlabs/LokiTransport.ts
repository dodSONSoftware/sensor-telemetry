/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import TransportStream from "winston-transport";
import { ensureError } from "./SystemFunctions";

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
  private failureState = { lastWarnMs: 0, suppressedCount: 0 };

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
    } catch {
      // Never throw into the winston stream: a transport exception would
      // surface as an uncaught exception in the logger's write path.
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
    } catch (err) {
      this.reportFailure(err, batch.length);
    }
  }

  /**
   * Flush any pending batch and stop the interval. Bounded (resolves within
   * ~timeoutMs even if the push hangs), idempotent (a second close races the
   * same cached promise), and never rejects: index.ts awaits it last on
   * shutdown and a throwing close would mask the real shutdown error.
   */
  public close(timeoutMs: number = 2_000): Promise<void> {
    if (this.closePromise) {
      return Promise.race([this.closePromise, this.closeTimeout(timeoutMs)]);
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
    })();
    return Promise.race([this.closePromise, this.closeTimeout(timeoutMs)]);
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
   * and at shutdown the pipeline may already be closing. First failure in
   * the window is logged with its dropped-entry count; repeats are
   * suppressed and the window's next log carries suppressedCount.
   */
  private reportFailure(err: unknown, droppedEntries: number): void {
    const now = Date.now();
    const state = this.failureState;
    if (now - state.lastWarnMs >= LokiTransport.FAILURE_REWARN_INTERVAL_MS) {
      state.lastWarnMs = now;
      const suppressed = state.suppressedCount;
      state.suppressedCount = 0;
      const detail = ensureError(err).message;
      const dropped = droppedEntries > 0 ? `; dropped ${droppedEntries} entrie(s)` : "";
      const suppressedNote =
        suppressed > 0 ? ` (${suppressed} earlier failure(s) suppressed)` : "";
      console.error(`[loki] push to this endpoint failed: ${detail}${dropped}${suppressedNote}`);
    } else {
      state.suppressedCount++;
    }
  }
}
