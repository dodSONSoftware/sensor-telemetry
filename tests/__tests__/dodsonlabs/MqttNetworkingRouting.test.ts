/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { MqttNetworking } from "../../../src/dodsonlabs/MqttNetworking";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// Mock the mqtt client so constructing MqttNetworking never opens a real
// connection. The fake client answers the only members MqttNetworking uses:
// on (event registration), end (close callback), and connected (status).
const mockConnect = jest.fn();
jest.mock("mqtt", () => ({
  __esModule: true,
  default: {
    connect: (...args: unknown[]) => (mockConnect as jest.Mock)(...args),
  },
}));

// Auto-mock PrometheusWriter so its constructor (which starts the HTTP
// server) never runs. The auto-mocked instance's publish_*/set_* methods
// are jest.fn(), which is exactly what the routing assertions target.
jest.mock("../../../src/dodsonlabs/PrometheusWriter");

// The auto-mock's admitFirmwareVersion returns undefined by default, which
// would mask the firmware strings the routing assertions check; make it a
// pass-through so getFirmwareVersion's extraction is what's under test.
jest
  .mocked(PrometheusWriter.prototype.admitFirmwareVersion)
  .mockImplementation((version: string) => version);

function createMockMqttClient() {
  // on must stay a recording jest.fn(): the drivers below find the
  // "message"/"connect" handlers by searching on.mock.calls. subscribe is
  // a recording jest.fn() so SUBACK callbacks can be captured and invoked
  // with either a grant or an error.
  return {
    connected: false,
    on: jest.fn(),
    subscribe: jest.fn(),
    end: jest.fn((optsOrCallback?: unknown, maybeCallback?: () => void) => {
      const cb = typeof optsOrCallback === "function"
        ? (optsOrCallback as () => void)
        : maybeCallback;
      cb?.();
    }),
  };
}

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

// The auto-mocked PrometheusWriter: every public method is a jest.fn().
// A string index keeps the routing assertions type-safe without `any`.
type MockProm = Record<string, jest.Mock>;

const baseConfig: z.infer<typeof configSchema> = {
  logLevel: "info",
  apiPort: 3301,
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

/**
 * Construct a MqttNetworking on the fake client and deliver one message to
 * the "message" handler the constructor registered. No log/health topics
 * are configured, so on_message falls through to handle_mqtt_message,
 * which routes by message_type; both handlers run synchronously, so the
 * promWriter calls are observable immediately after the call returns.
 */
function driveMessage(
  doc: Record<string, unknown>
): { prom: MockProm; logger: MockLogger & ILogger } {
  const logger = createMockLogger();
  const networking = new MqttNetworking(baseConfig, logger);
  const onMock = (
    networking as unknown as { mqtt_client: { on: jest.Mock } }
  ).mqtt_client.on;
  // The fake client is reused when a test drives more than one message, so
  // take the LAST registered handler (the one this construction just made)
  // rather than the first.
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
  handler(
    baseConfig.mqttTopicTelemetry,
    Buffer.from(JSON.stringify(doc)),
    {}
  );
  return {
    prom: (networking as unknown as { promWriter: MockProm }).promWriter,
    logger,
  };
}

beforeEach(() => {
  mockConnect.mockReset();
  mockConnect.mockReturnValue(createMockMqttClient());
});

describe("MqttNetworking V3 per-device telemetry routing", () => {
  // V3 discriminator: a top-level non-empty `device` field. Each message
  // must reach exactly the publisher for its device family.
  const fw = "1.2.3";

  it("routes yl69_fc28 (soil) to publish_soil and nothing else", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "yl69_fc28",
      source: "v3-src",
      firmware_version: fw,
      payload: { relative_moisture_percent: 42 },
    });

    expect(prom.publish_soil).toHaveBeenCalledTimes(1);
    expect(prom.publish_soil).toHaveBeenCalledWith(
      { soil: { relative_moisture_percent: 42 } },
      "v3-src",
      fw
    );
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.publish_water).not.toHaveBeenCalled();
    expect(prom.publish_light).not.toHaveBeenCalled();
  });

  it("routes plantmate_soil (soil) to publish_soil", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "plantmate_soil",
      source: "v3-src",
      firmware_version: fw,
      payload: { relative_moisture_percent: 10, raw: 2000 },
    });

    expect(prom.publish_soil).toHaveBeenCalledWith(
      { soil: { relative_moisture_percent: 10, raw: 2000 } },
      "v3-src",
      fw
    );
    expect(prom.publish_air).not.toHaveBeenCalled();
  });

  it("routes bme280 (air) to publish_air when pressure is present", () => {
    const payload = { temperature_c: 25, humidity_percent: 45, pressure_pa: 100000 };
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload,
    });

    expect(prom.publish_air).toHaveBeenCalledWith({ air: payload }, "v3-src", fw);
    expect(prom.publish_water).not.toHaveBeenCalled();
    expect(prom.publish_soil).not.toHaveBeenCalled();
    expect(prom.publish_light).not.toHaveBeenCalled();
  });

  it("routes sht35 (air) to publish_air without requiring pressure", () => {
    // sht35 has no pressure sensor; pressure is only required for bme280,
    // so this message must publish rather than be silently dropped.
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "sht35",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25, humidity_percent: 45 },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
  });

  it("does not publish bme280 (air) when pressure_pa is missing", () => {
    // The pressure guard (bme280 only) drops the message silently, so the
    // observable behavior is the absence of the publish call.
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25, humidity_percent: 45 },
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
  });

  it("routes ds18b20 (water) to publish_water and nothing else", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "ds18b20",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 20 },
    });

    expect(prom.publish_water).toHaveBeenCalledWith(
      { water: { temperature_c: 20 } },
      "v3-src",
      fw
    );
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.publish_soil).not.toHaveBeenCalled();
    expect(prom.publish_light).not.toHaveBeenCalled();
  });

  it("routes ltr390 (light) to publish_light and nothing else", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "ltr390",
      source: "v3-src",
      firmware_version: fw,
      payload: { lux: 500, uv_index: 3 },
    });

    expect(prom.publish_light).toHaveBeenCalledWith(
      { light: { lux: 500, uv_index: 3 } },
      "v3-src",
      fw
    );
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.publish_water).not.toHaveBeenCalled();
    expect(prom.publish_soil).not.toHaveBeenCalled();
  });

  it("drops an unknown device with a warning and publishes nothing", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "mystery9000",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25 },
    });

    expect(
      logger.write_warn.mock.calls.some(
        (call) =>
          call[2]?.event === "mqtt_unknown_v3_device" &&
          call[2]?.device === "mystery9000"
      )
    ).toBe(true);
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.publish_water).not.toHaveBeenCalled();
    expect(prom.publish_light).not.toHaveBeenCalled();
    expect(prom.publish_soil).not.toHaveBeenCalled();
  });

  it("errors and publishes nothing when a V3 device message has no payload", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
    });

    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_telemetry_missing_payload"
      )
    ).toBe(true);
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.publish_water).not.toHaveBeenCalled();
    expect(prom.publish_light).not.toHaveBeenCalled();
    expect(prom.publish_soil).not.toHaveBeenCalled();
  });
});

describe("MqttNetworking V3 health field mapping", () => {
  it("maps valid boolean fields to 1/0 gauges", () => {
    const { prom } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: {
        network_stack_ready: true,
        wifi_connected: true,
        mqtt_connected: false,
        core_1_active: false,
        utc_valid: true,
      },
    });

    expect(prom.set_network_stack_ready).toHaveBeenCalledWith("v3-src", 1);
    expect(prom.set_wifi_connected).toHaveBeenCalledWith("v3-src", 1);
    expect(prom.set_mqtt_connected).toHaveBeenCalledWith("v3-src", 0);
    expect(prom.set_core_1_active).toHaveBeenCalledWith("v3-src", 0);
    expect(prom.set_utc_valid).toHaveBeenCalledWith("v3-src", 1);
  });

  it("skips a boolean field given as a string, leaving the gauge untouched", () => {
    // The string "true" must not be coerced into a gauge value: getBoolField
    // accepts only typeof boolean, so the setter is never called at all.
    const { prom } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: { wifi_connected: "true" },
    });

    expect(prom.set_wifi_connected).not.toHaveBeenCalled();
  });

  it("maps numeric fields to their set_* gauges with exact values", () => {
    const { prom } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: {
        cpu_temperature_c: 55,
        free_heap_bytes: 123456,
        wifi_rssi_dbm: -60,
      },
    });

    expect(prom.set_cpu_temp).toHaveBeenCalledWith("v3-src", 55);
    expect(prom.set_heap_free_bytes).toHaveBeenCalledWith("v3-src", 123456);
    expect(prom.set_wifi_rssi_dbm).toHaveBeenCalledWith("v3-src", -60);
  });

  it("sets the health-up gauge from the status field", () => {
    const healthy = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: { status: "healthy" },
    });
    expect(healthy.prom.set_health_up).toHaveBeenCalledWith("v3-src", 1);

    const degraded = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: { status: "degraded" },
    });
    expect(degraded.prom.set_health_up).toHaveBeenCalledWith("v3-src", 0);
  });

  it("logs degraded_reasons as a warn without adding any gauge", () => {
    const { prom, logger } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: { status: "degraded", degraded_reasons: ["low_free_heap"] },
    });

    const degradedWarn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "v3_health_degraded"
    );
    expect(degradedWarn).toBeDefined();
    expect(degradedWarn?.[2]).toMatchObject({
      degraded_reasons: ["low_free_heap"],
      status: "degraded",
    });
    // status still drives the up gauge, and degraded_reasons alone adds
    // no gauge of its own.
    expect(prom.set_health_up).toHaveBeenCalledTimes(1);
    expect(prom.set_health_up).toHaveBeenCalledWith("v3-src", 0);
  });

  it("converts top-level uptime_ms to seconds via set_uptime_seconds", () => {
    const { prom } = driveMessage({
      message_type: "health",
      source: "v3-src",
      uptime_ms: 3600000,
      payload: { status: "healthy" },
    });

    expect(prom.set_uptime_seconds).toHaveBeenCalledWith("v3-src", 3600);
  });

  it("errors when a V3 health message has no payload", () => {
    const { prom, logger } = driveMessage({
      message_type: "health",
      source: "v3-src",
    });

    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_health_missing_payload"
      )
    ).toBe(true);
    expect(prom.set_health_up).not.toHaveBeenCalled();
    expect(prom.set_uptime_seconds).not.toHaveBeenCalled();
  });
});

describe("non-string source coercion (regression P3-4)", () => {
  const fw = "1.2.3";

  // A numeric source must be coerced to its string form at extraction
  // instead of throwing in sanitizeSource's .replace and being dropped
  // with an error log. Covers all three extraction sites: V3 per-device
  // telemetry, V2 section telemetry, and V3 health.
  it("publishes V3 telemetry from a numeric source as its string form", () => {
    const airPayload = { temperature_c: 25, humidity_percent: 45, pressure_pa: 100000 };
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: 123,
      firmware_version: fw,
      payload: airPayload,
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      { air: airPayload },
      "123",
      fw
    );
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_handling_error"
      )
    ).toBe(false);
  });

  it("publishes V2 section telemetry from a numeric source as its string form", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      source: 42,
      firmware_version: fw,
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
      },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      expect.anything(),
      "42",
      fw
    );
  });

  it("publishes V3 health from a numeric source as its string form", () => {
    const { prom } = driveMessage({
      message_type: "health",
      source: 7,
      payload: { status: "healthy" },
    });

    expect(prom.set_health_up).toHaveBeenCalledWith("7", 1);
  });
});

describe("missing system_info (regression P2-1)", () => {
  // V3 per-device telemetry does not carry payload.system_info, and V2
  // messages may omit it too. getFirmwareVersion passed that undefined
  // system_info to getField, which indexed obj[fieldName] without guarding
  // the object — a legitimate reading threw a TypeError before the
  // publisher ran and was dropped. The firmware extraction must fall back
  // to "unknown" (or to system_info.firmware_version when present) instead.
  const airPayload = {
    temperature_c: 25,
    humidity_percent: 45,
    pressure_pa: 100000,
  };

  it("publishes V3 telemetry with no system_info, falling back to 'unknown' firmware", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      payload: airPayload,
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      { air: airPayload },
      "v3-src",
      "unknown"
    );
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_handling_error"
      )
    ).toBe(false);
  });

  it("publishes V3 telemetry using system_info.firmware_version as the fallback", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      payload: { ...airPayload, system_info: { firmware_version: "3.1.0" } },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      expect.anything(),
      "v3-src",
      "3.1.0"
    );
  });

  it("publishes V2 section telemetry using system_info.firmware_version as the fallback", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      source: "v2-src",
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
        system_info: { firmware_version: "2.0.1" },
      },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      expect.anything(),
      "v2-src",
      "2.0.1"
    );
  });

  it("publishes V2 section telemetry with no firmware version as 'unknown'", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      source: "v2-src",
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
      },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      expect.anything(),
      "v2-src",
      "unknown"
    );
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_handling_error"
      )
    ).toBe(false);
  });
});

describe("sensor freshness (mark_source_seen)", () => {
  // The freshness gauge must advance exactly once per ACCEPTED message:
  // never per gauge (a health message sets 10+ gauges), and never for
  // dropped/malformed data.
  const fw = "1.2.3";

  it("marks the source seen exactly once per accepted V3 health message", () => {
    const { prom } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: {
        status: "healthy",
        cpu_temperature_c: 55,
        free_heap_bytes: 123456,
        wifi_rssi_dbm: -60,
        devices_active: 4,
      },
    });

    // Several gauges were set from this one message — the timestamp stamp
    // must have been exactly one.
    expect(prom.set_health_up).toHaveBeenCalledTimes(1);
    expect(prom.set_cpu_temp).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("v3-src");
  });

  it("does not mark the source seen when the V3 health message has no payload", () => {
    const { prom } = driveMessage({
      message_type: "health",
      source: "v3-src",
    });

    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("marks the source seen once per accepted V3 device telemetry message", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "yl69_fc28",
      source: "v3-src",
      firmware_version: fw,
      payload: { relative_moisture_percent: 42 },
    });

    expect(prom.publish_soil).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("v3-src");
  });

  it("does not mark the source seen when V3 telemetry fails validation", () => {
    // humidity_percent is required for air devices; the message is dropped
    // and must not claim the source is fresh.
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25 },
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("does not mark the source seen for an unknown V3 device", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "mystery9000",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25 },
    });

    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("marks the source seen for a V2 message carrying a recognized section", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      source: "v2-src",
      firmware_version: fw,
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
        system_info: {},
      },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("v2-src");
  });

  it("does not mark the source seen for a V2 message with no recognized section", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      source: "v2-src",
      firmware_version: fw,
      payload: { something_else: 1 },
    });

    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });
});

describe("subscription SUBACK handling (regression P2-3)", () => {
  // Fire the constructor's "connect" handler so on_connect() issues the
  // subscribe() calls, then capture the (topic, callback) pairs the fake
  // client recorded. baseConfig configures no log/health topics, so there
  // is exactly one subscription (telemetry).
  function driveConnect(): {
    networking: MqttNetworking;
    logger: MockLogger & ILogger;
    subscribe: jest.Mock;
  } {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);
    const client = (
      networking as unknown as { mqtt_client: ReturnType<typeof createMockMqttClient> }
    ).mqtt_client;
    const connectCall = client.on.mock.calls.find((call) => call[0] === "connect");
    if (!connectCall) {
      throw new Error("MqttNetworking did not register a 'connect' handler");
    }
    (connectCall[1] as () => Promise<void>)();
    return { networking, logger, subscribe: client.subscribe as jest.Mock };
  }

  it("logs mqtt_subscription_failed and reports subscriptions inactive when the broker denies the subscription", () => {
    const { networking, logger, subscribe } = driveConnect();

    // No SUBACK yet: the broker has acknowledged nothing.
    expect(networking.subscriptions_active()).toBe(false);
    expect(networking.get_subscription_states()).toEqual([
      { topic: baseConfig.mqttTopicTelemetry, active: false },
    ]);

    expect(subscribe).toHaveBeenCalledTimes(1);
    const [topic, callback] = subscribe.mock.calls[0];
    expect(topic).toBe(baseConfig.mqttTopicTelemetry);
    (callback as (err: Error | undefined, granted?: unknown) => void)(
      new Error("not authorized")
    );

    expect(networking.subscriptions_active()).toBe(false);
    const failures = logger.write_error.mock.calls.filter(
      (call) => call[2]?.event === "mqtt_subscription_failed"
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][2]).toMatchObject({
      mqttTopic: baseConfig.mqttTopicTelemetry,
    });
  });

  it("reports subscriptions active once the broker acknowledges them", () => {
    const { networking, subscribe } = driveConnect();

    expect(networking.subscriptions_active()).toBe(false);
    const [topic, callback] = subscribe.mock.calls[0];
    (callback as (err: Error | undefined, granted?: unknown) => void)(undefined, [
      { topic, qos: 0, isValid: true },
    ]);

    expect(networking.subscriptions_active()).toBe(true);
    expect(networking.get_subscription_states()).toEqual([
      { topic: baseConfig.mqttTopicTelemetry, active: true },
    ]);
  });
});
