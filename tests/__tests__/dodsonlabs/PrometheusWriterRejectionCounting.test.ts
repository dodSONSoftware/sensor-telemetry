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

/** Number of series the counter carries (must stay label-free: 1). */
async function counterSeriesCount(metricName: string): Promise<number> {
  const metric = register.getSingleMetric(metricName);
  if (!metric) {
    throw new Error(`${metricName} is not registered`);
  }
  const { values } = (await metric.get()) as unknown as { values: unknown[] };
  return values.length;
}

describe("PrometheusWriter rejection counting (sensor_sources_rejected_total, regression P3-1)", () => {
  // One writer per file (prom-client global registry); the tests share
  // admission state and assert cumulatively, in declaration order.
  const CAP = 3;
  const REJECTION_BOUND = CAP * 4; // the writer clears the dedup set at this size
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;

  function commitConfig(patch: Record<string, unknown>): void {
    const internals = writer as unknown as {
      config: z.infer<typeof configSchema>;
      applyStaleSourceRemoval(): void;
    };
    internals.config = { ...internals.config, ...patch } as z.infer<typeof configSchema>;
    internals.applyStaleSourceRemoval();
  }

  function airPayload(tempC: number) {
    return { air: { temperature_c: tempC, humidity_percent: 50 } };
  }

  /**
   * The full V3 health fan-out: one health message resolves the source
   * label once PER HEALTH GAUGE (17 setters), so a rejected source used to
   * count 17 times per message. This is the unit the counter must count
   * exactly once.
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

  it("admits up to the cap with zero rejections", async () => {
    for (const source of ["alpha", "beta", "gamma"]) {
      writer.publish_air(airPayload(20), source, "fw-x");
    }
    expect(await counterValue("sensor_sources_rejected_total")).toBe(0);
    // The counter must stay label-free (a source label here would itself
    // be an unbounded-cardinality defect).
    expect(await counterSeriesCount("sensor_sources_rejected_total")).toBe(1);
  });

  it("counts one full health message from a rejected source as exactly one rejection", async () => {
    // 17 setter calls — 17 label resolutions — one logical event.
    healthMessage("overflow-src");
    expect(await counterValue("sensor_sources_rejected_total")).toBe(1);
    // Repeated health messages while still rejected do not re-count.
    for (let i = 0; i < 5; i++) {
      healthMessage("overflow-src");
    }
    expect(await counterValue("sensor_sources_rejected_total")).toBe(1);
  });

  it("counts each DISTINCT rejected source as its own rejection", async () => {
    healthMessage("overflow-other");
    // A telemetry publish from the same rejected source adds nothing.
    writer.publish_air(airPayload(21), "overflow-other", "fw-x");
    expect(await counterValue("sensor_sources_rejected_total")).toBe(2);
  });

  it("counts a re-rejection again once the source was admitted in between (episode restart)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    // 3600/2 = 30 min, clamped to the 60s ceiling.
    commitConfig({ staleSourceRemovalSecs: 3600 });
    try {
      // Empty the cap so the rejected source can be admitted: admission
      // ends its rejection episode WITHOUT counting.
      writer.mark_source_seen("alpha");
      writer.mark_source_seen("beta");
      writer.mark_source_seen("gamma");
      jest.advanceTimersByTime(3_600_000 + 60_000);

      healthMessage("overflow-src");
      expect(await counterValue("sensor_sources_rejected_total")).toBe(2);

      // Fill the cap with fresh sources, then evict overflow-src so the
      // cap is full again WITHOUT it.
      writer.publish_air(airPayload(20), "delta", "fw-x");
      writer.publish_air(airPayload(20), "epsilon", "fw-x");
      writer.mark_source_seen("overflow-src");
      jest.advanceTimersByTime(3_600_000 + 60_000);
      writer.publish_air(airPayload(20), "zeta", "fw-x");

      // A fresh rejection episode: the count increments once more.
      healthMessage("overflow-src");
      expect(await counterValue("sensor_sources_rejected_total")).toBe(3);
      // And a follow-up message in the new episode stays at 3.
      healthMessage("overflow-src");
      expect(await counterValue("sensor_sources_rejected_total")).toBe(3);
    } finally {
      commitConfig({ staleSourceRemovalSecs: 0 });
      jest.useRealTimers();
    }
  });

  it("keeps the dedup set bounded: past 4× the cap it clears and a source may count again", async () => {
    const before = await counterValue("sensor_sources_rejected_total");
    // The two distinct rejections from the earlier tests leave the dedup
    // set at size 2, so churn-0..churn-9 grow it to REJECTION_BOUND and
    // churn-10 trips the clear. Every churn source still counts exactly
    // once in the batch (REJECTION_BOUND total increments).
    for (let i = 0; i < REJECTION_BOUND; i++) {
      writer.publish_air(airPayload(20), `churn-${i}`, "fw-x");
    }
    expect(await counterValue("sensor_sources_rejected_total")).toBe(before + REJECTION_BOUND);
    // After the clear, churn-0 is no longer tracked and counts again.
    writer.publish_air(airPayload(20), "churn-0", "fw-x");
    expect(await counterValue("sensor_sources_rejected_total")).toBe(before + REJECTION_BOUND + 1);
  });
});
