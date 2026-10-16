/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// This file constructs its writer with the /restart-service endpoint
// enabled (RESTART_SERVICE_TOKEN set) and a shutdown hook that THROWS,
// so it needs its own file:
// the callback is fixed at construction, and prom-client's global registry
// allows only one real writer per process. The contract under test: a
// throwing callback means no shutdown started, so the single-flight guard
// must be released (a later request can retry) and the failure must be
// logged rather than escaping into index.ts's uncaughtException path.

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

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
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

const RESTART_TOKEN = "restart-fail-token-1-0123456789abcdef";
const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter with a throwing restart callback", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let restartCallback: jest.Mock;
  let port: number;
  let configSource: string;
  let savedRestartToken: string | undefined;

  beforeAll(async () => {
    savedRestartToken = process.env.RESTART_SERVICE_TOKEN;
    process.env.RESTART_SERVICE_TOKEN = RESTART_TOKEN;

    port = await getFreePort();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-restart-fail-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    restartCallback = jest.fn().mockImplementation(() => {
      throw new Error("injected callback failure");
    });
    writer = new PrometheusWriter(
      { ...VALID_CONFIG, apiPort: port } as z.infer<typeof configSchema>,
      logger,
      configSource,
      jest.fn(),
      restartCallback
    );
    await until(() => writer.is_ready());
  });

  afterAll(async () => {
    writer.close();
    await until(() =>
      logger.write_info.mock.calls.some(
        (call) => call[2]?.event === "prometheus_server_closed"
      )
    );
    fs.rmSync(path.dirname(configSource), { recursive: true, force: true });
    if (savedRestartToken === undefined) {
      delete process.env.RESTART_SERVICE_TOKEN;
    } else {
      process.env.RESTART_SERVICE_TOKEN = savedRestartToken;
    }
  });

  async function post(): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        Authorization: `Bearer ${RESTART_TOKEN}`,
      },
    });
    return { status: res.status, body: await res.json() };
  }

  it("still answers 202 (the request was accepted), logs the failure, and releases the guard for retry", async () => {
    logger.write_error.mockClear();

    const first = await post();
    expect(first.status).toBe(202);
    expect(first.body).toEqual({
      success: true,
      status: "restart_scheduled",
      message: "Service restart requested",
    });

    // The callback ran and threw; the failure is captured and logged.
    await until(() => restartCallback.mock.calls.length >= 1);
    await until(() =>
      logger.write_error.mock.calls.some((c) => c[2]?.event === "restart_callback_failed")
    );
    expect(restartCallback).toHaveBeenCalledTimes(1);
    const fail = logger.write_error.mock.calls.find(
      (c) => c[2]?.event === "restart_callback_failed"
    );
    expect(fail).toBeDefined();
    expect(JSON.stringify(fail![1])).toContain("injected callback failure");

    // The guard was released: a second request is accepted again (NOT a
    // permanent 409), and the callback gets a fresh chance.
    const second = await post();
    expect(second.status).toBe(202);
    await until(() => restartCallback.mock.calls.length >= 2);
    expect(restartCallback).toHaveBeenCalledTimes(2);
  });
});
