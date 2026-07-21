/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import winston, { format } from "winston";
import { createRequire } from "module";
import { LogLevel } from "./Interfaces";
import type {
  ILogger,
  LogMetadata,
  CriticalLogMetadata,
  SerializedError,
} from "./Interfaces";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";

const { combine, timestamp, errors, json } = format;

// Load version from package.json at module load time
const pkgRequire = createRequire(__filename);
const packageJsonPath = pkgRequire.resolve("../..//package.json");
const { version } = pkgRequire(packageJsonPath) as { version: string };


// **** Secret Redaction Helpers ****

/**
 * Case-insensitive regex patterns for sensitive field names.
 */
const SECRET_PATTERNS = [
  /password/i,
  /passwd/i,
  /wifi-password/i,
  /wifiPassword/i,
  /authorization/i,
  /cookie/i,
  /token/i,
  /accessToken/i,
  /refreshToken/i,
  /secret/i,
  /clientSecret/i,
  /apiKey/i,
  /privateKey/i,
];

/**
 * Check if a key matches a secret pattern.
 */
function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Recursively redact sensitive values from an object.
 * Does not mutate the original object.
 */
function redactSensitiveValues(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item));
  }

  // Handle plain objects
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      result[key] = "[REDACTED]";
    } else if (val !== null && typeof val === "object") {
      result[key] = redactSensitiveValues(val);
    } else {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Format that applies secret redaction before other formatting.
 */
function createRedactionFormat() {
  return format((info) => {
    // Deep clone and redact sensitive values
    const sanitizedMeta = redactSensitiveValues(info) as Record<string, unknown>;

    // Remove the original meta property since we're merging it back
    delete (sanitizedMeta as any).meta;

    // Merge sanitized metadata back into info
    return { ...info, ...sanitizedMeta };
  })();
}

// **** Originator Normalization ****

/**
 * Parse originator string into module and function components.
 * Expected formats:
 * - "module/function" -> { module: "module", function: "function" }
 * - "module" -> { module: "module", function: undefined }
 * - "module.submodule/function" -> { module: "module.submodule", function: "function" }
 */
function normalizeOriginator(originator: string): { module?: string; function?: string } {
  const parts = originator.split("/");
  if (parts.length >= 2) {
    return {
      module: parts.slice(0, -1).join("."),
      function: parts[parts.length - 1],
    };
  }
  return { module: originator };
}

// **** Error Serialization ****

/**
 * Serialize an error-like value into a standardized format.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? (error.code as string)
        : undefined;

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code,
    };
  }

  // Handle non-Error thrown values
  if (typeof error === "string") {
    return {
      name: "UnknownError",
      message: error,
    };
  }

  return {
    name: "UnknownError",
    message: "A non-Error value was thrown",
  };
}

// **** Supported Log Levels ****

export type SupportedLogLevel = "error" | "warn" | "info" | "debug";

/**
 * Validate and convert a log level string to supported format.
 * Returns null if the level is invalid.
 */
function validateLogLevel(level: string): SupportedLogLevel | null {
  const normalized = level?.toLowerCase().trim();
  if (
    normalized === "error" ||
    normalized === "warn" ||
    normalized === "info" ||
    normalized === "debug"
  ) {
    return normalized as SupportedLogLevel;
  }
  return null;
}

// **** Logger Class ****

export class Logger implements ILogger {
  private readonly logger: winston.Logger;
  private globalLogLevelValue: LogLevel;
  private globalLogLevelName: string;

  constructor(config: z.infer<typeof configSchema>) {
    // Validate initial log level
    const validatedLevel = validateLogLevel(config.logLevel);
    if (validatedLevel === null) {
      // Fallback to info with warning - but config schema already validates this
      this.globalLogLevelValue = LogLevel.Info;
      this.globalLogLevelName = "info";
    } else {
      this.globalLogLevelValue = convertFromWinstonLevel(validatedLevel);
      this.globalLogLevelName = validatedLevel;
    }

    // Create Winston logger with JSON format
    this.logger = winston.createLogger({
      level: this.globalLogLevelName,
      defaultMeta: {
        service: "sensor-telemetry",
        environment: process.env.NODE_ENV ?? "development",
        version: version ?? "unknown",
      },
      format: combine(
        createRedactionFormat(),
        timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
        errors({ stack: true }),
        json(),
      ),
      transports: [
        new winston.transports.Console({
          handleExceptions: true,
        }),
      ],
      exitOnError: false,
    });
  }

  public global_log_level(): LogLevel {
    return this.globalLogLevelValue;
  }

  public global_log_level_string(): string {
    return this.globalLogLevelName;
  }

  /**
   * Update the log level at runtime.
   * @param level - New log level string ("error", "warn", "info", "debug")
   * @returns true if the level was changed, false if invalid
   */
  public setLogLevel(level: string): boolean {
    const validatedLevel = validateLogLevel(level);
    if (validatedLevel === null) {
      this.logger.warn("Invalid log level requested", {
        event: "log_level_change_rejected",
        logType: "service",
        requestedLevel: level,
        activeLevel: this.globalLogLevelName,
      });
      return false;
    }

    const previousLevel = this.globalLogLevelName;
    this.globalLogLevelValue = convertFromWinstonLevel(validatedLevel);
    this.globalLogLevelName = validatedLevel;

    // Update Winston logger level
    this.logger.level = validatedLevel;

    // Update transport levels
    for (const transport of this.logger.transports) {
      transport.level = validatedLevel;
    }

    this.logger.info("Log level changed", {
      event: "log_level_changed",
      logType: "service",
      previousLevel,
      newLevel: validatedLevel,
    });

    return true;
  }

  /**
   * Core write method that handles all log levels.
   */
  private write(
    level: SupportedLogLevel,
    originator: string,
    message: string,
    metadata?: LogMetadata,
  ): void {
    const normalizedOriginator = normalizeOriginator(originator);

    const finalMetadata: LogMetadata = {
      ...(metadata ?? {}),
      logType: metadata?.logType ?? "service",
      module: metadata?.module ?? normalizedOriginator.module,
      function: metadata?.function ?? normalizedOriginator.function,
    };

    this.logger.log(level, message, finalMetadata);
  }

  public write_info(
    originator: string,
    message: string,
    metadata?: LogMetadata,
  ): void {
    this.write("info", originator, message, metadata);
  }

  public write_warn(
    originator: string,
    message: string,
    metadata?: LogMetadata,
  ): void {
    this.write("warn", originator, message, metadata);
  }

  public write_error(
    originator: string,
    message: string,
    metadata?: LogMetadata,
  ): void {
    this.write("error", originator, message, {
      ...(metadata ?? {}),
      severity: "standard",
    });
  }

  public write_critical(
    originator: string,
    message: string,
    metadata: CriticalLogMetadata,
  ): void {
    this.write("error", originator, message, {
      ...metadata,
      severity: "critical",
    });
  }

  public write_debug(
    originator: string,
    message: string,
    metadata?: LogMetadata,
  ): void {
    this.write("debug", originator, message, metadata);
  }
}

// **** Level Conversion Helper ****

function convertFromWinstonLevel(level: string): LogLevel {
  switch (level.toLowerCase()) {
    case "crit":
    case "critical":
      return LogLevel.Critical;
    case "error":
      return LogLevel.Error;
    case "warn":
      return LogLevel.Warn;
    case "info":
      return LogLevel.Info;
    case "debug":
      return LogLevel.Debug;
    default:
      return LogLevel.Info;
  }
}
