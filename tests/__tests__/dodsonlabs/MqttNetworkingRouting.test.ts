/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { MqttNetworking, MAX_MQTT_PAYLOAD_BYTES } from "../../../src/dodsonlabs/MqttNetworking";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import {
  LOG_BOUND_DEPTH_MARKER,
  LOG_BOUND_MAX_DEPTH,
  LOG_VALUE_MAX_LENGTH,
} from "../../../src/dodsonlabs/SystemFunctions";
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

/**
 * Construct a MqttNetworking on the fake client and deliver a RAW payload
 * buffer to the "message" handler. Unlike driveMessage (which JSON-encodes
 * its input — impossible for deeply nested values, since JSON.stringify is
 * itself recursive past a few thousand levels), this accepts pre-assembled
 * JSON text and non-JSON bodies.
 */
function driveRawPayload(
  payload: Buffer
): { prom: MockProm; logger: MockLogger & ILogger } {
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
  handler(baseConfig.mqttTopicTelemetry, payload, {});
  return {
    prom: (networking as unknown as { promWriter: MockProm }).promWriter,
    logger,
  };
}

/**
 * Construct ONE MqttNetworking on the fake client and deliver several
 * messages through the same "message" handler. Unlike driveMessage (a fresh
 * instance — and thus a fresh auto-mocked promWriter — per message), this
 * shares a single promWriter, so cross-message state (e.g. the
 * firmware-version cardinality set) is observable in one place. Handlers run
 * synchronously, so the calls are observable immediately after delivery.
 */
function driveMessages(
  docs: Record<string, unknown>[]
): { prom: MockProm; logger: MockLogger & ILogger } {
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
  for (const doc of docs) {
    handler(baseConfig.mqttTopicTelemetry, Buffer.from(JSON.stringify(doc)), {});
  }
  return {
    prom: (networking as unknown as { promWriter: MockProm }).promWriter,
    logger,
  };
}

/**
 * Drive a raw payload to the "message" handler on an EXPLICIT topic.
 * driveMessage/driveRawPayload pin the topic to baseConfig.mqttTopicTelemetry,
 * so they cannot reach the topic itself — which is what the topic-bounding
 * regression tests need to exercise.
 */
function driveRawOnTopic(
  topic: string,
  payload: Buffer
): { prom: MockProm; logger: MockLogger & ILogger } {
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
  handler(topic, payload, {});
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
    // An accepted telemetry message stamps the source's freshness exactly
    // once, regardless of how many gauges the publish updates.
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("v3-src");
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
    // Pressure is a required bme280 field, so the missing-field guard
    // drops the message with the normal structured telemetry warning
    // (no silent drop) and the absence of the publish call.
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25, humidity_percent: 45 },
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "telemetry_field_missing"
    );
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({ field: "pressure_pa", source: "v3-src" });
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

describe("telemetry acceptance includes physical-range validation (regression P2-1)", () => {
  // Acceptance is the routing layer's decision: a message is accepted only
  // when EVERY required reading for the device type is present, finite,
  // and within the physical range the publisher enforces. A required
  // reading the publisher would reject (out of range) must not publish,
  // must not advance source freshness, and must not admit the firmware
  // version — otherwise Prometheus would expose a stale gauge next to a
  // fresh sensor_last_seen_timestamp_seconds.
  const fw = "1.2.3";
  const validAirPayload = {
    temperature_c: 25,
    humidity_percent: 45,
    pressure_pa: 100000,
  };

  function outOfRangeWarn(logger: MockLogger & ILogger, field: string) {
    return logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "telemetry_out_of_range" && call[2]?.field === field
    );
  }

  it("rejects soil telemetry with relative_moisture_percent > 100", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "yl69_fc28",
      source: "v3-src",
      firmware_version: fw,
      payload: { relative_moisture_percent: 150 },
    });

    expect(prom.publish_soil).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    const warn = outOfRangeWarn(logger, "relative_moisture_percent");
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({
      value: 150,
      minRange: 0,
      maxRange: 100,
      source: "v3-src",
    });
  });

  it("rejects soil telemetry with negative relative_moisture_percent", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "plantmate_soil",
      source: "v3-src",
      firmware_version: fw,
      payload: { relative_moisture_percent: -1 },
    });

    expect(prom.publish_soil).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    expect(outOfRangeWarn(logger, "relative_moisture_percent")).toBeDefined();
  });

  it("still accepts soil telemetry with a valid percent but an out-of-range optional raw", () => {
    // raw is optional (16-bit ADC, range-checked by the publisher); the
    // calibrated percent is the required field, so the message is accepted
    // and the publisher skips only the raw gauge.
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "yl69_fc28",
      source: "v3-src",
      firmware_version: fw,
      payload: { relative_moisture_percent: 50, raw: 70000 },
    });

    expect(prom.publish_soil).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
  });

  it("accepts soil telemetry at the inclusive range boundaries (0 and 100)", () => {
    for (const percent of [0, 100]) {
      const { prom } = driveMessage({
        message_type: "telemetry",
        device: "yl69_fc28",
        source: "v3-src",
        firmware_version: fw,
        payload: { relative_moisture_percent: percent },
      });

      expect(prom.publish_soil).toHaveBeenCalledTimes(1);
      expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects air telemetry with temperature_c out of the supported Fahrenheit range", () => {
    // 150C = 302F, above the 200F the publisher enforces.
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: { ...validAirPayload, temperature_c: 150 },
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    const warn = outOfRangeWarn(logger, "temperature_c");
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({
      value: 150,
      convertedValue: 302,
      minRange: -100,
      maxRange: 200,
    });
  });

  it("rejects sht35 air telemetry with temperature_c out of range", () => {
    // The sht35 shares the air range even though it needs no pressure.
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "sht35",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: -80, humidity_percent: 45 }, // -94F < -100F
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    expect(outOfRangeWarn(logger, "temperature_c")).toBeDefined();
  });

  it("rejects air telemetry with humidity_percent out of range", () => {
    for (const humidity of [101, -1]) {
      const { prom, logger } = driveMessage({
        message_type: "telemetry",
        device: "bme280",
        source: "v3-src",
        firmware_version: fw,
        payload: { ...validAirPayload, humidity_percent: humidity },
      });

      expect(prom.publish_air).not.toHaveBeenCalled();
      expect(prom.mark_source_seen).not.toHaveBeenCalled();
      expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
      const warn = outOfRangeWarn(logger, "humidity_percent");
      expect(warn).toBeDefined();
      expect(warn?.[2]).toMatchObject({ value: humidity, minRange: 0, maxRange: 100 });
    }
  });

  it("rejects water telemetry with temperature_c out of the supported Fahrenheit range", () => {
    // 200C = 392F, above the 212F the water publisher enforces.
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "ds18b20",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 200 },
    });

    expect(prom.publish_water).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    const warn = outOfRangeWarn(logger, "temperature_c");
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({
      value: 200,
      convertedValue: 392,
      minRange: -50,
      maxRange: 212,
    });
  });

  it("rejects bme280 telemetry missing pressure under both aliases with a structured warning", () => {
    // Valid temperature and humidity, but neither pressure_pa nor
    // pressure_pascal: the message is rejected with the same
    // telemetry_field_missing class used for other required-field
    // failures, naming the canonical field.
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25, humidity_percent: 45 },
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "telemetry_field_missing"
    );
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({ field: "pressure_pa", source: "v3-src" });
  });

  it("rejects bme280 telemetry with a finite but negative pressure", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25, humidity_percent: 45, pressure_pa: -100 },
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    const warn = outOfRangeWarn(logger, "pressure_pa");
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({ value: -100, minRange: 0 });
    expect(warn?.[2]).not.toHaveProperty("maxRange");
  });

  it("accepts bme280 telemetry carrying the legacy pressure_pascal alias", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: {
        temperature_c: 25,
        humidity_percent: 45,
        pressure_pascal: 100000,
      },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
  });

  it("rejects light telemetry with negative lux", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "ltr390",
      source: "v3-src",
      firmware_version: fw,
      payload: { lux: -1, uv_index: 3 },
    });

    expect(prom.publish_light).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    const warn = outOfRangeWarn(logger, "lux");
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({ value: -1, minRange: 0 });
    expect(warn?.[2]).not.toHaveProperty("maxRange");
  });

  it("rejects light telemetry with negative uv_index", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "ltr390",
      source: "v3-src",
      firmware_version: fw,
      payload: { lux: 500, uv_index: -0.5 },
    });

    expect(prom.publish_light).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    const warn = outOfRangeWarn(logger, "uv_index");
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({ value: -0.5, minRange: 0 });
  });

  it("accepts light telemetry at the zero lower bound (0 lux, 0 uv_index)", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "ltr390",
      source: "v3-src",
      firmware_version: fw,
      payload: { lux: 0, uv_index: 0 },
    });

    expect(prom.publish_light).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
  });

  it("emits a single validation warning per rejected message (routing owns the warning)", () => {
    // The publisher's range checks stay as defense in depth, but the
    // normal rejected path never reaches the publisher, so one rejected
    // message produces exactly one structured warning.
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "yl69_fc28",
      source: "v3-src",
      firmware_version: fw,
      payload: { relative_moisture_percent: 150 },
    });

    expect(
      logger.write_warn.mock.calls.filter(
        (call) => call[2]?.event === "telemetry_out_of_range"
      )
    ).toHaveLength(1);
    expect(prom.publish_soil).not.toHaveBeenCalled();
  });
});

describe("MqttNetworking telemetry requires device (V2 removal)", () => {
  // The legacy V2 section-based path was removed: a telemetry message
  // without a usable `device` is rejected with a warning instead of
  // falling through to the section parser. It publishes nothing and does
  // not claim the source is fresh.
  it("drops a legacy V2 section-based telemetry message", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      source: "v2-src",
      firmware_version: "2.0.1",
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
        system_info: { firmware_version: "2.0.1" },
      },
    });

    const warns = logger.write_warn.mock.calls.filter(
      (call) => call[2]?.event === "mqtt_telemetry_missing_device"
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][2]).toMatchObject({ source: "v2-src" });
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("drops a telemetry message whose device is missing, null, or blank", () => {
    for (const doc of [
      { source: "v2-src", payload: { temperature_c: 25 } },
      { device: null, source: "v2-src", payload: { temperature_c: 25 } },
      { device: "", source: "v2-src", payload: { temperature_c: 25 } },
      { device: "   ", source: "v2-src", payload: { temperature_c: 25 } },
    ]) {
      const { prom, logger } = driveMessage({
        message_type: "telemetry",
        ...doc,
      });

      expect(
        logger.write_warn.mock.calls.some(
          (call) => call[2]?.event === "mqtt_telemetry_missing_device"
        )
      ).toBe(true);
      expect(prom.publish_air).not.toHaveBeenCalled();
      expect(prom.mark_source_seen).not.toHaveBeenCalled();
    }
  });

  it("coerces a numeric source to its string form in the missing-device warning", () => {
    const { logger } = driveMessage({
      message_type: "telemetry",
      source: 42,
      payload: { air: {} },
    });

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_telemetry_missing_device"
    );
    expect(warn).toBeDefined();
    expect(warn?.[2]).toMatchObject({ source: "42" });
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
  // with an error log. Covers both extraction sites: V3 per-device
  // telemetry and V3 health.
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

  it("publishes V3 health from a numeric source as its string form", () => {
    const { prom } = driveMessage({
      message_type: "health",
      source: 7,
      payload: { status: "healthy" },
    });

    expect(prom.set_health_up).toHaveBeenCalledWith("7", 1);
  });
});

describe("firmware version extraction", () => {
  // getFirmwareVersion follows the V3 contract: the top-level
  // firmware_version field, falling back to "unknown" when absent. The
  // legacy payload.system_info.firmware_version fallback was removed with
  // the V2 section-based path, so a system_info block in the payload is
  // not consulted (the earlier P2-1 TypeError it could trigger is
  // unreachable — the fallback lookup itself is gone).
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

  it("does not consult payload.system_info.firmware_version (V2 fallback removed)", () => {
    // The legacy V2 fallback read the firmware from payload.system_info.
    // After V2 removal the extraction follows the V3 contract, so this
    // value is ignored and the label falls back to "unknown".
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      payload: { ...airPayload, system_info: { firmware_version: "3.1.0" } },
    });

    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      expect.anything(),
      "v3-src",
      "unknown"
    );
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_handling_error"
      )
    ).toBe(false);
  });
});

describe("firmware-version cardinality (regression P2-1)", () => {
  // Firmware admission (admitFirmwareVersion -> distinct-value cardinality
  // cap) must happen ONLY after the required-field validation passes. A
  // pre-validation admission would let a rejected (invalid) telemetry
  // message permanently consume a firmware-version slot — and, unlike
  // source slots, firmware slots are never freed by stale-source eviction.
  const fw = "1.2.3";
  const validAirPayload = {
    temperature_c: 25,
    humidity_percent: 45,
    pressure_pa: 100000,
  };

  it("does not admit firmware when V3 telemetry fails validation", () => {
    // humidity_percent is required for air; the message is dropped before
    // any firmware extraction, so admission, publishing, and freshness
    // stamping must all be absent.
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25 },
    });

    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("does not admit firmware for an unknown V3 device", () => {
    // The unknown-device gate drops the message before firmware extraction.
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "mystery9000",
      source: "v3-src",
      firmware_version: fw,
      payload: { temperature_c: 25 },
    });

    expect(prom.admitFirmwareVersion).not.toHaveBeenCalled();
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("admits firmware for accepted telemetry and passes the admitted value to the publisher", () => {
    const { prom } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "v3-src",
      firmware_version: fw,
      payload: validAirPayload,
    });

    expect(prom.admitFirmwareVersion).toHaveBeenCalledTimes(1);
    expect(prom.admitFirmwareVersion).toHaveBeenCalledWith(fw);
    expect(prom.publish_air).toHaveBeenCalledWith(
      { air: validAirPayload },
      "v3-src",
      fw
    );
    expect(prom.mark_source_seen).toHaveBeenCalledWith("v3-src");
  });

  it("does not let rejected telemetry consume firmware-version cardinality under a small cap", () => {
    // The real writer's cap is a distinct-value set bounded by
    // sensorSourceCardinalityCap (the writer's own cap logic is covered in
    // PrometheusWriterCardinality.test.ts). Here we stand in with the same
    // set+cap contract so the consequence is observable: one shared writer
    // receives cap-many REJECTED messages and then one ACCEPTED message. The
    // fix admits firmware only for accepted telemetry, so the rejected
    // messages never reach admission and cannot exhaust the cap — under the
    // pre-fix behavior their firmware versions would have filled it and the
    // accepted message's firmware would have been rejected to the fallback.
    const cap = 2;
    const admitted = new Set<string>();
    const rejected: string[] = [];
    const proto = jest.mocked(PrometheusWriter.prototype.admitFirmwareVersion);
    const originalImpl = proto.getMockImplementation();
    proto.mockImplementation((version: string) => {
      if (admitted.has(version)) return version;
      if (admitted.size < cap) {
        admitted.add(version);
        return version;
      }
      rejected.push(version);
      return "unknown_firmware";
    });
    try {
      const { prom, logger } = driveMessages([
        // cap-many rejected bme280 messages, distinct firmware each.
        {
          message_type: "telemetry",
          device: "bme280",
          source: "v3-src",
          firmware_version: "bad-fw-0",
          payload: { temperature_c: 25 },
        },
        {
          message_type: "telemetry",
          device: "bme280",
          source: "v3-src",
          firmware_version: "bad-fw-1",
          payload: { temperature_c: 25 },
        },
        // One accepted message with a fresh firmware version.
        {
          message_type: "telemetry",
          device: "bme280",
          source: "v3-src",
          firmware_version: "good-fw",
          payload: validAirPayload,
        },
      ]);

      // Only the accepted message reached admission; the rejected ones never
      // touched the cap, so the accepted firmware is admitted rather than
      // mapped to the fallback label.
      expect(admitted).toEqual(new Set(["good-fw"]));
      expect(rejected).toEqual([]);
      expect(prom.admitFirmwareVersion).toHaveBeenCalledTimes(1);
      expect(prom.admitFirmwareVersion).toHaveBeenCalledWith("good-fw");
      expect(prom.publish_air).toHaveBeenCalledTimes(1);
      expect(prom.publish_air).toHaveBeenCalledWith(
        expect.anything(),
        "v3-src",
        "good-fw"
      );
      expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
      // No handling error escaped to the logger for the dropped messages.
      expect(
        logger.write_error.mock.calls.some(
          (call) => call[2]?.event === "mqtt_message_handling_error"
        )
      ).toBe(false);
    } finally {
      proto.mockImplementation(originalImpl);
    }
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

  it("does not mark the source seen when the V3 health payload is not an object", () => {
    // A garbage payload (string, number, boolean, array) is rejected at
    // the object-shape boundary instead of being coerced to {}, which
    // would let a malformed message count as accepted activity.
    for (const payload of ["garbage", 42, true, [], [1, 2, 3]]) {
      const { prom, logger } = driveMessage({
        message_type: "health",
        source: "v3-src",
        payload,
      });

      expect(
        logger.write_warn.mock.calls.some(
          (call) => call[2]?.event === "mqtt_health_invalid_payload"
        )
      ).toBe(true);
      expect(prom.mark_source_seen).not.toHaveBeenCalled();
      expect(prom.set_health_up).not.toHaveBeenCalled();
    }
  });

  it("marks the source seen for an empty health payload object (no mandatory V3 health fields)", () => {
    // {} is structurally a valid health object; the V3 contract defines
    // every health field as optional, so it must still count as accepted.
    const { prom } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: {},
    });

    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("v3-src");
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

  it("does not mark the source seen when a telemetry message lacks a device", () => {
    // The message would have carried a recognized V2 section; after V2
    // removal it is dropped at the device gate and must not claim the
    // source is fresh.
    const { prom } = driveMessage({
      message_type: "telemetry",
      source: "v2-src",
      firmware_version: fw,
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
        system_info: {},
      },
    });

    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });
});

describe("untrusted JSON body handling (type-safety regression)", () => {
  // on_message narrows the JSON.parse result to JsonObject before routing:
  // valid JSON that is not an object is dropped with a warning instead of
  // flowing into the handlers, and a message_type that is not an actual
  // string (null, object, array) is proven scalar at the boundary and
  // takes the missing-type drop path instead of being String()-converted.

  function driveRawBody(
    body: string
  ): { prom: MockProm; logger: MockLogger & ILogger } {
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
    handler(baseConfig.mqttTopicTelemetry, Buffer.from(body), {});
    return {
      prom: (networking as unknown as { promWriter: MockProm }).promWriter,
      logger,
    };
  }

  it("drops a valid-JSON body that is an array with a warning and publishes nothing", () => {
    const { prom, logger } = driveRawBody("[1, 2, 3]");

    expect(
      logger.write_warn.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_not_object"
      )
    ).toBe(true);
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("drops a valid-JSON body that is a primitive with a warning and publishes nothing", () => {
    const { prom, logger } = driveRawBody('"just a string"');

    expect(
      logger.write_warn.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_not_object"
      )
    ).toBe(true);
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();
  });

  it("drops a message whose only message_type is null as missing (the ?? coalesces null to undefined)", () => {
    const { prom, logger } = driveMessage({
      message_type: null,
      source: "v3-src",
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
      },
    });

    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_missing_type"
      )
    ).toBe(true);
    expect(prom.publish_air).not.toHaveBeenCalled();
  });

  it("treats a null message_type (both keys null) as missing instead of stringifying it", () => {
    // Null is not a string: the scalar boundary reads it as absent, so the
    // message takes the missing-type drop path rather than routing the old
    // String(null) = "null" to the unknown-type branch.
    const { prom, logger } = driveMessage({
      message_type: null,
      "message-type": null,
      source: "v3-src",
      payload: {
        air: { temperature_c: 25, humidity_percent: 45, pressure_pascal: 100000 },
      },
    });

    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_missing_type"
      )
    ).toBe(true);
    expect(
      logger.write_warn.mock.calls.some(
        (call) => call[2]?.event === "mqtt_unknown_message_type"
      )
    ).toBe(false);
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(
      logger.write_error.mock.calls.some(
        (call) =>
          call[2]?.event === "mqtt_message_parse_error" ||
          call[2]?.event === "mqtt_message_handling_error"
      )
    ).toBe(false);
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

describe("MQTT 'close' invalidates subscription state (regression P2-2)", () => {
  // A transport loss (broker failure, network interruption, socket
  // closure) emits mqtt.js's 'close' event — not 'disconnect', which is
  // reserved for a client-sent DISCONNECT packet (end()). The 'close'
  // handler is the single point that resets subscription_active, so the
  // per-topic mqtt_subscription_active gauge cannot report 1 on a dead
  // connection.
  function driveConnect(): {
    networking: MqttNetworking;
    logger: MockLogger & ILogger;
    subscribe: jest.Mock;
    fireClose: () => void;
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
    const closeCall = client.on.mock.calls.find((call) => call[0] === "close");
    if (!closeCall) {
      throw new Error("MqttNetworking did not register a 'close' handler");
    }
    return {
      networking,
      logger,
      subscribe: client.subscribe as jest.Mock,
      fireClose: () => (closeCall[1] as () => void)(),
    };
  }

  it("registers 'close' — and not 'disconnect' — as the connection-loss handler", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);
    const client = (
      networking as unknown as { mqtt_client: ReturnType<typeof createMockMqttClient> }
    ).mqtt_client;
    const events = client.on.mock.calls.map((call) => call[0]);
    // 'close' fires for both a transport loss and a clean end(), so it is
    // the one ownership point for the reset; keeping a 'disconnect'
    // listener too would log the disconnect twice on a graceful stop
    // (end() emits both events).
    expect(events).toContain("close");
    expect(events).not.toContain("disconnect");
  });

  it("marks every subscription inactive on transport close and logs exactly one warning", () => {
    const { networking, logger, subscribe, fireClose } = driveConnect();

    // Successful SUBACK: the subscription is active.
    (subscribe.mock.calls[0][1] as (err: Error | undefined, granted?: unknown) => void)(
      undefined,
      [{ topic: baseConfig.mqttTopicTelemetry, qos: 0, isValid: true }]
    );
    expect(networking.subscriptions_active()).toBe(true);
    expect(networking.get_subscription_states()).toEqual([
      { topic: baseConfig.mqttTopicTelemetry, active: true },
    ]);

    // Transport close: the broker-side session is gone.
    fireClose();
    expect(networking.subscriptions_active()).toBe(false);
    expect(networking.get_subscription_states()).toEqual([
      { topic: baseConfig.mqttTopicTelemetry, active: false },
    ]);

    // Exactly one connection-loss warning for the single loss.
    const disconnects = logger.write_warn.mock.calls.filter(
      (call) => (call[2] as Record<string, unknown>)?.event === "mqtt_disconnected"
    );
    expect(disconnects).toHaveLength(1);
  });
});

describe("bounding untrusted MQTT values before logging", () => {
  // The logging path applies a size bound to attacker-controlled payload
  // values (source, device, message_type, degraded_reasons, and the
  // forwarded sensor-log body) that the Prometheus label path already bounds
  // for labels. These assert the values supplied to the logger abstraction
  // are bounded (message text AND structured metadata) while the warning/debug
  // event still fires, and that short values pass through unchanged.
  const ELL = "…";
  const CAP = 256;

  it("bounds a very long device value in the unknown-device warning (message + metadata)", () => {
    const longDevice = "d".repeat(1000);
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: longDevice,
      source: "v3-src",
      payload: { temperature_c: 25 },
    });

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_unknown_v3_device"
    );
    expect(warn).toBeDefined();
    const bounded = `${"d".repeat(CAP)}${ELL}`;
    expect(warn?.[1]).toContain(bounded);
    expect(warn?.[1]).not.toContain(longDevice);
    expect(warn?.[2]).toMatchObject({ device: bounded, source: "v3-src" });
    expect(prom.publish_air).not.toHaveBeenCalled();
  });

  it("bounds a very long source value in the missing-field warning (message + metadata)", () => {
    const longSource = "s".repeat(1000);
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: longSource,
      payload: { temperature_c: 25 }, // missing humidity_percent / pressure
    });

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "telemetry_field_missing"
    );
    expect(warn).toBeDefined();
    const bounded = `${"s".repeat(CAP)}${ELL}`;
    expect(warn?.[1]).toContain(bounded);
    expect(warn?.[1]).not.toContain(longSource);
    expect(warn?.[2]).toMatchObject({ source: bounded });
    expect(prom.publish_air).not.toHaveBeenCalled();
  });

  it("bounds a very long message_type value in the unknown-type warning (message + metadata)", () => {
    const longType = "t".repeat(1000);
    const { prom, logger } = driveMessage({
      message_type: longType,
      source: "v3-src",
      payload: { temperature_c: 25 },
    });

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_unknown_message_type"
    );
    expect(warn).toBeDefined();
    const bounded = `${"t".repeat(CAP)}${ELL}`;
    expect(warn?.[1]).toContain(bounded);
    expect(warn?.[1]).not.toContain(longType);
    expect(warn?.[2]).toMatchObject({ messageType: bounded });
    expect(prom.publish_air).not.toHaveBeenCalled();
  });

  it("bounds degraded_reasons by both element count and element length (message + metadata)", () => {
    const reasons = Array.from({ length: 20 }, () => "r".repeat(500));
    const { logger } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: { status: "degraded", degraded_reasons: reasons },
    });

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "v3_health_degraded"
    );
    expect(warn).toBeDefined();
    const bounded = warn?.[2] as Record<string, unknown>;
    const boundedReasons = bounded.degraded_reasons as string[];
    // Element count capped at 10, each element capped at 256 chars + ellipsis.
    expect(boundedReasons).toHaveLength(10);
    for (const element of boundedReasons) {
      expect(element).toBe(`${"r".repeat(CAP)}${ELL}`);
      expect(element.length).toBeLessThanOrEqual(CAP + 1);
    }
    // The joined message is bounded and does not carry any original 500-char reason.
    expect(warn?.[1]).toContain(`${"r".repeat(CAP)}${ELL}`);
    expect(warn?.[1]).not.toContain("r".repeat(500));
  });

  it("bounds the forwarded sensor-log body, source, and firmware_version (message + metadata)", () => {
    const longMessage = "m".repeat(1000);
    const longSource = "s".repeat(1000);
    const longFirmware = "f".repeat(1000);
    const { logger } = driveMessage({
      message_type: "log",
      source: longSource,
      firmware_version: longFirmware,
      payload: { level: "info", message: longMessage },
    });

    const info = logger.write_info.mock.calls.find(
      (call) => call[0] === "networking/logInfo"
    );
    expect(info).toBeDefined();
    const message = info?.[1] as string;
    const meta = info?.[2] as Record<string, unknown>;
    // The whole entry stays bounded even though source + body are each 1000 chars.
    expect(message.length).toBeLessThan(1000);
    expect(message).toContain(`${"s".repeat(CAP)}${ELL}`);
    expect(message).not.toContain(longSource);
    expect(message).not.toContain(longMessage);
    expect(meta.source).toBe(`${"s".repeat(CAP)}${ELL}`);
    expect(meta.firmware_version).toBe(`${"f".repeat(CAP)}${ELL}`);
  });

  it("leaves normal short values unchanged (no ellipsis)", () => {
    const { logger } = driveMessage({
      message_type: "telemetry",
      device: "mystery9000",
      source: "v3-src",
      payload: { temperature_c: 25 },
    });

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_unknown_v3_device"
    );
    expect(warn).toBeDefined();
    expect(warn?.[1]).toBe(`Unknown V3 device type 'mystery9000', dropping message`);
    expect(warn?.[2]).toMatchObject({ device: "mystery9000", source: "v3-src" });
    expect(warn?.[1]).not.toContain(ELL);
  });

  // The MQTT topic is untrusted protocol metadata, like the payload fields
  // above: bound it for the log channel (structured metadata) while the
  // case-folded routing comparison still uses the raw, untruncated value.
  it("bounds a very long MQTT topic in the not-object warning (metadata)", () => {
    const longTopic = "t".repeat(1000);
    // A valid-JSON array body triggers the not-object drop, which logs the
    // topic; routing is irrelevant here because that check precedes it.
    const { logger } = driveRawOnTopic(longTopic, Buffer.from("[1, 2, 3]"));

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_message_not_object"
    );
    expect(warn).toBeDefined();
    expect(warn?.[2]?.topic).toBe(longTopic.slice(0, CAP) + ELL);
    expect((warn?.[2]?.topic as string).length).toBe(CAP + 1);
  });

  it("bounds a very long MQTT topic in the oversized-payload warning (metadata)", () => {
    const longTopic = "t".repeat(1000);
    const oversize = Buffer.alloc(MAX_MQTT_PAYLOAD_BYTES + 1, 65);
    const { logger } = driveRawOnTopic(longTopic, oversize);

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_payload_too_large"
    );
    expect(warn).toBeDefined();
    expect(warn?.[2]?.topic).toBe(longTopic.slice(0, CAP) + ELL);
    expect((warn?.[2]?.topic as string).length).toBe(CAP + 1);
  });

  it("leaves a short MQTT topic unchanged in the not-object warning", () => {
    const { logger } = driveRawOnTopic("iot/v3/telemetry", Buffer.from("[1]"));

    const warn = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_message_not_object"
    );
    expect(warn).toBeDefined();
    expect(warn?.[2]?.topic).toBe("iot/v3/telemetry");
    expect(warn?.[2]?.topic).not.toContain(ELL);
  });
});

describe("bounded structured metadata in forwarded sensor logs (regression P2-2)", () => {
  const ELL = "…";
  const CAP = 256;

  // Every assertion targets the metadata the forwarded log reaches the
  // logger with: the message TEXT was already bounded, but the structured
  // metadata was an unrestricted side channel around those limits.

  function logMeta(doc: Record<string, unknown>): Record<string, unknown> {
    const { logger } = driveMessage(doc);
    const info = logger.write_info.mock.calls.find(
      (call) => call[0] === "networking/logInfo"
    );
    expect(info).toBeDefined();
    return info?.[2] as Record<string, unknown>;
  }

  it("bounds a 5000-character command_id", () => {
    const meta = logMeta({
      message_type: "log",
      source: "src",
      payload: { level: "info", message: "m", command_id: "c".repeat(5000) },
    });
    expect(meta.commandId).toBe(`${"c".repeat(CAP)}${ELL}`);
  });

  it("bounds a 5000-character target", () => {
    const meta = logMeta({
      message_type: "log",
      source: "src",
      payload: { level: "info", message: "m", target: "t".repeat(5000) },
    });
    expect(meta.target).toBe(`${"t".repeat(CAP)}${ELL}`);
  });

  it("bounds the Loki label fields (module, function, runtime_id, schema_version, level)", () => {
    const meta = logMeta({
      message_type: "log",
      source: "src",
      runtime_id: "r".repeat(5000),
      schema_version: "s".repeat(5000),
      payload: {
        level: "INFO",
        message: "m",
        module: "u".repeat(5000),
        function: "f".repeat(5000),
      },
    });
    expect(meta.module).toBe(`${"u".repeat(CAP)}${ELL}`);
    expect(meta.function).toBe(`${"f".repeat(CAP)}${ELL}`);
    expect(meta.runtime_id).toBe(`${"r".repeat(CAP)}${ELL}`);
    expect(meta.schema_version).toBe(`${"s".repeat(CAP)}${ELL}`);
    expect(meta.level).toBe("info");
  });

  it("bounds large strings nested inside data", () => {
    const meta = logMeta({
      message_type: "log",
      source: "src",
      payload: {
        level: "info",
        message: "m",
        data: { detail: "d".repeat(5000), count: 3 },
      },
    });
    const data = meta.data as Record<string, unknown>;
    expect(data.detail).toBe(`${"d".repeat(CAP)}${ELL}`);
    // Structure and non-string fields are preserved for Loki.
    expect(data.count).toBe(3);
  });

  it("caps data arrays at 10 elements", () => {
    const meta = logMeta({
      message_type: "log",
      source: "src",
      payload: {
        level: "info",
        message: "m",
        data: { reasons: Array.from({ length: 25 }, (_, i) => `r${i}`) },
      },
    });
    const data = meta.data as Record<string, unknown>;
    expect(data.reasons).toEqual(
      Array.from({ length: 10 }, (_, i) => `r${i}`)
    );
  });

  it("survives deeply nested data without stack exhaustion and marks the depth cap", () => {
    let node: Record<string, unknown> = { leaf: "bottom" };
    for (let i = 0; i < 100; i++) node = { child: node };
    const meta = logMeta({
      message_type: "log",
      source: "src",
      payload: { level: "info", message: "m", data: node },
    });

    // Walk the bounded chain: it must be flat (depth cap) and terminate in
    // the marker string rather than a 100-level object graph.
    let depth = 0;
    let current: unknown = meta.data;
    while (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      "child" in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>).child;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(10);
    expect(typeof current).toBe("string");
  });

  it("does not mutate the original MQTT payload object", () => {
    const data = { detail: "x".repeat(5000), list: Array.from({ length: 12 }, (_, i) => `i${i}`) };
    const doc = {
      message_type: "log",
      source: "src",
      payload: { level: "info", message: "m", data },
    };
    const snapshot = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    logMeta(doc);
    expect(doc).toEqual(snapshot);
  });

  it("keeps small structured data structurally equivalent (Loki queryability)", () => {
    const data = { event: "command_ack", count: 2, ok: true, detail: { sensor: "bme280" } };
    const meta = logMeta({
      message_type: "log",
      source: "src",
      payload: { level: "info", message: "m", data },
    });
    expect(meta.data).toEqual(data);
  });

  it("preserves secret-looking key names in data so the Logger's redaction still matches", () => {
    const meta = logMeta({
      message_type: "log",
      source: "src",
      payload: {
        level: "info",
        message: "m",
        data: { password: "hunter2", apiKey: "abc" },
      },
    });
    // boundForLog must not rename short keys: the Logger's recursive
    // redaction matches on exactly these names downstream.
    const data = meta.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["apiKey", "password"]);
  });
});

describe("MQTT payload size guard (regression)", () => {
  const wasSizeGuarded = (logger: MockLogger): boolean =>
    logger.write_warn.mock.calls.some(
      (call) => (call[2] as Record<string, unknown>)?.event === "mqtt_payload_too_large"
    );

  it("rejects an oversized payload before parsing without touching gauges or source freshness", () => {
    const payload = Buffer.alloc(MAX_MQTT_PAYLOAD_BYTES + 1, 0x61);
    const { prom, logger } = driveRawPayload(payload);

    expect(wasSizeGuarded(logger)).toBe(true);
    expect(logger.write_warn.mock.calls.find(
      (call) => (call[2] as Record<string, unknown>)?.event === "mqtt_payload_too_large"
    )![2]).toMatchObject({
      byteLength: payload.length,
      maxBytes: MAX_MQTT_PAYLOAD_BYTES,
      topic: baseConfig.mqttTopicTelemetry,
    });

    // Not parsed, not routed: no telemetry publisher ran and the freshness
    // stamp was not written.
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.publish_soil).not.toHaveBeenCalled();
    expect(prom.publish_water).not.toHaveBeenCalled();
    expect(prom.publish_light).not.toHaveBeenCalled();
    expect(prom.mark_source_seen).not.toHaveBeenCalled();

    // The rejection is a warn, not a parse error — JSON.parse never ran.
    expect(logger.write_error).not.toHaveBeenCalled();

    // The oversized contents are never copied into any log line.
    for (const call of [
      ...logger.write_warn.mock.calls,
      ...logger.write_error.mock.calls,
      ...logger.write_info.mock.calls,
      ...logger.write_debug.mock.calls,
    ]) {
      expect(JSON.stringify(call)).not.toContain("a".repeat(100));
    }
  });

  it("does not reject a valid payload whose byte length is exactly the cap", () => {
    // Build a well-formed telemetry message whose serialized length is
    // exactly MAX_MQTT_PAYLOAD_BYTES: the size guard must let it through.
    const doc = {
      message_type: "telemetry",
      device: "ds18b20",
      source: "boundary-src",
      firmware_version: "1.0",
      payload: { temperature_c: 20, pad: "" },
    };
    const baseLength = JSON.stringify(doc).length;
    doc.payload.pad = "a".repeat(MAX_MQTT_PAYLOAD_BYTES - baseLength);
    const serialized = JSON.stringify(doc);
    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_MQTT_PAYLOAD_BYTES);

    const { prom, logger } = driveRawPayload(Buffer.from(serialized, "utf8"));

    expect(wasSizeGuarded(logger)).toBe(false);
    expect(prom.publish_water).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("boundary-src");
  });

  it("lets a malformed at-cap payload fail in JSON.parse, not the size guard", () => {
    // Exactly at the cap but not JSON: the guard must not fire, and the
    // parse-error path is what logs the failure (without payload contents).
    const payload = Buffer.alloc(MAX_MQTT_PAYLOAD_BYTES, 0x61);
    const { logger } = driveRawPayload(payload);

    expect(wasSizeGuarded(logger)).toBe(false);
    expect(logger.write_error.mock.calls.some(
      (call) => (call[2] as Record<string, unknown>)?.event === "mqtt_message_parse_error"
    )).toBe(true);
  });
});

describe("health status scalar boundary (regression P2-1)", () => {
  // status must be normalized BEFORE any health gauge is mutated: a
  // malformed structured status follows the missing-field policy (the
  // health-up gauge stays untouched) without leaving contradictory
  // partial state, and in the log channel it is bounded like every other
  // untrusted value.
  const ELL = "…";

  // 25,000 levels of nesting: the old String(status) recursion overflowed
  // at ~1,000 levels (RangeError), and this document serializes to ~50 KiB
  // — under the 64 KiB payload cap. JSON.stringify cannot build such a
  // structure (it is itself recursive past a few thousand levels), so the
  // JSON text is assembled directly.
  const NEST = 25000;
  const nestedStatusText = `${"[".repeat(NEST)}"leaf"${"]".repeat(NEST)}`;

  it("survives a deeply nested health status without partial state or error events", () => {
    const body = `{"message_type":"health","source":"test-health-1","payload":{"cpu_temperature_c":42,"status":${nestedStatusText}}}`;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MAX_MQTT_PAYLOAD_BYTES);
    const { prom, logger } = driveRawPayload(Buffer.from(body, "utf8"));

    // No RangeError surfaced as a parse or handling error.
    const errorEvents = logger.write_error.mock.calls.map(
      (call) => (call[2] as Record<string, unknown>)?.event
    );
    expect(errorEvents).not.toContain("mqtt_message_parse_error");
    expect(errorEvents).not.toContain("mqtt_message_handling_error");

    // The malformed status follows the missing-field policy: the
    // health-up gauge is left untouched ...
    expect(prom.set_health_up).not.toHaveBeenCalled();
    // ... and the rest of the message processed to completion (no partial
    // state): the cpu gauge was set and the source stamped fresh.
    expect(prom.set_cpu_temp).toHaveBeenCalledWith("test-health-1", 42);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("test-health-1");
  });

  it("treats structured (non-string) health statuses as absent, still accepting the message", () => {
    for (const status of [[], ["healthy"], { value: "healthy" }, true, null]) {
      const { prom } = driveMessage({
        message_type: "health",
        source: "v3-src",
        payload: { status },
      });

      expect(prom.set_health_up).not.toHaveBeenCalled();
      // A malformed status does not drop the message: the payload is a
      // structurally valid health object, so the source counts as seen.
      expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
      expect(prom.mark_source_seen).toHaveBeenCalledWith("v3-src");
    }
  });

  it("bounds a long health status string in the processed log metadata", () => {
    const longStatus = "h".repeat(300);
    const { prom, logger } = driveMessage({
      message_type: "health",
      source: "v3-src",
      payload: { status: longStatus },
    });

    const processed = logger.write_debug.mock.calls.find(
      (call) => (call[2] as Record<string, unknown>)?.event === "v3_health_processed"
    );
    expect(processed).toBeDefined();
    // Bounded by the project's log limit, not the raw 300-char value.
    expect(processed?.[2]).toMatchObject({
      status: `${"h".repeat(LOG_VALUE_MAX_LENGTH)}${ELL}`,
    });
    // The status still drives the gauge: a non-"healthy" string is down.
    expect(prom.set_health_up).toHaveBeenCalledTimes(1);
    expect(prom.set_health_up).toHaveBeenCalledWith("v3-src", 0);
  });
});

describe("deeply nested degraded_reasons (regression P2-1)", () => {
  // degraded_reasons is validated as an array, but its individual elements
  // are not guaranteed to be scalar. The old String(value) coercion in
  // truncateForLog overflowed the stack at a few thousand levels (RangeError)
  // — AFTER some health gauges were already written — leaving partial state
  // with a stale freshness stamp. Reasons are now structurally bounded
  // before stringification, so the message processes to completion.
  const NEST = 25000;

  it("completes health processing with bounded log metadata and no error events", () => {
    const body = `{"message_type":"health","source":"test-health-deep","payload":{"cpu_temperature_c":42,"degraded_reasons":[${"[".repeat(NEST)}"leaf"${"]".repeat(NEST)}]}}`;
    // Under the 64 KiB payload cap: this exercises the stringification
    // defect, not the size guard.
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MAX_MQTT_PAYLOAD_BYTES);
    const { prom, logger } = driveRawPayload(Buffer.from(body, "utf8"));

    // No RangeError surfaced as a parse or handling error.
    const errorEvents = logger.write_error.mock.calls.map(
      (call) => (call[2] as Record<string, unknown>)?.event
    );
    expect(errorEvents).not.toContain("mqtt_message_parse_error");
    expect(errorEvents).not.toContain("mqtt_message_handling_error");

    // The message processed to completion (no partial state): the cpu gauge
    // was set and the source stamped fresh.
    expect(prom.set_cpu_temp).toHaveBeenCalledWith("test-health-deep", 42);
    expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
    expect(prom.mark_source_seen).toHaveBeenCalledWith("test-health-deep");

    // The degraded reason is still surfaced as a warn ...
    const degraded = logger.write_warn.mock.calls.find(
      (call) => (call[2] as Record<string, unknown>)?.event === "v3_health_degraded"
    );
    expect(degraded).toBeDefined();
    // ... with its metadata bounded: each reason is capped at the project
    // log limit, and no unbounded bracket expansion leaks into the log.
    const reasons = degraded?.[2]?.degraded_reasons as unknown;
    expect(Array.isArray(reasons)).toBe(true);
    for (const reason of reasons as string[]) {
      expect(reason.length).toBeLessThanOrEqual(LOG_VALUE_MAX_LENGTH + 1);
      expect(reason).not.toContain("[".repeat(100));
    }
  });
});

describe("deeply nested forwarded sensor-log body (regression P2-1)", () => {
  // The forwarded log body was serialized with a bare JSON.stringify before
  // its length was capped: a deeply nested hostile payload exhausts the call
  // stack (RangeError: Maximum call stack size exceeded) before the cap can
  // apply, so the message was dropped as mqtt_message_handling_error. The
  // body is now structurally bounded (boundForLog) before serialization,
  // like every other untrusted structured value in the log channel.
  //
  // ~5,000 levels of short-key nesting: deep enough for a bare
  // JSON.stringify to throw, yet JSON.parse (which the service runs first)
  // still succeeds and the document stays under the 64 KiB payload cap, so
  // this exercises the serialization defect, not the size guard. The test
  // cannot assemble this fixture with JSON.stringify either (it is itself
  // recursive past a few thousand levels), so the JSON text is built
  // directly by string wrapping.
  const NEST = 5000;

  function nestedBody(levels: number): string {
    let text = '{"leaf":"deep"}';
    for (let i = 0; i < levels; i++) text = `{"child":${text}}`;
    return text;
  }

  it("forwards a deeply nested log body with a bounded, marked representation", () => {
    const body = `{"message_type":"log","source":"test-log-deep","payload":{"level":"info","message":${nestedBody(NEST)}}}`;
    // Under the 64 KiB payload cap: this exercises the stringification
    // defect, not the size guard.
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MAX_MQTT_PAYLOAD_BYTES);
    const { logger } = driveRawPayload(Buffer.from(body, "utf8"));

    // The RangeError no longer surfaces as a parse or handling error.
    const errorEvents = logger.write_error.mock.calls.map(
      (call) => (call[2] as Record<string, unknown>)?.event
    );
    expect(errorEvents).not.toContain("mqtt_message_parse_error");
    expect(errorEvents).not.toContain("mqtt_message_handling_error");

    // The log is still forwarded — exactly once — ...
    const infos = logger.write_info.mock.calls.filter(
      (call) => call[0] === "networking/logInfo"
    );
    expect(infos).toHaveLength(1);
    const message = infos[0][1] as string;
    // ... bounded: the serialized body terminates in the depth marker
    // instead of carrying ~5,000 nested levels into the log line.
    expect(message).toContain(LOG_BOUND_DEPTH_MARKER);
    expect(message.split('"child"').length - 1).toBeLessThanOrEqual(LOG_BOUND_MAX_DEPTH);
    // The whole line stays bounded (source + body each capped at 256 + ellipsis).
    expect(message.length).toBeLessThanOrEqual(2 * (LOG_VALUE_MAX_LENGTH + 1) + 4);

    // ... and the message processed to completion (metadata intact).
    const meta = infos[0][2] as Record<string, unknown>;
    expect(meta.source).toBe("test-log-deep");
    expect(meta.level).toBe("info");
  });

  it("keeps the existing shallow-object log formatting unchanged", () => {
    const { logger } = driveMessage({
      message_type: "log",
      source: "src",
      payload: { level: "info", message: { event: "ack", count: 2 } },
    });

    const info = logger.write_info.mock.calls.find(
      (call) => call[0] === "networking/logInfo"
    );
    expect(info).toBeDefined();
    // boundForLog leaves a small shallow object structurally identical, so
    // the serialized text is exactly what a bare JSON.stringify produced.
    expect(info?.[1]).toBe(`[src] ${JSON.stringify({ event: "ack", count: 2 })}`);
  });
});

describe("scalar boundary for untrusted protocol fields (regression P2-1)", () => {
  // Every scalar protocol field must treat a structured (non-string,
  // non-finite-number) value exactly like an absent one — through the
  // existing drop/fallback paths, with no new semantics — and none of
  // them may recurse into the value (the old String() coercion overflowed
  // the stack on deeply nested payloads).

  const airPayload = { temperature_c: 25, humidity_percent: 45, pressure_pa: 100000 };

  // ~2,000 levels of nesting: past the point where String() overflowed
  // (~1,000 levels) but safely below JSON.stringify's own recursion
  // limit, so driveMessage can still encode the document.
  let deep: Record<string, unknown> = { leaf: "deep" };
  for (let i = 0; i < 2000; i++) deep = { child: deep };

  const structuredValues: Array<[string, unknown]> = [
    ["array", ["telemetry"]],
    ["nested array", [["telemetry"]]],
    ["object", { value: "telemetry" }],
    ["deep object", deep],
    ["boolean", true],
    ["null", null],
  ];

  interface FieldCase {
    label: string;
    drive: (value: unknown) => { prom: MockProm; logger: MockLogger & ILogger };
    expectHandled: (prom: MockProm, logger: MockLogger & ILogger) => void;
  }

  // Drive one forwarded-log document at the log topic: the field cases
  // for `level` need a config with mqttTopicLog, which baseConfig lacks.
  function driveLogMessage(doc: Record<string, unknown>): { logger: MockLogger & ILogger } {
    const logger = createMockLogger();
    const networking = new MqttNetworking(
      { ...baseConfig, mqttTopicLog: "iot/v3/log" },
      logger
    );
    const onMock = (networking as unknown as { mqtt_client: { on: jest.Mock } }).mqtt_client.on;
    const messageCall = onMock.mock.calls.filter((call) => call[0] === "message").at(-1);
    if (!messageCall) {
      throw new Error("MqttNetworking did not register a 'message' handler");
    }
    const handler = messageCall[1] as (
      topic: string,
      payload: Buffer,
      packet: unknown
    ) => void;
    handler("iot/v3/log", Buffer.from(JSON.stringify(doc)), {});
    return { logger };
  }

  const fieldCases: FieldCase[] = [
    {
      label: "message_type",
      drive: (value) =>
        driveMessage({
          message_type: value,
          device: "bme280",
          source: "tbl-src",
          firmware_version: "1.0.0",
          payload: airPayload,
        }),
      expectHandled: (prom, logger) => {
        // A structured type reads as missing: the existing missing-type drop.
        expect(
          logger.write_error.mock.calls.some(
            (call) => call[2]?.event === "mqtt_message_missing_type"
          )
        ).toBe(true);
        expect(prom.publish_air).not.toHaveBeenCalled();
      },
    },
    {
      label: "device",
      drive: (value) =>
        driveMessage({
          message_type: "telemetry",
          device: value,
          source: "tbl-src",
          payload: airPayload,
        }),
      expectHandled: (prom, logger) => {
        // A structured device reads as missing: the existing missing-device drop.
        expect(
          logger.write_warn.mock.calls.some(
            (call) => call[2]?.event === "mqtt_telemetry_missing_device"
          )
        ).toBe(true);
        expect(prom.publish_air).not.toHaveBeenCalled();
      },
    },
    {
      label: "source",
      drive: (value) =>
        driveMessage({
          message_type: "telemetry",
          device: "bme280",
          source: value,
          firmware_version: "1.0.0",
          payload: airPayload,
        }),
      expectHandled: (prom) => {
        // A structured source reads as absent and falls back to "unknown";
        // the message is still published.
        expect(prom.publish_air).toHaveBeenCalledTimes(1);
        expect(prom.publish_air).toHaveBeenCalledWith(
          { air: airPayload },
          "unknown",
          "1.0.0"
        );
      },
    },
    {
      label: "firmware_version",
      drive: (value) =>
        driveMessage({
          message_type: "telemetry",
          device: "bme280",
          source: "tbl-src",
          firmware_version: value,
          payload: airPayload,
        }),
      expectHandled: (prom) => {
        // A structured version reads as absent: the "unknown" label, and
        // the message is still published.
        expect(prom.publish_air).toHaveBeenCalledTimes(1);
        expect(prom.publish_air).toHaveBeenCalledWith(
          { air: airPayload },
          "tbl-src",
          "unknown"
        );
      },
    },
    {
      label: "level (forwarded sensor log)",
      drive: (value) => {
        const { logger } = driveLogMessage({
          message: "tbl log message",
          source: "tbl-src",
          level: value,
        });
        return { prom: {} as MockProm, logger };
      },
      expectHandled: (_prom, logger) => {
        // A structured level reads as absent and defaults to "info"; the
        // message is still forwarded (at info, above the debug threshold).
        const forwarded = logger.write_info.mock.calls.find(
          (call) =>
            (call[2] as Record<string, unknown>)?.logType === "sensor"
        );
        expect(forwarded).toBeDefined();
        expect(forwarded?.[2]).toMatchObject({
          level: "info",
          source: "tbl-src",
        });
      },
    },
    {
      label: "status (V3 health)",
      drive: (value) =>
        driveMessage({
          message_type: "health",
          source: "tbl-src",
          payload: { status: value },
        }),
      expectHandled: (prom) => {
        // A structured status reads as absent: the health-up gauge is left
        // untouched, but the message is still accepted (source stamped).
        expect(prom.set_health_up).not.toHaveBeenCalled();
        expect(prom.mark_source_seen).toHaveBeenCalledTimes(1);
        expect(prom.mark_source_seen).toHaveBeenCalledWith("tbl-src");
      },
    },
  ];

  const rows: Array<
    [
      string,
      unknown,
      (value: unknown) => { prom: MockProm; logger: MockLogger & ILogger },
      (prom: MockProm, logger: MockLogger & ILogger) => void
    ]
  > = [];
  for (const fieldCase of fieldCases) {
    for (const [valueLabel, value] of structuredValues) {
      rows.push([`${fieldCase.label} = ${valueLabel}`, value, fieldCase.drive, fieldCase.expectHandled]);
    }
  }

  it.each(rows)(
    "treats a %s as absent through the existing path without recursing into the value",
    (_fullName, value, drive, expectHandled) => {
      const { prom, logger } = drive(value);
      expectHandled(prom, logger);

      // The pipeline completed: no parse error, no handling error, no
      // unhandled rejection surfaced.
      const errorEvents = logger.write_error.mock.calls.map(
        (call) => (call[2] as Record<string, unknown>)?.event
      );
      expect(errorEvents).not.toContain("mqtt_message_parse_error");
      expect(errorEvents).not.toContain("mqtt_message_handling_error");
    }
  );
});

describe("numeric compatibility at the scalar boundary (regression P2-1)", () => {
  // source, device, and firmware_version accept finite numbers (coerced to
  // their string form) in addition to strings — message_type, log level,
  // and health status do NOT (string-only). A numeric source is already
  // covered by the P3-4 describe; here: device and firmware_version.

  it("coerces a numeric device to its string form before the known-device lookup", () => {
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: 42,
      source: "tbl-numeric",
      payload: { temperature_c: 20 },
    });

    // "42" is not a known V3 device: the unknown-device warning names the
    // coerced string, proving the coercion happened at extraction.
    const warning = logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "mqtt_unknown_v3_device"
    );
    expect(warning).toBeDefined();
    expect(warning?.[2]).toMatchObject({ device: "42" });
    expect(prom.publish_air).not.toHaveBeenCalled();
    expect(prom.publish_water).not.toHaveBeenCalled();
  });

  it("coerces a numeric firmware_version to its string form (0 is not absent)", () => {
    const airPayload = { temperature_c: 25, humidity_percent: 45, pressure_pa: 100000 };
    const { prom, logger } = driveMessage({
      message_type: "telemetry",
      device: "bme280",
      source: "tbl-numeric",
      firmware_version: 0,
      payload: airPayload,
    });

    // 0 is a finite number, not a falsy trap: it becomes the label "0".
    expect(prom.publish_air).toHaveBeenCalledTimes(1);
    expect(prom.publish_air).toHaveBeenCalledWith(
      { air: airPayload },
      "tbl-numeric",
      "0"
    );
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_message_handling_error"
      )
    ).toBe(false);
  });
});

describe("deeply nested message_type (regression P2-1)", () => {
  // 25,000 levels: the old String(message_type) recursion overflowed at
  // ~1,000 levels (RangeError, which the broad catch mislabeled as a parse
  // error). The scalar boundary reads the value as absent instead — the
  // message is dropped through the existing missing-type path.
  const NEST = 25000;

  it("is rejected as missing type, not a parse error or a crash", () => {
    const body = `{"message_type":${"[".repeat(NEST)}"leaf"${"]".repeat(NEST)},
"device":"bme280","source":"tbl-deep","payload":{"temperature_c":20}}`;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MAX_MQTT_PAYLOAD_BYTES);
    const { prom, logger } = driveRawPayload(Buffer.from(body, "utf8"));

    const errorEvents = logger.write_error.mock.calls.map(
      (call) => (call[2] as Record<string, unknown>)?.event
    );
    // Dropped via the existing missing-type path ...
    expect(errorEvents).toContain("mqtt_message_missing_type");
    // ... with no RangeError surfacing as a parse or handling error.
    expect(errorEvents).not.toContain("mqtt_message_parse_error");
    expect(errorEvents).not.toContain("mqtt_message_handling_error");
    expect(prom.publish_air).not.toHaveBeenCalled();
  });
});

describe("error classification in on_message (regression P2-1)", () => {
  // A malformed body is a parse error; a valid body that throws during
  // processing is a handling error. The two are distinct events, each with
  // the topic, and one exception is never logged under both.

  function buildTelemetryDriver(): {
    prom: MockProm;
    logger: MockLogger & ILogger;
    driveRaw: (payload: Buffer) => void;
    drive: (doc: Record<string, unknown>) => void;
  } {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);
    const onMock = (
      networking as unknown as { mqtt_client: { on: jest.Mock } }
    ).mqtt_client.on;
    const messageCall = onMock.mock.calls
      .filter((call) => call[0] === "message")
      .at(-1);
    if (!messageCall) {
      throw new Error("MqttNetworking did not register a 'message' handler");
    }
    const handler = messageCall[1] as (
      topic: string,
      payload: Buffer,
      packet: unknown
    ) => void;
    return {
      prom: (networking as unknown as { promWriter: MockProm }).promWriter,
      logger,
      driveRaw: (payload) => handler(baseConfig.mqttTopicTelemetry, payload, {}),
      drive: (doc) =>
        handler(
          baseConfig.mqttTopicTelemetry,
          Buffer.from(JSON.stringify(doc)),
          {}
        ),
    };
  }

  it("classifies malformed JSON as a parse error only", () => {
    const { logger, driveRaw } = buildTelemetryDriver();
    // Truncated body: valid as text, invalid as JSON.
    driveRaw(Buffer.from('{"message_type":"telemetry","devic', "utf8"));

    const parseErrors = logger.write_error.mock.calls.filter(
      (call) => call[2]?.event === "mqtt_message_parse_error"
    );
    expect(parseErrors).toHaveLength(1);
    // The topic is preserved for triage ...
    expect(parseErrors[0]?.[2]).toMatchObject({
      topic: baseConfig.mqttTopicTelemetry,
    });
    // ... and the body never reached routing: no missing-type or handling
    // error, and the parse failure is not also logged as a handling error.
    const allEvents = logger.write_error.mock.calls.map(
      (call) => (call[2] as Record<string, unknown>)?.event
    );
    expect(allEvents).not.toContain("mqtt_message_handling_error");
    expect(allEvents).not.toContain("mqtt_message_missing_type");
  });

  it("classifies a post-parse processing throw as a handling error only", () => {
    const { prom, logger, drive } = buildTelemetryDriver();
    // Simulate a processing failure: the (auto-mocked) publisher throws.
    prom.publish_water.mockImplementation(() => {
      throw new Error("simulated handler failure");
    });

    drive({
      message_type: "telemetry",
      device: "ds18b20",
      source: "tbl-err",
      payload: { temperature_c: 20 },
    });
    // handle_mqtt_message is synchronous, so the throw is caught by the
    // outer catch in on_message and the handling-error log lands before
    // drive returns — no microtask flush needed.

    const handlingErrors = logger.write_error.mock.calls.filter(
      (call) => call[2]?.event === "mqtt_message_handling_error"
    );
    expect(handlingErrors).toHaveLength(1);
    expect(handlingErrors[0]?.[2]).toMatchObject({
      topic: baseConfig.mqttTopicTelemetry,
    });
    // The exception's message is preserved in the logged error.
    const loggedError = (handlingErrors[0]?.[2] as Record<string, unknown>)?.error;
    expect(String(loggedError)).toContain("simulated handler failure");

    // The body parsed fine: no parse error for the same exception.
    const allEvents = logger.write_error.mock.calls.map(
      (call) => (call[2] as Record<string, unknown>)?.event
    );
    expect(allEvents).not.toContain("mqtt_message_parse_error");
  });
});
