/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { aboutDude, createLogger, logger } from "./common/global";
import type { Logger } from "./dodsonlabs/Logger";
import {
  CONFIG_FILE_CANDIDATES,
  ensureError,
  formatElapsedTime,
  read_file_yaml_first,
} from "./dodsonlabs/SystemFunctions";
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
  // read the configuration file (try container mount, then current working directory, then build output)
  const configResult = read_file_yaml_first<z.infer<typeof configSchema>>(
    CONFIG_FILE_CANDIDATES
  );
  if (configResult.data === null || configResult.source === null) {
    console.error(`ERROR: Could not read config.yml — ${configResult.error ?? "unknown error"} — cannot start without configuration.`);
    process.exit(1);
  }
  const configSource = configResult.source;

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

  // **** graceful shutdown
  // Wired up before the Prometheus readiness wait below so a stop signal
  // arriving during that startup window (up to 5 s) is handled by the
  // graceful close path instead of the platform's default termination.
  // appLogger and networking are already constructed at this point, and
  // networking.close() is safe to call before the HTTP server reports ready.

  const start_time = Date.now();

  // Only the first signal owns the shutdown: a second signal during the
  // close window (up to 5 s) must not re-enter the close path or re-exit
  // with its own code, which could mask a crash's exit 1 as a clean 0.
  let shuttingDown = false;

  // exitCode 0 = graceful stop requested by the operator; 1 = the process
  // is exiting because of a fatal error, so orchestrators and monitoring
  // can distinguish a crash from a clean shutdown.
  // pendingExitCode tracks the worst code seen so far: a fatal error that
  // lands during an in-flight graceful shutdown escalates the pending code
  // to 1 instead of being dropped, so a crash in the close window is never
  // reported as a clean stop.
  let pendingExitCode = 0;

  async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (shuttingDown) {
      if (exitCode > pendingExitCode) {
        pendingExitCode = exitCode;
        appLogger.write_warn("index.ts/shutdownEscalated", `Received ${signal} during an in-flight shutdown; escalating exit code to ${exitCode}.`, {
          event: "shutdown_escalated",
          logType: "service",
          signal,
          exitCode,
        });
      } else {
        appLogger.write_warn("index.ts/shutdownIgnored", `Received ${signal} during an in-flight shutdown; ignoring.`, {
          event: "shutdown_ignored",
          logType: "service",
          signal,
        });
      }
      return;
    }
    shuttingDown = true;
    pendingExitCode = exitCode;

    appLogger.write_info("index.ts/shutdown", `Received ${signal}. Starting graceful shutdown...`, {
      event: "shutdown_initiated",
      logType: "service",
      signal,
      exitCode,
    });

    try {
      // Single 5 s deadline for the entire close path: the Prometheus HTTP
      // drain and the MQTT disconnect share one budget, so the shutdown is
      // bounded even when an in-flight HTTP request holds the drain open.
      await networking.close(5000);

      appLogger.write_info(
        "index.ts/gracefulShutdownComplete",
        `Graceful shutdown complete. Uptime: ${formatElapsedTime(Date.now() - start_time)}.`,
        {
          event: "graceful_shutdown_completed",
          logType: "service",
          uptimeMs: Math.trunc(Date.now() - start_time),
          exitCode: pendingExitCode,
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
      process.exit(pendingExitCode);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));
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
    shutdown("uncaughtException", 1);
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
    shutdown("unhandledRejection", 1);
  });

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
})();
