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
    "log-level": z.enum(["error", "warn", "info", "debug"], {
        error: "log-level must be one of: error, warn, info, debug",
    }),
    "prometheus-port": z.number({
        error: "prometheus-port must be a number",
    }).int("prometheus-port must be an integer")
        .positive("prometheus-port must be greater than 0"),
    "mqtt-broker-ip-address": z.string({
        error: "mqtt-broker-ip-address must be a string",
    }).min(1, "mqtt-broker-ip-address must not be empty"),
    "mqtt-topic-telemetry": z.string({
        error: "mqtt-topic-telemetry must be a string",
    }).min(1, "mqtt-topic-telemetry must not be empty"),
    "sensor-source-max-length": z.number({
        error: "sensor-source-max-length must be a number",
    }).int("sensor-source-max-length must be an integer")
        .positive("sensor-source-max-length must be greater than 0")
        .optional(),
    "sensor-source-valid-chars-regex": z.string().optional(),
    "forward-sensor-logs": z.boolean().optional(),
    "forward-sensor-logs-level": z.enum(["error", "warn", "info", "debug"], {
        error: "forward-sensor-logs-level must be one of: error, warn, info, debug",
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
