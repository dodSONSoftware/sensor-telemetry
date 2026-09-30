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

  const baseConfig = {
    logLevel: "info",
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  beforeAll(async () => {
    // Endpoints must be reachable without a token for this test.
    savedToken = process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;

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

  // Declared last because it consumes the shared writer: close() stops the
  // metrics server, so this must run after every describe that still needs
  // it. afterAll's own close() is then a no-op by design.
  describe("close() idempotency", () => {
    it("a second close() while the first is still in flight does not throw and logs no error", async () => {
      logger.write_error.mockClear();
      logger.write_critical.mockClear();

      // The first close puts the server into its closing state; an
      // unguarded second close() would reach server.close() on that
      // closing server and throw ERR_SERVER_NOT_RUNNING.
      expect(() => {
        writer.close();
        writer.close();
      }).not.toThrow();

      expect(logger.write_error).not.toHaveBeenCalled();
      expect(logger.write_critical).not.toHaveBeenCalled();

      // First close's callback still fires exactly once.
      await until(() =>
        logger.write_info.mock.calls.some(
          (call) => call[2]?.event === "prometheus_server_closed"
        )
      );
    });
  });
});
