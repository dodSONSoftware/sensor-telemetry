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
  appLogger.write_info(
    "index.ts/readConfigurationFile",
    "Configuration loaded successfully",
    {
      event: "configuration_loaded",
      logType: "service",
      source: configSource,
      configurationKeyCount: Object.keys(config).length,
    }
  );

  // log it
  const dude = aboutDude();
  appLogger.write_info("index.ts/startApplication", `${dude.about.name} v${dude.about.version} starting...`, {
    event: "application_starting",
    logType: "service",
    version: dude.about.version,
  });

  // wire up config change callback to update networking when config changes
  const configChangeCallback = (newConfig: z.infer<typeof configSchema>): void => {
    networking.updateConfig(newConfig);
  };

  // create networking with callback passed during construction
  const networking = new MqttNetworking(config, appLogger, configSource, configChangeCallback);

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
      appLogger.write_error(
        "index.ts/prometheusStartupFailed",
        "Prometheus server failed to start within timeout",
        {
          event: "prometheus_startup_failed",
          logType: "service",
          maxWaitMs,
        }
      );
      process.exit(1);
    }

    appLogger.write_info("index.ts/applicationStarted", `${dude.about.name} v${dude.about.version} started.`, {
      event: "application_started",
      logType: "service",
      version: dude.about.version,
      apiPort,
      mqttTopic: config.mqttTopicTelemetry,
    });
    appLogger.write_info("index.ts/listeningOnMqtt", `Listening on MQTT topic: ${config.mqttTopicTelemetry}`, {
      event: "mqtt_subscription_started",
      logType: "service",
      mqttTopic: config.mqttTopicTelemetry,
    });
  } catch (err: unknown) {
    // log error
    appLogger.write_error(
      "index.ts/startupError",
      `Application startup failed: ${(err as Error).message}`,
      {
        event: "application_startup_failed",
        logType: "service",
        fatal: true,
        exitCode: 1,
        error: err,
      }
    );

    // terminate application
    process.exit(1);
  }

  // **** graceful shutdown

  const start_time = Date.now();

  async function shutdown(signal: string): Promise<void> {
    appLogger.write_info("index.ts/shutdown", `Received ${signal}. Starting graceful shutdown...`, {
      event: "shutdown_initiated",
      logType: "service",
      signal,
    });

    try {
      // Close MQTT client with timeout
      await networking.close(5000);

      appLogger.write_info(
        "index.ts/gracefulShutdownComplete",
        `Graceful shutdown complete. Uptime: ${formatElapsedTime(Date.now() - start_time)}.`,
        {
          event: "graceful_shutdown_completed",
          logType: "service",
          uptimeMs: Date.now() - start_time,
        }
      );
    } catch (err) {
      appLogger.write_error(
        "index.ts/shutdownError",
        `Error during graceful shutdown: ${(err as Error).message}`,
        {
          event: "shutdown_error",
          logType: "service",
          error: err,
        }
      );
    } finally {
      process.exit(0);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    appLogger.write_critical(
      "process/uncaughtException",
      "Uncaught exception reached the process boundary",
      {
        event: "uncaught_exception",
        logType: "service",
        severity: "critical",
        fatal: true,
        exitCode: 1,
        error: err,
      }
    );
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason, _promise) => {
    appLogger.write_critical(
      "process/unhandledRejection",
      "Unhandled rejection reached the process boundary",
      {
        event: "unhandled_rejection",
        logType: "service",
        severity: "critical",
        fatal: true,
        exitCode: 1,
        error: reason,
      }
    );
    shutdown("unhandledRejection");
  });
})();
