/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import net from "net";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import { wait_for_prometheus } from "../../../src/dodsonlabs/SystemFunctions";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// Regression P3-1 (concrete server path): a definitive listen failure — here
// a real EADDRINUSE from a port already held by another server — must flip the
// writer's listen-failed predicate and make the startup readiness wait resolve
// as "failed" well before its 5 s deadline, instead of running the full wait
// and being reported as a spurious "timeout".
//
// This file runs in its own Jest process, so its PrometheusWriter is the only
// one to register metric names in prom-client's global registry (a second
// writer in the same process throws on duplicate names — the reason the other
// PrometheusWriter suites share a single writer).

interface MockLogger {
  global_log_level: jest.Mock;
  global_log_level_string: jest.Mock;
  write_info: jest.Mock;
  write_warn: jest.Mock;
  write_error: jest.Mock;
  write_critical: jest.Mock;
  write_debug: jest.Mock;
  setLogLevel: jest.Mock;
}

function createMockLogger(): MockLogger & ILogger {
  return {
    global_log_level: jest.fn(),
    global_log_level_string: jest.fn().mockReturnValue("info"),
    write_info: jest.fn(),
    write_warn: jest.fn(),
    write_error: jest.fn(),
    write_critical: jest.fn(),
    write_debug: jest.fn(),
    setLogLevel: jest.fn().mockReturnValue(false),
  };
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("PrometheusWriter listen failure (regression P3-1)", () => {
  const baseConfig = {
    logLevel: "info",
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  // A server that holds the port the writer will try to bind, forcing
  // EADDRINUSE. Kept open for the whole file and closed in afterAll.
  let blocker: net.Server;
  let port: number;

  beforeAll(async () => {
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.removeListener("error", reject);
        resolve();
      });
    });
    blocker = listener;
    port = (listener.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("flips listen_failed() and resolves the startup wait as 'failed' well before the deadline", async () => {
    const logger = createMockLogger();
    const writer = new PrometheusWriter(
      { ...baseConfig, apiPort: port } as z.infer<typeof configSchema>,
      logger
    );

    try {
      // server.listen's EADDRINUSE is delivered asynchronously; the writer's
      // error handler sets the flag, so poll until it is observed.
      await until(() => writer.listen_failed());
      // The server never became ready, and the underlying error was logged.
      expect(writer.is_ready()).toBe(false);
      expect(
        logger.write_error.mock.calls.some(
          (call) => call[2]?.event === "prometheus_server_start_failed"
        )
      ).toBe(true);

      // The startup wait must bail out on the failure, not run its full 5 s
      // deadline: if the failure were (incorrectly) treated as a slow start the
      // wait would take the full maxWaitMs, so bounding elapsed time is what
      // pins the early-bail.
      const start = Date.now();
      const result = await wait_for_prometheus(
        () => writer.is_ready(),
        () => writer.listen_failed(),
        () => false,
        5000,
        25
      );
      const elapsed = Date.now() - start;

      expect(result).toBe("failed");
      expect(elapsed).toBeLessThan(5000);
    } finally {
      // close() is explicitly tolerant of a writer whose listen failed, so it
      // stops any sweep timer and resolves without throwing.
      await writer.close();
    }
  });
});
