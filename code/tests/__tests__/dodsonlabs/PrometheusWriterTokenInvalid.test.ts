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

// This file pins the SET-BUT-INVALID token states: SENSOR_TELEMETRY_CONFIG_TOKEN
// is 31 characters (one under the minimum) and RESTART_SERVICE_TOKEN is
// 48 characters but hyphenated (outside the A-Z, a-z, 0-9 charset). Both
// are invalid under the shared validity rule — and the constructor must NOT
// fail: it warns, disables both abilities, and the service boots normally.
// (These replace the old startup-refusal tests that lived in
// PrometheusWriterRestart; they need their own file because prom-client's
// global registry allows only one real writer per process, and the token is
// captured at construction.)

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

// Invalid by length: one character under the 32 minimum.
const INVALID_CONFIG_TOKEN = "a".repeat(31);
// Invalid by charset: long enough, but hyphens are not alphanumeric.
const INVALID_RESTART_TOKEN = "a-1".repeat(16);

// The EXACT wire bytes of the disabled responses. The config literal is
// byte-identical to the one asserted by the companion
// PrometheusWriterConfigDisabled suite (true-unset state) — the two disabled
// states must be indistinguishable on the wire.
const CONFIG_DISABLED_503_BODY =
  '{"success":false,"message":"Configuration API is disabled."}';
const RESTART_DISABLED_503_BODY =
  '{"success":false,"message":"Restart endpoint is disabled."}';

const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter with set-but-invalid tokens (warn + disable, never a startup failure)", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let restartCallback: jest.Mock;
  let port: number;
  let configSource: string;
  let savedConfigToken: string | undefined;
  let savedRestartToken: string | undefined;

  beforeAll(async () => {
    savedConfigToken = process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    savedRestartToken = process.env.RESTART_SERVICE_TOKEN;
    process.env.SENSOR_TELEMETRY_CONFIG_TOKEN = INVALID_CONFIG_TOKEN;
    process.env.RESTART_SERVICE_TOKEN = INVALID_RESTART_TOKEN;

    port = await getFreePort();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-token-invalid-test-"));
    configSource = path.join(configDir, "config.yml");

    // Construction with both invalid tokens must SUCCEED (the old
    // constructor throw is gone) — reaching this point proves it.
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
    if (savedConfigToken === undefined) {
      delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    } else {
      process.env.SENSOR_TELEMETRY_CONFIG_TOKEN = savedConfigToken;
    }
    if (savedRestartToken === undefined) {
      delete process.env.RESTART_SERVICE_TOKEN;
    } else {
      process.env.RESTART_SERVICE_TOKEN = savedRestartToken;
    }
  });

  it("warns config_token_invalid and restart_token_invalid at startup", () => {
    const configWarn = logger.write_warn.mock.calls.find(
      (c) => c[2]?.event === "config_token_invalid"
    );
    expect(configWarn).toBeDefined();
    expect(configWarn?.[1]).toContain("disabled (503)");
    const restartWarn = logger.write_warn.mock.calls.find(
      (c) => c[2]?.event === "restart_token_invalid"
    );
    expect(restartWarn).toBeDefined();
    expect(restartWarn?.[1]).toContain("disabled (503)");
  });

  it("announces neither ability as enabled", () => {
    expect(
      logger.write_info.mock.calls.some((c) => c[2]?.event === "config_api_enabled")
    ).toBe(false);
    expect(
      logger.write_info.mock.calls.some(
        (c) => c[2]?.event === "restart_endpoint_enabled"
      )
    ).toBe(false);
  });

  it("never logs either invalid token value", () => {
    const serialized = [
      JSON.stringify(logger.write_info.mock.calls),
      JSON.stringify(logger.write_warn.mock.calls),
      JSON.stringify(logger.write_error.mock.calls),
      JSON.stringify(logger.write_critical.mock.calls),
      JSON.stringify(logger.write_debug.mock.calls),
    ].join("");
    expect(serialized).not.toContain(INVALID_CONFIG_TOKEN);
    expect(serialized).not.toContain(INVALID_RESTART_TOKEN);
  });

  it("answers /read-config with the exact disabled 503 bytes (same wire state as true-unset)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/read-config`, {
      headers: { Connection: "close" },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toBe(CONFIG_DISABLED_503_BODY);
  });

  it("answers /restart-service with the exact disabled 503 bytes even for a plausible Bearer, never invoking the hook", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        // A well-formed, strong-looking Bearer header — an invalid
        // environment token cannot be cured by the request.
        Authorization: `Bearer ${"Aa0b1C2d3E4f5G6h7I8j9K0l1M2n3O4p"}`,
      },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toBe(RESTART_DISABLED_503_BODY);
    expect(restartCallback).not.toHaveBeenCalled();
  });

  it("boots and runs normally with both abilities disabled: /health stays 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Connection: "close" },
    });
    const body = (await res.json()) as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(writer.is_ready()).toBe(true);
  });
});
