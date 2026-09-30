/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { validateConfig } from "../../../src/schemas/config";

describe("validateConfig", () => {
  const validConfig = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  it("accepts a minimal valid config", () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it("accepts a config with all optional keys", () => {
    const full = {
      ...validConfig,
      mqttTopicLog: "iot/v3/log",
      mqttTopicHealth: "iot/v3/health",
      sensorSourceMaxLength: 30,
      sensorSourceValidCharsRegex: "a-zA-Z0-9._-",
      forwardSensorLogs: true,
      forwardSensorLogsLevel: "debug",
    };
    expect(validateConfig(full)).toEqual(full);
  });

  it("rejects a missing required key", () => {
    expect(() =>
      validateConfig({ logLevel: "info", apiPort: 3301 })
    ).toThrow(/mqttBrokerIpAddress/);
  });

  it("rejects an invalid logLevel", () => {
    expect(() => validateConfig({ ...validConfig, logLevel: "verbose" })).toThrow(
      /logLevel/
    );
  });

  it("rejects a non-integer or non-positive apiPort", () => {
    expect(() => validateConfig({ ...validConfig, apiPort: 0 })).toThrow(/apiPort/);
    expect(() => validateConfig({ ...validConfig, apiPort: 3.5 })).toThrow(/apiPort/);
  });

  it("rejects an apiPort above the maximum TCP port", () => {
    expect(() => validateConfig({ ...validConfig, apiPort: 65536 })).toThrow(
      /apiPort/
    );
    expect(() => validateConfig({ ...validConfig, apiPort: 999999 })).toThrow(
      /apiPort/
    );
  });

  it("accepts apiPort at the maximum TCP port", () => {
    expect(() => validateConfig({ ...validConfig, apiPort: 65535 })).not.toThrow();
  });

  it("rejects an empty broker address or telemetry topic", () => {
    expect(() =>
      validateConfig({ ...validConfig, mqttBrokerIpAddress: "" })
    ).toThrow(/mqttBrokerIpAddress/);
    expect(() =>
      validateConfig({ ...validConfig, mqttTopicTelemetry: "" })
    ).toThrow(/mqttTopicTelemetry/);
  });

  it("rejects an empty sensorSourceValidCharsRegex", () => {
    // An explicit "" is not nullish, so without min(1) the ?? default in
    // PrometheusWriter is bypassed and every source sanitizes to "".
    expect(() =>
      validateConfig({ ...validConfig, sensorSourceValidCharsRegex: "" })
    ).toThrow(/sensorSourceValidCharsRegex/);
  });

  it("rejects an invalid forwardSensorLogsLevel", () => {
    expect(() =>
      validateConfig({ ...validConfig, forwardSensorLogsLevel: "loud" })
    ).toThrow(/forwardSensorLogsLevel/);
  });
});
