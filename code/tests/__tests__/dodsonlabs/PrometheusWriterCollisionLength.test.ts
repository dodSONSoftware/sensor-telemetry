/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "crypto";
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

describe("PrometheusWriter collision disambiguation at sensorSourceMaxLength 9", () => {
  // One writer for the whole file (prom-client's global registry), built
  // with the schema minimum: the disambiguation suffix is "-" + 8 hex
  // characters, exactly 9 characters, so at this length the whole base
  // is truncated away and ONLY the suffix fits. The configured maximum
  // must still hold on the resulting label.
  const MAX_LEN = 9;
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

  it("disambiguates a character-strip collision within 9 characters", async () => {
    // @ and # are both stripped from the default charset, so the two
    // distinct sensors collapse onto "soil1".
    writer.publish_air(airPayload(20), "soil@1", "fw-x");
    writer.publish_air(airPayload(25), "soil#1", "fw-x");
    const sources = await seriesSources("air_temperature");

    expect(sources).toContain("soil1");
    const disambiguated = sources.filter((label) => label !== "soil1");
    expect(disambiguated).toHaveLength(1);
    // No room left for the base: the label is exactly "-" + 8 hex, 9 chars.
    expect(disambiguated[0]).toMatch(/^-([0-9a-f]{8})$/);
    expect(disambiguated[0].length).toBe(MAX_LEN);
    // The two sensors stay observably separate.
    expect(await seriesValue("air_temperature", "soil1")).toBe(68); // 20C
    expect(await seriesValue("air_temperature", disambiguated[0])).toBe(77); // 25C
  });

  it("disambiguates a truncation collision within 9 characters", async () => {
    // Two 11-char names that share their first 9 characters: after
    // truncation they collide on "abcdefghi". The colliding source takes
    // the same base-less disambiguation form — distinct from the first
    // collision's suffix (different raw source → different fingerprint).
    writer.publish_air(airPayload(21), "abcdefghij1", "fw-x");
    writer.publish_air(airPayload(22), "abcdefghij2", "fw-x");
    const sources = await seriesSources("air_temperature");

    expect(sources).toContain("abcdefghi");
    const disambiguated = sources.filter((label) => /^-[0-9a-f]{8}$/.test(label));
    expect(disambiguated).toHaveLength(2);
    expect(new Set(disambiguated).size).toBe(2);
    // Exactly the four admitted identities: soil1, abcdefghi, both suffixes.
    expect(sources).toHaveLength(4);
    // Every label obeys the configured maximum — the invariant the schema
    // minimum exists to protect.
    for (const label of sources) {
      expect(label.length).toBeLessThanOrEqual(MAX_LEN);
    }
    expect(await seriesValue("air_temperature", "abcdefghi")).toBe(69.8); // 21C
    const expectedSuffix =
      "-" + createHash("sha256").update("abcdefghij2", "utf8").digest("hex").slice(0, 8);
    expect(await seriesValue("air_temperature", expectedSuffix)).toBe(71.6); // 22C
  });
});
