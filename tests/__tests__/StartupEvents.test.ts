/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

// Regression coverage for P3-1 (startup MQTT event ownership). index.ts used
// to log `mqtt_subscription_started` the moment the Prometheus/HTTP server
// reported ready — but HTTP readiness proves nothing about MQTT. With the
// broker unavailable the client is still in its reconnect loop when that log
// fires, so the structured event announced a subscription that had not been
// attempted, contradicting /ready (mqtt: disconnected) and the
// mqtt_subscription_active gauge. The event is owned by
// MqttNetworking.on_connect(), which emits it per topic immediately before
// the subscribe() call that actually starts the subscription.
//
// The unit tests cannot exercise index.ts's startup logging directly: it is
// an IIFE that ends in process.exit, and the decision being pinned is the
// ABSENCE of a log call, not extractable logic. So this suite runs the real
// entrypoint as a subprocess with the finding's exact scenario — valid HTTP
// configuration, unavailable MQTT broker — and asserts on the structured log
// lines it emits:
//   application_started          → may occur
//   mqtt_subscription_started    → must NOT occur (no on_connect has run)
// logLevel is set to debug in the child config so even the debug-level
// on_connect subscription events would surface here if the broker were ever
// reached — the negative assertion cannot pass because the event is below
// the log level.
//
// The broker is 127.0.0.1:1 (a closed local port → immediate ECONNREFUSED).
// The suite additionally asserts a connection-failure event was observed,
// which proves the broker really was unreachable: if the child were ever
// able to connect (e.g. a broker appeared on that port), the subscription
// event would legitimately appear and the negative assertion must not be
// treated as a pass — it would fail, loudly, instead.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENTRY_TS = path.join(REPO_ROOT, "src", "index.ts");
const TSCONFIG = path.join(REPO_ROOT, "tsconfig.json");
const TS_NODE_BIN = path.join(REPO_ROOT, "node_modules", "ts-node", "dist", "bin.js");

// ts-node's first compile of the src/ closure plus startup can take a while
// on a cold cache; the rest of the waits are short.
const STARTUP_TIMEOUT_MS = 90_000;
// The (removed) false event was logged synchronously right after
// application_started, so a short settle window after it is more than enough
// to catch any reintroduction.
const SETTLE_MS = 1_500;
const SHUTDOWN_TIMEOUT_MS = 15_000;

interface LogRecord {
  [key: string]: unknown;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(addr !== null ? (addr as net.AddressInfo).port : 0));
    });
  });
}

describe("startup MQTT lifecycle events (regression P3-1)", () => {
  jest.setTimeout(STARTUP_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS + 30_000);

  let tmpDir = "";
  let child: ChildProcess | null = null;
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  const records: LogRecord[] = [];

  function output(): string {
    return `--- exit: ${exitCode} ---\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
  }

  async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) {
        return;
      }
      // The child exiting before the expected event is an immediate failure,
      // not a timeout: report the captured output and stop waiting.
      if (exitCode !== null) {
        throw new Error(`child exited (code ${exitCode}) before ${what}\n${output()}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}\n${output()}`);
  }

  beforeAll(async () => {
    const apiPort = await getFreePort();

    // The child's cwd is a private temp dir, so the ./config.yml candidate
    // (CONFIG_FILE_CANDIDATES) resolves to THIS config — free HTTP port,
    // unreachable broker — rather than the repo's config.yml.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-telemetry-startup-"));
    fs.writeFileSync(
      path.join(tmpDir, "config.yml"),
      [
        "logLevel: debug",
        `apiPort: ${apiPort}`,
        "mqttBrokerIpAddress: 127.0.0.1:1",
        "mqttTopicTelemetry: iot/v3/telemetry",
        "sensorSourceMaxLength: 30",
        "sensorSourceValidCharsRegex: a-zA-Z0-9._-",
        "",
      ].join("\n")
    );

    const env = { ...process.env };
    // Determinism: never inherit config-token or CORS allowlist state.
    delete env.SENSOR_TELEMETRY_CONFIG_TOKEN;
    delete env.SENSOR_TELEMETRY_CORS_ORIGINS;

    child = spawn(
      process.execPath,
      [TS_NODE_BIN, "--transpile-only", "--project", TSCONFIG, ENTRY_TS],
      { cwd: tmpDir, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let lineBuffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Only complete lines from the new chunk are parsed; a line split
      // across chunks stays in lineBuffer until its newline arrives.
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          continue;
        }
        try {
          records.push(JSON.parse(line) as LogRecord);
        } catch {
          // Not a structured log line (e.g. a non-JSON warning) — ignore it.
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      exitCode = code;
    });
  });

  afterAll(() => {
    if (child && exitCode === null) {
      child.kill("SIGKILL");
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads its own config and completes startup without announcing the MQTT subscription", async () => {
    // Startup completes: the HTTP server is up and application_started fired.
    await waitFor(
      () => records.some((r) => r.event === "application_started"),
      STARTUP_TIMEOUT_MS,
      "application_started"
    );

    // The child must have loaded the temp-dir config (source is the
    // candidate path as read): if the wrong config won (e.g. an /app mount
    // on this host), the broker/port assumptions below no longer hold.
    const loaded = records.find((r) => r.event === "configuration_loaded");
    expect(loaded).toBeDefined();
    expect(loaded?.source).toBe("./config.yml");

    // Let any (reintroduced) false event — which would be logged
    // synchronously right after application_started — arrive.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // The broker really is unreachable: the client attempted to connect and
    // failed. This is what makes the negative assertion below meaningful
    // rather than a vacuous pass.
    expect(
      records.some(
        (r) => r.event === "mqtt_connection_error" || r.event === "mqtt_reconnect_failed"
      )
    ).toBe(true);

    // The regression: with no on_connect, no subscription has started, so
    // the subscription event must not exist — at any level (the child logs
    // at debug, so the on_connect debug events would surface if reached).
    expect(
      records.filter((r) => r.event === "mqtt_subscription_started")
    ).toHaveLength(0);
  });

  it("still shuts down gracefully when stopped with MQTT never connected", async () => {
    // application_started is already observed by the previous test.
    expect(records.some((r) => r.event === "application_started")).toBe(true);

    child?.kill("SIGTERM");
    await waitFor(() => exitCode !== null, SHUTDOWN_TIMEOUT_MS, "child exit after SIGTERM");

    // The completion record is logged just before process.exit, but the
    // stdout pipe can deliver its last chunk after the 'exit' event — wait
    // for the record rather than asserting on the pipe's delivery timing.
    await waitFor(
      () => records.some((r) => r.event === "graceful_shutdown_completed"),
      5_000,
      "graceful_shutdown_completed"
    );

    // An operator stop is a clean stop (exit 0), not a crash (exit 1) —
    // the removed log line must not have disturbed the startup/shutdown
    // path's exit-code ownership.
    expect(exitCode).toBe(0);
  });
});
