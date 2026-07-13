/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { aboutDude, createLogger, logger } from "./common/global";
import type { Logger } from "./dodsonlabs/Logger";
import { ensureError, formatElapsedTime, read_file_yaml } from "./dodsonlabs/SystemFunctions";
import { validateConfig, type configSchema } from "./schemas/config";
import type { z } from "zod";
import { MqttNetworking } from "./dodsonlabs/MqttNetworking";

// **** configuration validation

function validate_config(raw: unknown): z.infer<typeof configSchema> {
    try {
        return validateConfig(raw);
    } catch (err) {
        const message = ensureError(err).message;
        console.error(`ERROR: Invalid config.yml — ${message}`);
        process.exit(1);
    }
}

// **** start up code

(async () => {
    // read the configuration file (try container mount first, then CWD-relative)
    let configResult = read_file_yaml<z.infer<typeof configSchema>>(
        "/app/configs/config.yml"
    );
    let configSource = "/app/configs/config.yml";
    if (configResult.data === null) {
        configResult = read_file_yaml<z.infer<typeof configSchema>>("./dist/config.yml");
        configSource = "./dist/config.yml";
    }
    if (configResult.data === null) {
        // eslint-disable-next-line no-console
        console.error(`ERROR: Could not read config.yml — ${configResult.error ?? "unknown error"} — cannot start without configuration.`);
        process.exit(1);
    }

    // validate and type the config with Zod
    const config = validate_config(configResult.data);

    // create logger
    createLogger(config);
    // createLogger(config) above guarantees logger() returns a defined Logger
    const appLogger = logger() as Logger;

    // display configuration source and contents
    appLogger.write_info("index.ts", `Configuration loaded from: ${configSource}`);
    appLogger.write_info("index.ts", `CONFIGURATION:\n${JSON.stringify(config, null, 2)}`);

    // log it
    const dude = aboutDude();
    appLogger.write_info("index.ts", `${dude.about.name} v${dude.about.version} starting...`);

    // create networking
    const networking = new MqttNetworking(config, appLogger, configSource);

    // wire up config change callback to update networking when config changes
    networking.getPrometheusWriter()?.setConfigChangeCallback((newConfig) => {
        networking.updateConfig(newConfig);
    });

    // get api port (for logging)
    const apiPort = config.apiPort;

    try {
        // Wait for Prometheus server to be ready
        const maxWaitMs = 5000;
        const waitInterval = 100;
        let elapsed = 0;
        while (!networking.prometheus_server_ready() && elapsed < maxWaitMs) {
            await new Promise((resolve) => setTimeout(resolve, waitInterval));
            elapsed += waitInterval;
        }

        if (!networking.prometheus_server_ready()) {
            appLogger.write_error("index.ts", "Prometheus server failed to start within timeout");
            process.exit(1);
        }

        appLogger.write_info("index.ts", `${dude.about.name} v${dude.about.version} started.`);
        appLogger.write_info("index.ts", `API server available at http://localhost:${apiPort}`);
        appLogger.write_info("index.ts", `Listening on MQTT topic: ${config.mqttTopicTelemetry}`);
    } catch (err: unknown) {
        // log error
        appLogger.write_error("index.ts", ensureError(err).message);

        // terminate application
        process.exit(1);
    }

    // **** graceful shutdown

    const start_time = Date.now();

    async function shutdown(signal: string): Promise<void> {
        appLogger.write_info("index.ts", `Received ${signal}. Starting graceful shutdown...`);

        try {
            // Close MQTT client with timeout
            await networking.close(5000);

            appLogger.write_info("index.ts", `Graceful shutdown complete. Uptime: ${formatElapsedTime(Date.now() - start_time)}.`);
        } catch (err) {
            appLogger.write_error("index.ts", `Error during graceful shutdown: ${(err as Error).message}`);
        } finally {
            process.exit(0);
        }
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("uncaughtException", (err) => {
        appLogger.write_error("index.ts/uncaughtException", `Uncaught exception: ${(err as Error).message}\n${(err as Error).stack ?? ""}`);
        shutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason, _promise) => {
        const message = ensureError(reason).message;
        appLogger.write_error("index.ts/unhandledRejection", `Unhandled rejection: ${message}`);
        shutdown("unhandledRejection");
    });
})();
