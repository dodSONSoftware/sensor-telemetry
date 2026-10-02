/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import winston, { format } from "winston";
import { createRequire } from "module";
import { LOG_BOUND_MAX_DEPTH, LOG_BOUND_DEPTH_MARKER } from "./SystemFunctions";
import { LogLevel } from "./Interfaces";
import type {
  ILogger,
  LogMetadata,
  CriticalLogMetadata,
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
 *
 * Depth-bounded: this pass recurses through the whole log record, and log
 * metadata can carry arbitrary untrusted MQTT-supplied structures — without
 * a cap a deeply nested payload would exhaust the call stack per log line
 * (and the resulting JSON record would be unbounded). Past LOG_BOUND_MAX_DEPTH
 * the whole subtree collapses to the same bounded marker boundForLog uses,
 * so the record stays shallow and serializable. The bound applies to the
 * nesting, not to redaction: secret keys at or below the cap are still
 * replaced, and Error instances are always serialized to their
 * name/message/stack form (bounded by construction) regardless of depth.
 */
function redactSensitiveValues(value: unknown, depth: number = 0): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  // Error instances carry their state in non-enumerable message/stack
  // properties, so the generic object branch below would flatten them to {}
  // and drop the stack trace from the log line. Extract the fields explicitly
  // so the stack survives into every `error:` log field.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  // Depth cap: past the bound the whole subtree becomes a marker instead of
  // recursing (see the function doc for why this must exist).
  if (depth >= LOG_BOUND_MAX_DEPTH) {
    return LOG_BOUND_DEPTH_MARKER;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item, depth + 1));
  }

  // Handle plain objects
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      result[key] = "[REDACTED]";
    } else if (val !== null && typeof val === "object") {
      result[key] = redactSensitiveValues(val, depth + 1);
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
    delete sanitizedMeta.meta;

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

// **** Supported Log Levels ****

export type SupportedLogLevel = "error" | "warn" | "info" | "debug";

/**
 * A schema-accepted log level paired with the winston level it filters at.
 * "critical" filters at winston's "error" level because critical entries
 * are emitted at winston's error level (see write_critical).
 */
type ResolvedLogLevel = {
  name: string;
  winstonLevel: SupportedLogLevel;
};

/**
 * Validate and convert a log level string to supported format.
 * "critical" is accepted and mapped to the winston level "error".
 * Returns null if the level is invalid.
 */
function validateLogLevel(level: string): ResolvedLogLevel | null {
  const normalized = level?.toLowerCase().trim();
  if (
    normalized === "error" ||
    normalized === "warn" ||
    normalized === "info" ||
    normalized === "debug"
  ) {
    return { name: normalized, winstonLevel: normalized as SupportedLogLevel };
  }
  if (normalized === "critical") {
    return { name: "critical", winstonLevel: "error" };
  }
  return null;
}

// **** Logger Class ****

export class Logger implements ILogger {
  private readonly logger: winston.Logger;
  private globalLogLevelValue: LogLevel;
  private globalLogLevelName: string;
  private winstonLevel: SupportedLogLevel;

  constructor(config: z.infer<typeof configSchema>) {
    // Validate initial log level
    const validatedLevel = validateLogLevel(config.logLevel);
    if (validatedLevel === null) {
      // Fallback to info. The config schema already restricts this value, so
      // this only guards against construction with unvalidated input.
      this.winstonLevel = "info";
      this.globalLogLevelValue = LogLevel.Info;
      this.globalLogLevelName = "info";
    } else {
      this.winstonLevel = validatedLevel.winstonLevel;
      this.globalLogLevelValue = convertFromWinstonLevel(validatedLevel.name);
      this.globalLogLevelName = validatedLevel.name;
    }

    // Create Winston logger with JSON format
    this.logger = winston.createLogger({
      level: this.winstonLevel,
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
        // Deliberately no `handleExceptions: true` here: that would make
        // winston install its own global uncaughtException handler, producing
        // a second, non-app-formatted crash line and leaking a global listener
        // per Logger. Crash logging is owned intentionally by the process-level
        // handlers in index.ts (uncaughtException / unhandledRejection), which
        // log via this Logger and own the exit code.
        new winston.transports.Console(),
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
   * @param level - New log level string ("error", "warn", "info", "debug", "critical")
   * @returns true if the level was changed, false if invalid
   */
  public setLogLevel(level: string): boolean {
    const validatedLevel = validateLogLevel(level);
    if (validatedLevel === null) {
      // Route through the common write() path (the single ownership point
      // for winston calls) rather than a direct this.logger.warn(), so a
      // future printf token in the message cannot resurrect the splat
      // metadata-loss path.
      this.write("warn", "logger/setLogLevel", "Invalid log level requested", {
        event: "log_level_change_rejected",
        logType: "service",
        requestedLevel: level,
        activeLevel: this.globalLogLevelName,
      });
      return false;
    }

    const previousLevel = this.globalLogLevelName;
    this.winstonLevel = validatedLevel.winstonLevel;
    this.globalLogLevelValue = convertFromWinstonLevel(validatedLevel.name);
    this.globalLogLevelName = validatedLevel.name;

    // Update Winston logger level
    this.logger.level = validatedLevel.winstonLevel;

    // Update transport levels
    for (const transport of this.logger.transports) {
      transport.level = validatedLevel.winstonLevel;
    }

    this.write("info", "logger/setLogLevel", "Log level changed", {
      event: "log_level_changed",
      logType: "service",
      previousLevel,
      newLevel: validatedLevel.name,
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

    // Write the fully-constructed info object directly instead of winston's
    // three-argument log(level, message, metadata) form: when the message
    // contains printf-style tokens (%s, %d, %j, %% ...), that form routes
    // the extra arguments through winston's SPLAT path and DROPS the
    // metadata object entirely (the pipeline deliberately has no
    // format.splat() — these messages are literal strings, often untrusted
    // MQTT content, not printf templates). logger.write() has no splat
    // handling and keeps the message literal. It also does NOT merge
    // defaultMeta (only the log() convenience form does), so spread it
    // explicitly first — preserving the merge order the three-argument
    // form used (defaultMeta applied first, finalMetadata overriding it,
    // including forwarded sensor logs' `version: undefined` suppressing
    // the default version field).
    this.logger.write({
      ...(this.logger.defaultMeta ?? {}),
      ...finalMetadata,
      level,
      message,
    });
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
