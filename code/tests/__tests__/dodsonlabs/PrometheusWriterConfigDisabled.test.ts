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

// This file constructs its writer with the configuration API DISABLED —
// SENSOR_TELEMETRY_CONFIG_TOKEN is DELETED (true unset). The empty-string
// representation is covered by PrometheusWriterRestartDisabled (compose
// injects `${SENSOR_TELEMETRY_CONFIG_TOKEN}` without a `:-` default, so an
// unset host variable arrives as the EMPTY value — the same code branch).
// It needs its own file: the token is captured at construction, and
// prom-client's global registry allows only one real writer per process.
// RESTART_SERVICE_TOKEN is deleted too, so this file also pins the new
// restart_token_not_set startup warning.

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

// The EXACT wire bytes of the disabled response. The companion
// PrometheusWriterTokenInvalid suite asserts the same literal against its
// own writer — byte-identity across the two disabled states (true-unset
// vs set-but-invalid), proven without sharing state across Jest module
// sandboxes.
const DISABLED_503_BODY = '{"success":false,"message":"Configuration API is disabled."}';

const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

interface StartupLog {
  message: string;
  event: string | undefined;
}

function snapshotLogCalls(mock: jest.Mock): StartupLog[] {
  return mock.mock.calls.map((c) => ({
    message: String(c[1] ?? ""),
    event: (c[2] as Record<string, unknown> | undefined)?.event as
      | string
      | undefined,
  }));
}

describe("PrometheusWriter with the configuration API disabled (config token unset)", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let restartCallback: jest.Mock;
  let port: number;
  let configSource: string;
  let savedConfigToken: string | undefined;
  let savedRestartToken: string | undefined;
  // Snapshotted at construction: the request tests below mockClear()
  // write_warn to isolate their throttled audits, which would wipe the
  // startup warnings.
  let startupWarns: StartupLog[];
  let startupInfos: StartupLog[];

  beforeAll(async () => {
    savedConfigToken = process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    savedRestartToken = process.env.RESTART_SERVICE_TOKEN;
    delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    delete process.env.RESTART_SERVICE_TOKEN;

    port = await getFreePort();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-config-off-test-"));
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
    startupWarns = snapshotLogCalls(logger.write_warn);
    startupInfos = snapshotLogCalls(logger.write_info);
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

  it("answers /read-config with the exact disabled 503 bytes", async () => {
    logger.write_warn.mockClear();
    const res = await fetch(`http://127.0.0.1:${port}/read-config`, {
      headers: { Connection: "close" },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toBe(DISABLED_503_BODY);
    // The disabled probe is audited (throttled) so unauthenticated
    // discovery attempts stay visible, like restart_disabled.
    expect(
      logger.write_warn.mock.calls.some((c) => c[2]?.event === "config_api_disabled")
    ).toBe(true);
  });

  it("answers /write-config and /reload-config with the same disabled 503 bytes", async () => {
    const writeRes = await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify(VALID_CONFIG),
    });
    expect(writeRes.status).toBe(503);
    expect(await writeRes.text()).toBe(DISABLED_503_BODY);

    const reloadRes = await fetch(`http://127.0.0.1:${port}/reload-config`, {
      headers: { Connection: "close" },
    });
    expect(reloadRes.status).toBe(503);
    expect(await reloadRes.text()).toBe(DISABLED_503_BODY);
  });

  it("answers the same 503 bytes with a well-formed x-config-token (the header cannot grant enablement)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/read-config`, {
      headers: {
        Connection: "close",
        // A well-formed, strong-looking header — enablement comes from the
        // environment token, never from the request.
        "x-config-token": "Aa0b1C2d3E4f5G6h7I8j9K0l1M2n3O4p",
      },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toBe(DISABLED_503_BODY);
  });

  it("checks the method before disablement: POST /read-config is 405, not 503", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/read-config`, {
      method: "POST",
      headers: { Connection: "close" },
    });
    const body = (await res.json()) as { success: boolean };

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(body.success).toBe(false);
  });

  it("boots and runs normally while disabled: /health stays 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Connection: "close" },
    });
    const body = (await res.json()) as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(writer.is_ready()).toBe(true);
  });

  it("warns config_token_not_set with the disabled wording and announces nothing", () => {
    const warn = startupWarns.find((c) => c.event === "config_token_not_set");
    expect(warn).toBeDefined();
    expect(warn?.message).toContain("disabled (503)");
    expect(startupInfos.some((c) => c.event === "config_api_enabled")).toBe(false);
  });

  it("warns restart_token_not_set (pins the new always-starts restart warning)", () => {
    const warn = startupWarns.find((c) => c.event === "restart_token_not_set");
    expect(warn).toBeDefined();
    expect(warn?.message).toContain("disabled (503)");
    expect(startupInfos.some((c) => c.event === "restart_endpoint_enabled")).toBe(
      false
    );
  });

  it("still lists the routes in /endpoints (the routes exist; the feature is off)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/endpoints`, {
      headers: { Connection: "close" },
    });
    const body = (await res.json()) as { endpoints: Array<{ route: string }> };
    for (const route of ["/read-config", "/write-config", "/reload-config"]) {
      expect(body.endpoints.some((e) => e.route === route)).toBe(true);
    }
  });
});
