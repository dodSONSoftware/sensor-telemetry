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

// This file constructs its writer with a VALID RESTART_SERVICE_TOKEN but
// WITHOUT a shutdown hook (standalone construction — index.ts always
// injects one, so this is a miswiring, not a deployment state), so it
// needs its own file: the hook is fixed at construction, and prom-client's
// global registry allows only one real writer per process.
//
// The contract under test is the SECOND half of the fail-closed check:
// either half missing — no validated token, or no injected hook — answers
// the SAME byte-identical 503, so the response cannot probe which half a
// deployment lacks. The companion PrometheusWriterRestartDisabled suite
// (token unset/empty, hook present) asserts the same literal against its
// own writer, proving the byte-identity across halves without sharing
// state across Jest module sandboxes. A restart is never represented as
// scheduled: the acceptance audit must not fire, and the single-flight
// guard is never set (no 409 can follow).

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

// Must satisfy the shared token validity rule (at least 32 alphanumeric
// characters): the whole point of this file is a VALID token with the
// shutdown hook missing, not an invalid token.
const RESTART_TOKEN = "restartnocb0123456789abcdef0123456789abcdef";
// The EXACT wire bytes of the disabled response — the same literal the
// PrometheusWriterRestartDisabled suite asserts (see the file header).
const DISABLED_503_BODY = '{"success":false,"message":"Restart endpoint is disabled."}';
const VALID_CONFIG = {
  logLevel: "info",
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("PrometheusWriter with a valid token but no shutdown hook", () => {
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let port: number;
  let configSource: string;
  let savedRestartToken: string | undefined;

  beforeAll(async () => {
    savedRestartToken = process.env.RESTART_SERVICE_TOKEN;
    process.env.RESTART_SERVICE_TOKEN = RESTART_TOKEN;

    port = await getFreePort();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-restart-nocb-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    // No fifth constructor argument: no shutdown hook.
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
    if (savedRestartToken === undefined) {
      delete process.env.RESTART_SERVICE_TOKEN;
    } else {
      process.env.RESTART_SERVICE_TOKEN = savedRestartToken;
    }
  });

  it("answers the exact disabled 503 bytes with an authenticated POST — never 202, never 409, never 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        Authorization: `Bearer ${RESTART_TOKEN}`,
      },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    // Byte-identical to the missing-token half (the Disabled suite): a
    // valid token cannot reveal that the missing half is the hook.
    expect(text).toBe(DISABLED_503_BODY);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The disabled probe is audited (throttled), and the acceptance
    // audit (which would assert a scheduled restart) must NOT have fired.
    expect(
      logger.write_warn.mock.calls.some((c) => c[2]?.event === "restart_disabled")
    ).toBe(true);
    expect(
      logger.write_info.mock.calls.some((c) => c[2]?.event === "service_restart_requested")
    ).toBe(false);
  });

  it("answers the same 503 bytes unauthenticated (the half-check precedes auth)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: { Connection: "close" },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toBe(DISABLED_503_BODY);
  });

  it("still answers 503 on a repeat (the guard was never set, so no 409)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/restart-service`, {
      method: "POST",
      headers: {
        Connection: "close",
        Authorization: `Bearer ${RESTART_TOKEN}`,
      },
    });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toBe(DISABLED_503_BODY);
  });
});
