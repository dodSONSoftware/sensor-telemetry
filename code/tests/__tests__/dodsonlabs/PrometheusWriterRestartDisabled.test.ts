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
// DISABLED (flag unset — the default deployment), so it needs its own
// file: the flag is captured at construction, and prom-client's global
// registry allows only one real writer per process. The callback spy must
// NEVER be invoked by any request in this file.

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

const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter with /restart-service disabled (default)", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let restartCallback: jest.Mock;
  let port: number;
  let configSource: string;
  let savedRestartEnabled: string | undefined;
  let savedRestartToken: string | undefined;

  beforeAll(async () => {
    savedRestartEnabled = process.env.SENSOR_TELEMETRY_RESTART_ENABLED;
    savedRestartToken = process.env.SENSOR_TELEMETRY_RESTART_TOKEN;
    // Unset on purpose: the default deployment. The token is set anyway —
    // the flag alone must keep the feature off.
    delete process.env.SENSOR_TELEMETRY_RESTART_ENABLED;
    process.env.SENSOR_TELEMETRY_RESTART_TOKEN = "should-not-matter";

    port = await getFreePort();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-restart-off-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    restartCallback = jest.fn();
    writer = new PrometheusWriter(
      { ...VALID_CONFIG, apiPort: port } as z.infer<typeof configSchema>,
      logger,
      configSource,
      jest.fn(),
      restartCallback
    );
    await until(() => writer.is_ready());
  });

  const HTTP_AUDIT_REWARN_INTERVAL_DEFAULT = 60_000;
  beforeEach(() => {
    (
      PrometheusWriter as unknown as { HTTP_AUDIT_REWARN_INTERVAL_MS: number }
    ).HTTP_AUDIT_REWARN_INTERVAL_MS = 0;
  });
  afterEach(() => {
    (
      PrometheusWriter as unknown as { HTTP_AUDIT_REWARN_INTERVAL_MS: number }
    ).HTTP_AUDIT_REWARN_INTERVAL_MS = HTTP_AUDIT_REWARN_INTERVAL_DEFAULT;
    restartCallback.mockClear();
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

  it("answers POST with 503 (feature disabled), never invoking the callback", async () => {
    logger.write_warn.mockClear();
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        "x-restart-token": "should-not-matter",
      },
    });
    const body = (await res.json()) as { success: boolean; message: string };

    expect(res.status).toBe(503);
    expect(body).toEqual({
      success: false,
      message: "service restart endpoint is disabled",
    });
    expect(restartCallback).not.toHaveBeenCalled();
    // The disabled probe is audited (throttled) so unauthenticated
    // discovery attempts stay visible.
    expect(
      logger.write_warn.mock.calls.some((c) => c[2]?.event === "restart_disabled")
    ).toBe(true);
  });

  it("answers 503 even with a correct token when the flag is unset", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        // The token is valid — but enablement is a strict opt-in the
        // token alone cannot grant.
        "x-restart-token": "should-not-matter",
      },
    });
    expect(res.status).toBe(503);
    expect(restartCallback).not.toHaveBeenCalled();
  });

  it("checks the method before enablement: GET is 405, not 503", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      headers: { Connection: "close" },
    });
    const body = (await res.json()) as { success: boolean };

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(body.success).toBe(false);
    expect(restartCallback).not.toHaveBeenCalled();
  });

  it("does not announce the feature at construction", () => {
    expect(
      logger.write_info.mock.calls.some(
        (c) => c[2]?.event === "restart_endpoint_enabled"
      )
    ).toBe(false);
  });

  it("still lists the route in /endpoints (the route exists; the feature is off)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/endpoints`, {
      headers: { Connection: "close" },
    });
    const body = (await res.json()) as { endpoints: Array<{ route: string }> };
    expect(body.endpoints.some((e) => e.route === "/restart-service")).toBe(true);
  });
});
