/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import net from "net";
import { register } from "prom-client";
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

/** All source labels currently present on a metric's series, sorted. */
async function seriesSources(metricName: string): Promise<string[]> {
  const metric = register.getSingleMetric(metricName);
  if (!metric) {
    throw new Error(`${metricName} is not registered`);
  }
  const { values } = (await metric.get()) as unknown as {
    values: Array<{ labels: Record<string, string> }>;
  };
  return values.map((entry) => entry.labels.source).sort();
}

/** One source's value for a metric, or undefined when the series is absent. */
async function seriesValue(metricName: string, source: string): Promise<number | undefined> {
  const metric = register.getSingleMetric(metricName);
  if (!metric) {
    throw new Error(`${metricName} is not registered`);
  }
  const { values } = (await metric.get()) as unknown as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return values.find((entry) => entry.labels.source === source)?.value;
}

/** The current sensor_sources_rejected_total counter value. */
async function rejectionCounter(): Promise<number> {
  const metric = register.getSingleMetric("sensor_sources_rejected_total");
  if (!metric) {
    throw new Error("sensor_sources_rejected_total is not registered");
  }
  const { values } = (await metric.get()) as unknown as {
    values: Array<{ value: number }>;
  };
  return values.reduce((sum, entry) => sum + entry.value, 0);
}

describe("PrometheusWriter shared fallback source identity (regression P2)", () => {
  // One writer for the whole file (prom-client's global registry forbids a
  // second per process), with a deliberately small concrete-source cap so
  // saturation is reachable. The tests share admission state and assert
  // cumulatively, in declaration order.
  const CAP = 2;
  const BLANK = "###"; // strips to nothing under the default charset
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;

  function airPayload(tempC: number) {
    return { air: { temperature_c: tempC, humidity_percent: 50 } };
  }

  beforeAll(async () => {
    const port = await getFreePort();
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
    await new Promise<void>((resolve) => {
      if (writer.is_ready()) {
        resolve();
      } else {
        const check = setInterval(() => {
          if (writer.is_ready()) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      }
    });
  });

  afterAll(async () => {
    writer.close();
    await new Promise<void>((resolve) => {
      if (!writer.is_ready()) {
        resolve();
      } else {
        const check = setInterval(() => {
          if (!writer.is_ready()) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      }
    });
  });

  it("keeps the blank source on 'unknown' and admits the full concrete cap around it", async () => {
    // The blank source is observed FIRST, with the cap empty. If the shared
    // fallback consumed a concrete-source slot, one of the two concrete
    // sources below would already overflow to unknown_source.
    writer.publish_air(airPayload(20), BLANK, "fw-x");
    writer.publish_air(airPayload(21), "cap-a", "fw-x");
    writer.publish_air(airPayload(22), "cap-b", "fw-x");

    const sources = await seriesSources("air_temperature");
    // All three identities present: the blank keeps the bare fallback
    // label, and BOTH concrete slots were admitted.
    expect(sources).toEqual(["cap-a", "cap-b", "unknown"]);
    expect(await seriesValue("air_temperature", "unknown")).toBe(68); // 20C
    expect(await seriesValue("air_temperature", "cap-a")).toBe(69.8); // 21C
    expect(await seriesValue("air_temperature", "cap-b")).toBe(71.6); // 22C
    // The fallback consumed nothing: no concrete source was rejected.
    expect(await rejectionCounter()).toBe(0);
  });

  it("keeps the blank source on 'unknown' after the concrete cap saturates", async () => {
    // The concrete cap is full (cap-a, cap-b). Pre-fix, re-observing the
    // blank source here resolved from "unknown" to "unknown_source" (the
    // cap-full rejection branch), splitting its telemetry and freshness
    // series across two Prometheus identities.
    for (let i = 0; i < 3; i++) {
      writer.publish_air(airPayload(20), BLANK, "fw-x");
      writer.publish_air(airPayload(24), "unknown-adjacent-" + i, "fw-x");
    }

    const sources = await seriesSources("air_temperature");
    // The blank source is still on the bare fallback label, and its value
    // was overwritten by its own later messages — never split.
    expect(sources).toContain("unknown");
    expect(await seriesValue("air_temperature", "unknown")).toBe(68); // 20C
    // The concrete overflow sources took the reserved label, as designed —
    // exactly two bare fallback labels, no third minted identity.
    expect(sources.filter((label) => /^unknown_source$|^unknown$/.test(label)))
      .toEqual(["unknown", "unknown_source"]);
    expect(sources).not.toContain(BLANK);
    // Three distinct concrete sources were rejected (one per "i").
    expect(await rejectionCounter()).toBe(3);
  });

  it("keeps telemetry and freshness identity consistent for the blank source", async () => {
    // The freshness stamp must use the same source identity as the
    // telemetry gauges: both on "unknown", and the stamp must not mint an
    // "unknown_source" series for the blank source.
    writer.mark_source_seen(BLANK);

    const seenSources = await seriesSources("sensor_last_seen_timestamp_seconds");
    expect(seenSources).toContain("unknown");
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "unknown")).toBeDefined();
    // Only the blank source has been marked seen in this file.
    expect(seenSources).toEqual(["unknown"]);
    // Marking seen does not reject or count anything.
    expect(await rejectionCounter()).toBe(3);
  });

  it("does not increment the rejection counter for the blank source while the cap is full", async () => {
    // The blank source is reprocessed through several setter paths (the
    // shape of one V3 health message) with the concrete cap saturated:
    // every resolution must stay on "unknown" and none may count as a
    // rejected concrete source.
    const before = await rejectionCounter();
    writer.set_cpu_temp(BLANK, 50);
    writer.set_heap_free_bytes(BLANK, 1_000_000);
    writer.set_wifi_rssi_dbm(BLANK, -50);
    writer.set_health_up(BLANK, 1);
    writer.mark_source_seen(BLANK);

    expect(await rejectionCounter()).toBe(before);
    // And the health gauges landed on the same "unknown" identity.
    expect(await seriesValue("sensor_health_cpu_temperature_c", "unknown")).toBe(50);
    expect(await seriesValue("sensor_health_heap_free_bytes", "unknown")).toBe(1_000_000);
  });
});
