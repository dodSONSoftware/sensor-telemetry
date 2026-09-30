/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { validateConfig } from "../../../src/schemas/config";

const validConfig = {
  logLevel: "info",
  apiPort: 3301,
  mqttBrokerIpAddress: "10.0.0.1",
  mqttTopicTelemetry: "iot/v3/telemetry",
};

describe("validateConfig", () => {
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

describe("mqttBrokerIpAddress format validation (regression P3)", () => {
  // The MqttNetworking constructor (and thus mqtt.connect) runs before
  // index.ts's structured startup try. A value that makes mqtt.connect
  // throw synchronously — an out-of-range port — escaped as an unhandled
  // rejection instead of a clean config error. The schema now validates
  // exactly the forms the app supports (host, IP, bracketed IPv6, each
  // optionally with :port), so those failures surface at config load.
  const withBroker = (mqttBrokerIpAddress: string) =>
    validateConfig({ ...validConfig, mqttBrokerIpAddress });

  it.each([
    ["10.0.0.1", "bare IP"],
    ["broker", "bare hostname"],
    ["a_broker.local", "hostname with underscore and dot"],
    ["10.0.0.1:1883", "IP with port"],
    ["broker:8883", "hostname with port"],
    ["10.0.0.1:1", "port at the lower bound"],
    ["10.0.0.1:65535", "port at the upper bound"],
    ["[::1]", "bracketed IPv6 literal"],
    ["[::1]:1883", "bracketed IPv6 literal with port"],
  ])("accepts %s (%s)", (address, _label) => {
    expect(() => withBroker(address)).not.toThrow();
  });

  it.each([
    ["10.0.0.1:70000", "out-of-range port"],
    ["10.0.0.1:65536", "port one above the maximum"],
    ["10.0.0.1:0", "port zero"],
    ["host:abc", "non-numeric port"],
    ["host:", "empty port"],
    ["host:1883:1884", "extra colon"],
    ["mqtt://10.0.0.1:1883", "scheme prefix"],
    ["::1", "unbracketed IPv6 literal"],
    ["[::1", "unbalanced bracket"],
    ["host with space", "whitespace in hostname"],
  ])("rejects %s (%s)", (address, _label) => {
    expect(() => withBroker(address)).toThrow(/mqttBrokerIpAddress/);
  });
});
