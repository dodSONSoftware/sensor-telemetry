/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { Gauge, register } from "prom-client";
import {
  initializeDefaultMetrics,
  PrometheusWriter,
} from "../../../src/dodsonlabs/PrometheusWriter";
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
      const port = (srv.address() as net.AddressInfo).port;
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
 * Read one series value from Prometheus exposition text. Returns undefined
 * when the series is absent. Anchored to line start with the value at line
 * end, so # HELP / # TYPE lines (which also carry the metric name) never
 * match, and a no-label metric cannot match a labeled series of the same
 * name.
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

interface ParsedExposition {
  // family name -> count of "# HELP <name>" lines
  helpCounts: Map<string, number>;
  // family name -> count of "# TYPE <name> <type>" lines
  typeCounts: Map<string, number>;
  // family name -> declared type (from the (single) "# TYPE" line)
  types: Map<string, string>;
  // "<name><labelset>" -> number of sample lines with that full identity
  sampleCounts: Map<string, number>;
  // non-comment, non-blank lines that did NOT parse as a sample (empty when
  // the exposition is fully well-formed; kept as raw text for the failure msg)
  unparsable: string[];
  // sorted family names (from "# TYPE" lines)
  familyNames: string[];
}

// A minimal but faithful Prometheus text-format parser sufficient to detect
// the two duplication defects the change must avoid: a family declared more
// than once (repeated # HELP / # TYPE) and a repeated sample (same full name
// plus label set). It also flags any non-comment line that is not a
// well-formed sample, so a broken exposition is not silently accepted.
// (A plain "no repeated raw line" check would miss a duplicate that differs
// only in value, and would not catch a family declared twice with the same
// HELP text, so the structure is checked explicitly.)
function parseExposition(text: string): ParsedExposition {
  const helpCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const types = new Map<string, string>();
  const sampleCounts = new Map<string, number>();
  const unparsable: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("# HELP ")) {
      const name = line.slice("# HELP ".length).split(" ")[0];
      helpCounts.set(name, (helpCounts.get(name) ?? 0) + 1);
    } else if (line.startsWith("# TYPE ")) {
      const parts = line.slice("# TYPE ".length).trim().split(/\s+/);
      const name = parts[0];
      typeCounts.set(name, (typeCounts.get(name) ?? 0) + 1);
      types.set(name, parts[1] ?? "");
    } else if (line.trim() === "" || line.startsWith("#")) {
      // blank line or unknown comment: not a sample, ignore
    } else {
      // Sample line: name{labels} value  or  name value. The value follows the
      // Prometheus text-format grammar: a finite number (integer, decimal, and
      // scientific notation — including a SIGNED exponent, which the tiny
      // event-loop-lag values such as 1.234e-7 require) or a special float.
      // prom-client spells a NaN value "Nan" (its exact getValueAsString
      // output, distinct from the spec's "NaN"); Prometheus's own parser
      // accepts both case variants, so "Nan" is validated here as-is.
      const m = line.match(
        /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?|Nan|[-+]Inf)$/
      );
      if (!m) {
        unparsable.push(line);
        continue;
      }
      const name = m[1];
      const labels = m[2] ?? "";
      const key = `${name}${labels}`;
      sampleCounts.set(key, (sampleCounts.get(key) ?? 0) + 1);
    }
  }

  return {
    helpCounts,
    typeCounts,
    types,
    sampleCounts,
    unparsable,
    familyNames: [...types.keys()].sort(),
  };
}

// Names that appear in a Map more than once, for a readable assertion message.
function duplicatedEntries(map: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [name, count] of map) {
    if (count > 1) {
      out.push(`${name} (x${count})`);
    }
  }
  return out.sort();
}

describe("PrometheusWriter default metrics (single registry)", () => {
  // One writer for the whole file: prom-client's global registry allows only
  // one real writer per module registry (a second would throw on duplicate
  // family names), so — exactly like the other real-writer suites — the
  // writer is constructed once in beforeAll and shared.
  let logger: MockLogger & ILogger;
  let writer: PrometheusWriter;
  let port: number;
  let configDir: string;
  let configSource: string;

  const baseConfig = {
    logLevel: "info",
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  beforeAll(async () => {
    delete process.env.SENSOR_TELEMETRY_CONFIG_TOKEN;

    port = await getFreePort();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prom-writer-defaults-"));
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

  async function getMetrics(): Promise<{ text: string; contentType: string | null }> {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      // Connection: close keeps undici's keep-alive pool from holding a
      // socket open, which would block server.close() in afterAll.
      headers: { Connection: "close" },
    });
    expect(res.status).toBe(200);
    return { text: await res.text(), contentType: res.headers.get("content-type") };
  }

  it("registers the library's default metrics into the same global registry the endpoint reads", async () => {
    // Both a custom family and a default family must resolve on the imported
    // global registry — proof that collectDefaultMetrics() targeted the same
    // registry the writer's /metrics handler reads (not a second one).
    expect(register.getSingleMetric("air_temperature")).toBeDefined();
    expect(register.getSingleMetric("nodejs_version_info")).toBeDefined();

    const { text } = await getMetrics();
    const parsed = parseExposition(text);
    expect(parsed.familyNames).toContain("air_temperature");
    expect(parsed.familyNames).toContain("nodejs_version_info");
  });

  it("declares every metric family exactly once (no duplicate # HELP / # TYPE)", async () => {
    const { text } = await getMetrics();
    const parsed = parseExposition(text);
    expect(duplicatedEntries(parsed.helpCounts)).toEqual([]);
    expect(duplicatedEntries(parsed.typeCounts)).toEqual([]);
  });

  it("exposes no duplicate sample (full name + label set) within one scrape", async () => {
    const { text } = await getMetrics();
    const parsed = parseExposition(text);
    expect(duplicatedEntries(parsed.sampleCounts)).toEqual([]);
  });

  it("serves a syntactically valid exposition with the registry content type", async () => {
    const { text, contentType } = await getMetrics();
    // The endpoint must report the registry's content type.
    expect((contentType ?? "").trim()).toBe(register.contentType);
    // Every non-comment, non-blank line must parse as a sample.
    const parsed = parseExposition(text);
    expect(parsed.unparsable).toEqual([]);
    // A few known families keep their expected types (guards against a
    // silent type change as defaults are added).
    expect(parsed.types.get("air_temperature")).toBe("gauge");
    expect(parsed.types.get("http_requests_total")).toBe("counter");
    expect(parsed.types.get("nodejs_gc_duration_seconds")).toBe("histogram");
  });

  it("exposes the installed prom-client's default process_*/nodejs_* metrics", async () => {
    const { text } = await getMetrics();
    const parsed = parseExposition(text);
    // A representative, platform-independent set of the default families
    // that the installed prom-client emits (verified against the
    // installed dependency, not assumed).
    const expectedDefaultFamilies = [
      "nodejs_version_info",
      "nodejs_heap_size_used_bytes",
      "nodejs_heap_size_total_bytes",
      "nodejs_heap_space_size_used_bytes",
      "nodejs_external_memory_bytes",
      "nodejs_eventloop_lag_seconds",
      "process_cpu_seconds_total",
      "process_start_time_seconds",
      "process_resident_memory_bytes",
    ];
    for (const name of expectedDefaultFamilies) {
      expect(parsed.familyNames).toContain(name);
    }
    // The default nodejs heap metric carries a real (nonzero) sample.
    expect(metricValue(text, "nodejs_heap_size_used_bytes")).toBeGreaterThan(0);
  });

  it("preserves the retained custom families, including the hand-rolled process metrics", async () => {
    const { text } = await getMetrics();
    const parsed = parseExposition(text);
    // Hand-rolled process metrics that do NOT collide with a default name
    // must still be present and unchanged in name/unit.
    for (const name of [
      "process_uptime_seconds",
      "process_heap_used_bytes",
      "process_heap_total_bytes",
      // Milliseconds, mean-since-last-scrape — a DIFFERENT metric from the
      // default nodejs_eventloop_lag_*_seconds family; both are present.
      "process_event_loop_lag_ms",
    ]) {
      expect(parsed.familyNames).toContain(name);
    }
    // The one colliding name is now served by the default producer, not the
    // removed hand-rolled gauge: exactly one process_resident_memory_bytes
    // family (a hand-rolled one would have thrown at construction as a
    // duplicate), with a real sample.
    expect(parsed.typeCounts.get("process_resident_memory_bytes")).toBe(1);
    expect(metricValue(text, "process_resident_memory_bytes")).toBeGreaterThan(0);
    // A spread of retained domain/application families.
    for (const name of [
      "air_temperature",
      "water_temperature",
      "soil_moisture_percent",
      "sensor_health_up",
      "sensor_last_seen_timestamp_seconds",
      "mqtt_client_connected",
      "telemetry_messages_total",
      "sensor_sources_rejected_total",
      "sensor_firmware_versions_rejected_total",
    ]) {
      expect(parsed.familyNames).toContain(name);
    }
  });

  it("initializeDefaultMetrics() is idempotent: repeated calls do not throw or double-register", async () => {
    // The writer's constructor already ran the initializer once; calling it
    // again (e.g. a re-construction) must be a safe no-op, not a
    // duplicate-registration throw.
    expect(() => initializeDefaultMetrics()).not.toThrow();
    expect(() => initializeDefaultMetrics()).not.toThrow();
    // ...and it must not have added any duplicate family to the registry.
    const { text } = await getMetrics();
    const parsed = parseExposition(text);
    expect(duplicatedEntries(parsed.typeCounts)).toEqual([]);
  });

  it("a genuinely duplicate metric name fails clearly rather than being silently ignored", async () => {
    // Registering a SECOND metric under an already-registered default name
    // must throw (the conflict is not swallowed), proving there is no
    // catch-and-ignore duplicate-registration mechanism in play.
    expect(
      () => new Gauge({ name: "nodejs_version_info", help: "test: duplicate default name" })
    ).toThrow(/already been registered/);
    // The failed registration must not have corrupted the family: still
    // exactly one nodejs_version_info declaration.
    const { text } = await getMetrics();
    const parsed = parseExposition(text);
    expect(parsed.helpCounts.get("nodejs_version_info")).toBe(1);
    expect(parsed.typeCounts.get("nodejs_version_info")).toBe(1);
  });

  it("consecutive scrapes do not grow the family set or introduce duplicates", async () => {
    const first = parseExposition((await getMetrics()).text);
    const second = parseExposition((await getMetrics()).text);
    // The family set is stable across scrapes (the library manages
    // collection; nothing re-registers per scrape).
    expect(second.familyNames).toEqual(first.familyNames);
    // And neither scrape carries a duplicate family or sample.
    expect(duplicatedEntries(first.typeCounts)).toEqual([]);
    expect(duplicatedEntries(second.typeCounts)).toEqual([]);
    expect(duplicatedEntries(second.sampleCounts)).toEqual([]);
  });
});
