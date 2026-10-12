/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import type { ILogger, IMqttNetworking } from "../../../src/dodsonlabs/Interfaces";
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
 * Stand-in for MqttNetworking: the only member the application metrics read
 * is is_connected() (the pull-model mqtt_client_connected gauge). The
 * remaining interface members exist so the fake is a faithful
 * IMqttNetworking and a future gauge that reads them cannot silently break.
 */
class FakeNetworking implements IMqttNetworking {
  connected = false;
  is_connected(): boolean {
    return this.connected;
  }
  subscriptions_active(): boolean {
    return false;
  }
  get_subscription_states(): Array<{ topic: string; active: boolean }> {
    return [];
  }
  async close(): Promise<void> {
    // no-op
  }
  prometheus_server_ready(): boolean {
    return true;
  }
}

/**
 * Read one series from Prometheus exposition text. Returns undefined when
 * the series is absent. The regex is anchored to the start of a line and
 * requires the value at the end of the line, so the `# HELP` / `# TYPE`
 * lines (which also contain the metric name) can never match, and a
 * no-label metric cannot be matched by a labeled series of the same name.
 */
function metricValue(
  text: string,
  name: string,
  labels?: Record<string, string>
): number | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelPart = labels
    ? `\\{${Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`)
        .join(",")}\\}`
    : "";
  const re = new RegExp(`^${escaped}${labelPart} (-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)$`, "m");
  const m = text.match(re);
  return m ? Number.parseFloat(m[1]) : undefined;
}

describe("PrometheusWriter application metrics", () => {
  // One writer for the whole file: prom-client registers metric names in a
  // global registry, so a second PrometheusWriter in the same process would
  // throw on duplicate names.
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let port: number;
  let configDir: string;
  let configSource: string;
  let networking: FakeNetworking;

  const baseConfig = {
    logLevel: "info",
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  beforeAll(async () => {
    // Endpoints must be reachable without a token for this test.
    delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;

    port = await getFreePort();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-writer-svc-test-"));
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
    await writer.close();
    fs.rmSync(configDir, { recursive: true, force: true });
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

  // The res "finish" event (which increments http_requests_total) fires on
  // the tick after the response flushes; the client observing the complete
  // response does not itself order after that tick. Poll the scrape until
  // the increment lands instead of assuming a single fixed sleep.
  async function untilMetric(
    labels: Record<string, string> | undefined,
    test: (value: number | undefined) => boolean,
    timeoutMs = 2000
  ): Promise<void> {
    const start = Date.now();
    for (;;) {
      const text = await getMetrics();
      if (test(metricValue(text, "http_requests_total", labels))) {
        return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for http_requests_total${JSON.stringify(labels)}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  describe("process gauges (pull model)", () => {
    it("exposes uptime, heap, and resident memory with finite, plausible values", async () => {
      const text = await getMetrics();

      const uptime = metricValue(text, "process_uptime_seconds");
      expect(uptime).toBeGreaterThan(0);

      const heapUsed = metricValue(text, "process_heap_used_bytes");
      expect(heapUsed).toBeGreaterThan(0);

      const heapTotal = metricValue(text, "process_heap_total_bytes");
      expect(heapTotal).toBeGreaterThanOrEqual(heapUsed!);

      const rss = metricValue(text, "process_resident_memory_bytes");
      expect(rss).toBeGreaterThan(heapUsed!);
    });

    it("exposes event-loop lag as a finite non-negative value", async () => {
      const text = await getMetrics();
      const lag = metricValue(text, "process_event_loop_lag_ms");
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(lag!)).toBe(true);
    });

    it("reports the process uptime it was started with a fresh process", async () => {
      // The writer was constructed at the top of this file's process; its
      // uptime must be at least the writer's own age within this process,
      // which is more than 0 and far less than a day.
      const text = await getMetrics();
      const uptime = metricValue(text, "process_uptime_seconds");
      expect(uptime).toBeLessThan(86400);
    });
  });

  describe("mqtt_client_connected (pull model)", () => {
    it("reports 0 when no networking is attached", async () => {
      // Unlike the topic-labeled mqtt_subscription_active gauge (a labeled
      // gauge has no series until .set() is called), this gauge is
      // unlabeled, so prom-client always exposes a series — 0, which is
      // the correct state: no client attached means not connected.
      const text = await getMetrics();
      expect(metricValue(text, "mqtt_client_connected")).toBe(0);
    });

    it("reflects the networking's connection state at scrape time", async () => {
      networking = new FakeNetworking();
      writer.setMqttNetworking(networking);

      const offline = await getMetrics();
      expect(metricValue(offline, "mqtt_client_connected")).toBe(0);

      // Pull model: the flip is picked up on the NEXT scrape without any
      // push — no reconnect event, no callback, no timer.
      networking.connected = true;
      const online = await getMetrics();
      expect(metricValue(online, "mqtt_client_connected")).toBe(1);
    });
  });

  describe("http_requests_total", () => {
    it("counts a /health request with its path and status", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Connection: "close" },
      });
      expect(res.status).toBe(200);
      await res.text();

      await untilMetric({ path: "/health", status: "200" }, (v) => v !== undefined && v >= 1);
    });

    it("counts an unknown route as path=\"unknown\" with a 404", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/definitely-not-a-route`, {
        headers: { Connection: "close" },
      });
      expect(res.status).toBe(404);
      await res.text();

      await untilMetric({ path: "unknown", status: "404" }, (v) => v !== undefined && v >= 1);
    });

    it("counts a CORS preflight with a 204", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "OPTIONS",
        headers: { Connection: "close" },
      });
      expect(res.status).toBe(204);
      await res.text();

      await untilMetric({ path: "/health", status: "204" }, (v) => v !== undefined && v >= 1);
    });

    it("never exposes an untrusted request path as a label value", async () => {
      // A path crafted to look like the start of a second label must land
      // in the "unknown" bucket, exactly like the 404 above. The quote and
      // equals are percent-encoded (undici rejects raw control characters
      // and %2F in the URL, but accepts these in the path segment); the
      // server still sees a path that is not one of the fixed routes.
      const res = await fetch(`http://127.0.0.1:${port}/health%22status%3D%22999`, {
        headers: { Connection: "close" },
      });
      expect(res.status).toBe(404);
      await res.text();

      const text = await getMetrics();
      // The crafted label shape must not exist as its own series.
      expect(text).not.toMatch('http_requests_total\{path="/health" status="999');
      // The request was counted, under the fixed "unknown" bucket.
      await untilMetric({ path: "unknown", status: "404" }, (v) => v !== undefined && v >= 2);
    });
  });

  describe("mqtt pipeline and connection counters (push model)", () => {
    it("start at zero before any event", async () => {
      const text = await getMetrics();
      // Unlabeled counters expose a 0 series from construction; labeled
      // counters have no series until the first .inc() for that label set.
      expect(metricValue(text, "mqtt_messages_received_total")).toBe(0);
      expect(metricValue(text, "mqtt_reconnects_total")).toBe(0);
      expect(metricValue(text, "mqtt_connection_errors_total", { kind: "connection" })).toBeUndefined();
      expect(metricValue(text, "mqtt_connection_errors_total", { kind: "client" })).toBeUndefined();
    });

    it("increments via the writer's record_* methods", async () => {
      writer.record_mqtt_message_received();
      writer.record_mqtt_message_received();
      writer.record_mqtt_message_received();
      writer.record_mqtt_message_dropped("payload_too_large");
      writer.record_mqtt_message_dropped("parse_error");
      writer.record_mqtt_message_dropped("parse_error");
      writer.record_mqtt_connection_error("connection");
      writer.record_mqtt_connection_error("client");
      writer.record_mqtt_reconnect();

      const text = await getMetrics();
      expect(metricValue(text, "mqtt_messages_received_total")).toBe(3);
      expect(metricValue(text, "mqtt_messages_dropped_total", { reason: "payload_too_large" })).toBe(1);
      expect(metricValue(text, "mqtt_messages_dropped_total", { reason: "parse_error" })).toBe(2);
      expect(metricValue(text, "mqtt_connection_errors_total", { kind: "connection" })).toBe(1);
      expect(metricValue(text, "mqtt_connection_errors_total", { kind: "client" })).toBe(1);
      expect(metricValue(text, "mqtt_reconnects_total")).toBe(1);
    });
  });
});
