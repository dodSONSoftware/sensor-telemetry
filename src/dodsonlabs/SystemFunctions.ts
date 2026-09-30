/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import { ILogger, LogLevel } from "./Interfaces";
import * as yaml from "js-yaml";

// **** error functions

export function ensureError(value: unknown): Error {
  // check for undefined
  if (value === undefined) return Error("<<< Error is undefined >>>");

  // check for error
  if (value instanceof Error) return value;

  // convert to json string
  let result =
    "Unknown Error: error value cannot be converted to a json string.";
  try {
    result = JSON.stringify(value);
  } catch {}

  // return new error
  return new Error(result);
}

// **** file functions

/** Result of a file read operation — distinguishes "not found" from parse errors. */
export interface ReadFileResult<T> {
  data: T | null;
  error: string | null;
}

export function read_file(
  filename: string,
  logger?: ILogger
): string | null {
  try {
    const buffer = fs.readFileSync(filename, "utf8");
    return buffer.toString();
  } catch (error) {
    const msg = `read_file: failed to read '${filename}': ${(error as Error).message}`;
    if (logger) {
      logger.write_error("SystemFunctions/read_file", msg, {
        event: "file_read_failed",
        logType: "service",
        filename,
        error,
      });
    } else {
      console.error(msg);
    }
    return null;
  }
}

export function read_file_yaml<T>(
  filename: string,
  logger?: ILogger
): ReadFileResult<T> {
  const data = read_file(filename, logger);
  if (data == null) {
    return { data: null, error: `read_file_yaml: could not read '${filename}'` };
  }
  try {
    // yaml.load returns undefined (not null) for empty/whitespace-only
    // input; normalize so data is strictly T | null as documented.
    const parsed = yaml.load(data) as T;
    return { data: parsed ?? null, error: null };
  } catch (error) {
    const msg = `read_file_yaml: failed to parse '${filename}': ${(error as Error).message}`;
    if (logger) {
      logger.write_error("SystemFunctions/read_file_yaml", msg, {
        event: "yaml_parse_failed",
        logType: "service",
        filename,
        error,
      });
    } else {
      console.error(msg);
    }
    return { data: null, error: msg };
  }
}

// **** configuration file resolution

/**
 * Candidate locations for config.yml, tried in order:
 *  - /app/configs/config.yml — Docker container mount (see docker-compose.yml)
 *  - ./dist/config.yml       — build output (npm run build copies it there)
 *  - ./config.yml            — repo root, the single source of truth
 */
export const CONFIG_FILE_CANDIDATES: string[] = [
  "/app/configs/config.yml",
  "./dist/config.yml",
  "./config.yml",
];

/** Result of resolving a YAML file from a list of candidate paths. */
export interface ResolveYamlResult<T> {
  /** Parsed YAML data, or null if no candidate could be read. */
  data: T | null;
  /**
   * On success, the candidate that was read; on failure, the existing
   * candidate that stopped the search (unreadable or unparseable), or
   * null if no candidate file existed at all.
   */
  source: string | null;
  /** Error text, or null on success. */
  error: string | null;
}

/**
 * Try each candidate path in order and return the first one that can be
 * read and parsed as YAML. Relative paths resolve against the process
 * working directory, so callers can mix container paths and CWD-relative
 * fallbacks.
 *
 * Falling through is only allowed past *missing* files. A candidate that
 * exists but fails to read or parse (or parses to null) is an operator
 * error — a corrupted or truncated config — and stops the search with
 * that error. This is deliberate: silently continuing on to the next
 * candidate would let the service boot on a stale snapshot (e.g. a
 * previous build's dist/config.yml) that may point at a different broker
 * or topic. The check applies to every existing candidate, so a corrupted
 * source-of-truth ./config.yml is caught even when an earlier candidate
 * (dist/) is still valid.
 */
export function read_file_yaml_first<T>(
  candidates: readonly string[],
  logger?: ILogger
): ResolveYamlResult<T> {
  const missing: string[] = [];
  const parsed: Record<string, T> = {};

  // First pass: validate every candidate that exists on disk. An
  // unreadable or unparseable file that is present fails fast instead of
  // falling back to a potentially stale earlier candidate.
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      missing.push(candidate);
      continue;
    }
    const result = read_file_yaml<T>(candidate, logger);
    if (result.data === null) {
      return {
        data: null,
        source: candidate,
        error:
          result.error ??
          `read_file_yaml_first: '${candidate}' exists but parsed to null`,
      };
    }
    parsed[candidate] = result.data;
  }

  // Second pass: return the first parseable candidate in priority order.
  for (const candidate of candidates) {
    if (candidate in parsed) {
      return { data: parsed[candidate], source: candidate, error: null };
    }
  }

  return {
    data: null,
    source: null,
    error:
      missing.length > 0
        ? `read_file_yaml_first: no config file found in any candidate location: ${missing.join(", ")}`
        : null,
  };
}

/**
 * Atomically replace `filename` with the YAML serialization of `data`:
 * write to a sibling temp file, then rename it over the target.
 * rename(2) is atomic on POSIX, so readers and the next startup never
 * observe a truncated file — a failure mid-write (ENOSPC, crash, power
 * loss) leaves the previous config byte-for-byte intact, which callers
 * rely on to truthfully report "no changes were applied".
 */
export function write_file_yaml(
  filename: string,
  data: unknown,
  logger?: ILogger
): boolean {
  // Sibling in the same directory so the rename stays on one filesystem.
  const tmpFile = `${filename}.tmp-${process.pid}`;
  try {
    const yamlStr = yaml.dump(data, {
      indent: 2,
      lineWidth: -1,
    });
    fs.writeFileSync(tmpFile, yamlStr, "utf8");
    fs.renameSync(tmpFile, filename);
    return true;
  } catch (error) {
    // Best-effort cleanup; the original file is untouched either way.
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    const msg = `write_file_yaml: failed to write '${filename}': ${(error as Error).message}`;
    if (logger) {
      logger.write_error("SystemFunctions/write_file_yaml", msg, {
        event: "yaml_write_failed",
        logType: "service",
        filename,
        error,
      });
    } else {
      console.error(msg);
    }
    return false;
  }
}

// ******** log level string to enum conversion

export function convert_from_log_level_string_to_enum(
  logLevelString: string
): LogLevel {
  switch (logLevelString.toLowerCase()) {
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
      // Unknown log level — default to Info (forward most messages)
      // rather than None (silently drop everything).
      return LogLevel.Info;
  }
}

// **** general functions

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Build the regex that strips invalid characters from sensor source /
 * firmware label values: every character of `validChars` is escaped and
 * placed in a negated character class (`[^...]+`, global flag), so the
 * configured string is interpreted as a literal whitelist — except `-`,
 * which is deliberately NOT escaped because it is the range separator the
 * whitelist syntax relies on (`a-zA-Z0-9._-` must keep its ranges).
 *
 * Leaving `-` unescaped means some values produce an invalid character
 * class — `z-a` is an out-of-order range — and `new RegExp` throws a
 * SyntaxError. The config schema validates constructibility with this same
 * function, so a value that reaches PrometheusWriter's constructor cannot
 * throw at startup; this function is the single source of truth for the
 * construction rule so the two can never drift apart.
 */
export function buildSourceValidCharsRegex(validChars: string): RegExp {
  const escaped = validChars.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return new RegExp(`[^${escaped}]+`, "g");
}

// **** payload field extraction

/**
 * Get a numeric value from an object using the first field name that holds
 * a usable value (pass snake_case/camelCase aliases in either order).
 *
 * - Only numbers and numeric strings are accepted. MQTT payloads are
 *   untrusted: Number() on anything else would let false/true become 0/1,
 *   an empty array become 0, and a single-element array masquerade as its
 *   element — publishing a plausible but wrong reading instead of dropping
 *   malformed telemetry. Non-number/string values are treated as absent
 *   and the next alias is tried.
 * - Empty/whitespace strings are the protocol's "unset" marker (V1/V2 use
 *   them for missing values); Number("") would coerce them to 0 and publish
 *   a false zero reading, so they are treated as absent and the next alias
 *   is tried.
 * - Values that do not parse to a finite number are likewise absent.
 * - Fields whose name contains time/Time/millis/Millis (e.g. uptime_ms) are
 *   truncated to integer milliseconds.
 *
 * Returns undefined if no field holds a valid finite number.
 */
export function get_numeric_field(
  obj: any,
  ...fieldNames: string[]
): number | undefined {
  for (const fieldName of fieldNames) {
    const value = obj[fieldName];
    let numValue: number;
    if (typeof value === "number") {
      numValue = value;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") continue;
      numValue = Number(trimmed);
    } else {
      continue;
    }
    if (!Number.isFinite(numValue)) continue;
    if (
      fieldName.includes("time") ||
      fieldName.includes("Time") ||
      fieldName.includes("millis") ||
      fieldName.includes("Millis")
    ) {
      return Math.trunc(numValue);
    }
    return numValue;
  }
  return undefined;
}

// **** time-related functions

// The full ISO 8601 form, trailing Z included: the value is written into
// *_utc fields (boot_date_utc, forwarded-log timestamps) where a string with
// no timezone designation is not actually unambiguous UTC.
export function get_timestamp_iso(): string {
  return new Date().toISOString();
}

export function formatElapsedTime(ms: number): string {
  // Calculate hours, minutes, seconds, and remaining milliseconds
  const hours = Math.floor(ms / 3600000);
  ms %= 3600000; // Remaining milliseconds after hours
  const minutes = Math.floor(ms / 60000);
  ms %= 60000; // Remaining milliseconds after minutes
  const seconds = Math.floor(ms / 1000);
  const milliseconds = ms % 1000; // Remaining milliseconds

  // Format the result
  const hours_str = hours.toString().padStart(2, "0");
  const minutes_str = minutes.toString().padStart(2, "0");
  const seconds_str = seconds.toString().padStart(2, "0");
  const ms_str = milliseconds.toString().padStart(3, "0");
  return `${hours_str}:${minutes_str}:${seconds_str}.${ms_str}`;
}

// **** process functions
