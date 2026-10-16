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
// DISABLED — RESTART_SERVICE_TOKEN is the empty string, so
// it needs its own file: the token is captured at construction, and
// prom-client's global registry allows only one real writer per process.
// The empty string (not a deleted variable) is deliberate: compose
// injects `${RESTART_SERVICE_TOKEN:-}`, so an unset host variable arrives
// in the container as an EMPTY value — this is the real deployed disabled
// state (true-unset takes the same code branch). The shutdown hook IS
// injected here: the missing half of the fail-closed check is the token.
// The callback spy must NEVER be invoked by any request in this file.

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
// PrometheusWriterRestartNoCallback suite (valid token, missing shutdown
// hook) asserts the same literal against its own writer — byte-identity
// across the two halves of the fail-closed check, proven without sharing
// state across Jest module sandboxes.
const DISABLED_503_BODY = '{"success":false,"message":"Restart endpoint is disabled."}';

const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

// The startup warn must be snapshotted: the request tests below
// mockClear() write_warn to isolate their throttled audits, which would
// wipe it.
function snapshotEvents(mock: jest.Mock): string[] {
  return mock.mock.calls
    .map((c) => (c[2] as Record<string, unknown> | undefined)?.event)
    .filter((e): e is string => typeof e === "string");
}

describe("PrometheusWriter with /restart-service disabled (token unset/empty)", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let restartCallback: jest.Mock;
  let port: number;
  let configSource: string;
  let savedRestartToken: string | undefined;
  let startupWarnEvents: string[];

  beforeAll(async () => {
    savedRestartToken = process.env.RESTART_SERVICE_TOKEN;
    process.env.RESTART_SERVICE_TOKEN = "";

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
    startupWarnEvents = snapshotEvents(logger.write_warn);
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
    if (savedRestartToken === undefined) {
      delete process.env.RESTART_SERVICE_TOKEN;
    } else {
      process.env.RESTART_SERVICE_TOKEN = savedRestartToken;
    }
  });

  it("answers POST with the exact disabled 503 bytes, never invoking the callback", async () => {
    logger.write_warn.mockClear();
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: { Connection: "close" },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    // Byte-identical body: the response must not leak which half of the
    // fail-closed check is missing.
    expect(text).toBe(DISABLED_503_BODY);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(restartCallback).not.toHaveBeenCalled();
    // The disabled probe is audited (throttled) so unauthenticated
    // discovery attempts stay visible.
    expect(
      logger.write_warn.mock.calls.some((c) => c[2]?.event === "restart_disabled")
    ).toBe(true);
  });

  it("answers the same 503 bytes with a plausible Bearer header (the token cannot grant enablement)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        // A well-formed, strong-looking Bearer header — enablement comes
        // from the environment token, never from the request.
        Authorization: `Bearer ${"a".repeat(48)}`,
      },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toBe(DISABLED_503_BODY);
    expect(restartCallback).not.toHaveBeenCalled();
  });

  it("checks the method before enablement: GET is 405, not 503", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      headers: { Connection: "close" },
    });
    const body = (await res.json()) as { success: boolean };

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.success).toBe(false);
    expect(restartCallback).not.toHaveBeenCalled();
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

  it("warns restart_token_not_set at startup (the service boots and warns)", () => {
    expect(startupWarnEvents).toContain("restart_token_not_set");
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
