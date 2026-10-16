/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import * as yaml from "js-yaml";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import { LOG_VALUE_MAX_LENGTH } from "../../../src/dodsonlabs/SystemFunctions";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// This file constructs its writer WITH a valid SENSOR_TELEMETRY_CONFIG_TOKEN
// set (every config request below carries the x-config-token header), so it
// needs its own file: the token is captured at construction and prom-client's
// global registry allows only one real writer per process. It pins the
// commit/rejection/read AUDIT events: every one must carry the directly
// observed remoteAddress (non-empty, the token-suite predicate) and — for
// commits — key NAMES only, never values. (The disabled and invalid-token
// states have their own files: PrometheusWriterConfigDisabled,
// PrometheusWriterTokenInvalid.)

// Valid under the shared token rule (at least 32 alphanumeric characters).
const AUDIT_TOKEN = "auditSuiteToken0123456789abcdef0";

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

// Write raw bytes to the port and resolve with the full response text.
// Unlike fetch, this can send a malformed request (garbage, oversized
// header) that the HTTP parser rejects before a request line exists.
function rawSocketWrite(port: number, bytes: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    let settled = false;
    const finish = (value: string, error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("error", (err) => finish(response, err));
    socket.on("data", (data: Buffer) => { response += data.toString("utf8"); });
    socket.on("close", () => finish(response));
    socket.write(bytes);
  });
}

const BASE_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter config commit/rejection/read audit", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let configChangeCallback: jest.Mock;
  let port: number;
  let configDir: string;
  let configSource: string;
  let savedToken: string | undefined;

  beforeAll(async () => {
    savedToken = process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    process.env.SENSOR_TELEMETRY_CONFIG_TOKEN = AUDIT_TOKEN;

    port = await getFreePort();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-audit-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    configChangeCallback = jest.fn();
    writer = new PrometheusWriter(
      { ...BASE_CONFIG, apiPort: port } as z.infer<typeof configSchema>,
      logger,
      configSource,
      configChangeCallback
    );
    await until(() => writer.is_ready());
  });

  // The HTTP audit throttle (60 s window in production) would suppress the
  // second same-event occurrence on this file's shared writer, which the
  // per-occurrence assertions below predate. Collapse the window for every
  // test; the throttle semantics themselves are covered in
  // PrometheusWriter.test.ts / PrometheusWriterConfigToken.test.ts.
  const HTTP_AUDIT_REWARN_INTERVAL_DEFAULT = 60_000;
  const setHttpAuditInterval = (ms: number) => {
    (
      PrometheusWriter as unknown as { HTTP_AUDIT_REWARN_INTERVAL_MS: number }
    ).HTTP_AUDIT_REWARN_INTERVAL_MS = ms;
  };
  beforeEach(() => {
    setHttpAuditInterval(0);
  });
  afterEach(() => {
    setHttpAuditInterval(HTTP_AUDIT_REWARN_INTERVAL_DEFAULT);
  });

  afterAll(async () => {
    writer.close();
    await until(() =>
      logger.write_info.mock.calls.some(
        (call) => call[2]?.event === "prometheus_server_closed"
      )
    );
    fs.rmSync(configDir, { recursive: true, force: true });
    if (savedToken === undefined) {
      delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    } else {
      process.env.SENSOR_TELEMETRY_CONFIG_TOKEN = savedToken;
    }
  });

  function writeValidConfig(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      configSource,
      yaml.dump({ ...BASE_CONFIG, apiPort: port, ...overrides })
    );
  }

  // Reset BOTH sources of state between tests: the on-disk file (tests
  // corrupt/rewrite it) and the RUNNING in-memory config — every successful
  // /write-config commits into this.config, so a later test's "identical"
  // write would otherwise diff against an earlier test's changes. The reset
  // commit is dropped by clearing the audit mocks immediately after.
  beforeEach(async () => {
    writeValidConfig();
    const reset = await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: JSON.stringify({ ...BASE_CONFIG, apiPort: port }),
    });
    expect(reset.status).toBe(200);
    // Clear AFTER the reset commit so only the test's own events/callback
    // invocations are visible.
    configChangeCallback.mockClear();
    logger.write_info.mockClear();
    logger.write_warn.mockClear();
    logger.write_error.mockClear();
  });

  // The LAST matching audit event: the beforeEach reset commit also emits
  // config_write_committed, so earlier matches are not the ones under test.
  function auditInfo(event: string): Record<string, unknown> | undefined {
    const calls = logger.write_info.mock.calls.filter((c) => c[2]?.event === event);
    const call = calls.at(-1);
    return call ? (call[2] as Record<string, unknown>) : undefined;
  }

  function auditWarn(event: string): Record<string, unknown> | undefined {
    const calls = logger.write_warn.mock.calls.filter((c) => c[2]?.event === event);
    const call = calls.at(-1);
    return call ? (call[2] as Record<string, unknown>) : undefined;
  }

  // ---- Gap 1: successful commit audit (write) ----

  it("audits a /write-config commit with path, changedKeys, and remoteAddress", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: JSON.stringify({ ...BASE_CONFIG, apiPort: port, logLevel: "warn" }),
    });
    expect(res.status).toBe(200);

    const meta = auditInfo("config_write_committed");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({
      logType: "audit",
      path: "write",
      changedKeys: ["logLevel"],
    });
    expect(typeof meta?.remoteAddress).toBe("string");
    expect((meta?.remoteAddress as string).length).toBeGreaterThan(0);
    // The callback still fires — the audit is additive, not a replacement.
    expect(configChangeCallback).toHaveBeenCalledTimes(1);
  });

  it("reports an empty changedKeys list for an identical commit", async () => {
    await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: JSON.stringify({ ...BASE_CONFIG, apiPort: port }),
    });

    const meta = auditInfo("config_write_committed");
    expect(meta?.changedKeys).toEqual([]);
  });

  it("coalesces defaults: writing a key at its default is not a change", async () => {
    // sensorSourceMaxLength is omitted from the running baseline; writing it
    // back at the default (30) must not be reported as a changed key.
    const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: JSON.stringify({ ...BASE_CONFIG, apiPort: port, sensorSourceMaxLength: 30 }),
    });
    expect(res.status).toBe(200);
    expect(auditInfo("config_write_committed")?.changedKeys).toEqual([]);

    // A non-default value IS a change.
    await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: JSON.stringify({ ...BASE_CONFIG, apiPort: port, sensorSourceMaxLength: 40 }),
    });
    expect(auditInfo("config_write_committed")?.changedKeys).toEqual(["sensorSourceMaxLength"]);
  });

  it("logs key names only — never the new value (broker IP redaction pin)", async () => {
    const secretBroker = "10.9.9.9";
    await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: JSON.stringify({ ...BASE_CONFIG, apiPort: port, mqttBrokerIpAddress: secretBroker }),
    });

    const meta = auditInfo("config_write_committed");
    expect(meta?.changedKeys).toEqual(["mqttBrokerIpAddress"]);
    // The whole metadata must not leak the new value anywhere.
    expect(JSON.stringify(meta)).not.toContain(secretBroker);
  });

  // ---- Gap 1: successful commit audit (reload) ----

  it("audits a /reload-config commit with path=reload and diff vs in-memory", async () => {
    // Change the on-disk file (add a log topic) without going through
    // /write-config, then reload: the audit must diff against the running
    // (in-memory) config, not the file.
    writeValidConfig({ mqttTopicLog: "iot/v3/log" });
    const res = await fetch(`http://127.0.0.1:${port}/reload-config`, { method: "GET", headers: { "x-config-token": AUDIT_TOKEN } });
    expect(res.status).toBe(200);

    const meta = auditInfo("config_reload_completed");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({
      logType: "audit",
      path: "reload",
      changedKeys: ["mqttTopicLog"],
    });
    expect(typeof meta?.remoteAddress).toBe("string");
    expect((meta?.remoteAddress as string).length).toBeGreaterThan(0);
  });

  // ---- Gap 2: validation-rejection audit ----

  it("audits a schema-invalid /write-config body as config_write_rejected (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: JSON.stringify({ ...BASE_CONFIG, apiPort: "not-a-number" }),
    });
    expect(res.status).toBe(400);

    const meta = auditWarn("config_write_rejected");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({
      logType: "audit",
      statusCode: 400,
    });
    expect(typeof meta?.remoteAddress).toBe("string");
    expect((meta?.remoteAddress as string).length).toBeGreaterThan(0);
    expect(typeof meta?.error).toBe("string");
    expect((meta?.error as string).length).toBeGreaterThan(0);
    expect((meta?.error as string).length).toBeLessThanOrEqual(LOG_VALUE_MAX_LENGTH + 1);
  });

  it("audits a malformed-JSON /write-config body as config_write_rejected (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-config-token": AUDIT_TOKEN },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(auditWarn("config_write_rejected")).toMatchObject({ statusCode: 400 });
  });

  it("audits an on-disk schema failure on /reload-config as config_reload_failed (500)", async () => {
    // Valid YAML, missing a required key → parseable but fails validateConfig.
    fs.writeFileSync(configSource, yaml.dump({ logLevel: "info", apiPort: port }));
    const res = await fetch(`http://127.0.0.1:${port}/reload-config`, { method: "GET", headers: { "x-config-token": AUDIT_TOKEN } });
    expect(res.status).toBe(500);

    const meta = auditWarn("config_reload_failed");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({ logType: "audit", statusCode: 500 });
    expect(typeof meta?.remoteAddress).toBe("string");
    expect((meta?.remoteAddress as string).length).toBeGreaterThan(0);
  });

  it("audits an on-disk schema failure on /read-config as config_read_failed (500)", async () => {
    fs.writeFileSync(configSource, yaml.dump({ logLevel: "info", apiPort: port }));
    const res = await fetch(`http://127.0.0.1:${port}/read-config`, { method: "GET", headers: { "x-config-token": AUDIT_TOKEN } });
    expect(res.status).toBe(500);

    const meta = auditWarn("config_read_failed");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({ logType: "audit", statusCode: 500 });
    expect(typeof meta?.remoteAddress).toBe("string");
    expect((meta?.remoteAddress as string).length).toBeGreaterThan(0);
  });

  // ---- Gap 4: successful read audit ----

  it("audits a successful /read-config with remoteAddress and no config values", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/read-config`, { method: "GET", headers: { "x-config-token": AUDIT_TOKEN } });
    expect(res.status).toBe(200);

    const meta = auditInfo("config_read_completed");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({ logType: "audit", statusCode: 200 });
    expect(typeof meta?.remoteAddress).toBe("string");
    expect((meta?.remoteAddress as string).length).toBeGreaterThan(0);
    // Exactly the four audit keys — no config value may leak.
    expect(Object.keys(meta ?? {}).sort()).toEqual(
      ["event", "logType", "remoteAddress", "statusCode"].sort()
    );
  });

  // ---- Gap 6: clientError handler ----

  it("answers 400 and audits a malformed request line (http_client_error)", async () => {
    const response = await rawSocketWrite(port, "GARBAGE\r\n\r\n");
    expect(response).toContain("400 Bad Request");

    const meta = auditWarn("http_client_error");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({ logType: "audit" });
    expect(typeof meta?.remoteAddress).toBe("string");
    expect((meta?.remoteAddress as string).length).toBeGreaterThan(0);
    expect(typeof meta?.error).toBe("string");
    expect(typeof meta?.code).toBe("string");
  });

  it("answers 400 and audits an oversized header (HPE_HEADER_OVERFLOW)", async () => {
    const longValue = "x".repeat(100 * 1024);
    const response = await rawSocketWrite(
      port,
      `GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${longValue}\r\n\r\n`
    );
    expect(response).toContain("400 Bad Request");

    const meta = auditWarn("http_client_error");
    expect(meta).toBeDefined();
    expect(meta?.code).toBe("HPE_HEADER_OVERFLOW");
  });

  it("keeps serving normal requests after a clientError (listener replacement)", async () => {
    await rawSocketWrite(port, "GARBAGE\r\n\r\n").catch(() => {
      /* the 400 is written then the socket is destroyed — either is fine */
    });
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET" });
    expect(res.status).toBe(200);
  });
});
