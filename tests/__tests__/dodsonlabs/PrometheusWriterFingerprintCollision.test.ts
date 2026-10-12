/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import net from "net";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// Regression coverage for the fingerprint-collision fallbacks in
// admitSource / admitFirmwareVersion: an 8-hex SHA-256 collision at the
// disambiguated-label level is effectively unreachable with the real hash,
// so this file stubs createHash to a fixed digest — every identity then
// hashes to the same suffix, and a third distinct raw identity that
// sanitizes to the same form collides deterministically on the second's
// disambiguated label. That is exactly the shape the ownership map's
// fallback was written for, and the branch must be observable in
// Prometheus rather than silent: the source counter counts it once per
// rejection episode (its documented contract), the firmware counter counts
// every occurrence (likewise).
//
// The stub applies to the whole file (jest.mock is module-scoped), so this
// suite lives in its own file: other suites rely on the real hash.

jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  // Every digest is 64 zero chars: digest("hex").slice(0, 8) is "00000000"
  // for every identity, no matter what it is.
  const hash = {
    update: () => hash,
    digest: () => "0".repeat(64),
  };
  return {
    ...actual,
    createHash: () => hash,
  };
});

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
 * Matches both `name{label="v",...} 1` and the unlabeled `name 1` form.
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

describe("PrometheusWriter fingerprint-collision fallbacks (stubbed hash)", () => {
  // One writer for the whole file: prom-client registers metric names in a
  // global registry, so a second PrometheusWriter in the same process would
  // throw on duplicate names.
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

  const AIR = { air: { temperature_c: 20, humidity_percent: 50 } };

  it("maps a disambiguated-level source collision to the fallback and counts it once per episode", async () => {
    // The stubbed digest gives every identity the suffix "00000000", and
    // the default valid-chars set strips '@' / '!' / '#': all three raw
    // sources sanitize to "ab".
    writer.publish_air(AIR, "a@b", "fw-coll");
    writer.publish_air(AIR, "a!b", "fw-coll");
    let metrics = await getMetrics();
    // First keeps the plain label; second takes the disambiguated one.
    expect(labelValues("air_temperature", "source", metrics)).toEqual(
      new Set(["ab", "ab-00000000"])
    );
    expect(counterValue("sensor_sources_rejected_total", metrics)).toBe(0);

    // The third raw identity hashes onto the second's disambiguated label:
    // the collision branch must take the reserved fallback...
    writer.publish_air(AIR, "a#b", "fw-coll");
    writer.publish_air(AIR, "a#b", "fw-coll");
    metrics = await getMetrics();
    expect(labelValues("air_temperature", "source", metrics)).toEqual(
      new Set(["ab", "ab-00000000", "unknown_source"])
    );
    // ...and count once for the episode, not once per message.
    expect(counterValue("sensor_sources_rejected_total", metrics)).toBe(1);
  });

  it("maps a disambiguated-level firmware collision to the fallback and counts every occurrence", async () => {
    // Same stub, same default valid chars: all three raw versions sanitize
    // to "fw1.0".
    expect(writer.admitFirmwareVersion("fw1.0@")).toBe("fw1.0");
    expect(writer.admitFirmwareVersion("fw1.0!")).toBe("fw1.0-00000000");
    let metrics = await getMetrics();
    expect(counterValue("sensor_firmware_versions_rejected_total", metrics)).toBe(0);

    // The third hashes onto the second's disambiguated label: the
    // collision branch must take the reserved fallback and count the
    // occurrence, as the firmware counter's contract does.
    expect(writer.admitFirmwareVersion("fw1.0#")).toBe("unknown_firmware");
    expect(writer.admitFirmwareVersion("fw1.0#")).toBe("unknown_firmware");
    metrics = await getMetrics();
    expect(counterValue("sensor_firmware_versions_rejected_total", metrics)).toBe(2);
  });
});
