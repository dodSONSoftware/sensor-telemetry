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

async function counterValue(metricName: string): Promise<number> {
  const metric = register.getSingleMetric(metricName);
  if (!metric) {
    throw new Error(`${metricName} is not registered`);
  }
  const { values } = (await metric.get()) as unknown as {
    values: Array<{ value: number }>;
  };
  return values.reduce((sum, entry) => sum + entry.value, 0);
}

/** Collision warnings, as structured metadata. */
function collisionWarnings(logger: MockLogger): Array<Record<string, unknown>> {
  return logger.write_warn.mock.calls
    .map((call) => call[2] as Record<string, unknown> | undefined)
    .filter((meta): meta is Record<string, unknown> => meta?.event === "sensor_source_collision");
}

describe("PrometheusWriter collision warning for cap-rejected sources (regression P3-1)", () => {
  // One writer per file (prom-client global registry); the cap is captured
  // at construction, so a CAP = 1 regression needs its own file. The tests
  // share admission state and assert cumulatively, in declaration order.
  //
  // A cap-rejected source never receives a sourceLabelOwnership entry (the
  // map's bounded-ownership invariant — only admitted labels are claimed),
  // so ownership alone cannot dedupe its collision warning: every one of
  // the 17 per-gauge label resolutions in a health message re-fired the
  // WARN. The warning now dedupes through the same rejection-episode set
  // (rejectedSources) as the rejection counter, so the expected behavior
  // is exactly one collision WARN per rejected source per episode.
  const CAP = 1;
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;

  function airPayload(tempC: number) {
    return { air: { temperature_c: tempC, humidity_percent: 50 } };
  }

  /**
   * The full V3 health fan-out: one health message resolves the source
   * label once PER HEALTH GAUGE (17 setters), so a rejected colliding
   * source used to emit the collision warning 17 times per message.
   */
  function healthMessage(source: string): void {
    writer.set_cpu_temp(source, 55);
    writer.set_heap_free_bytes(source, 1_000_000);
    writer.set_wifi_rssi_dbm(source, -50);
    writer.set_health_up(source, 1);
    writer.set_uptime_seconds(source, 3_600);
    writer.set_min_heap_free_bytes(source, 900_000);
    writer.set_devices_active(source, 3);
    writer.set_devices_configured(source, 4);
    writer.set_network_stack_ready(source, 1);
    writer.set_wifi_connected(source, 1);
    writer.set_mqtt_connected(source, 1);
    writer.set_core_1_active(source, 1);
    writer.set_outbound_queue_depth(source, 0);
    writer.set_outbound_evicted(source, 0);
    writer.set_outbound_rejected(source, 0);
    writer.set_utc_valid(source, 1);
    writer.set_utc_sync_age_sec(source, 120);
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

  it("admits the first colliding source to the plain label without a collision warning", async () => {
    writer.publish_air(airPayload(20), "soil@1", "fw-x");
    expect(await seriesSources("air_temperature")).toEqual(["soil1"]);
    expect(collisionWarnings(logger)).toHaveLength(0);
  });

  it("warns exactly once when one health message from a colliding source is rejected by the cap", async () => {
    // 17 setter calls — 17 label resolutions of the same rejected source.
    healthMessage("soil#1");

    // The collision was detected and the source rejected to the fallback
    // label: the health series live under unknown_source, and the
    // disambiguated identity never materializes as a series.
    expect(await seriesSources("sensor_health_up")).toEqual(["unknown_source"]);
    expect(await seriesSources("air_temperature")).toEqual(["soil1"]);

    // ... with EXACTLY ONE collision warning, not one per setter ...
    const warns = collisionWarnings(logger);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      originalSource: "soil#1",
      sanitizedSource: "soil1",
    });
    expect(warns[0].finalLabel).toMatch(/^soil1-[0-9a-f]{8}$/);
    // ... and the rejection counter counts the same logical event once.
    expect(await counterValue("sensor_sources_rejected_total")).toBe(1);
  });

  it("does not re-warn for the same rejected source on subsequent messages (rejection-episode policy)", async () => {
    // Further health messages, plus a telemetry publish from the same
    // rejected raw source: the episode is unchanged, so no new warnings
    // and no new counter increments.
    for (let i = 0; i < 3; i++) {
      healthMessage("soil#1");
    }
    writer.publish_air(airPayload(25), "soil#1", "fw-x");
    expect(collisionWarnings(logger)).toHaveLength(1);
    expect(await counterValue("sensor_sources_rejected_total")).toBe(1);
    // The rejected source still never mints a series of its own: its
    // telemetry lands on the shared fallback label, no disambiguated
    // identity appears.
    expect(await seriesSources("air_temperature")).toEqual([
      "soil1",
      "unknown_source",
    ]);
  });

  it("still warns once on first sighting of a DIFFERENT rejected colliding source", async () => {
    // "soil+1" sanitizes to the same "soil1" but is a distinct raw source
    // with its own disambiguated label: dedup is per disambiguated label,
    // not a global latch, so this identity gets its own single warning.
    healthMessage("soil+1");
    const warns = collisionWarnings(logger);
    expect(warns).toHaveLength(2);
    expect(warns[1]).toMatchObject({
      originalSource: "soil+1",
      sanitizedSource: "soil1",
    });
    expect(warns[1].finalLabel).toMatch(/^soil1-[0-9a-f]{8}$/);
    expect(warns[1].finalLabel).not.toBe(warns[0].finalLabel);
    expect(await counterValue("sensor_sources_rejected_total")).toBe(2);
    // ... and repeats of it stay quiet.
    healthMessage("soil+1");
    expect(collisionWarnings(logger)).toHaveLength(2);
    expect(await counterValue("sensor_sources_rejected_total")).toBe(2);
  });
});
