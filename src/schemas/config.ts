/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { z } from "zod";

/**
 * Zod schema for config.yml - telemetry-only version.
 * All keys are required and must match their expected types.
 */
export const configSchema = z.object({
    logLevel: z.enum(["error", "warn", "info", "debug"], {
        error: "logLevel must be one of: error, warn, info, debug",
    }),
    apiPort: z.number({
        error: "apiPort must be a number",
    }).int("apiPort must be an integer")
        .positive("apiPort must be greater than 0"),
    mqttBrokerIpAddress: z.string({
        error: "mqttBrokerIpAddress must be a string",
    }).min(1, "mqttBrokerIpAddress must not be empty"),
    mqttTopicTelemetry: z.string({
        error: "mqttTopicTelemetry must be a string",
    }).min(1, "mqttTopicTelemetry must not be empty"),
    sensorSourceMaxLength: z.number({
        error: "sensorSourceMaxLength must be a number",
    }).int("sensorSourceMaxLength must be an integer")
        .positive("sensorSourceMaxLength must be greater than 0")
        .optional(),
    sensorSourceValidCharsRegex: z.string().optional(),
    forwardSensorLogs: z.boolean().optional(),
    forwardSensorLogsLevel: z.enum(["error", "warn", "info", "debug"], {
        error: "forwardSensorLogsLevel must be one of: error, warn, info, debug",
    }).optional(),
});

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
