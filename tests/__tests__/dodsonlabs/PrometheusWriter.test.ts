/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import * as yaml from "js-yaml";
import { register } from "prom-client";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import { write_file_yaml } from "../../../src/dodsonlabs/SystemFunctions";
import type { ILogger, IMqttNetworking } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// Fail the disk write on demand (chmod-based failures are unreliable when
// the suite runs as root). Default behavior is the real write, and
// everything else in SystemFunctions stays real.
jest.mock("../../../src/dodsonlabs/SystemFunctions", () => {
  const actual = jest.requireActual("../../../src/dodsonlabs/SystemFunctions");
  return { ...actual, write_file_yaml: jest.fn(actual.write_file_yaml) };
});

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

/**
 * POST a body over a raw socket, flushing one byte at a time so every
 * multi-byte UTF-8 sequence in the payload is guaranteed to straddle a TCP
 * chunk boundary. This is the slow-client shape of request that per-chunk
 * string accumulation used to corrupt: each half of, e.g., é (0xC3 0xA9)
 * decoded to U+FFFD before JSON.parse ran.
 */
function postByteByByte(
  port: number,
  body: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    let sentHeaders = false;
    let index = 0;
    let settled = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    const finish = (statusCode: number, responseBody: string) => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.destroy();
      resolve({ statusCode, body: responseBody });
    };

    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimers();
        socket.destroy();
        reject(err);
      }
    });
    socket.on("data", (data: Buffer) => {
      response += data.toString("utf8");
    });

    const sendNextByte = () => {
      if (settled) return;
      if (!sentHeaders) {
        socket.write(
          "POST /write-config HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${payload.length}\r\n` +
            "\r\n"
        );
        sentHeaders = true;
      }
      if (index >= payload.length) {
        socket.end();
        return;
      }
      socket.write(payload.subarray(index, index + 1));
      index += 1;
      // Space writes so each byte arrives as its own read chunk on the
      // server rather than coalescing into one.
      setTimeout(sendNextByte, 1);
    };

    // sendJson calls writeHead before the body is known, so responses use
    // chunked transfer encoding rather than Content-Length. Returns the
    // decoded body once fully received, or null while still in flight.
    const decodedBody = (): string | null => {
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd === -1) return null;
      const bodyPart = response.slice(headerEnd + 4);
      let offset = 0;
      let decoded = "";
      for (;;) {
        const lineEnd = bodyPart.indexOf("\r\n", offset);
        if (lineEnd === -1) return null;
        const size = parseInt(bodyPart.slice(offset, lineEnd), 16);
        if (Number.isNaN(size)) return null;
        const dataStart = lineEnd + 2;
        const dataEnd = dataStart + size;
        if (bodyPart.length < dataEnd + 2) return null;
        decoded += bodyPart.slice(dataStart, dataEnd);
        offset = dataEnd + 2;
        if (size === 0) return decoded;
      }
    };

    // The server only responds after the full body has been received and
    // processed, so a complete response means the whole payload landed.
    pollTimer = setInterval(() => {
      const bodyDone = decodedBody();
      if (bodyDone === null) return;
      const headerEnd = response.indexOf("\r\n\r\n");
      const statusMatch = response.slice(0, headerEnd).match(/^HTTP\/1\.1 (\d+)/);
      finish(statusMatch ? parseInt(statusMatch[1], 10) : 0, bodyDone);
    }, 5);

    // A handler regression (e.g. it stops responding) must fail the test
    // with the socket torn down, not hang the suite. Fires before jest's
    // default 5s test timeout.
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.destroy();
      reject(new Error(`timed out waiting for /write-config response (received: ${JSON.stringify(response.slice(0, 200))})`));
    }, 4000);

    sendNextByte();
  });
}

describe("PrometheusWriter", () => {
  // One writer for the whole file: prom-client registers metric names in a
  // global registry, so a second PrometheusWriter in the same process would
  // throw on duplicate names.
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let port: number;
  let configDir: string;
  let configSource: string;
  let savedToken: string | undefined;
  let savedCorsOrigins: string | undefined;

  const baseConfig = {
    logLevel: "info",
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  // The writer's CORS allowlist, fixed for the whole file: the browser
  // tests below use http://browser.test:3000, and every other Origin is
  // rejected. Parsed once at construction, so it must be set before the
  // writer is built (and never changed afterward).
  const allowedOrigin = "http://browser.test:3000";
  const disallowedOrigin = "http://evil.test:3000";

  beforeAll(async () => {
    // Endpoints must be reachable without a token for this test.
    savedToken = process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;

    savedCorsOrigins = process.env.SENSOR_TELEMETRY_CORS_ORIGINS;
    process.env.SENSOR_TELEMETRY_CORS_ORIGINS = allowedOrigin;

    port = await getFreePort();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-writer-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    writer = new PrometheusWriter(
      { ...baseConfig, apiPort: port } as z.infer<typeof configSchema>,
      logger,
      configSource
    );
    await until(() => writer.is_ready());
  });

  afterAll(async () => {
    // close() resolves only once the server's close callback has fired, so
    // awaiting it guarantees the log line is already written — no polling.
    await writer.close();
    expect(
      logger.write_info.mock.calls.some(
        (call) => call[2]?.event === "prometheus_server_closed"
      )
    ).toBe(true);
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

  async function getMetrics(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      // Connection: close keeps undici's keep-alive pool from holding a
      // socket open, which would block server.close() in afterAll.
      headers: { Connection: "close" },
    });
    expect(res.status).toBe(200);
    return res.text();
  }

  describe("/write-config", () => {
    it("persists non-ASCII config values intact when the body arrives one byte at a time", async () => {
      // é is 0xC3 0xA9: at one byte per chunk the two halves land in
      // separate data events, which is exactly the boundary that used to
      // decode to two U+FFFD replacement characters.
      const topic = "iot/café/telemetry";
      const payload = JSON.stringify({
        ...baseConfig,
        apiPort: port,
        mqttTopicTelemetry: topic,
      });

      const { statusCode, body } = await postByteByByte(port, payload);
      const response = JSON.parse(body);

      expect(statusCode).toBe(200);
      expect(response.success).toBe(true);

      const onDisk = yaml.load(fs.readFileSync(configSource, "utf8")) as z.infer<typeof configSchema>;
      expect(onDisk.mqttTopicTelemetry).toBe(topic);
      expect(onDisk.mqttTopicTelemetry).not.toContain("\uFFFD");
    });

    it("still writes a normal single-shot POST", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        // Connection: close keeps undici's keep-alive pool from holding a
        // socket open, which would block server.close() in afterAll.
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({
          ...baseConfig,
          apiPort: port,
          mqttTopicLog: "iot/v3/log",
        }),
      });
      const response = await res.json();

      expect(res.status).toBe(200);
      expect(response.success).toBe(true);

      const onDisk = yaml.load(fs.readFileSync(configSource, "utf8")) as z.infer<typeof configSchema>;
      expect(onDisk.mqttTopicTelemetry).toBe(baseConfig.mqttTopicTelemetry);
      expect(onDisk.mqttTopicLog).toBe("iot/v3/log");
    });

    it("returns 500 and leaves the in-memory config unchanged when the disk write fails", async () => {
      // A failed persistence must be a no-op: /read-config and /reload-config
      // both treat the disk as authoritative, so committing the candidate to
      // this.config before the write would leave the process split-brain
      // (new memory, stale disk) even though the response reports 500.
      (write_file_yaml as unknown as jest.Mock).mockReturnValueOnce(false);

      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        // Connection: close keeps undici's keep-alive pool from holding a
        // socket open, which would block server.close() in afterAll.
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ ...baseConfig, apiPort: port, logLevel: "warn" }),
      });
      const response = await res.json();

      expect(res.status).toBe(500);
      expect(response.success).toBe(false);

      // Disk is untouched.
      const onDisk = yaml.load(fs.readFileSync(configSource, "utf8")) as z.infer<typeof configSchema>;
      expect(onDisk.logLevel).toBe("info");

      // The in-memory commit is observable through the next write: if the
      // failed request had already set this.config.logLevel to "warn", the
      // retry would see no level change and skip setLogLevel entirely.
      logger.setLogLevel.mockClear();
      const retry = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ ...baseConfig, apiPort: port, logLevel: "warn" }),
      });
      const retryResponse = await retry.json();
      expect(retry.status).toBe(200);
      expect(retryResponse.success).toBe(true);
      expect(logger.setLogLevel).toHaveBeenCalledWith("warn");

      // Restore the "info" baseline the /reload-config tests depend on.
      const restore = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ ...baseConfig, apiPort: port, logLevel: "info" }),
      });
      expect(restore.status).toBe(200);
    });
  });

  describe("/reload-config", () => {
    it("applies logLevel changes found on disk to the running logger", async () => {
      // Drive the running level from "info" (the constructor config and all
      // prior tests use it) to "warn" via the write path, so the reload
      // below has a definite change to apply.
      logger.setLogLevel.mockClear();
      const writeRes = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        // Connection: close keeps undici's keep-alive pool from holding a
        // socket open, which would block server.close() in afterAll.
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ ...baseConfig, apiPort: port, logLevel: "warn" }),
      });
      const writeResponse = await writeRes.json();
      expect(writeRes.status).toBe(200);
      expect(writeResponse.success).toBe(true);
      expect(logger.setLogLevel).toHaveBeenCalledWith("warn");

      // Operator edits logLevel on disk (the Docker-mount scenario) and asks
      // the service to reload it: the disk level must reach the running
      // logger, not just the in-memory config.
      logger.setLogLevel.mockClear();
      fs.writeFileSync(
        configSource,
        yaml.dump({ ...baseConfig, apiPort: port, logLevel: "debug" })
      );

      const reloadRes = await fetch(`http://127.0.0.1:${port}/reload-config`, {
        headers: { Connection: "close" },
      });
      const reloadResponse = await reloadRes.json();

      expect(reloadRes.status).toBe(200);
      expect(reloadResponse.success).toBe(true);
      expect(logger.setLogLevel).toHaveBeenCalledWith("debug");
    });

    it("does not re-apply the log level when the on-disk value is unchanged", async () => {
      logger.setLogLevel.mockClear();

      const reloadRes = await fetch(`http://127.0.0.1:${port}/reload-config`, {
        headers: { Connection: "close" },
      });
      expect(reloadRes.status).toBe(200);

      // The previous test left disk and the running level both at "debug",
      // so a no-op reload must not touch the logger.
      expect(logger.setLogLevel).not.toHaveBeenCalled();
    });
  });

  describe("HTTP method enforcement", () => {
    it("rejects non-GET methods on /read-config with 405 and Allow: GET", async () => {
      for (const method of ["POST", "DELETE", "PATCH"]) {
        const res = await fetch(`http://127.0.0.1:${port}/read-config`, {
          method,
          headers: { Connection: "close" },
        });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
        const body = (await res.json()) as { success: boolean; message: string };
        expect(body.success).toBe(false);
      }
    });

    it("still serves /read-config on GET", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/read-config`, {
        headers: { Connection: "close" },
      });
      expect(res.status).toBe(200);
    });

    it("rejects non-POST methods on /write-config with 405 and Allow: POST", async () => {
      for (const method of ["GET", "DELETE", "PUT"]) {
        const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
          method,
          headers: { Connection: "close" },
        });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        const body = (await res.json()) as { success: boolean; message: string };
        expect(body.success).toBe(false);
      }
    });

    it("rejects non-GET methods on /reload-config with 405 and Allow: GET", async () => {
      for (const method of ["POST", "DELETE", "PUT"]) {
        const res = await fetch(`http://127.0.0.1:${port}/reload-config`, {
          method,
          headers: { Connection: "close" },
        });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
        const body = (await res.json()) as { success: boolean; message: string };
        expect(body.success).toBe(false);
      }
    });

    // The read-only routes advertise verb GET at /endpoints, so they must
    // enforce it: DELETE /health, POST /metrics, and friends used to be
    // served as normal reads.
    it("rejects non-GET methods on the read-only routes with 405 and Allow: GET", async () => {
      const routes = ["/metrics", "/health", "/ready", "/about", "/endpoints"];
      for (const route of routes) {
        for (const method of ["POST", "DELETE", "PATCH"]) {
          const res = await fetch(`http://127.0.0.1:${port}${route}`, {
            method,
            headers: { Connection: "close" },
          });
          expect(res.status).toBe(405);
          expect(res.headers.get("allow")).toBe("GET");
          const body = (await res.json()) as { success: boolean; message: string };
          expect(body.success).toBe(false);
        }
      }
    });

    it("serves /about on GET with the service description and route list", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/about`, {
        headers: { Connection: "close" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        about: { name: string };
        routes: { route: string }[];
      };
      expect(body.about.name).toBe("Sensor Telemetry Services");
      expect(body.routes.map((r) => r.route)).toContain("/endpoints");
    });

    it("serves /endpoints on GET with the advertised verbs", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/endpoints`, {
        headers: { Connection: "close" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        endpoints: { route: string; verb: string }[];
      };
      // The runtime now enforces exactly what this list advertises.
      const verbs = new Map(body.endpoints.map((e) => [e.route, e.verb]));
      expect(verbs.get("/metrics")).toBe("GET");
      expect(verbs.get("/health")).toBe("GET");
      expect(verbs.get("/ready")).toBe("GET");
      expect(verbs.get("/about")).toBe("GET");
      expect(verbs.get("/endpoints")).toBe("GET");
      expect(verbs.get("/write-config")).toBe("POST");
    });
  });

  describe("query-string routing", () => {
    // req.url includes the query string, so matching routes against it
    // 404s well-formed requests like /health?probe=20260929 and emits a
    // route_not_found warn per hit.
    it("routes /health?x=1 to the health handler instead of 404", async () => {
      logger.write_warn.mockClear();

      const res = await fetch(`http://127.0.0.1:${port}/health?x=1`, {
        // Connection: close keeps undici's keep-alive pool from holding a
        // socket open, which would block server.close() in afterAll.
        headers: { Connection: "close" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("healthy");

      // A query string on a valid route is not a routing failure.
      expect(
        logger.write_warn.mock.calls.some(
          (call) => call[2]?.event === "route_not_found"
        )
      ).toBe(false);
    });

    it("routes /metrics with a query string to the metrics handler", async () => {
      logger.write_warn.mockClear();

      const res = await fetch(`http://127.0.0.1:${port}/metrics?probe=20260929`, {
        headers: { Connection: "close" },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("# HELP");

      expect(
        logger.write_warn.mock.calls.some(
          (call) => call[2]?.event === "route_not_found"
        )
      ).toBe(false);
    });
  });

  describe("CORS (browser clients)", () => {
    // Node's fetch() does not enforce browser CORS policy, so these tests
    // send Origin/OPTIONS explicitly and inspect the raw response headers.
    // The shared writer runs with SENSOR_TELEMETRY_CORS_ORIGINS pinned to
    // allowedOrigin (set in beforeAll), which is the only allowed origin.

    function variesOnOrigin(res: globalThis.Response): boolean {
      return (res.headers.get("vary") ?? "")
        .split(",")
        .map((part) => part.trim())
        .includes("Origin");
    }

    it("answers an allowed preflight for /write-config with 204 and no body", async () => {
      // A preflight carries the *names* of the headers the actual request
      // will use, never their values — no x-config-token header here.
      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "OPTIONS",
        headers: {
          Origin: allowedOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-config-token",
          // Connection: close keeps undici's keep-alive pool from holding a
          // socket open, which would block server.close() in afterAll.
          Connection: "close",
        },
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
      const methods = res.headers.get("access-control-allow-methods") ?? "";
      expect(methods).toContain("POST");
      expect(methods).toContain("OPTIONS");
      const allowedHeaders = res.headers.get("access-control-allow-headers") ?? "";
      expect(allowedHeaders).toContain("Content-Type");
      expect(allowedHeaders).toContain("X-Config-Token");
      expect(res.headers.get("access-control-max-age")).toBe("600");
      expect(variesOnOrigin(res)).toBe(true);
    });

    it("does not execute the endpoint for a preflight request", async () => {
      // If the preflight fell through to normal routing, requireMethod
      // would answer 405 (OPTIONS is not POST) before any body handling.
      (write_file_yaml as unknown as jest.Mock).mockClear();
      const before = fs.readFileSync(configSource, "utf8");

      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "OPTIONS",
        headers: { Origin: allowedOrigin, Connection: "close" },
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(fs.readFileSync(configSource, "utf8")).toBe(before);
      expect(write_file_yaml).not.toHaveBeenCalled();
    });

    it("serves an allowed cross-origin GET /health even though it bypasses sendJson", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: allowedOrigin, Connection: "close" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
      expect(variesOnOrigin(res)).toBe(true);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("healthy");
    });

    it("serves /metrics with CORS headers for an allowed browser origin", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { Origin: allowedOrigin, Connection: "close" },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("# HELP");
      expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    });

    it("serves an allowed cross-origin POST /write-config and keeps write behavior intact", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "POST",
        headers: {
          Origin: allowedOrigin,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ ...baseConfig, apiPort: port, mqttTopicLog: "iot/v3/log" }),
      });
      const response = (await res.json()) as { success: boolean };

      expect(res.status).toBe(200);
      expect(response.success).toBe(true);
      expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
      expect(variesOnOrigin(res)).toBe(true);

      const onDisk = yaml.load(fs.readFileSync(configSource, "utf8")) as z.infer<typeof configSchema>;
      expect(onDisk.mqttTopicLog).toBe("iot/v3/log");
    });

    it("includes the CORS header on API error responses for an allowed origin", async () => {
      // A 405 goes through sendJson: the browser must see the real API
      // status and body rather than an opaque CORS failure.
      const res = await fetch(`http://127.0.0.1:${port}/read-config`, {
        method: "POST",
        headers: { Origin: allowedOrigin, Connection: "close" },
      });

      expect(res.status).toBe(405);
      expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(false);
    });

    it("includes the CORS header on 404 responses, which bypass sendJson", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/not-a-route`, {
        headers: { Origin: allowedOrigin, Connection: "close" },
      });

      expect(res.status).toBe(404);
      expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    });

    it("rejects a preflight from a disallowed origin with 403 and no allow-origin header", async () => {
      logger.write_warn.mockClear();

      const res = await fetch(`http://127.0.0.1:${port}/write-config`, {
        method: "OPTIONS",
        headers: {
          Origin: disallowedOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-config-token",
          Connection: "close",
        },
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      // The rejection is audited with the offending origin, never the token.
      expect(
        logger.write_warn.mock.calls.some(
          (call) =>
            call[2]?.event === "cors_origin_rejected" &&
            call[2]?.logType === "audit" &&
            call[2]?.origin === disallowedOrigin &&
            call[2]?.statusCode === 403
        )
      ).toBe(true);
    });

    it("rejects a normal browser request from a disallowed origin with 403 and no allow-origin header", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: disallowedOrigin, Connection: "close" },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      const body = (await res.json()) as { success: boolean; message: string };
      expect(body.success).toBe(false);
      expect(body.message).toBe("origin not allowed");
    });

    it("leaves non-browser requests (no Origin header) unaffected", async () => {
      // Prometheus scrapers, Docker healthchecks, curl, and other services
      // send no Origin header and must keep working unchanged.
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Connection: "close" },
      });
      expect(health.status).toBe(200);
      expect(health.headers.get("access-control-allow-origin")).toBeNull();

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { Connection: "close" },
      });
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("CORS origin parsing and matching (pure logic)", () => {
    // parseCorsOrigins and resolveCorsOrigin are pure, so wildcard-mode
    // semantics (unset/empty/"*") can be pinned without constructing a
    // second writer — prom-client's global registry allows only one per
    // process, and the shared writer is allowlist-mode by design.
    const parse = (raw: string | undefined) =>
      (
        PrometheusWriter as unknown as {
          parseCorsOrigins(
            raw: string | undefined
          ): { allowAllOrigins: boolean; allowedOrigins: ReadonlySet<string> };
        }
      ).parseCorsOrigins(raw);

    const resolve = (
      origin: string | undefined,
      parsed: { allowAllOrigins: boolean; allowedOrigins: ReadonlySet<string> }
    ): string | null =>
      (
        PrometheusWriter as unknown as {
          resolveCorsOrigin(
            origin: string | undefined,
            allowAllOrigins: boolean,
            allowedOrigins: ReadonlySet<string>
          ): string | null;
        }
      ).resolveCorsOrigin(origin, parsed.allowAllOrigins, parsed.allowedOrigins);

    it("treats an unset, empty, or '*' value as allow-all and emits *", () => {
      for (const raw of [undefined, "", "   ", "*"]) {
        const parsed = parse(raw);
        expect(parsed.allowAllOrigins).toBe(true);
        expect(resolve("http://any-origin.example:1234", parsed)).toBe("*");
      }
    });

    it("trims entries and drops empty ones from an explicit list", () => {
      const parsed = parse(" http://a.example:3000 , ,https://b.example ,");
      expect(parsed.allowAllOrigins).toBe(false);
      expect(parsed.allowedOrigins.has("http://a.example:3000")).toBe(true);
      expect(parsed.allowedOrigins.has("https://b.example")).toBe(true);
      expect(parsed.allowedOrigins.size).toBe(2);
    });

    it("matches origins by exact equality only (scheme and port matter)", () => {
      const parsed = parse("http://browser.test:3000");
      expect(resolve("http://browser.test:3000", parsed)).toBe("http://browser.test:3000");
      // Same host, different port / scheme / suffix: all distinct origins.
      expect(resolve("http://browser.test:3301", parsed)).toBeNull();
      expect(resolve("https://browser.test:3000", parsed)).toBeNull();
      expect(resolve("http://browser.test:3000.evil.example", parsed)).toBeNull();
    });

    it("emits no header for requests without an Origin header", () => {
      expect(resolve(undefined, parse("*"))).toBeNull();
      expect(resolve(undefined, parse("http://a.example:3000"))).toBeNull();
    });
  });

  describe("/ready", () => {
    // /ready reports readiness (can the service ingest telemetry right
    // now), not liveness: /health stays 200 through a transient broker
    // outage so the Docker healthcheck never restarts the container,
    // while readiness-sensitive orchestrators probe /ready instead.
    it("returns 503 and degraded when no MQTT client is connected", async () => {
      // The shared writer has no networking attached, so is_connected() is
      // undefined and the service is not ready to ingest.
      const res = await fetch(`http://127.0.0.1:${port}/ready`, {
        headers: { Connection: "close" },
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; mqtt: string };
      expect(body.status).toBe("degraded");
      expect(body.mqtt).toBe("disconnected");
    });

    it("returns 503 and degraded when the MQTT client is disconnected", async () => {
      writer.setMqttNetworking({
        is_connected: () => false,
        subscriptions_active: () => false,
        get_subscription_states: () => [{ topic: "iot/v3/telemetry", active: false }],
      } as unknown as IMqttNetworking);

      const res = await fetch(`http://127.0.0.1:${port}/ready`, {
        headers: { Connection: "close" },
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; mqtt: string; subscriptions: string };
      expect(body.status).toBe("degraded");
      expect(body.mqtt).toBe("disconnected");
      expect(body.subscriptions).toBe("degraded");
    });

    it("returns 503 and degraded when connected but the subscription was denied (regression P2-3)", async () => {
      // A broker that grants CONNECT but denies SUBSCRIBE keeps the client
      // "connected" while ingesting nothing — the exact silent failure
      // /ready exists to surface.
      writer.setMqttNetworking({
        is_connected: () => true,
        subscriptions_active: () => false,
        get_subscription_states: () => [{ topic: "iot/v3/telemetry", active: false }],
      } as unknown as IMqttNetworking);

      const res = await fetch(`http://127.0.0.1:${port}/ready`, {
        headers: { Connection: "close" },
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; mqtt: string; subscriptions: string };
      expect(body.status).toBe("degraded");
      expect(body.mqtt).toBe("connected");
      expect(body.subscriptions).toBe("degraded");
    });

    it("returns 200 and ready when the MQTT client is connected", async () => {
      writer.setMqttNetworking({
        is_connected: () => true,
        subscriptions_active: () => true,
        get_subscription_states: () => [{ topic: "iot/v3/telemetry", active: true }],
      } as unknown as IMqttNetworking);

      const res = await fetch(`http://127.0.0.1:${port}/ready`, {
        headers: { Connection: "close" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; mqtt: string; subscriptions: string };
      expect(body.status).toBe("ready");
      expect(body.mqtt).toBe("connected");
      expect(body.subscriptions).toBe("active");
    });

    it("keeps /health at 200 while the MQTT client is disconnected", async () => {
      // The whole point of the split: a readiness failure must not be
      // reported as a liveness failure.
      writer.setMqttNetworking({
        is_connected: () => false,
        subscriptions_active: () => false,
        get_subscription_states: () => [],
      } as unknown as IMqttNetworking);

      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Connection: "close" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; mqtt: string };
      expect(body.status).toBe("healthy");
      expect(body.mqtt).toBe("disconnected");
    });
  });

  describe("publish_air message gating", () => {
    it("does not publish humidity or altitude when temperature_c is missing", async () => {
      const source = "gate-air-invalid";
      writer.publish_air(
        { air: { humidity_percent: 42, pressure_pa: 100000, altitude_m: 100 } },
        source,
        "1.0.0"
      );

      // The rejection is audited as a telemetry_invalid_value warning.
      expect(
        logger.write_warn.mock.calls.some(
          (call) =>
            call[2]?.event === "telemetry_invalid_value" &&
            call[2]?.field === "temperature_c"
        )
      ).toBe(true);

      const metrics = await getMetrics();
      expect(metrics).not.toContain(`air_humidity{source="${source}"}`);
      expect(metrics).not.toContain(`air_altitude_ft{source="${source}"}`);
    });

    it("publishes the full air message when temperature_c is valid", async () => {
      const source = "gate-air-valid";
      writer.publish_air(
        {
          air: {
            temperature_c: 25,
            humidity_percent: 42,
            pressure_pa: 100000,
            altitude_m: 100,
          },
        },
        source,
        "1.0.0"
      );

      const metrics = await getMetrics();
      expect(metrics).toContain(`air_temperature{source="${source}"}`);
      expect(metrics).toContain(`air_humidity{source="${source}"}`);
      expect(metrics).toContain(`air_altitude_ft{source="${source}"}`);
    });

    it.each([
      ["below-zero", -0.1],
      ["above-hundred", 100.2],
    ])(
      "skips the humidity gauge when humidity_percent is %s",
      async (_label, humidity) => {
        const source = `gate-air-humidity-${humidity}`;
        writer.publish_air(
          {
            air: {
              temperature_c: 25,
              humidity_percent: humidity,
              pressure_pa: 100000,
            },
          },
          source,
          "1.0.0"
        );

        // Physically impossible humidity is audited as telemetry_out_of_range;
        // only the humidity gauge is skipped — the rest of the message
        // (temperature) is still published, matching the temperature
        // out-of-range behavior.
        expect(
          logger.write_warn.mock.calls.some(
            (call) =>
              call[2]?.event === "telemetry_out_of_range" &&
              call[2]?.field === "humidity_percent" &&
              call[2]?.minRange === 0 &&
              call[2]?.maxRange === 100
          )
        ).toBe(true);

        const metrics = await getMetrics();
        expect(metrics).not.toContain(`air_humidity{source="${source}"}`);
        expect(metrics).toContain(`air_temperature{source="${source}"}`);
      }
    );

    it.each([["zero", 0], ["hundred", 100]])(
      "accepts the boundary humidity value %s",
      async (_label, humidity) => {
        const source = `gate-air-humidity-${humidity}`;
        writer.publish_air(
          { air: { temperature_c: 25, humidity_percent: humidity } },
          source,
          "1.0.0"
        );

        const metrics = await getMetrics();
        expect(metrics).toContain(`air_humidity{source="${source}"}`);
      }
    );

    it("logs the completion event without claiming a fixed metric count", async () => {
      // SHT35-style payload: temperature and humidity only, no pressure or
      // altitude. Only 2 gauges are published, so the old completion log's
      // metricsCount: 4 / "Published all air metrics" was inaccurate.
      const source = "gate-air-log-contract";
      writer.publish_air(
        { air: { temperature_c: 25, humidity_percent: 42 } },
        source,
        "1.0.0"
      );

      const completionCall = logger.write_debug.mock.calls.find(
        (call) => call[2]?.event === "metrics_published" && call[2]?.source === source
      );
      expect(completionCall).toBeDefined();
      expect(completionCall?.[2]).not.toHaveProperty("metricsCount");
      expect(completionCall?.[1]).not.toMatch(/Published all air metrics/);
      expect(completionCall?.[1]).toContain("Processed air telemetry for source");
    });
  });

  describe("source label sanitization", () => {
    it("maps an all-invalid source to the 'unknown' label instead of an empty label", async () => {
      // The shared writer uses the default char set (a-zA-Z0-9._-), so "###"
      // strips to nothing. Pre-fix that produced source="" and every
      // all-invalid source collided on one empty label.
      writer.publish_air(
        {
          air: {
            temperature_c: 25,
            humidity_percent: 42,
            pressure_pa: 100000,
            altitude_m: 100,
          },
        },
        "###",
        "1.0.0"
      );

      // The collision is audited as a warning (visible at the default level).
      expect(
        logger.write_warn.mock.calls.some(
          (call) =>
            call[2]?.event === "sensor_source_sanitized" &&
            call[2]?.originalSource === "###" &&
            call[2]?.sanitizedSource === "unknown"
        )
      ).toBe(true);

      const metrics = await getMetrics();
      expect(metrics).toContain(`air_temperature{source="unknown"}`);
      expect(metrics).not.toContain(`air_temperature{source=""}`);
    });
  });

  describe("sanitizeSource (direct unit)", () => {
    // Direct calls to the private label normalizer: the returned string IS
    // the Prometheus label, so these pin the exact transformation pipeline
    // (falsy fallback, dash normalization, stripping, truncation) without
    // having to parse /metrics output.
    const sanitize = (source: string): string =>
      (
        writer as unknown as { sanitizeSource(source: string): string }
      ).sanitizeSource(source);

    it("returns an already-clean source unchanged", () => {
      expect(sanitize("Air-1")).toBe("Air-1");
    });

    it("normalizes a unicode en dash to an ASCII hyphen", () => {
      // U+2013 (EN DASH) falls inside the production [‐-―−] class.
      expect(sanitize("Air–1")).toBe("Air-1");
    });

    it("strips whitespace (an invalid character) from the source", () => {
      expect(sanitize("Air 1")).toBe("Air1");
    });

    it("returns 'unknown' for an empty source", () => {
      expect(sanitize("")).toBe("unknown");
    });

    it("returns 'unknown' and warns when all characters are invalid", () => {
      logger.write_warn.mockClear();

      expect(sanitize("💩💩")).toBe("unknown");

      expect(
        logger.write_warn.mock.calls.some(
          (call) =>
            call[2]?.event === "sensor_source_sanitized" &&
            call[2]?.originalSource === "💩💩" &&
            call[2]?.sanitizedSource === "unknown"
        )
      ).toBe(true);
    });

    it("truncates a source longer than the max length (30) to 30 chars", () => {
      expect(sanitize("a".repeat(40))).toBe("a".repeat(30));
    });
  });

  describe("sensor_last_seen_timestamp_seconds (sensor freshness)", () => {
    // Read directly from prom-client's global registry (the same one the
    // shared writer writes to) rather than scraping /metrics: the
    // fake-timer test below must not perform an HTTP request, which would
    // need real timers to complete.
    async function readLastSeen(source: string): Promise<number | undefined> {
      const metric = register.getSingleMetric("sensor_last_seen_timestamp_seconds");
      if (!metric) {
        throw new Error("sensor_last_seen_timestamp_seconds is not registered");
      }
      // Gauge.get() resolves to { help, name, type, values, aggregator };
      // the series live under values.
      const { values } = (await metric.get()) as unknown as {
        values: Array<{ labels: Record<string, string>; value: number }>;
      };
      return values.find((entry) => entry.labels.source === source)?.value;
    }

    it("exposes no series until a source is marked seen, then one series at the current time", async () => {
      const source = "freshness-1";
      expect(await getMetrics()).not.toContain(
        `sensor_last_seen_timestamp_seconds{source="${source}"}`
      );

      writer.mark_source_seen(source);

      const line = (await getMetrics())
        .split("\n")
        .find((l) => l.startsWith(`sensor_last_seen_timestamp_seconds{source="${source}"}`));
      expect(line).toBeDefined();
      const value = Number(line!.split(/\s+/).pop());
      // setToCurrentTime() stamps now/1000 — tolerate the sub-second
      // elapsed between the stamp and the scrape.
      const nowSec = Math.floor(Date.now() / 1000);
      expect(nowSec - value).toBeLessThanOrEqual(1);
    });

    it("stamps the current time and advances it when the source reports again", async () => {
      jest.useFakeTimers();
      try {
        const source = "freshness-timers";

        jest.setSystemTime(new Date("2026-09-30T12:00:00Z"));
        writer.mark_source_seen(source);
        const first = await readLastSeen(source);
        // Derive the expectation from the faked clock rather than
        // hardcoding the epoch.
        expect(first).toBe(Math.floor(Date.now() / 1000));

        jest.setSystemTime(new Date("2026-09-30T12:01:00Z"));
        writer.mark_source_seen(source);
        const second = await readLastSeen(source);
        expect(second).toBe(Math.floor(Date.now() / 1000));
        expect(second).toBe(first! + 60);
      } finally {
        jest.useRealTimers();
      }
    });

    it("sanitizes the source label like every other sensor metric", async () => {
      // Whitespace and '#' are invalid under the default charset, so the
      // freshness label must go through the same admitSource() pipeline as
      // the other sensor metrics rather than minting a raw label.
      writer.mark_source_seen("Bad Source###");

      const metrics = await getMetrics();
      expect(metrics).toContain(
        `sensor_last_seen_timestamp_seconds{source="BadSource"}`
      );
      expect(metrics).not.toContain(`source="Bad Source`);
    });
  });

  describe("device-owned cumulative counts (gauges, not counters)", () => {
    // lightning_strike_count, sensor_health_read_failure_count, and
    // sensor_health_read_count mirror counter values owned by the sensor.
    // The exporter publishes the device's absolute value as-is (Gauge.set),
    // never accumulating deltas, so a device-side reset (102 -> 0) must land
    // as a lower gauge value rather than be rejected, clamped, or
    // compensated. These tests pin that the metrics stay Gauges named
    // *_count and still track decreasing reported values.
    function metricValue(
      metrics: string,
      name: string,
      source: string
    ): number | undefined {
      const line = metrics
        .split("\n")
        .find((l) => l.startsWith(`${name}{source="${source}"}`));
      if (!line) return undefined;
      return Number(line.split(/\s+/).pop());
    }

    it("exports all three under the *_count names as gauge TYPEs", async () => {
      const metrics = await getMetrics();
      expect(metrics).toContain("# TYPE lightning_strike_count gauge");
      expect(metrics).toContain("# TYPE sensor_health_read_failure_count gauge");
      expect(metrics).toContain("# TYPE sensor_health_read_count gauge");
      // Old _total names are gone — no compatibility aliases.
      expect(metrics).not.toContain("lightning_strikes_total");
      expect(metrics).not.toContain("sensor_health_read_failures_total");
      expect(metrics).not.toContain("sensor_health_read_counter_total");
    });

    it("lightning_strike_count follows decreasing device values (10 -> 11 -> 0)", async () => {
      const source = "count-lightning";
      writer.publish_lightning({ lightning: { lightning_count: 10 } }, source, "1.0.0");
      expect(metricValue(await getMetrics(), "lightning_strike_count", source)).toBe(10);

      writer.publish_lightning({ lightning: { lightning_count: 11 } }, source, "1.0.0");
      // 11, not 21: the exporter mirrors the absolute value, it does not sum.
      expect(metricValue(await getMetrics(), "lightning_strike_count", source)).toBe(11);

      writer.publish_lightning({ lightning: { lightning_count: 0 } }, source, "1.0.0");
      expect(metricValue(await getMetrics(), "lightning_strike_count", source)).toBe(0);
    });

    it("sensor_health_read_failure_count follows decreasing device values (5 -> 6 -> 0)", async () => {
      const source = "count-readfail";
      writer.set_sensor_read_failures(source, 5);
      expect(metricValue(await getMetrics(), "sensor_health_read_failure_count", source)).toBe(5);

      writer.set_sensor_read_failures(source, 6);
      expect(metricValue(await getMetrics(), "sensor_health_read_failure_count", source)).toBe(6);

      writer.set_sensor_read_failures(source, 0);
      expect(metricValue(await getMetrics(), "sensor_health_read_failure_count", source)).toBe(0);
    });

    it("sensor_health_read_count follows decreasing device values (100 -> 101 -> 0)", async () => {
      const source = "count-readcount";
      writer.set_sensor_read_counter(source, 100);
      expect(metricValue(await getMetrics(), "sensor_health_read_count", source)).toBe(100);

      writer.set_sensor_read_counter(source, 101);
      expect(metricValue(await getMetrics(), "sensor_health_read_count", source)).toBe(101);

      writer.set_sensor_read_counter(source, 0);
      expect(metricValue(await getMetrics(), "sensor_health_read_count", source)).toBe(0);
    });
  });

  // Declared last because it consumes the shared writer: close() stops the
  // metrics server, so this must run after every describe that still needs
  // it. afterAll's own close() is then a no-op by design.
  describe("close() idempotency", () => {
    it("a second close() while the first is still in flight resolves without throwing and logs no error", async () => {
      logger.write_error.mockClear();
      logger.write_critical.mockClear();

      // The first close puts the server into its closing state; an
      // unguarded second close() would reach server.close() on that
      // closing server and throw ERR_SERVER_NOT_RUNNING.
      const first = writer.close();
      const second = writer.close();
      await Promise.all([first, second]);

      expect(logger.write_error).not.toHaveBeenCalled();
      expect(logger.write_critical).not.toHaveBeenCalled();

      // First close's callback fires exactly once.
      const closedCalls = logger.write_info.mock.calls.filter(
        (call) => call[2]?.event === "prometheus_server_closed"
      );
      expect(closedCalls).toHaveLength(1);
    });
  });
});
