/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
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

/**
 * The 27 per-source gauges the sweep is allowed to remove (9 readings +
 * 17 sensor_health_* + the last-seen timestamp). Mirrors
 * PrometheusWriter.prometheus_SourceDataGauges by metric name so the test
 * fails if the writer's eviction list drifts.
 */
const DATA_METRIC_NAMES = [
  "air_temperature",
  "air_humidity",
  "air_pressure",
  "air_altitude_ft",
  "light_uv_index",
  "light_lux",
  "water_temperature",
  "soil_moisture_percent",
  "soil_moisture_raw",
  "sensor_health_cpu_temperature_c",
  "sensor_health_heap_free_bytes",
  "sensor_health_wifi_rssi_dbm",
  "sensor_health_up",
  "sensor_health_uptime_seconds",
  "sensor_health_heap_min_free_bytes",
  "sensor_health_devices_active",
  "sensor_health_devices_configured",
  "sensor_health_network_stack_ready",
  "sensor_health_wifi_connected",
  "sensor_health_mqtt_connected",
  "sensor_health_core_1_active",
  "sensor_health_outbound_queue_depth",
  "sensor_health_outbound_evicted",
  "sensor_health_outbound_rejected",
  "sensor_health_utc_valid",
  "sensor_health_utc_sync_age_sec",
  "sensor_last_seen_timestamp_seconds",
];

/**
 * Read one source's value for a metric straight from prom-client's global
 * registry (the same one the shared writer writes to) instead of scraping
 * /metrics: this file runs on fake timers, where the HTTP request would
 * need real timers to complete.
 */
async function seriesValue(metricName: string, source: string): Promise<number | undefined> {
  const metric = register.getSingleMetric(metricName);
  if (!metric) {
    throw new Error(`${metricName} is not registered`);
  }
  // Gauge.get() resolves to { help, name, type, values, aggregator };
  // the series live under values.
  const { values } = (await metric.get()) as unknown as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return values.find((entry) => entry.labels.source === source)?.value;
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
  const { values } = (await metric.get()) as unknown as { values: Array<{ value: number }> };
  return values.reduce((sum, entry) => sum + entry.value, 0);
}

describe("PrometheusWriter stale-source removal (staleSourceRemovalSecs)", () => {
  let writer: PrometheusWriter;
  let logger: MockLogger & ILogger;
  let configDir: string;
  let configSource: string;
  let configChangeCallback: jest.Mock;

  // Private access to the commit-path tail: committing the config and
  // applying it is exactly what performConfigWrite / handleReloadConfig do
  // after the disk write; the real endpoints are pinned separately in
  // PrometheusWriter.test.ts.
  function commitConfig(patch: Record<string, unknown>): void {
    const internals = writer as unknown as {
      config: z.infer<typeof configSchema>;
      applyStaleSourceRemoval(): void;
    };
    internals.config = { ...internals.config, ...patch } as z.infer<typeof configSchema>;
    internals.applyStaleSourceRemoval();
  }

  function evictionWarnings(): Array<Record<string, unknown>> {
    return logger.write_warn.mock.calls
      .map((call) => call[2] as Record<string, unknown> | undefined)
      .filter(
        (meta): meta is Record<string, unknown> => meta?.event === "stale_source_removed"
      );
  }

  function enabledAudits(): Array<Record<string, unknown>> {
    return logger.write_info.mock.calls
      .map((call) => call[2] as Record<string, unknown> | undefined)
      .filter(
        (meta): meta is Record<string, unknown> =>
          meta?.event === "stale_source_removal" && meta.enabled === true
      );
  }

  beforeAll(async () => {
    // Disabled at construction (key absent → 0), so no real timer is armed
    // while the writer comes up on real timers.
    const port = await getFreePort();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-stale-test-"));
    configSource = path.join(configDir, "config.yml");

    logger = createMockLogger();
    configChangeCallback = jest.fn();
    writer = new PrometheusWriter(
      {
        logLevel: "info",
        mqttBrokerIpAddress: "10.0.0.1",
        mqttTopicTelemetry: "iot/v3/telemetry",
        apiPort: port,
        sensorSourceCardinalityCap: 2,
      } as z.infer<typeof configSchema>,
      logger,
      configSource,
      configChangeCallback
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

    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  });

  afterAll(() => {
    jest.useRealTimers();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("removes nothing before the threshold elapses", async () => {
    commitConfig({ staleSourceRemovalSecs: 3600 });
    // 3600/2 = 30 min, clamped to the 60s ceiling.
    expect(enabledAudits().find((meta) => meta.thresholdSeconds === 3600)).toMatchObject({
      intervalMs: 60_000,
    });

    const t0 = Date.now();
    writer.mark_source_seen("alpha");
    writer.set_cpu_temp("alpha", 41);

    // 59 sweep passes at the 60s interval, none past the threshold.
    jest.advanceTimersByTime(3_599_000);

    expect(await seriesValue("sensor_health_cpu_temperature_c", "alpha")).toBe(41);
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "alpha")).toBe(
      Math.floor(t0 / 1000)
    );
    expect(evictionWarnings()).toHaveLength(0);
  });

  it("removes all per-source series, including sensor_last_seen_timestamp_seconds, after the threshold", async () => {
    // Next pass at 3600s is age == threshold (strictly older required);
    // the one at 3660s evicts.
    jest.advanceTimersByTime(120_000);

    for (const name of DATA_METRIC_NAMES) {
      expect(await seriesValue(name, "alpha")).toBeUndefined();
    }
    // The last-seen series goes with the data: eviction frees the source's
    // cardinality slot, so retaining its one source-labeled series would
    // let source churn accumulate this metric without bound.
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "alpha")).toBeUndefined();
    const evictions = evictionWarnings();
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toMatchObject({
      source: "alpha",
      thresholdSeconds: 3600,
      ageSeconds: expect.any(Number),
    });
    expect(evictions[0].ageSeconds).toBeGreaterThanOrEqual(3660);
  });

  it("never removes while disabled, even a year later", async () => {
    commitConfig({ staleSourceRemovalSecs: 0 });
    const disabled = logger.write_info.mock.calls
      .map((call) => call[2] as Record<string, unknown> | undefined)
      .find((meta) => meta?.event === "stale_source_removal" && meta.enabled === false);
    expect(disabled).toBeDefined();

    writer.mark_source_seen("beta");
    writer.set_cpu_temp("beta", 10);

    jest.advanceTimersByTime(31_536_000_000);

    expect(await seriesValue("sensor_health_cpu_temperature_c", "beta")).toBe(10);
    expect(evictionWarnings()).toHaveLength(1); // still only alpha
  });

  it("frees the admitted-source cap slot on eviction and re-admits a returning source", async () => {
    commitConfig({ staleSourceRemovalSecs: 3600 });
    const rejectedBefore = await counterValue("sensor_sources_rejected_total");

    // beta occupies one slot from the disabled test above; age it out first
    // (the map must end empty before the re-admission assertions).
    jest.advanceTimersByTime(3_661_000);
    expect(evictionWarnings().map((w) => w.source)).toEqual(["alpha", "beta"]);

    // Now both slots are free: c1 and c2 admit under their own labels.
    writer.mark_source_seen("c1");
    writer.mark_source_seen("c2");
    jest.advanceTimersByTime(3_661_000);
    expect(evictionWarnings().map((w) => w.source).sort()).toEqual(["alpha", "beta", "c1", "c2"]);

    // c3 takes one of the freed slots under its own label — no rejection.
    writer.mark_source_seen("c3");
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "c3")).toBeDefined();
    expect(await counterValue("sensor_sources_rejected_total")).toBe(rejectedBefore);

    // c1 returns: re-admitted under its own label, series recreated.
    const stampBefore = await seriesValue("sensor_last_seen_timestamp_seconds", "c1");
    writer.mark_source_seen("c1");
    writer.set_cpu_temp("c1", 55);
    expect(await seriesValue("sensor_health_cpu_temperature_c", "c1")).toBe(55);
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "c1")).toBeGreaterThan(
      stampBefore ?? 0
    );

    // Age out both so downstream tests start from an empty map (the
    // "unknown" label, once admitted, holds a cap slot forever — see the
    // fallback test, which therefore runs last of the eviction tests).
    jest.advanceTimersByTime(3_661_000);
    expect(evictionWarnings().map((w) => w.source).sort()).toEqual([
      "alpha",
      "beta",
      "c1",
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("eviction removes the last-seen series, so source churn stays within the cap", async () => {
    // Regression for the retained-last-seen leak: eviction frees the
    // source's admitted slot, so each evicted source's slot is reused by
    // the next source. If the evicted source's
    // sensor_last_seen_timestamp_seconds series survived, every churned
    // source (replaced sensors, a churning publisher) would leak one series
    // and the metric would grow without bound despite
    // sensorSourceCardinalityCap (2 here, see beforeAll).
    //
    // Timing is phase-robust: the sweep passes every 60s at an unknown
    // phase, so a source is guaranteed evicted once past the 3600s
    // threshold plus one full period, and guaranteed kept while its age at
    // the last possible sweep before the assertion is at most 3600s
    // (eviction is strictly older-than).
    const rejectedBefore = await counterValue("sensor_sources_rejected_total");

    // 1-2. Admit source-1, then source-2 3500s later: both are admitted
    // (at the cap), and source-1 is at most 3500s old at the last sweep so
    // far — nothing evicted yet.
    writer.mark_source_seen("source-1");
    jest.advanceTimersByTime(3_500_000);
    writer.mark_source_seen("source-2");

    // 3. 161s later a sweep finds source-1 strictly past the threshold and
    // evicts it; source-2 is at most 161s old and stays.
    jest.advanceTimersByTime(161_000);
    expect(evictionWarnings().at(-1)).toMatchObject({ source: "source-1" });
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "source-1")).toBeUndefined();
    expect(await seriesSources("sensor_last_seen_timestamp_seconds")).toEqual(["source-2"]);

    // 4. source-3 takes source-1's freed slot — no rejection, and the
    // concrete label set is at the cap, held by live sources only.
    writer.mark_source_seen("source-3");
    expect(await counterValue("sensor_sources_rejected_total")).toBe(rejectedBefore);
    expect(await seriesSources("sensor_last_seen_timestamp_seconds")).toEqual([
      "source-2",
      "source-3",
    ]);

    // 5. source-2 crosses the threshold and is evicted; source-3's age at
    // the last sweep is at most 3600s, so the strictly-older rule keeps it.
    jest.advanceTimersByTime(3_600_000);
    expect(evictionWarnings().at(-1)).toMatchObject({ source: "source-2" });
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "source-2")).toBeUndefined();
    expect(await seriesSources("sensor_last_seen_timestamp_seconds")).toEqual(["source-3"]);

    // 6. source-4 takes source-2's freed slot.
    writer.mark_source_seen("source-4");

    // The spec's end state: the evicted sources' historical last-seen
    // series are gone, the live sources are present, the concrete label set
    // sits at — not above — the cap, and no source was ever rejected.
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "source-1")).toBeUndefined();
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "source-2")).toBeUndefined();
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "source-3")).toBeDefined();
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "source-4")).toBeDefined();
    const lastSeenSources = await seriesSources("sensor_last_seen_timestamp_seconds");
    expect(lastSeenSources).toEqual(["source-3", "source-4"]);
    expect(lastSeenSources.length).toBeLessThanOrEqual(2); // sensorSourceCardinalityCap
    expect(await counterValue("sensor_sources_rejected_total")).toBe(rejectedBefore);

    // Age both out so downstream tests start from an empty map, as before.
    jest.advanceTimersByTime(3_661_000);
    expect(await seriesSources("sensor_last_seen_timestamp_seconds")).toEqual([]);
  });

  it("clamps the sweep interval to [10s, 60s] and warns on sub-300s thresholds", async () => {
    commitConfig({ staleSourceRemovalSecs: 100 });
    expect(enabledAudits().find((meta) => meta.thresholdSeconds === 100)).toMatchObject({
      intervalMs: 50_000,
    });

    commitConfig({ staleSourceRemovalSecs: 16 });
    const audit16 = enabledAudits().find((meta) => meta.thresholdSeconds === 16);
    // 16/2 = 8s is below the 10s floor.
    expect(audit16).toMatchObject({ intervalMs: 10_000 });
    expect(
      logger.write_warn.mock.calls.some(
        (call) => (call[2] as Record<string, unknown> | undefined)?.event === "stale_source_removal_threshold_low"
      )
    ).toBe(true);

    // Behavioral floor: with the 10s cadence a 16s-old source is evicted by
    // t=20s; an unclamped 8s cadence would not evict before t=24s.
    writer.mark_source_seen("flappy");
    writer.set_cpu_temp("flappy", 1);
    jest.advanceTimersByTime(20_000);
    expect(await seriesValue("sensor_health_cpu_temperature_c", "flappy")).toBeUndefined();
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "flappy")).toBeUndefined();
  });

  it("re-arms the sweep on runtime config changes (enable, disable, re-enable)", async () => {
    const internals = writer as unknown as { staleSweepTimer?: unknown };

    // (a) enable → disable: the armed 10s timer must stop sweeping.
    writer.mark_source_seen("survivor");
    writer.set_cpu_temp("survivor", 7);
    commitConfig({ staleSourceRemovalSecs: 0 });
    expect(internals.staleSweepTimer).toBeUndefined();
    jest.advanceTimersByTime(32_000); // would be three sweeps at the old cadence
    expect(await seriesValue("sensor_health_cpu_temperature_c", "survivor")).toBe(7);

    // (b) disable → enable: the freshly armed sweep evicts the pre-stale
    // source; a source admitted after the commit survives its own threshold.
    writer.mark_source_seen("ancient");
    writer.set_cpu_temp("ancient", 1);
    commitConfig({ staleSourceRemovalSecs: 300 });
    expect(internals.staleSweepTimer).toBeDefined();

    // 300/2 = 150s, clamped to 60s. survivor (age 332s) crosses the
    // threshold at the fourth pass; ancient (age 300s) has not yet —
    // eviction is strictly older-than, so it is still kept.
    jest.advanceTimersByTime(300_000);
    expect(await seriesValue("sensor_health_cpu_temperature_c", "survivor")).toBeUndefined();
    expect(await seriesValue("sensor_health_cpu_temperature_c", "ancient")).toBe(1);

    // survivor's eviction freed a slot, so the new source admits under its
    // own label rather than overflowing to unknown_source.
    writer.mark_source_seen("freshly");
    writer.set_cpu_temp("freshly", 2);
    // Next pass evicts ancient (age 360s > 300s); freshly (age 300s) is
    // still exactly at, not past, the threshold.
    jest.advanceTimersByTime(300_000);
    expect(await seriesValue("sensor_health_cpu_temperature_c", "ancient")).toBeUndefined();
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "ancient")).toBeUndefined();
    expect(await seriesValue("sensor_health_cpu_temperature_c", "freshly")).toBe(2);
  });

  it("never evicts the fallback labels (unknown, unknown_source)", async () => {
    // Runs last of the eviction tests: the close() test that follows does
    // not care about admission slots.
    // freshly (from the re-arm test) holds one slot; fill the second, then
    // overflow to unknown_source.
    writer.mark_source_seen("overflow-x");
    writer.mark_source_seen("overflow-y"); // cap full → unknown_source
    writer.set_cpu_temp("overflow-z", 20); // also unknown_source

    jest.advanceTimersByTime(4 * 3_600_000);

    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "unknown_source")).toBeDefined();
    expect(await seriesValue("sensor_health_cpu_temperature_c", "unknown_source")).toBe(20);
    // The concrete sources did age out — the sweep ran, the fallbacks just
    // were not eligible.
    expect(await seriesValue("sensor_health_cpu_temperature_c", "freshly")).toBeUndefined();
    expect(await seriesValue("sensor_health_cpu_temperature_c", "overflow-x")).toBeUndefined();

    // A blank source maps to the shared "unknown" fallback (which holds no
    // cap slot); it must survive the sweep the same way.
    writer.mark_source_seen("");
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "unknown")).toBeDefined();

    jest.advanceTimersByTime(4 * 3_600_000);
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "unknown")).toBeDefined();
    expect(await seriesValue("sensor_last_seen_timestamp_seconds", "unknown_source")).toBeDefined();
  });

  it("clears the sweep timer on close() and never fires again", async () => {
    // Last test in the file: close() consumes the shared writer (prom-client's
    // global registry forbids a second writer per process).
    commitConfig({ staleSourceRemovalSecs: 1000 });
    const internals = writer as unknown as { staleSweepTimer?: unknown };
    expect(internals.staleSweepTimer).toBeDefined();

    jest.useRealTimers();
    await writer.close();
    expect(internals.staleSweepTimer).toBeUndefined();
    // Idempotent: a second close resolves without throwing.
    await writer.close();
    expect(
      logger.write_info.mock.calls.some(
        (call) => (call[2] as Record<string, unknown> | undefined)?.event === "prometheus_server_closed"
      )
    ).toBe(true);
  });
});
