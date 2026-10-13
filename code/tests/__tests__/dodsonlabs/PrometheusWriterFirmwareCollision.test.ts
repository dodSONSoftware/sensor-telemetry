/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import net from "net";
import { createHash } from "crypto";
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

function labelValues(metric: string, label: string, text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line === "") continue;
    const match = line.match(new RegExp(`^${metric}\\{([^}]*)\\}\\s+([0-9eE+.-]+)$`));
    if (!match) continue;
    for (const pair of match[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      if (pair[1] === label) out.add(pair[2]);
    }
  }
  return out;
}

describe("PrometheusWriter firmware label collision resolution (regression P3)", () => {
  // One writer for the whole file: prom-client registers metric names in a
  // global registry, so a second PrometheusWriter in the same process would
  // throw on duplicate names. The default cardinality cap (1024) is far
  // above every distinct version admitted below, so the cap path is never
  // exercised here — the cardinality file covers it separately.
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
        sensorSourceMaxLength: 30,
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

  it("disambiguates distinct raw versions that collide after invalid-character stripping", () => {
    // '+' is not a valid label character, so both raw versions sanitize to
    // 'fw123'. The first raw version keeps the plain label; the second
    // must get a deterministic disambiguation, never the same series.
    const a = writer.admitFirmwareVersion("fw+123");
    const b = writer.admitFirmwareVersion("fw123");

    expect(a).toBe("fw123");
    expect(b).not.toBe(a);
    expect(b).toMatch(/^fw123-[0-9a-f]{8}$/);
    expect(b.length).toBeLessThanOrEqual(30);

    // Repeated admission of the SAME raw version is stable: each raw
    // version keeps the label it already owns for the process lifetime.
    expect(writer.admitFirmwareVersion("fw+123")).toBe(a);
    expect(writer.admitFirmwareVersion("fw123")).toBe(b);

    // The collision is warned exactly once (deduped by the ownership
    // entry), with the raw/ sanitized/final identities.
    const collisionWarnings = logger.write_warn.mock.calls.filter(
      (call) => call[2]?.event === "sensor_firmware_collision"
    );
    expect(collisionWarnings).toHaveLength(1);
    expect(collisionWarnings[0][2]).toMatchObject({
      originalFirmware: "fw123",
      sanitizedFirmware: "fw123",
      finalLabel: b,
    });
  });

  it("disambiguates distinct raw versions that differ only beyond the truncation boundary", () => {
    // Both versions share the full 30-char sanitized prefix; only the
    // portion past MAX_SOURCE_LENGTH (sensorSourceMaxLength) differs.
    const prefix = `fw${"x".repeat(28)}`;
    expect(prefix.length).toBe(30);
    const longA = `${prefix}AAA`;
    const longB = `${prefix}BBB`;

    const a = writer.admitFirmwareVersion(longA);
    const b = writer.admitFirmwareVersion(longB);

    expect(a).toBe(prefix); // first raw version keeps the truncated base
    expect(b).not.toBe(a);
    // The disambiguation truncates the base to make room for "-<8 hex>":
    // 30 - 9 = 21 base chars, still within the label bound. Verify the
    // suffix independently against the raw version's sha256 fingerprint.
    const expectedSuffix = createHash("sha256").update(longB, "utf8").digest("hex").slice(0, 8);
    expect(b).toBe(`${prefix.slice(0, 21)}-${expectedSuffix}`);
    expect(b.length).toBeLessThanOrEqual(30);
    // Deterministic: re-admission is stable and warns nothing new.
    expect(writer.admitFirmwareVersion(longB)).toBe(b);
    const collisionWarnings = logger.write_warn.mock.calls.filter(
      (call) => call[2]?.event === "sensor_firmware_collision" && call[2]?.originalFirmware === longB
    );
    expect(collisionWarnings).toHaveLength(1);
  });

  it("disambiguates a real version that sanitizes to a reserved fallback identity", () => {
    // A version literally named after a reserved fallback would otherwise
    // be indistinguishable from missing/overflow firmware.
    const namedUnknown = writer.admitFirmwareVersion("unknown");
    expect(namedUnknown).not.toBe("unknown");
    expect(namedUnknown).toMatch(/^unknown-[0-9a-f]{8}$/);

    const namedFallback = writer.admitFirmwareVersion("unknown_firmware");
    expect(namedFallback).not.toBe("unknown_firmware");
    expect(namedFallback).toMatch(/^unknown_firmware-[0-9a-f]{8}$/);
    expect(namedFallback).not.toBe(namedUnknown);

    // Re-admission is stable for both.
    expect(writer.admitFirmwareVersion("unknown")).toBe(namedUnknown);
    expect(writer.admitFirmwareVersion("unknown_firmware")).toBe(namedFallback);
  });

  it("still merges blank/all-invalid versions onto the shared 'unknown' fallback", () => {
    // The blank contract is deliberately lossy (mirrors blank sources):
    // every all-invalid version shares 'unknown' — no disambiguation, no
    // collision warning.
    expect(writer.admitFirmwareVersion("!!!")).toBe("unknown");
    expect(writer.admitFirmwareVersion("###")).toBe("unknown");
    expect(
      logger.write_warn.mock.calls.some(
        (call) =>
          call[2]?.event === "sensor_firmware_collision" &&
          (call[2]?.originalFirmware === "!!!" || call[2]?.originalFirmware === "###")
      )
    ).toBe(false);
  });

  it("keeps the colliding versions in distinct telemetry series end to end", async () => {
    // The real path (MqttNetworking.getFirmwareVersion) admits the version
    // and passes the admitted label to the publisher — mirror that here so
    // the counter actually carries two series, not one merged one.
    const a = writer.admitFirmwareVersion("fw+999");
    const b = writer.admitFirmwareVersion("fw999");
    writer.publish_air({ air: { temperature_c: 20, humidity_percent: 50 } }, "fw-collision-src", a);
    writer.publish_air({ air: { temperature_c: 21, humidity_percent: 50 } }, "fw-collision-src", b);

    const metrics = await getMetrics();
    const firmwareLabels = labelValues("telemetry_messages_total", "firmware_version", metrics);
    expect(firmwareLabels.has(a)).toBe(true);
    expect(firmwareLabels.has(b)).toBe(true);
    expect(firmwareLabels.size).toBeGreaterThanOrEqual(2);
    // Nothing hit the cap: no firmware rejections anywhere in this file.
    const rejected = metrics.match(/^sensor_firmware_versions_rejected_total.*$/m);
    expect(rejected === null || Number(rejected[0].split(" ").at(-1)) === 0).toBe(true);
  });
});
