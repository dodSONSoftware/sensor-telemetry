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

// This file constructs its writer WITH the /restart-service feature enabled
// (SENSOR_TELEMETRY_RESTART_ENABLED=true + SENSOR_TELEMETRY_RESTART_TOKEN),
// so it needs its own file: the flag and token are captured at construction,
// and prom-client's global registry allows only one real writer per process
// (each Jest file gets its own module sandbox, so one file = one writer).
//
// State model for the whole file: an ACCEPTED request latches the
// writer's restartPending guard for the writer's lifetime (in production
// the process exits right after, so the latch is never observable). The
// rejection-path tests below therefore all run first, and the accept-path
// tests reset the private guard (the suites elsewhere in this repo reach
// into private state the same way) so each accept test starts clean.
// The lifecycle callback is a spy that records invocations — it never
// signals, so the test process is never terminated.

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

const RESTART_TOKEN = "restart-secret-12345";
const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter with /restart-service enabled", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let restartCallback: jest.Mock;
  let port: number;
  let configSource: string;
  let savedRestartEnabled: string | undefined;
  let savedRestartToken: string | undefined;
  let savedCorsOrigins: string | undefined;

  beforeAll(async () => {
    savedRestartEnabled = process.env.SENSOR_TELEMETRY_RESTART_ENABLED;
    savedRestartToken = process.env.SENSOR_TELEMETRY_RESTART_TOKEN;
    savedCorsOrigins = process.env.SENSOR_TELEMETRY_CORS_ORIGINS;
    process.env.SENSOR_TELEMETRY_RESTART_ENABLED = "true";
    process.env.SENSOR_TELEMETRY_RESTART_TOKEN = RESTART_TOKEN;
    // Allowlist CORS mode (not the wildcard default): every request in this
    // file carries no Origin header (curl-style, unaffected by the
    // allowlist), and the 403 test below needs a denied origin to exist.
    process.env.SENSOR_TELEMETRY_CORS_ORIGINS = "http://allowed.test:3000";

    port = await getFreePort();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-restart-test-"));
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

  // The HTTP audit throttle (60 s window in production) would suppress the
  // later same-event occurrences on this file's shared writer. Collapse the
  // window for every test; the throttle semantics themselves are covered by
  // the dedicated config-token test.
  const HTTP_AUDIT_REWARN_INTERVAL_DEFAULT = 60_000;
  const setHttpAuditInterval = (ms: number) => {
    (
      PrometheusWriter as unknown as { HTTP_AUDIT_REWARN_INTERVAL_MS: number }
    ).HTTP_AUDIT_REWARN_INTERVAL_MS = ms;
  };
  const RESTART_FALLBACK_DEFAULT = 2000;
  const setRestartFallback = (ms: number) => {
    (
      PrometheusWriter as unknown as { RESTART_FALLBACK_DELAY_MS: number }
    ).RESTART_FALLBACK_DELAY_MS = ms;
  };

  // Release the single-flight guard between accept tests (see the file
  // header): an accepted request latches it for the writer's lifetime, and
  // the spy callback never exits the process.
  const releaseRestartGuard = () => {
    (writer as unknown as { restartPending: boolean }).restartPending = false;
    const t = (writer as unknown as { restartFallbackTimer: NodeJS.Timeout | undefined }).restartFallbackTimer;
    if (t !== undefined) {
      clearTimeout(t);
      (writer as unknown as { restartFallbackTimer: NodeJS.Timeout | undefined }).restartFallbackTimer = undefined;
    }
  };

  beforeEach(() => {
    setHttpAuditInterval(0);
  });
  afterEach(() => {
    setHttpAuditInterval(HTTP_AUDIT_REWARN_INTERVAL_DEFAULT);
    setRestartFallback(RESTART_FALLBACK_DEFAULT);
    restartCallback.mockClear();
  });

  afterAll(async () => {
    releaseRestartGuard();
    writer.close();
    await until(() =>
      logger.write_info.mock.calls.some(
        (call) => call[2]?.event === "prometheus_server_closed"
      )
    );
    fs.rmSync(path.dirname(configSource), { recursive: true, force: true });
    for (const [name, saved] of [
      ["SENSOR_TELEMETRY_RESTART_ENABLED", savedRestartEnabled],
      ["SENSOR_TELEMETRY_RESTART_TOKEN", savedRestartToken],
      ["SENSOR_TELEMETRY_CORS_ORIGINS", savedCorsOrigins],
    ] as const) {
      if (saved === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved;
      }
    }
  });

  async function post(
    reqPath: string,
    headers: Record<string, string> = {},
    body: string | undefined = undefined
  ): Promise<{ status: number; allow: string | null; cacheControl: string | null; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
      method: "POST",
      // Connection: close keeps undici's keep-alive pool from holding a
      // socket open, which would block server.close() in afterAll.
      headers: { Connection: "close", ...headers },
      body,
    });
    return {
      status: res.status,
      allow: res.headers.get("allow"),
      cacheControl: res.headers.get("cache-control"),
      body: await res.json(),
    };
  }

  async function get(reqPath: string): Promise<{ status: number; allow: string | null; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
      headers: { Connection: "close" },
    });
    return { status: res.status, allow: res.headers.get("allow"), body: await res.json() };
  }

  describe("method check (before authentication and enablement)", () => {
    it("returns 405 with Allow: POST for GET, and never invokes the callback", async () => {
      const { status, allow, body } = await get("/restart-service");

      expect(status).toBe(405);
      expect(allow).toBe("POST");
      expect(body.success).toBe(false);
      expect(restartCallback).not.toHaveBeenCalled();
    });

    it("returns 405 with Allow: POST for PUT and DELETE", async () => {
      for (const method of ["PUT", "DELETE"]) {
        const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
          method,
          headers: {
            Connection: "close",
            "x-restart-token": RESTART_TOKEN,
          },
        });
        const body = (await res.json()) as { success: boolean };
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        expect(body.success).toBe(false);
      }
      expect(restartCallback).not.toHaveBeenCalled();
    });
  });

  describe("token check", () => {
    it("returns 401 with an audit warning when the token header is missing", async () => {
      logger.write_warn.mockClear();

      const { status, body } = await post("/restart-service");

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-restart-token",
      });
      expect(restartCallback).not.toHaveBeenCalled();
      const warn = logger.write_warn.mock.calls.find(
        (c) => c[2]?.event === "restart_token_rejected"
      );
      expect(warn).toBeDefined();
      expect(warn![2].logType).toBe("audit");
      expect(warn![2].statusCode).toBe(401);
      // The audit carries the directly observed socket address for
      // forensics; over a real socket it is always present.
      expect(typeof warn![2].remoteAddress).toBe("string");
      expect((warn![2].remoteAddress as string).length).toBeGreaterThan(0);
      // The token value never reaches the log channel.
      const serialized = JSON.stringify(
        logger.write_warn.mock.calls
      );
      expect(serialized).not.toContain(RESTART_TOKEN);
    });

    it("returns 401 when the token header has the wrong value (same length)", async () => {
      // Same length as RESTART_TOKEN so the comparison reaches
      // timingSafeEqual.
      const { status, body } = await post("/restart-service", {
        "x-restart-token": "wrong-secret-999999",
      });

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-restart-token",
      });
      expect(restartCallback).not.toHaveBeenCalled();
    });

    it("returns 401 when the token header has the wrong length", async () => {
      // Different length: exercises the length check that guards
      // timingSafeEqual (which throws on unequal-length buffers).
      const { status, body } = await post("/restart-service", {
        "x-restart-token": "short",
      });

      expect(status).toBe(401);
      expect(body).toEqual({
        success: false,
        message: "missing or invalid x-restart-token",
      });
      expect(restartCallback).not.toHaveBeenCalled();
    });

    it("does not accept the config token in the restart header", async () => {
      // The restart secret is DISTINCT: SENSOR_TELEMETRY_CONFIG_TOKEN is
      // unset in this file, so the config token's header cannot exist —
      // but the point is that x-restart-token is checked against the
      // restart token only, with no fallback.
      const { status } = await post("/restart-service", {
        "x-config-token": RESTART_TOKEN,
      });

      expect(status).toBe(401);
      expect(restartCallback).not.toHaveBeenCalled();
    });
  });

  describe("body contract", () => {
    it("returns 400 when the request carries a non-empty body", async () => {
      const { status, body } = await post(
        "/restart-service",
        { "x-restart-token": RESTART_TOKEN },
        JSON.stringify({ ignore: "me" })
      );

      expect(status).toBe(400);
      expect(body).toEqual({ success: false, message: "request body must be empty" });
      expect(restartCallback).not.toHaveBeenCalled();
    });

    it("checks the token before the body: wrong token with a body is 401", async () => {
      const { status } = await post(
        "/restart-service",
        { "x-restart-token": "nope" },
        "x"
      );

      expect(status).toBe(401);
      expect(restartCallback).not.toHaveBeenCalled();
    });
  });

  describe("CORS", () => {
    it("returns 403 for an origin not on the allowlist, without invoking the callback", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
        method: "POST",
        headers: {
          Origin: "http://evil.example",
          Connection: "close",
          "x-restart-token": RESTART_TOKEN,
        },
      });
      const body = (await res.json()) as { success: boolean };

      expect(res.status).toBe(403);
      expect(body.success).toBe(false);
      expect(restartCallback).not.toHaveBeenCalled();
    });
  });

  describe("metrics and endpoint discovery", () => {
    it("counts /restart-service requests under the named path label, not unknown", async () => {
      await post("/restart-service"); // 401 — the status is irrelevant to the label

      // The res "finish" event (which increments http_requests_total) fires
      // on the tick after the response flushes; poll the scrape until the
      // increment lands instead of assuming a single fixed sleep.
      const start = Date.now();
      for (;;) {
        const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
          headers: { Connection: "close" },
        });
        const text = await res.text();
        const line = text
          .split("\n")
          .find(
            (l) =>
              l.startsWith("http_requests_total{") &&
              l.includes('path="/restart-service"') &&
              l.includes('status="401"')
          );
        if (line !== undefined && Number(line.trim().split(" ").pop()) >= 1) {
          return;
        }
        if (Date.now() - start > 3000) {
          throw new Error('timed out waiting for http_requests_total{path="/restart-service"}');
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    });

    it("lists /restart-service in /endpoints with the POST/202 contract", async () => {
      const { status, body } = await get("/endpoints");
      expect(status).toBe(200);
      const endpoints = body.endpoints as Array<Record<string, string>>;
      const entry = endpoints.find((e) => e.route === "/restart-service");
      expect(entry).toBeDefined();
      expect(entry!.verb).toBe("POST");
      expect(entry!.responseBody).toContain("restart_scheduled");
      expect(entry!.responseBody).toContain("503");
      expect(entry!.requestBody).toContain("x-restart-token");
    });

    it("lists /restart-service in /about routes", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/about`, {
        headers: { Connection: "close" },
      });
      const body = (await res.json()) as { routes: Array<{ route: string }> };
      expect(body.routes.some((r) => r.route === "/restart-service")).toBe(true);
    });

    it("announced the enabled state at construction", () => {
      const call = logger.write_info.mock.calls.find(
        (c) => c[2]?.event === "restart_endpoint_enabled"
      );
      expect(call).toBeDefined();
    });
  });

  describe("accept path (latches restartPending — runs last, guard released per test)", () => {
    beforeEach(() => {
      releaseRestartGuard();
    });

    it("returns 202 with the scheduled contract and fires the callback exactly once after the response", async () => {
      logger.write_info.mockClear();

      const { status, cacheControl, body } = await post("/restart-service", {
        "x-restart-token": RESTART_TOKEN,
      });

      expect(status).toBe(202);
      expect(cacheControl).toBe("no-store");
      expect(body).toEqual({
        success: true,
        status: "restart_scheduled",
        message: "Service restart requested",
      });
      await until(() => restartCallback.mock.calls.length >= 1);
      // Give any (incorrect) duplicate firing a chance to show up.
      await new Promise((r) => setTimeout(r, 50));
      expect(restartCallback).toHaveBeenCalledTimes(1);

      // The acceptance audit fired exactly once, carries the observed
      // socket address and the 202, and never the token.
      const audits = logger.write_info.mock.calls.filter(
        (c) => c[2]?.event === "service_restart_requested"
      );
      expect(audits).toHaveLength(1);
      expect(audits[0][2].logType).toBe("audit");
      expect(audits[0][2].statusCode).toBe(202);
      expect(typeof audits[0][2].remoteAddress).toBe("string");
      expect(JSON.stringify(logger.write_info.mock.calls)).not.toContain(RESTART_TOKEN);
    });

    it("serves the full 202 body even though the callback has already fired", async () => {
      // Raw socket: send the request, collect the response as it arrives,
      // wait until the callback has fired (the server flushed the
      // response), and assert the client still received the COMPLETE
      // response. This is the response-before-shutdown ordering the
      // endpoint promises.
      const socket = net.connect(port, "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.on("data", (c: Buffer) => chunks.push(c));
      // Attach the 'end' handler BEFORE the write: a small response can be
      // flushed and the socket closed within the same tick, and an 'end'
      // that fires before its listener exists is lost (the test would
      // time out waiting for an already-delivered response).
      const ended = new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out reading response")), 3000);
        socket.on("end", () => {
          clearTimeout(t);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
      socket.write(
        "POST /restart-service HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "x-restart-token: " + RESTART_TOKEN + "\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n"
      );
      await until(() => restartCallback.mock.calls.length >= 1);
      const full = await ended;
      socket.end();

      expect(full.startsWith("HTTP/1.1 202")).toBe(true);
      expect(full).toContain('"status":"restart_scheduled"');
      expect(restartCallback).toHaveBeenCalledTimes(1);
    });

    it("returns 409 for a second authenticated POST while pending, with no duplicate callback", async () => {
      const first = await post("/restart-service", {
        "x-restart-token": RESTART_TOKEN,
      });
      expect(first.status).toBe(202);
      await until(() => restartCallback.mock.calls.length >= 1);

      const second = await post("/restart-service", {
        "x-restart-token": RESTART_TOKEN,
      });
      expect(second.status).toBe(409);
      expect(second.body).toEqual({
        success: false,
        message: "restart already scheduled",
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(restartCallback).toHaveBeenCalledTimes(1);
    });

    it("accepts exactly one of several concurrent authenticated POSTs", async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          post("/restart-service", { "x-restart-token": RESTART_TOKEN })
        )
      );
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([202, 409, 409, 409]);
      await until(() => restartCallback.mock.calls.length >= 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(restartCallback).toHaveBeenCalledTimes(1);
    });

    it("still schedules exactly once when the client disconnects before the response finishes", async () => {
      // Collapse the bounded fallback so the test does not wait the full
      // 2 s production delay.
      setRestartFallback(50);
      // Deterministic sub-case: the client receives the 202 STATUS LINE
      // (proof the server accepted the request and started the response)
      // and only then destroys the socket — the request was accepted,
      // but the response may never complete ('finish' may never fire).
      // The accepted restart must still be honored exactly once via the
      // fallback, and the guard cannot wedge.
      const socket = net.connect(port, "127.0.0.1");
      // Attach the data listener BEFORE the write (same reasoning as the
      // full-response test above). The write must happen BEFORE awaiting
      // the promise — the promise only resolves on the response, and
      // awaiting it first would deadlock the test.
      const received = new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for 202")), 3000);
        let buf = "";
        socket.on("data", (c: Buffer) => {
          buf += c.toString("utf8");
          if (buf.includes("\r\n\r\n")) {
            clearTimeout(t);
            resolve(buf);
          }
        });
      });
      socket.write(
        "POST /restart-service HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "x-restart-token: " + RESTART_TOKEN + "\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n"
      );
      const status = await received;
      expect(status.startsWith("HTTP/1.1 202")).toBe(true);
      socket.destroy();

      await until(() => restartCallback.mock.calls.length >= 1, 3000);
      await new Promise((r) => setTimeout(r, 100));
      expect(restartCallback).toHaveBeenCalledTimes(1);
      // The fallback timer is cleared once the single-fire scheduler ran,
      // so nothing is left armed for close() in afterAll to hold.
      expect(
        (writer as unknown as { restartFallbackTimer: NodeJS.Timeout | undefined }).restartFallbackTimer
      ).toBeUndefined();
    });
  });

  describe("startup fail-fast (constructor)", () => {
    it("refuses to start when the flag is true but no token is set", () => {
      const savedEnabled = process.env.SENSOR_TELEMETRY_RESTART_ENABLED;
      const savedToken = process.env.SENSOR_TELEMETRY_RESTART_TOKEN;
      process.env.SENSOR_TELEMETRY_RESTART_ENABLED = "true";
      delete process.env.SENSOR_TELEMETRY_RESTART_TOKEN;
      try {
        expect(() =>
          new PrometheusWriter(
            { ...VALID_CONFIG, apiPort: 0 } as z.infer<typeof configSchema>,
            createMockLogger()
          )
        ).toThrow(/SENSOR_TELEMETRY_RESTART_TOKEN/);
      } finally {
        process.env.SENSOR_TELEMETRY_RESTART_ENABLED = savedEnabled;
        process.env.SENSOR_TELEMETRY_RESTART_TOKEN = savedToken;
      }
    });

    it("treats an empty token as missing (fail-fast)", () => {
      const savedToken = process.env.SENSOR_TELEMETRY_RESTART_TOKEN;
      process.env.SENSOR_TELEMETRY_RESTART_TOKEN = "";
      try {
        expect(() =>
          new PrometheusWriter(
            { ...VALID_CONFIG, apiPort: 0 } as z.infer<typeof configSchema>,
            createMockLogger()
          )
        ).toThrow(/SENSOR_TELEMETRY_RESTART_TOKEN/);
      } finally {
        process.env.SENSOR_TELEMETRY_RESTART_TOKEN = savedToken;
      }
    });
  });
});
