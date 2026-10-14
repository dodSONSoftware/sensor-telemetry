/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { MqttNetworking } from "../../../src/dodsonlabs/MqttNetworking";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// Mock the mqtt client so constructing MqttNetworking never opens a real
// connection (same pattern as MqttNetworkingRouting.test.ts).
const mockConnect = jest.fn();
jest.mock("mqtt", () => ({
  __esModule: true,
  default: {
    connect: (...args: unknown[]) => (mockConnect as jest.Mock)(...args),
  },
}));

// Auto-mock PrometheusWriter so its constructor (which starts the HTTP
// server) never runs.
jest.mock("../../../src/dodsonlabs/PrometheusWriter");

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

const baseConfig: z.infer<typeof configSchema> = {
  logLevel: "info",
  apiPort: 32002,
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

function createMockMqttClient() {
  // on must stay a recording jest.fn(): build() finds the "message"
  // handler by searching on.mock.calls.
  return {
    connected: false,
    on: jest.fn(),
    subscribe: jest.fn(),
    end: jest.fn(),
  };
}

beforeEach(() => {
  mockConnect.mockReset();
  mockConnect.mockReturnValue(createMockMqttClient());
});

/**
 * Construct ONE MqttNetworking on the fake client and return a send()
 * closure that delivers messages to the same instance — the throttle state
 * is per-instance, so multiple messages on one construction are what
 * exercises it (driveMessage in the routing suite builds a fresh instance
 * per message, which is why none of its assertions are affected).
 */
function build(): {
  logger: MockLogger & ILogger;
  send: (doc: Record<string, unknown>) => void;
  networking: MqttNetworking;
} {
  const logger = createMockLogger();
  const networking = new MqttNetworking(baseConfig, logger);
  const onMock = (
    networking as unknown as { mqtt_client: { on: jest.Mock } }
  ).mqtt_client.on;
  const messageCalls = onMock.mock.calls.filter((call) => call[0] === "message");
  const messageCall = messageCalls.at(-1);
  if (!messageCall) {
    throw new Error("MqttNetworking did not register a 'message' handler");
  }
  const handler = messageCall[1] as (
    topic: string,
    payload: Buffer,
    packet: unknown
  ) => void;
  return {
    logger,
    networking,
    send: (doc: Record<string, unknown>) =>
      handler(baseConfig.mqttTopicTelemetry, Buffer.from(JSON.stringify(doc)), {}),
  };
}

// An out-of-range bme280 temperature drives telemetry_out_of_range with a
// usable source (the hostile-minting and cadence tests use it).
const outOfRange = (source: string) => ({
  message_type: "telemetry",
  device: "bme280",
  source,
  payload: {
    temperature_c: 999,
    humidity_percent: 45,
    pressure_pa: 100000,
  },
});

describe("per-event throttle for per-message rejection warnings", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs the first missing-type occurrence as ERROR with no suppressedCount", () => {
    const { logger, send } = build();
    send({ source: "v3-src" }); // no message_type

    const errors = logger.write_error.mock.calls.filter(
      (call) => call[2]?.event === "mqtt_message_missing_type"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[2]).toMatchObject({
      logType: "sensor",
      source: "v3-src",
    });
    // First-occurrence shape is the pre-throttle shape: no suppressedCount.
    expect((errors[0]?.[2] as Record<string, unknown>).suppressedCount).toBeUndefined();
  });

  it("logs the first unknown-device occurrence as WARN with no suppressedCount", () => {
    const { logger, send } = build();
    send({
      message_type: "telemetry",
      device: "no_such_device",
      source: "v3-src",
      payload: {},
    });

    const warns = logger.write_warn.mock.calls.filter(
      (call) => call[2]?.event === "mqtt_unknown_v3_device"
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[2]).toMatchObject({
      logType: "sensor",
      source: "v3-src",
      device: "no_such_device",
    });
    expect((warns[0]?.[2] as Record<string, unknown>).suppressedCount).toBeUndefined();
  });

  it("suppresses repeats of the same event within the re-warn window", () => {
    const { logger, send } = build();
    send(outOfRange("v3-src"));
    send(outOfRange("v3-src"));
    send(outOfRange("v3-src"));

    expect(
      logger.write_warn.mock.calls.filter(
        (call) => call[2]?.event === "telemetry_out_of_range"
      )
    ).toHaveLength(1);
  });

  it("re-warns after the 60s window with suppressedCount, then restarts the window", () => {
    const { logger, send } = build();
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      send(outOfRange("v3-src")); // first occurrence
      send(outOfRange("v3-src")); // suppressed
      dateNow.mockReturnValue(1_000_000 + 60_001);
      send(outOfRange("v3-src")); // re-warn

      const warns = logger.write_warn.mock.calls.filter(
        (call) => call[2]?.event === "telemetry_out_of_range"
      );
      expect(warns).toHaveLength(2);
      expect(warns[1]?.[2]).toMatchObject({ suppressedCount: 1 });

      // The window restarted: an immediate repeat is suppressed again.
      send(outOfRange("v3-src"));
      expect(
        logger.write_warn.mock.calls.filter(
          (call) => call[2]?.event === "telemetry_out_of_range"
        )
      ).toHaveLength(2);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("accumulates the suppressed count across the whole window", () => {
    const { logger, send } = build();
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      send(outOfRange("v3-src")); // first occurrence
      send(outOfRange("v3-src"));
      send(outOfRange("v3-src"));
      send(outOfRange("v3-src")); // 3 suppressed
      dateNow.mockReturnValue(2_000_000 + 60_001);
      send(outOfRange("v3-src")); // re-warn carrying the whole window

      const warns = logger.write_warn.mock.calls.filter(
        (call) => call[2]?.event === "telemetry_out_of_range"
      );
      expect(warns).toHaveLength(2);
      expect(warns[1]?.[2]).toMatchObject({ suppressedCount: 3 });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("throttles each event independently (first sighting always wins)", () => {
    const { logger, send } = build();
    // A = missing type, B = out-of-range telemetry.
    send({ source: "v3-src" }); // A first
    send(outOfRange("v3-src")); // B first
    send({ source: "v3-src" }); // A repeat — suppressed

    expect(
      logger.write_error.mock.calls.filter(
        (call) => call[2]?.event === "mqtt_message_missing_type"
      )
    ).toHaveLength(1);
    expect(
      logger.write_warn.mock.calls.filter(
        (call) => call[2]?.event === "telemetry_out_of_range"
      )
    ).toHaveLength(1);
  });

  it("bounds the throttle state to one entry per event, not per source", () => {
    const { logger, send, networking } = build();
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(3_000_000);
    try {
      // A hostile publisher minting a fresh source per message must not
      // grow the throttle map: the key is the event name, so 50 distinct
      // sources all collapse onto the single telemetry_out_of_range entry.
      for (let i = 0; i < 50; i++) {
        send(outOfRange(`hostile-source-${i}`));
      }
      dateNow.mockReturnValue(3_000_000 + 60_001);
      send(outOfRange("one-more"));

      expect(
        logger.write_warn.mock.calls.filter(
          (call) => call[2]?.event === "telemetry_out_of_range"
        )
      ).toHaveLength(2);
      const map = (
        networking as unknown as {
          rejectionWarnThrottle: Map<string, { lastWarnMs: number; suppressedCount: number }>;
        }
      ).rejectionWarnThrottle;
      expect(map.size).toBe(1);
      expect(map.has("telemetry_out_of_range")).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("throttles missing-type rejections without a usable source field", () => {
    const { logger, send } = build();
    send({}); // no message_type, no source
    send({}); // repeat — suppressed

    const errors = logger.write_error.mock.calls.filter(
      (call) => call[2]?.event === "mqtt_message_missing_type"
    );
    expect(errors).toHaveLength(1);
    expect((errors[0]?.[2] as Record<string, unknown>).source).toBeUndefined();
  });
});

describe("per-(source, reasons) throttle for v3_health_degraded warns", () => {
  // A permanently degraded sensor reporting every 30s is a persistent
  // state (the live value is the sensor_health_up gauge), so the re-warn
  // cadence is 5 minutes, not the rejection throttle's 60s. The key
  // includes the reasons signature, so a changed reasons set re-fires
  // immediately.

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const degraded = (source: string, reasons: string[]) => ({
    message_type: "health",
    source,
    payload: { status: "degraded", degraded_reasons: reasons },
  });

  const degradedWarns = (logger: MockLogger) =>
    logger.write_warn.mock.calls.filter(
      (call) => call[2]?.event === "v3_health_degraded"
    );

  it("logs the first occurrence without suppressedCount and suppresses repeats within the window", () => {
    const { logger, send } = build();
    send(degraded("v3-src", ["low_free_heap"]));
    send(degraded("v3-src", ["low_free_heap"]));
    send(degraded("v3-src", ["low_free_heap"]));

    const warns = degradedWarns(logger);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[2]).toMatchObject({
      source: "v3-src",
      status: "degraded",
      degraded_reasons: ["low_free_heap"],
    });
    expect((warns[0]?.[2] as Record<string, unknown>).suppressedCount).toBeUndefined();
  });

  it("re-warns after the 5-minute window with suppressedCount, then restarts the window", () => {
    const { logger, send } = build();
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(10_000_000);
    try {
      send(degraded("v3-src", ["low_free_heap"])); // first occurrence
      dateNow.mockReturnValue(10_000_000 + 30_000);
      send(degraded("v3-src", ["low_free_heap"])); // suppressed (30s cadence)
      dateNow.mockReturnValue(10_000_000 + 300_001);
      send(degraded("v3-src", ["low_free_heap"])); // re-warn

      const warns = degradedWarns(logger);
      expect(warns).toHaveLength(2);
      expect(warns[1]?.[2]).toMatchObject({ suppressedCount: 1 });

      // The window restarted: a repeat well before 5 minutes is
      // suppressed again.
      dateNow.mockReturnValue(10_000_000 + 360_000);
      send(degraded("v3-src", ["low_free_heap"]));
      expect(degradedWarns(logger)).toHaveLength(2);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("re-fires immediately when the reasons set changes (new signature, first-occurrence shape)", () => {
    const { logger, send } = build();
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(20_000_000);
    try {
      send(degraded("v3-src", ["low_free_heap"])); // first occurrence
      dateNow.mockReturnValue(20_000_000 + 5_000);
      send(degraded("v3-src", ["low_free_heap", "mqtt_not_connected"])); // new key
      // The old key is still live too: its next occurrence is suppressed.
      send(degraded("v3-src", ["low_free_heap"]));

      const warns = degradedWarns(logger);
      expect(warns).toHaveLength(2);
      expect(warns[1]?.[2]).toMatchObject({
        degraded_reasons: ["low_free_heap", "mqtt_not_connected"],
      });
      // First-occurrence shape: no suppressedCount on the new signature.
      expect((warns[1]?.[2] as Record<string, unknown>).suppressedCount).toBeUndefined();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("throttles distinct sources independently (each source keeps first-occurrence visibility)", () => {
    const { logger, send } = build();
    send(degraded("src-a", ["low_free_heap"]));
    send(degraded("src-b", ["low_free_heap"])); // different key — fires
    send(degraded("src-a", ["low_free_heap"])); // suppressed

    expect(degradedWarns(logger)).toHaveLength(2);
  });

  it("keeps a re-warn plain (no suppressedCount field) when nothing was suppressed in between", () => {
    const { logger, send } = build();
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(30_000_000);
    try {
      send(degraded("v3-src", ["low_free_heap"])); // first occurrence
      dateNow.mockReturnValue(30_000_000 + 300_001);
      send(degraded("v3-src", ["low_free_heap"])); // re-warn, 0 suppressed

      const warns = degradedWarns(logger);
      expect(warns).toHaveLength(2);
      expect((warns[1]?.[2] as Record<string, unknown>).suppressedCount).toBeUndefined();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("caps the throttle map: a never-tracked key at the cap logs unthrottled instead of growing it", () => {
    const { logger, send, networking } = build();
    const map = (
      networking as unknown as { healthDegradedThrottle: Map<string, unknown> }
    ).healthDegradedThrottle;
    // Fill the cap with one distinct (source, reasons) key each.
    for (let i = 0; i < 1024; i++) {
      send(degraded(`hostile-source-${i}`, ["r"]));
    }
    expect(map.size).toBe(1024);

    // A never-tracked key at the cap: logged (the pre-throttle behavior),
    // and repeated occurrences stay logged — but the map does not grow.
    send(degraded("one-more", ["r"]));
    send(degraded("one-more", ["r"]));
    expect(map.size).toBe(1024);
    expect(
      degradedWarns(logger).filter(
        (call) => (call[2] as Record<string, unknown>).source === "one-more"
      )
    ).toHaveLength(2);

    // Tracked keys still throttle: a repeat of a filled-in source is
    // suppressed.
    send(degraded("hostile-source-0", ["r"]));
    expect(
      degradedWarns(logger).filter(
        (call) => (call[2] as Record<string, unknown>).source === "hostile-source-0"
      )
    ).toHaveLength(1);
  });
});
