/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { wait_for_prometheus } from "../../../src/dodsonlabs/SystemFunctions";

// Regression coverage for the startup-vs-shutdown race (P3-1). The readiness
// wait in index.ts polls until the Prometheus server reports ready, but a stop
// signal (or a fatal error) arriving during that wait starts the graceful-close
// path, whose close() clears the server's ready flag. The wait must therefore
// be shutdown-aware: it bails out and defers to the shutdown path (which owns
// the process exit) rather than running to its full deadline and reporting a
// spurious "timeout" — which index.ts turns into prometheus_startup_failed +
// exit(1), masking a clean operator stop (exit 0) as a startup crash.
//
// wait_for_prometheus is the extracted, dependency-free decision logic behind
// that wait. isReady/isShuttingDown are injected so the race is driven
// deterministically with fake timers, without a live HTTP server or a real
// signal. The exit-code ownership itself lives in index.ts's shutdown()
// (process.exit in its finally), which this pure helper cannot exercise — the
// contract it establishes is: report "shutdown", not "timeout", so the caller
// defers to the shutdown path instead of racing it with its own exit.
describe("wait_for_prometheus", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns 'ready' once the server reports ready", async () => {
    let ready = false;
    const p = wait_for_prometheus(() => ready, () => false, 1000, 100);
    // The first poll sees the server not ready; it then sleeps. Flipping
    // ready before the next poll resolves the wait on that poll.
    ready = true;
    await jest.advanceTimersByTimeAsync(100);

    await expect(p).resolves.toBe("ready");
  });

  it("returns 'timeout' when the server never becomes ready and no shutdown starts", async () => {
    const p = wait_for_prometheus(() => false, () => false, 1000, 100);
    // Run past the 1 s deadline; with no shutdown and no readiness the wait
    // is the caller's signal to report a startup failure and exit 1.
    await jest.advanceTimersByTimeAsync(1100);

    await expect(p).resolves.toBe("timeout");
  });

  // Regression P3-1: an operator stop signal (SIGTERM) arrives during the
  // startup readiness wait, before the server is ready. The wait must report
  // "shutdown" and bail out early — deferring to the graceful-close path that
  // owns the exit — instead of running to its full deadline and reporting
  // "timeout" (which index.ts would turn into a spurious
  // prometheus_startup_failed + exit(1) masking a clean stop, exit 0).
  it("returns 'shutdown' and bails early when a stop signal arrives before the server is ready (regression P3-1)", async () => {
    let shuttingDown = false;
    let settled = false;
    const p = wait_for_prometheus(() => false, () => shuttingDown, 5000, 100);
    p.then(() => {
      settled = true;
    });

    // The first poll runs; the server is still not ready.
    await jest.advanceTimersByTimeAsync(100);
    // The operator sends SIGTERM partway through the wait.
    shuttingDown = true;
    await jest.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    // After only ~200ms of fake time — far short of the 5000ms deadline —
    // the wait has settled. Had it ignored the shutdown it would still be
    // pending here (settled === false), so this is what pins the early-bail.
    expect(settled).toBe(true);
    await expect(p).resolves.toBe("shutdown");
  });

  // Regression P3-1, fatal-error variant: an unhandledRejection during the
  // startup window routes through the same shutdown path, but with exit code
  // 1. The wait must still defer to it (return "shutdown") so the shutdown
  // path owns the exit (code 1) rather than the readiness path emitting its
  // own — the startup path must never independently terminate once a shutdown
  // is in flight.
  it("returns 'shutdown' when a fatal error starts the close during the wait", async () => {
    let shuttingDown = false;
    const p = wait_for_prometheus(() => false, () => shuttingDown, 5000, 100);
    // The fatal-error handler flips shuttingDown (and begins the close) before
    // the wait's next poll.
    shuttingDown = true;
    await jest.advanceTimersByTimeAsync(100);

    await expect(p).resolves.toBe("shutdown");
  });
});
