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
      sensorSourceCardinalityCap: 1024,
      staleSourceRemovalSecs: 3600,
      forwardSensorLogs: true,
      forwardSensorLogsLevel: "debug",
    };
    expect(validateConfig(full)).toEqual(full);
  });

  describe("staleSourceRemovalSecs", () => {
    it("accepts 0 (disabled) and the one-year maximum", () => {
      expect(() => validateConfig({ ...validConfig, staleSourceRemovalSecs: 0 })).not.toThrow();
      expect(() =>
        validateConfig({ ...validConfig, staleSourceRemovalSecs: 31_536_000 })
      ).not.toThrow();
    });

    it("rejects negative, fractional, and over-maximum values", () => {
      expect(() =>
        validateConfig({ ...validConfig, staleSourceRemovalSecs: -1 })
      ).toThrow(/staleSourceRemovalSecs/);
      expect(() =>
        validateConfig({ ...validConfig, staleSourceRemovalSecs: 1.5 })
      ).toThrow(/staleSourceRemovalSecs/);
      expect(() =>
        validateConfig({ ...validConfig, staleSourceRemovalSecs: 31_536_001 })
      ).toThrow(/staleSourceRemovalSecs/);
    });
  });

  describe("sensorSourceMaxLength", () => {
    it("rejects values below the collision-label minimum (9)", () => {
      // Collision disambiguation appends "-" + 8 hex characters (9 chars);
      // below 9 the configured maximum would not actually hold.
      for (const value of [0, 1, 5, 8]) {
        expect(() =>
          validateConfig({ ...validConfig, sensorSourceMaxLength: value })
        ).toThrow(/sensorSourceMaxLength/);
      }
    });

    it("rejects a non-integer sensorSourceMaxLength", () => {
      expect(() =>
        validateConfig({ ...validConfig, sensorSourceMaxLength: 9.5 })
      ).toThrow(/sensorSourceMaxLength/);
    });

    it("accepts 9 and larger values", () => {
      expect(() =>
        validateConfig({ ...validConfig, sensorSourceMaxLength: 9 })
      ).not.toThrow();
      expect(() =>
        validateConfig({ ...validConfig, sensorSourceMaxLength: 30 })
      ).not.toThrow();
    });
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

  it("rejects unknown configuration keys", () => {
    // Previously Zod silently stripped unrecognized keys, so a typo like
    // `forwardSensorLog` booted the service on the default (forwarding on)
    // with no validation failure.
    expect(() =>
      validateConfig({
        ...validConfig,
        forwardSensorLog: true,
      })
    ).toThrow(/forwardSensorLog|unrecognized/i);
  });

  it("does not silently ignore misspelled optional keys", () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        forwardSensorLogsLevelTypo: "debug",
      })
    ).toThrow();
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

describe("MQTT topic uniqueness under case folding (regression P3-1)", () => {
  // MqttNetworking.on_message routes by lowercasing both the received
  // topic and the configured topics, with the log branch taking priority
  // over health and both over the telemetry fallback. MQTT itself is
  // case-sensitive, so topics that differ only in case are distinct to
  // the broker but identical to the router — one would silently shadow
  // the other. The schema now rejects any pair of configured topics that
  // collapse to the same string under case folding (exact duplicates
  // included).
  const withTopics = (
    mqttTopicTelemetry: string,
    mqttTopicLog?: string,
    mqttTopicHealth?: string
  ) =>
    validateConfig({
      ...validConfig,
      mqttTopicTelemetry,
      ...(mqttTopicLog !== undefined && { mqttTopicLog }),
      ...(mqttTopicHealth !== undefined && { mqttTopicHealth }),
    });

  it.each([
    [["iot/v3/telemetry"], "telemetry topic only"],
    [
      ["iot/v3/telemetry", "iot/v3/log"],
      "distinct topics",
    ],
    [
      ["iot/v3/telemetry", "iot/v3/log", "iot/v3/health"],
      "all three distinct topics",
    ],
    [
      ["iot/v3/telemetry", "IOT/V3/Log"],
      "distinct topics that differ in case and content",
    ],
  ])("accepts %s", (topics, _label) => {
    expect(() => withTopics(...(topics as [string, string?, string?]))).not.toThrow();
  });

  it.each([
    [
      ["iot/v3/telemetry", "iot/v3/telemetry"],
      "mqttTopicLog",
      /mqttTopicTelemetry and mqttTopicLog/i,
      "exact duplicate: log shadows telemetry",
    ],
    [
      ["iot/v3/telemetry", "IOT/V3/TELEMETRY"],
      "mqttTopicLog",
      /mqttTopicTelemetry and mqttTopicLog/i,
      "case-folded duplicate: log shadows telemetry",
    ],
    [
      ["iot/v3/telemetry", undefined, "iot/v3/telemetry"],
      "mqttTopicHealth",
      /mqttTopicTelemetry and mqttTopicHealth/i,
      "exact duplicate: health shadows telemetry",
    ],
    [
      ["IOT/v3/telemetry", undefined, "iot/V3/TELEMETRY"],
      "mqttTopicHealth",
      /mqttTopicTelemetry and mqttTopicHealth/i,
      "case-folded duplicate across mixed case",
    ],
    [
      ["iot/v3/telemetry", "IoT/v3/telemetry", "IOT/V3/Telemetry"],
      "mqttTopicHealth",
      /mqttTopicTelemetry and/i,
      "all three collapse to one topic",
    ],
  ])("rejects %s (%s)", (topics, _label, expected, _why) => {
    expect(() => withTopics(...(topics as [string, string?, string?]))).toThrow(expected);
  });
});

describe("MQTT topics must be exact, not wildcard filters (regression)", () => {
  // MqttNetworking.on_message routes by exact (case-folded) string
  // equality against the configured topics and implements no wildcard
  // matching. A configured filter like "iot/v3/health/#" would subscribe
  // fine at the broker, but deliveries to matching concrete topics would
  // never equal the configured value and would fall through to another
  // route. The schema rejects + and # in every configured topic so the
  // supported contract fails fast with a clear message.
  it.each([
    ["iot/v3/telemetry/#", "mqttTopicTelemetry"],
    ["iot/+/log", "mqttTopicTelemetry"],
    ["#", "mqttTopicTelemetry"],
    ["+", "mqttTopicTelemetry"],
  ])("rejects %s as mqttTopicTelemetry", (topic) => {
    expect(() =>
      validateConfig({ ...validConfig, mqttTopicTelemetry: topic })
    ).toThrow(
      /mqttTopicTelemetry must be an exact MQTT topic; wildcard filters \(\+ and #\) are not supported/
    );
  });

  it.each([
    ["iot/v3/log/#", "mqttTopicLog"],
    ["iot/+/log", "mqttTopicLog"],
    ["#", "mqttTopicLog"],
  ])("rejects %s as mqttTopicLog", (topic) => {
    expect(() =>
      validateConfig({ ...validConfig, mqttTopicLog: topic })
    ).toThrow(
      /mqttTopicLog must be an exact MQTT topic; wildcard filters \(\+ and #\) are not supported/
    );
  });

  it.each([
    ["iot/v3/health/#", "mqttTopicHealth"],
    ["iot/+/health", "mqttTopicHealth"],
    ["+", "mqttTopicHealth"],
  ])("rejects %s as mqttTopicHealth", (topic) => {
    expect(() =>
      validateConfig({ ...validConfig, mqttTopicHealth: topic })
    ).toThrow(
      /mqttTopicHealth must be an exact MQTT topic; wildcard filters \(\+ and #\) are not supported/
    );
  });

  it("still accepts plain exact topics", () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        mqttTopicTelemetry: "iot/v3/telemetry",
        mqttTopicLog: "iot/v3/log",
        mqttTopicHealth: "iot/v3/health",
      })
    ).not.toThrow();
  });

  it("still enforces case-insensitive topic uniqueness alongside the wildcard check", () => {
    // A duplicate that does NOT contain wildcards must still hit the
    // uniqueness rule, not the wildcard rule.
    expect(() =>
      validateConfig({
        ...validConfig,
        mqttTopicTelemetry: "iot/v3/telemetry",
        mqttTopicLog: "IOT/V3/TELEMETRY",
      })
    ).toThrow(/mqttTopicTelemetry and mqttTopicLog/i);
  });
});

describe("sensorSourceValidCharsRegex constructibility (regression P2-1)", () => {
  // The value is escaped into a negated character class in the
  // PrometheusWriter constructor, which runs before index.ts's structured
  // startup try. A value that passed the old string-only check but made
  // new RegExp() throw (e.g. "z-a" — an out-of-order range) could be
  // persisted via /write-config, which reported success, then crash-looped
  // every restart. The schema now validates constructibility with the same
  // buildSourceValidCharsRegex the writer uses.
  const withChars = (sensorSourceValidCharsRegex: string) =>
    validateConfig({ ...validConfig, sensorSourceValidCharsRegex });

  it.each([
    ["a-zA-Z0-9._-", "default whitelist with ranges"],
    ["abc123_-", "letters, digits, trailing hyphen"],
    ["a-z", "single range"],
    ["Z-a", "ascending range"],
    ["-", "lone hyphen (literal, not a range)"],
  ])("accepts %s (%s)", (chars, _label) => {
    expect(() => withChars(chars)).not.toThrow();
  });

  it.each([
    ["z-a", "out-of-order range"],
    ["z-A", "descending range across letter cases"],
    ["a--b", "hyphen forming an out-of-order range with its neighbor"],
  ])("rejects %s (%s)", (chars, _label) => {
    expect(() => withChars(chars)).toThrow(/sensorSourceValidCharsRegex/);
  });
});
