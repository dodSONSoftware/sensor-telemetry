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

// This file constructs its writer with the /restart-service feature
// enabled but WITHOUT a lifecycle callback (standalone construction —
// index.ts always injects one, so this is a miswiring, not a deployment
// state), so it needs its own file: the callback is fixed at construction,
// and prom-client's global registry allows only one real writer per
// process. The contract under test: a restart that cannot be scheduled is
// reported as a 500 BEFORE any 202 — a restart must never be represented
// as scheduled — and the single-flight guard is never set (no 409 can
// follow).

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

const RESTART_TOKEN = "restart-nocb-token-1";
const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter with the feature enabled but no lifecycle callback", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let port: number;
  let configSource: string;
  let savedRestartEnabled: string | undefined;
  let savedRestartToken: string | undefined;

  beforeAll(async () => {
    savedRestartEnabled = process.env.SENSOR_TELEMETRY_RESTART_ENABLED;
    savedRestartToken = process.env.SENSOR_TELEMETRY_RESTART_TOKEN;
    process.env.SENSOR_TELEMETRY_RESTART_ENABLED = "true";
    process.env.SENSOR_TELEMETRY_RESTART_TOKEN = RESTART_TOKEN;

    port = await getFreePort();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-restart-nocb-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    // No fifth constructor argument: no lifecycle callback.
    writer = new PrometheusWriter(
      { ...VALID_CONFIG, apiPort: port } as z.infer<typeof configSchema>,
      logger,
      configSource,
      jest.fn()
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
    if (savedRestartEnabled === undefined) {
      delete process.env.SENSOR_TELEMETRY_RESTART_ENABLED;
    } else {
      process.env.SENSOR_TELEMETRY_RESTART_ENABLED = savedRestartEnabled;
    }
    if (savedRestartToken === undefined) {
      delete process.env.SENSOR_TELEMETRY_RESTART_TOKEN;
    } else {
      process.env.SENSOR_TELEMETRY_RESTART_TOKEN = savedRestartToken;
    }
  });

  it("answers 500 with an authenticated POST — never 202, never 409", async () => {
    logger.write_error.mockClear();

    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        "x-restart-token": RESTART_TOKEN,
      },
    });
    const body = (await res.json()) as { success: boolean; message: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.message).toBe("service restart is unavailable");
    // The missing callback is logged as an error, and the acceptance
    // audit (which would assert a scheduled restart) must NOT have fired.
    expect(
      logger.write_error.mock.calls.some((c) => c[2]?.event === "restart_callback_missing")
    ).toBe(true);
    expect(
      logger.write_info.mock.calls.some((c) => c[2]?.event === "service_restart_requested")
    ).toBe(false);
  });

  it("still answers 500 on a repeat (the guard was never set, so no 409)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        "x-restart-token": RESTART_TOKEN,
      },
    });
    expect(res.status).toBe(500);
  });
});
