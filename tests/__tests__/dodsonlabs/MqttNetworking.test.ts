/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { MqttNetworking } from "../../../src/dodsonlabs/MqttNetworking";
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
// server) never runs. updateConfig does not touch the writer.
jest.mock("../../../src/dodsonlabs/PrometheusWriter");

function createMockMqttClient() {
  return {
    connected: false,
    on: jest.fn(),
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

describe("MqttNetworking.updateConfig restart-only key warning", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
    sensorSourceMaxLength: 30,
    sensorSourceValidCharsRegex: "a-zA-Z0-9._-",
  };

  beforeEach(() => {
    mockConnect.mockReset();
    mockConnect.mockReturnValue(createMockMqttClient());
  });

  function findRestartOnlyWarn(logger: MockLogger) {
    return logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "configuration_restart_only_keys",
    );
  }

  it("warns when sensorSourceMaxLength or sensorSourceValidCharsRegex change at runtime", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({
      ...baseConfig,
      sensorSourceMaxLength: 40,
      sensorSourceValidCharsRegex: "a-zA-Z0-9._-+",
    });

    const warnCall = findRestartOnlyWarn(logger);
    expect(warnCall).toBeDefined();
    expect(warnCall?.[1]).toContain("sensorSourceMaxLength");
    expect(warnCall?.[1]).toContain("sensorSourceValidCharsRegex");
    expect(warnCall?.[2]).toMatchObject({
      event: "configuration_restart_only_keys",
      keys: ["sensorSourceMaxLength", "sensorSourceValidCharsRegex"],
    });
  });

  it("names only the changed sanitization key when the other is untouched", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({ ...baseConfig, sensorSourceMaxLength: 40 });

    const warnCall = findRestartOnlyWarn(logger);
    expect(warnCall).toBeDefined();
    expect(warnCall?.[2]).toMatchObject({
      keys: ["sensorSourceMaxLength"],
    });
  });

  it("still warns for MQTT/port keys captured at construction", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({ ...baseConfig, apiPort: 3399 });

    const warnCall = findRestartOnlyWarn(logger);
    expect(warnCall).toBeDefined();
    expect(warnCall?.[2]).toMatchObject({
      keys: ["apiPort"],
    });
  });

  it("does not warn when only runtime-effective keys change", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({ ...baseConfig, logLevel: "debug" });

    expect(findRestartOnlyWarn(logger)).toBeUndefined();
    // The update itself is still audited.
    const infoCall = logger.write_info.mock.calls.find(
      (call) => call[2]?.event === "configuration_updated",
    );
    expect(infoCall).toBeDefined();
    expect(infoCall?.[2]).toMatchObject({ logLevel: "debug" });
  });
});
