/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { z } from "zod";
import { buildSourceValidCharsRegex } from "../dodsonlabs/SystemFunctions";

/**
 * Zod schema for config.yml - telemetry-only version.
 * All non-optional keys are required and must match their expected types.
 * The object is strict: unknown keys (e.g. a misspelled optional key like
 * `forwardSensorLog`) fail validation instead of being silently stripped,
 * which would otherwise boot the service on a default the operator did not
 * ask for.
 */
export const configSchema = z.object({
    logLevel: z.enum(["error", "warn", "info", "debug", "critical"], {
        error: "logLevel must be one of: error, warn, info, debug, critical",
    }),
    apiPort: z.number({
        error: "apiPort must be a number",
    }).int("apiPort must be an integer")
        .positive("apiPort must be greater than 0")
        .max(65535, "apiPort must be at most 65535"),
    mqttBrokerIpAddress: z.string({
        error: "mqttBrokerIpAddress must be a string",
    }).min(1, "mqttBrokerIpAddress must not be empty")
        .refine(
            isMqttBrokerAddress,
            "mqttBrokerIpAddress must be a host or IP address (bracketed IPv6 literal for IPv6) with an optional :port in 1-65535 — e.g. 'broker' or '10.0.0.1:1883'; do not include a scheme like 'mqtt://'"
        ),
    mqttTopicTelemetry: z.string({
        error: "mqttTopicTelemetry must be a string",
    }).min(1, "mqttTopicTelemetry must not be empty"),
    mqttTopicLog: z.string({
        error: "mqttTopicLog must be a string",
    }).min(1, "mqttTopicLog must not be empty").optional(),
    mqttTopicHealth: z.string({
        error: "mqttTopicHealth must be a string",
    }).min(1, "mqttTopicHealth must not be empty").optional(),
    sensorSourceMaxLength: z.number({
        error: "sensorSourceMaxLength must be a number",
    }).int("sensorSourceMaxLength must be an integer")
        .positive("sensorSourceMaxLength must be greater than 0")
        .optional(),
    sensorSourceValidCharsRegex: z.string({
        error: "sensorSourceValidCharsRegex must be a string",
    }).min(1, "sensorSourceValidCharsRegex must not be empty")
        // The value is escaped into a negated character class at
        // construction time (buildSourceValidCharsRegex); a value that
        // cannot build one (e.g. "z-a", an out-of-order range) would throw
        // in the PrometheusWriter constructor — before index.ts's
        // structured startup try — so persisting it via /write-config
        // would crash-loop the next restart. Validate constructibility
        // here, using the same function the writer uses, so every path
        // (startup, /write-config, /reload-config) rejects it.
        .refine(
            (value) => {
                try {
                    buildSourceValidCharsRegex(value);
                    return true;
                } catch {
                    return false;
                }
            },
            "sensorSourceValidCharsRegex must form a valid character class when escaped into [^...] — e.g. 'z-a' is an out-of-order range"
        ).optional(),
    sensorSourceCardinalityCap: z.number({
        error: "sensorSourceCardinalityCap must be a number",
    }).int("sensorSourceCardinalityCap must be an integer")
        .positive("sensorSourceCardinalityCap must be greater than 0")
        .optional(),
    forwardSensorLogs: z.boolean().optional(),
    forwardSensorLogsLevel: z.enum(["error", "warn", "info", "debug", "critical"], {
        error: "forwardSensorLogsLevel must be one of: error, warn, info, debug, critical",
    }).optional(),
}).strict();

function isValidPort(port: string): boolean {
    if (!/^\d{1,5}$/.test(port)) {
        return false;
    }
    const value = Number(port);
    return value >= 1 && value <= 65535;
}

/**
 * The forms MqttNetworking.connect_to_mqtt_broker actually parses cleanly:
 * the configured value is appended directly to "mqtt://", so it must be a
 * host, an IP, or a bracketed IPv6 literal, each optionally followed by
 * ":port". Other forms are worse than a connection failure — mqtt.connect
 * throws synchronously for an out-of-range port (outside index.ts's
 * structured startup path, since the MqttNetworking constructor runs
 * before the startup try) and silently misparses the rest: a "mqtt://"
 * scheme becomes the host "mqtt", an unbracketed IPv6 literal becomes an
 * empty host on port 1, and a non-numeric or empty port silently falls
 * back to the default port. Validating the contract here surfaces those
 * as clean config errors at startup.
 *
 * Bracket contents are checked as hex/colons only, not as full IPv6
 * groups — a typo inside the brackets fails as an ordinary unresolvable
 * host at connection time, which the client's error handling covers.
 */
export function isMqttBrokerAddress(value: string): boolean {
    const hostChars = /^[A-Za-z0-9._-]+$/;

    if (value.startsWith("[")) {
        const close = value.indexOf("]");
        if (close === -1 || !/^[0-9a-fA-F:]+$/.test(value.slice(1, close))) {
            return false;
        }
        const rest = value.slice(close + 1);
        if (rest === "") {
            return true;
        }
        return rest.startsWith(":") && isValidPort(rest.slice(1));
    }

    const colon = value.indexOf(":");
    if (colon === -1) {
        return hostChars.test(value);
    }
    // A second colon means an unbracketed IPv6 literal or similar garbage;
    // the only colon in a supported form is the port separator.
    const port = value.slice(colon + 1);
    if (port.includes(":")) {
        return false;
    }
    return hostChars.test(value.slice(0, colon)) && isValidPort(port);
}

/**
 * Validates a parsed YAML/JSON config object against the config schema.
 * Returns the typed config on success, or throws on failure.
 */
export function validateConfig(raw: unknown): z.infer<typeof configSchema> {
    const result = configSchema.safeParse(raw);
    if (!result.success) {
        const messages = result.error.issues.map(i => i.message).join("; ");
        throw new Error(`Config validation failed: ${messages}`);
    }
    return result.data;
}
