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
    }).min(1, "mqttTopicTelemetry must not be empty")
        .refine(
            isExactMqttTopic,
            "mqttTopicTelemetry must be an exact MQTT topic; wildcard filters (+ and #) are not supported"
        ),
    mqttTopicLog: z.string({
        error: "mqttTopicLog must be a string",
    }).min(1, "mqttTopicLog must not be empty")
        .refine(
            isExactMqttTopic,
            "mqttTopicLog must be an exact MQTT topic; wildcard filters (+ and #) are not supported"
        ).optional(),
    mqttTopicHealth: z.string({
        error: "mqttTopicHealth must be a string",
    }).min(1, "mqttTopicHealth must not be empty")
        .refine(
            isExactMqttTopic,
            "mqttTopicHealth must be an exact MQTT topic; wildcard filters (+ and #) are not supported"
        ).optional(),
    sensorSourceMaxLength: z.number({
        error: "sensorSourceMaxLength must be a number",
    }).int("sensorSourceMaxLength must be an integer")
        // Collision disambiguation appends "-" + 8 hex characters, which
        // needs 9 characters: below that the writer would still emit a
        // 9-char label and the configured maximum would not hold. The
        // schema (not runtime writer code) is the boundary for the
        // invariant, so startup, /write-config, and /reload-config all
        // reject it.
        .min(
            9,
            "sensorSourceMaxLength must be at least 9 (collision-safe source disambiguation needs '-' plus 8 hex characters)"
        )
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
    staleSourceRemovalSecs: z.number({
        error: "staleSourceRemovalSecs must be a number",
    }).int("staleSourceRemovalSecs must be an integer")
        .nonnegative("staleSourceRemovalSecs must be 0 or greater")
        .max(31536000, "staleSourceRemovalSecs must be at most 31536000 (one year)")
        .optional(),
    forwardSensorLogs: z.boolean().optional(),
    forwardSensorLogsLevel: z.enum(["error", "warn", "info", "debug", "critical"], {
        error: "forwardSensorLogsLevel must be one of: error, warn, info, debug, critical",
    }).optional(),
}).strict().superRefine((config, ctx) => {
    // MqttNetworking.on_message routes by lowercasing both the received
    // topic and the configured topics, with log winning over health and
    // both winning over the telemetry fallback. MQTT itself is
    // case-sensitive, so two configured topics that differ only in case
    // are distinct to the broker but identical to the router — one would
    // silently shadow the other. The three configured topics must be
    // unique under the same case-folded equality the router uses.
    const topics: Array<{ name: "mqttTopicTelemetry" | "mqttTopicLog" | "mqttTopicHealth"; value: string }> = [
        { name: "mqttTopicTelemetry", value: config.mqttTopicTelemetry },
    ];
    if (config.mqttTopicLog !== undefined) {
        topics.push({ name: "mqttTopicLog", value: config.mqttTopicLog });
    }
    if (config.mqttTopicHealth !== undefined) {
        topics.push({ name: "mqttTopicHealth", value: config.mqttTopicHealth });
    }
    const seen = new Map<string, "mqttTopicTelemetry" | "mqttTopicLog" | "mqttTopicHealth">();
    for (const topic of topics) {
        const folded = topic.value.toLowerCase();
        const first = seen.get(folded);
        if (first !== undefined) {
            ctx.addIssue({
                code: "custom",
                message: `${first} and ${topic.name} must not resolve to the same topic when compared case-insensitively`,
                path: [topic.name],
            });
        } else {
            seen.set(folded, topic.name);
        }
    }
});

/**
 * Configured MQTT topics must be EXACT topics, not subscription filters.
 * MqttNetworking.on_message routes delivered messages by comparing the
 * topic string for case-folded equality against the configured values —
 * it does not (and should not) implement MQTT wildcard matching. A
 * filter like "iot/v3/health/#" would subscribe fine at the broker, but
 * a delivery to "iot/v3/health/soil-1" would never equal the configured
 * value and would fall through to another route, misclassified or
 * dropped. Rejecting + and # at validation time makes the supported
 * contract fail fast instead of silently mis-routing.
 */
export function isExactMqttTopic(value: string): boolean {
    return !value.includes("+") && !value.includes("#");
}

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
