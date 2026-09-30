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
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// This file constructs its writer WITH SENSOR_TELEMETRY_CONFIG_TOKEN set, so
// it needs its own file: the token is captured at construction and
// prom-client's global registry allows only one real writer per process.

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

const TOKEN = "secret-token-12345";
const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter with SENSOR_TELEMETRY_CONFIG_TOKEN set", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let configChangeCallback: jest.Mock;
  let port: number;
  let configDir: string;
  let configSource: string;
  let savedToken: string | undefined;
  let savedCorsOrigins: string | undefined;

  beforeAll(async () => {
    savedToken = process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    process.env.SENSOR_TELEMETRY_CONFIG_TOKEN = TOKEN;

    // Left unset on purpose: this writer runs in wildcard CORS mode
    // (Access-Control-Allow-Origin: *), which the preflight/token
    // interaction tests pin. Parsed at construction, so it must be fixed
    // before the writer is built.
    savedCorsOrigins = process.env.SENSOR_TELEMETRY_CORS_ORIGINS;
    delete process.env.SENSOR_TELEMETRY_CORS_ORIGINS;

    port = await getFreePort();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-token-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    configChangeCallback = jest.fn();
    writer = new PrometheusWriter(
      { ...VALID_CONFIG, apiPort: port } as z.infer<typeof configSchema>,
      logger,
      configSource,
      configChangeCallback
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
    fs.rmSync(configDir, { recursive: true, force: true });
    if (savedToken === undefined) {
      delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    } else {
      process.env.SENSOR_TELEMETRY_CONFIG_TOKEN = savedToken;
    }
    if (savedCorsOrigins === undefined) {
      delete process.env.SENSOR_TELEMETRY_CORS_ORIGINS;
    } else {
      process.env.SENSOR_TELEMETRY_CORS_ORIGINS = savedCorsOrigins;
    }
  });

  function writeValidConfig(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      configSource,
      yaml.dump({ ...VALID_CONFIG, apiPort: port, ...overrides })
    );
  }

  beforeEach(() => {
    // Load-bearing: the failure-path tests delete or corrupt the on-disk
    // file, so every test starts from a valid baseline.
    writeValidConfig();
  });

  async function get(
    reqPath: string,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; allow: string | null; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
      // Connection: close keeps undici's keep-alive pool from holding a
      // socket open, which would block server.close() in afterAll.
      headers: { Connection: "close", ...headers },
    });
    return { status: res.status, allow: res.headers.get("allow"), body: await res.json() };
  }

  async function post(
    reqPath: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; allow: string | null; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
      method: "POST",
      // Connection: close keeps undici's keep-alive pool from holding a
      // socket open, which would block server.close() in afterAll.
      headers: { "Content-Type": "application/json", Connection: "close", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, allow: res.headers.get("allow"), body: await res.json() };
  }

  function tokenRejectedWarns(logger: MockLogger): boolean {
    return logger.write_warn.mock.calls.some(
      (call) =>
        call[2]?.event === "config_token_rejected" &&
        call[2]?.logType === "audit" &&
        call[2]?.statusCode === 401
    );
  }

  describe("verifyConfigToken on /reload-config (GET)", () => {
    it("allows the request and reloads with a correct x-config-token", async () => {
      logger.write_warn.mockClear();

      const { status, body } = await get("/reload-config", {
        "x-config-token": TOKEN,
      });

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, message: "Configuration reloaded successfully" });
      expect(tokenRejectedWarns(logger)).toBe(false);
    });

    it("returns 401 with an audit warning when the token header is missing", async () => {
      logger.write_warn.mockClear();

      const { status, body } = await get("/reload-config");

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-config-token",
      });
      expect(tokenRejectedWarns(logger)).toBe(true);
    });

    it("returns 401 when the token header has the wrong value", async () => {
      // Same length as TOKEN so the comparison reaches timingSafeEqual.
      const { status, body } = await get("/reload-config", {
        "x-config-token": "wrong-token-999999",
      });

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-config-token",
      });
    });

    it("returns 401 when the token header has the wrong length", async () => {
      // Different length: exercises the length check that guards
      // timingSafeEqual (which throws on unequal-length buffers).
      const { status, body } = await get("/reload-config", {
        "x-config-token": "short",
      });

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-config-token",
      });
    });
  });

  describe("verifyConfigToken on /write-config (POST)", () => {
    it("accepts a valid config POST with a correct token", async () => {
      const { status, body } = await post(
        "/write-config",
        { ...VALID_CONFIG, apiPort: port },
        { "x-config-token": TOKEN }
      );

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, message: "Configuration updated successfully" });
    });

    it("returns 401 on POST when the token is missing", async () => {
      const { status, body } = await post("/write-config", {
        ...VALID_CONFIG,
        apiPort: port,
      });

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-config-token",
      });
    });

    it("returns 401 on POST when the token is wrong", async () => {
      const { status, body } = await post(
        "/write-config",
        { ...VALID_CONFIG, apiPort: port },
        { "x-config-token": "nope" }
      );

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-config-token",
      });
    });
  });

  describe("method check precedes token check", () => {
    // requireMethod runs before verifyConfigToken, so a wrong verb is a 405
    // even when a token is configured and the header is absent.
    it("returns 405, not 401, for GET /write-config without a token", async () => {
      const { status, allow, body } = await get("/write-config");

      expect(status).toBe(405);
      expect(allow).toBe("POST");
      expect(body.success).toBe(false);
    });

    it("returns 405, not 401, for POST /reload-config without a token", async () => {
      const { status, allow, body } = await post("/reload-config", {});

      expect(status).toBe(405);
      expect(allow).toBe("GET");
      expect(body.success).toBe(false);
    });
  });

  describe("/write-config regex constructibility (regression P2-1)", () => {
    // "z-a" passes a plain string check but cannot build a character class
    // (out-of-order range). Before the constructibility refine it reached
    // validate → persist → commit → HTTP 200, then threw in the
    // PrometheusWriter constructor on the next restart — a crash loop with
    // restart: unless-stopped.
    it("returns 400 and leaves the on-disk config unchanged for a non-constructible value", async () => {
      configChangeCallback.mockClear();
      const before = fs.readFileSync(configSource, "utf8");

      const { status, body } = await post(
        "/write-config",
        { ...VALID_CONFIG, apiPort: port, sensorSourceValidCharsRegex: "z-a" },
        { "x-config-token": TOKEN }
      );

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(String(body.message)).toContain("sensorSourceValidCharsRegex");
      // validateConfig threw before write_file_yaml, so the persisted file
      // is byte-for-byte unchanged (write_file_yaml was never called).
      expect(fs.readFileSync(configSource, "utf8")).toBe(before);
      expect(configChangeCallback).not.toHaveBeenCalled();
    });

    it("still accepts a constructible value", async () => {
      const { status, body } = await post(
        "/write-config",
        { ...VALID_CONFIG, apiPort: port, sensorSourceValidCharsRegex: "a-zA-Z0-9._-" },
        { "x-config-token": TOKEN }
      );

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, message: "Configuration updated successfully" });
    });
  });

  describe("/reload-config failure paths (token present)", () => {
    // All three use the real file system and real js-yaml: no module mocks,
    // each exercises a distinct branch of handleReloadConfig.
    it("returns 500 when the config file is missing from disk", async () => {
      fs.rmSync(configSource);

      const { status, body } = await get("/reload-config", {
        "x-config-token": TOKEN,
      });

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.message).toContain("could not read");
    });

    it("returns 500 when the on-disk YAML is malformed", async () => {
      fs.writeFileSync(configSource, "{{{ this is: not: valid: yaml");

      const { status, body } = await get("/reload-config", {
        "x-config-token": TOKEN,
      });

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.message).toContain("failed to parse");
    });

    it("returns 500 when the on-disk config fails schema validation", async () => {
      // Valid YAML, missing the required mqttTopicTelemetry: read_file_yaml
      // succeeds and validateConfig throws, hitting the catch branch.
      fs.writeFileSync(
        configSource,
        yaml.dump({ logLevel: "info", apiPort: port, mqttBrokerIpAddress: "10.0.0.1" })
      );

      const { status, body } = await get("/reload-config", {
        "x-config-token": TOKEN,
      });

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.message).toContain("Config validation failed");
    });
  });

  describe("configChangeCallback", () => {
    it("is invoked with the validated config on a successful reload", async () => {
      writeValidConfig({ logLevel: "warn" });
      configChangeCallback.mockClear();

      const { status, body } = await get("/reload-config", {
        "x-config-token": TOKEN,
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(configChangeCallback).toHaveBeenCalledTimes(1);
      expect(configChangeCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          logLevel: "warn",
          mqttTopicTelemetry: "iot/v3/telemetry",
        })
      );
    });
  });

  describe("CORS preflight with a token configured", () => {
    // This writer runs in wildcard mode (SENSOR_TELEMETRY_CORS_ORIGINS
    // unset), so allowed browser origins get Access-Control-Allow-Origin:
    // *. The point of this block: preflights must never be authenticated —
    // a browser preflight names x-config-token but never carries the value,
    // so authenticating it would break every token-protected browser call.

    it("answers the preflight 204 without requiring x-config-token", async () => {
      logger.write_warn.mockClear();
      configChangeCallback.mockClear();
      const before = fs.readFileSync(configSource, "utf8");

      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://browser.test:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-config-token",
          // Connection: close keeps undici's keep-alive pool from holding a
          // socket open, which would block server.close() in afterAll.
          Connection: "close",
        },
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      // Preflight is not an authentication attempt: no token-rejected warn.
      expect(tokenRejectedWarns(logger)).toBe(false);
      // The endpoint never ran: config untouched, no callback.
      expect(fs.readFileSync(configSource, "utf8")).toBe(before);
      expect(configChangeCallback).not.toHaveBeenCalled();
    });

    it("still returns 401 for the actual POST without a token, with the CORS header", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        headers: {
          Origin: "http://browser.test:3000",
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ ...VALID_CONFIG, apiPort: port }),
      });
      const body = (await res.json()) as { success: boolean };

      expect(res.status).toBe(401);
      expect(body.success).toBe(false);
      // The browser must be able to read the real API error status instead
      // of an opaque CORS failure.
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("lets an allowed-origin POST through when the token is correct", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        headers: {
          Origin: "http://browser.test:3000",
          "Content-Type": "application/json",
          "x-config-token": TOKEN,
          Connection: "close",
        },
        body: JSON.stringify({ ...VALID_CONFIG, apiPort: port }),
      });
      const body = (await res.json()) as { success: boolean; message: string };

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true, message: "Configuration updated successfully" });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });
});
