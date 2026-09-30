/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import net from "net";
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

interface Series {
  labels: Record<string, string>;
  value: number;
}

/**
 * Extract the series for one metric name from scraped /metrics text.
 * Matches both `name{label="v",...} 1` and the unlabeled `name 1` form;
 * the name anchor plus trailing value keep same-prefix metrics
 * (e.g. air_temperature vs air_temperature_total) from colliding.
 */
function seriesFor(name: string, text: string): Series[] {
  const out: Series[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line === "") continue;
    const labeled = line.match(new RegExp(`^${name}\\{([^}]*)\\}\\s+([0-9eE+.-]+)$`));
    const unlabeled = labeled
      ? null
      : line.match(new RegExp(`^${name}\\s+([0-9eE+.-]+)$`));
    const match = labeled ?? unlabeled;
    if (!match) continue;
    const labels: Record<string, string> = {};
    if (labeled) {
      for (const pair of labeled[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[pair[1]] = pair[2];
      }
    }
    out.push({ labels, value: Number(match[match.length - 1]) });
  }
  return out;
}

function labelValues(metric: string, label: string, text: string): Set<string> {
  return new Set(seriesFor(metric, text).map((s) => s.labels[label]).filter((v) => v !== undefined));
}

function counterValue(name: string, text: string): number {
  const series = seriesFor(name, text);
  return series.length === 0 ? 0 : series.reduce((sum, s) => sum + s.value, 0);
}

describe("PrometheusWriter label cardinality cap", () => {
  // One writer for the whole file: prom-client registers metric names in a
  // global registry, so a second PrometheusWriter in the same process would
  // throw on duplicate names. The tests below therefore share admission
  // state and assert cumulatively, in declaration order.
  const CAP = 3;
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let port: number;

  beforeAll(async () => {
    port = await getFreePort();
    logger = createMockLogger();
    writer = new PrometheusWriter(
      {
        logLevel: "info",
        mqttBrokerIpAddress: "10.0.0.1",
        mqttTopicTelemetry: "iot/v3/telemetry",
        apiPort: port,
        sensorSourceCardinalityCap: CAP,
      } as z.infer<typeof configSchema>,
      logger
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

  function airPayload() {
    return { air: { temperature_c: 20, humidity_percent: 50 } };
  }

  it("admits distinct sources up to the cap without rejection", async () => {
    for (const source of ["alpha", "beta", "gamma"]) {
      writer.publish_air(airPayload(), source, "fw-base");
    }
    const metrics = await getMetrics();
    expect(labelValues("air_temperature", "source", metrics)).toEqual(
      new Set(["alpha", "beta", "gamma"])
    );
    expect(counterValue("sensor_sources_rejected_total", metrics)).toBe(0);
  });

  it("maps sources beyond the cap to the fallback label and counts rejections", async () => {
    writer.publish_air(airPayload(), "overflow-1", "fw-base");
    writer.publish_air(airPayload(), "overflow-2", "fw-base");
    const metrics = await getMetrics();
    // The three admitted sources plus one fallback label — the overflow
    // sources themselves never appear as label values.
    expect(labelValues("air_temperature", "source", metrics)).toEqual(
      new Set(["alpha", "beta", "gamma", "unknown_source"])
    );
    expect(counterValue("sensor_sources_rejected_total", metrics)).toBe(2);
  });

  it("maps every overflow source to the same fallback label", async () => {
    writer.publish_air(airPayload(), "overflow-3", "fw-base");
    const metrics = await getMetrics();
    // A third, different overflow source must not mint a new series: the
    // distinct label count is still cap + one fallback.
    expect(labelValues("air_temperature", "source", metrics)).toEqual(
      new Set(["alpha", "beta", "gamma", "unknown_source"])
    );
    expect(counterValue("sensor_sources_rejected_total", metrics)).toBe(3);
    // Re-publishing an admitted source stays admitted (no new series, no
    // extra rejection).
    writer.publish_air(airPayload(), "alpha", "fw-base");
    const after = await getMetrics();
    expect(labelValues("air_temperature", "source", after)).toEqual(
      new Set(["alpha", "beta", "gamma", "unknown_source"])
    );
    expect(counterValue("sensor_sources_rejected_total", after)).toBe(3);
  });

  it("caps firmware_version values admitted for the telemetry counter", async () => {
    // Firmware admission is applied in MqttNetworking.getFirmwareVersion
    // before the value reaches the counter label (the wiring is covered by
    // the MqttNetworking routing tests); this covers the admission contract
    // itself, with CAP = 3.
    // First admissions: the three distinct valid values fill the cap, and
    // each overflow value (counted once per admission) takes the fallback.
    const admitted = new Map<string, string>();
    for (const raw of ["!!!", "fw-1", "fw-2", "fw-3", "fw-4"]) {
      admitted.set(raw, writer.admitFirmwareVersion(raw));
    }
    expect(admitted.get("!!!")).toBe("unknown"); // 1 of CAP
    expect(admitted.get("fw-1")).toBe("fw-1"); // 2 of CAP
    expect(admitted.get("fw-2")).toBe("fw-2"); // 3 of CAP
    expect(admitted.get("fw-3")).toBe("unknown_firmware");
    expect(admitted.get("fw-4")).toBe("unknown_firmware");
    // Re-admitting an admitted value stays admitted even with the cap full.
    expect(writer.admitFirmwareVersion("fw-1")).toBe("fw-1");

    // Publish through the already-admitted values the way the real path
    // does, so the counter labels show the cap end-to-end.
    for (const value of admitted.values()) {
      writer.publish_air(airPayload(), "alpha", value);
    }
    const metrics = await getMetrics();
    // "fw-base" comes from the earlier source tests; the overflow values
    // (fw-3, fw-4) appear only under the shared fallback label.
    expect(labelValues("telemetry_messages_total", "firmware_version", metrics)).toEqual(
      new Set(["fw-base", "unknown", "fw-1", "fw-2", "unknown_firmware"])
    );
    expect(counterValue("sensor_firmware_versions_rejected_total", metrics)).toBe(2);
  });
});
