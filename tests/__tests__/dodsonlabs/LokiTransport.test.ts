/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { LokiTransport } from "../../../src/dodsonlabs/LokiTransport";

const PUSH_URL = "http://loki:3100/loki/api/v1/push";
const LABELS = {
  service: "sensor-telemetry",
  environment: "test",
  version: "0.0.0",
};
// Matches the transport's internal flush interval.
const FLUSH_INTERVAL_MS = 5_000;

const MESSAGE = Symbol.for("message");

function makeEntry(index: number): Record<PropertyKey, unknown> {
  return {
    [MESSAGE]: JSON.stringify({
      level: "info",
      message: `entry ${index}`,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    level: "info",
    timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
  };
}

/** A resolved fetch response the transport can drain. */
function okResponse() {
  return {
    ok: true,
    status: 204,
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

type PushCall = {
  url: string;
  body: { streams: Array<{ stream: Record<string, string>; values: string[][] }> };
};

/** Int64 nanosecond epoch for an entry's ISO timestamp (e.g. 1767225600000000000). */
function entryNs(index: number): string {
  return String(1_767_225_600_000_000_000 + (index % 60) * 1_000_000_000);
}

function pushedBatches(fetchMock: jest.SpyInstance): PushCall[] {
  return fetchMock.mock.calls.map(([url, init]: [string, RequestInit]) => ({
    url,
    body: JSON.parse(init.body as string),
  }));
}

describe("LokiTransport", () => {
  let fetchMock: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  afterEach(async () => {
    fetchMock.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("pushes the Loki push format: streams[] wrapper, static labels, [nsTs, line] values", async () => {
    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      transport.log(makeEntry(0), () => {});
      transport.log(makeEntry(1), () => {});
      await transport.close();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(PUSH_URL);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

      const parsed = pushedBatches(fetchMock)[0];
      // The push API requires the streams[] wrapper — a bare { stream,
      // values } top level is a 422 on the server.
      expect(parsed.body.streams).toHaveLength(1);
      expect(parsed.body.streams[0].stream).toEqual(LABELS);
      const values = parsed.body.streams[0].values;
      expect(values).toHaveLength(2);
      // Timestamps are int64 nanoseconds, not the ISO strings entries carry.
      expect(values[0][0]).toBe(entryNs(0));
      expect(values[1][0]).toBe(entryNs(1));
      // The line is the redacted, JSON-serialized record — a parseable object,
      // not the bare message text.
      expect(JSON.parse(values[0][1])).toEqual(
        expect.objectContaining({ level: "info", message: "entry 0" })
      );
    } finally {
      await transport.close();
    }
  });

  it("flushes on the entry-size limit without waiting for the interval", async () => {
    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      for (let i = 0; i < 256; i++) {
        transport.log(makeEntry(i), () => {});
      }
      // Let the serialized flush chain (microtasks + mocked fetch) settle.
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pushedBatches(fetchMock)[0].body.streams[0].values).toHaveLength(256);
    } finally {
      await transport.close();
    }
  });

  it("flushes a sub-threshold batch on the interval", async () => {
    jest.useFakeTimers();
    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      transport.log(makeEntry(0), () => {});
      expect(fetchMock).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pushedBatches(fetchMock)[0].body.streams[0].values).toHaveLength(1);
    } finally {
      // close() settles on real setImmediates; fake timers would hang it.
      jest.useRealTimers();
      await transport.close();
    }
  });

  it("close() flushes a pending batch and is idempotent", async () => {
    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    transport.log(makeEntry(0), () => {});
    const first = transport.close();
    const second = transport.close();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pushedBatches(fetchMock)[0].body.streams[0].values).toHaveLength(1);
    // A log after close is dropped, not queued.
    transport.log(makeEntry(1), () => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed push drops the batch, warns once, and never rejects unhandled", async () => {
    const rejectionProbe = jest.fn();
    process.on("unhandledRejection", rejectionProbe);
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:3100"));

    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      transport.log(makeEntry(0), () => {});
      transport.log(makeEntry(1), () => {});
      await transport.close();

      expect(rejectionProbe).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/ECONNREFUSED/);
      expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/dropped 2/);
    } finally {
      await transport.close();
      process.removeListener("unhandledRejection", rejectionProbe);
    }
  });

  it("bounds each push: an unresponsive endpoint is aborted and its batch reported dropped", async () => {
    // Regression for P3-2: undici has no app-level timeout by default, so a
    // black-holed endpoint (SYN-accepted, never answered) held the in-flight
    // push for undici's implicit ~300 s headersTimeout — and close() could
    // spend its entire shutdown budget waiting on it. The mock hangs until
    // the signal it was given aborts, then rejects the way undici does on
    // abort (it also rejects loudly if no signal arrives at all — the
    // wiring itself is under test). The real 5 s PUSH_TIMEOUT_MS elapses,
    // hence the extended test timeout.
    const rejectionProbe = jest.fn();
    process.on("unhandledRejection", rejectionProbe);
    fetchMock.mockImplementation(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal ?? undefined;
          if (!signal) {
            reject(new Error("push was invoked without an abort signal"));
            return;
          }
          // Plain Error (not DOMException): Node's DOMException is not
          // instanceof Error, so ensureError would render it as "{}" in the
          // report — the assertion below targets the report's message text.
          const onAbort = () =>
            reject(new Error("The operation was aborted. (AbortError)"));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        })
    );

    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      // 256 entries hit the size limit, so the flush is enqueued
      // immediately (not on the 5 s interval tick) and the abort signal —
      // created at flush time — starts at t≈0.
      for (let i = 0; i < 256; i++) {
        transport.log(makeEntry(i), () => {});
      }
      // Wait out PUSH_TIMEOUT_MS (5 s) plus slack for the abort to surface
      // through performFlush's catch into reportFailure.
      await new Promise((resolve) => setTimeout(resolve, 5_500));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/aborted/i);
      expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/dropped 256/);
      expect(rejectionProbe).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", rejectionProbe);
      jest.useRealTimers();
      await transport.close();
    }
  }, 15_000);

  it("throttles repeated push failures: suppress in-window, re-warn with the count", async () => {
    jest.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:3100"));

    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      // Failure 1: logged.
      transport.log(makeEntry(0), () => {});
      await jest.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

      // Failure 2, same window: suppressed.
      transport.log(makeEntry(1), () => {});
      await jest.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

      // Failure 3, past the 60 s re-warn window (the window is measured
      // from failure 1 at t=5 s, so it elapses at t=65 s): the flush that
      // lands after the expiry is re-warned with the suppressed count.
      await jest.advanceTimersByTimeAsync(55_000);
      transport.log(makeEntry(2), () => {});
      await jest.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy.mock.calls[1][0]).toMatch(/1 earlier failure\(s\) suppressed/);
    } finally {
      jest.useRealTimers();
      await transport.close();
    }
  });

  it("a non-2xx push response is treated as a failure", async () => {
    fetchMock.mockResolvedValue(
      { ok: false, status: 413, body: { cancel: () => Promise.resolve() } } as unknown as Response
    );
    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      transport.log(makeEntry(0), () => {});
      await transport.close();

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/HTTP 413/);
    } finally {
      await transport.close();
    }
  });

  it("does not require a response body to drain", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, body: null } as unknown as Response);
    const transport = new LokiTransport({ url: PUSH_URL, labels: LABELS });
    try {
      transport.log(makeEntry(0), () => {});
      await transport.close();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      await transport.close();
    }
  });
});
