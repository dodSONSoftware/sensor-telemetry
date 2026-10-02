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

/** Distinct collision warnings, as structured metadata. */
function collisionWarnings(logger: MockLogger): Array<Record<string, unknown>> {
  return logger.write_warn.mock.calls
    .map((call) => call[2] as Record<string, unknown> | undefined)
    .filter((meta): meta is Record<string, unknown> => meta?.event === "sensor_source_collision");
}

describe("PrometheusWriter source identity (sanitization collisions, regression P2-2)", () => {
  // One writer for the whole file: prom-client registers metric names in a
  // global registry, so a second PrometheusWriter in the same process would
  // throw on duplicate names. The tests therefore share admission state and
  // assert cumulatively, in declaration order.
  const CAP = 10;
  const MAX_LEN = 30; // the writer default
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
        sensorSourceMaxLength: MAX_LEN,
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

  it("maps two raw sources that sanitize identically to distinct Prometheus identities", async () => {
    // @ and # are both stripped from the default valid charset, so the two
    // DISTINCT physical sensors collapse onto one sanitized form. The
    // first keeps the plain label; the second must be disambiguated, not
    // merged into the first's series.
    writer.publish_air(airPayload(20), "soil@1", "fw-x");
    writer.publish_air(airPayload(25), "soil#1", "fw-x");
    const sources = await seriesSources("air_temperature");

    expect(sources).toContain("soil1");
    const disambiguated = sources.filter((label) => /^soil1-[0-9a-f]{8}$/.test(label));
    expect(disambiguated).toHaveLength(1);
    expect(disambiguated[0]).not.toBe("soil1");
    // The two sensors stay observably separate: distinct labels, distinct
    // values, both present.
    expect(await seriesValue("air_temperature", "soil1")).toBe(68); // 20C
    expect(await seriesValue("air_temperature", disambiguated[0])).toBe(77); // 25C

    // The collision is explicitly logged, naming the raw source and the
    // label it was given.
    const warns = collisionWarnings(logger);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      originalSource: "soil#1",
      sanitizedSource: "soil1",
      finalLabel: disambiguated[0],
    });
  });

  it("disambiguates a truncation collision (sources differing only beyond max length)", async () => {
    // Two 31-char names that share all 30 truncated characters.
    const first = "a".repeat(MAX_LEN) + "1";
    const second = "a".repeat(MAX_LEN) + "2";
    writer.publish_air(airPayload(21), first, "fw-x");
    writer.publish_air(airPayload(22), second, "fw-x");
    const sources = await seriesSources("air_temperature");

    const plain = "a".repeat(MAX_LEN);
    expect(sources).toContain(plain);
    const disambiguated = sources.filter(
      (label) => label !== plain && /^a{21}-[0-9a-f]{8}$/.test(label)
    );
    expect(disambiguated).toHaveLength(1);
    // The disambiguated label still obeys sensorSourceMaxLength.
    expect(disambiguated[0].length).toBe(MAX_LEN);
    expect(disambiguated[0]).not.toBe(plain);
  });

  it("keeps the reserved fallback labels out of reach of real sources", async () => {
    // A real sensor literally named "unknown" (or "unknown_source") must
    // not be indistinguishable from internal fallback traffic: both are
    // given deterministic disambiguated labels instead.
    writer.publish_air(airPayload(23), "unknown", "fw-x");
    writer.publish_air(airPayload(24), "unknown_source", "fw-x");
    // Blank sources still share the bare fallback label — the internal
    // fallback bucket the real sources must not collide with.
    writer.publish_air(airPayload(26), "###", "fw-x");
    const sources = await seriesSources("air_temperature");

    expect(sources).toContain("unknown"); // the "###" blank fallback
    const unknownOwned = sources.filter((label) => /^unknown-[0-9a-f]{8}$/.test(label));
    const unknownSourceOwned = sources.filter((label) =>
      /^unknown_source-[0-9a-f]{8}$/.test(label)
    );
    expect(unknownOwned).toHaveLength(1);
    expect(unknownSourceOwned).toHaveLength(1);
    expect(unknownOwned[0]).not.toBe("unknown");
    expect(unknownSourceOwned[0]).not.toBe("unknown_source");
    expect(unknownSourceOwned[0]).not.toBe(unknownOwned[0]);
    // The real sensor named "unknown" carries its own value, separate from
    // whatever reports into the fallback bucket.
    expect(await seriesValue("air_temperature", unknownOwned[0])).toBe(73.4); // 23C
    expect(await seriesValue("air_temperature", "unknown")).toBe(78.8); // 26C
  });

  it("resolves the same raw source to the same final label on every message", async () => {
    const before = await seriesSources("air_temperature");
    // Four distinct colliding raw sources have been admitted so far
    // (soil#1, the truncated pair, unknown, unknown_source); each warned
    // exactly once, on first sighting.
    const warnsBefore = collisionWarnings(logger).length;
    expect(warnsBefore).toBe(4);
    // Repeat offenders — including both colliding raw sources — must not
    // mint new labels or re-warn.
    for (let i = 0; i < 3; i++) {
      writer.publish_air(airPayload(20), "soil#1", "fw-x");
      writer.publish_air(airPayload(23), "unknown", "fw-x");
      writer.publish_air(airPayload(26), "###", "fw-x");
    }
    const after = await seriesSources("air_temperature");
    expect(after).toEqual(before);
    // Steady-state messages do not re-log the collision (one warn per
    // first sighting, from the earlier tests).
    expect(collisionWarnings(logger)).toHaveLength(warnsBefore);
  });

  it("frees label ownership when a stale source is evicted, so the label can be re-claimed", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    // 3600/2 = 30 min, clamped to the 60s ceiling.
    commitConfig({ staleSourceRemovalSecs: 3600 });
    try {
      // Re-stamp the colliding pair and let it go stale: eviction must
      // free BOTH the admission slots and the ownership entries.
      writer.mark_source_seen("soil@1");
      writer.mark_source_seen("soil#1");
      jest.advanceTimersByTime(3_600_000 + 60_000);

      // A brand-new raw source that sanitizes to the same form must now
      // claim the plain label its predecessor owned — not be forced into a
      // fresh disambiguation because the ownership entry still pins the
      // long-gone owner.
      writer.publish_air(airPayload(20), "soil!1", "fw-x");

      const labels = await seriesSources("air_temperature");
      expect(labels).toContain("soil1");
      // The evicted owner's disambiguated series is gone, and the newcomer
      // claimed the plain label rather than a fresh disambiguation: no
      // soil1-* identity survives.
      expect(labels.filter((label) => /^soil1-[0-9a-f]{8}$/.test(label))).toHaveLength(0);
      expect(await seriesValue("air_temperature", "soil1")).toBe(68); // 20C, new owner
    } finally {
      commitConfig({ staleSourceRemovalSecs: 0 });
      jest.useRealTimers();
    }
  });
});
