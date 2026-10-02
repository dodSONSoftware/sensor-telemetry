/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import { randomUUID } from "crypto";
import { ILogger, LogLevel } from "./Interfaces";
import type { JsonObject } from "./Interfaces";
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
 *  - ./config.yml            — configuration for the current working directory
 *  - ./dist/config.yml       — build-output fallback when running from repo root
 */
export const CONFIG_FILE_CANDIDATES: string[] = [
  "/app/configs/config.yml",
  "./config.yml",
  "./dist/config.yml",
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
 * ./config.yml is caught even when the dist/ fallback is still valid.
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
 * Atomically replace `filename` with the YAML serialization of `data`.
 *
 * The new contents are written to a sibling temporary file and then
 * renamed over the target. On POSIX filesystems the rename is atomic, so
 * during normal process execution readers and the next startup never
 * observe a partially replaced target: they see either the old contents
 * or the new ones, never a truncated file. Each call uses its own
 * temporary file (a per-call unique name), so concurrent calls on the
 * same target cannot interleave through a shared temp path — one
 * writer's partial write or failed cleanup cannot corrupt another
 * writer's in-flight contents.
 *
 * This provides atomic replacement semantics, not durability across
 * sudden host power loss — the rename and the writes are not fsync'd, so
 * a power loss can leave either version (or neither) unflushed to disk.
 * Filesystem durability is outside this helper's contract. On a failure
 * thrown here (e.g. ENOSPC), the rename did not happen, so the previous
 * contents are still on disk and callers can truthfully report "no changes
 * were applied".
 */
export function write_file_yaml(
  filename: string,
  data: unknown,
  logger?: ILogger
): boolean {
  // Sibling in the same directory so the rename stays on one filesystem.
  // The name is unique per call (pid + randomUUID), not just per process:
  // concurrent writers (two in-flight /write-config requests) would
  // otherwise share one temp file, letting one writer's partial write or
  // failed cleanup corrupt the other writer's in-flight temp contents —
  // which the rename could then promote over the target, or leave the
  // on-disk and in-memory configs diverged.
  const tmpFile = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const yamlStr = yaml.dump(data, {
      indent: 2,
      lineWidth: -1,
    });
    fs.writeFileSync(tmpFile, yamlStr, "utf8");
    fs.renameSync(tmpFile, filename);
    return true;
  } catch (error) {
    // Best-effort cleanup of the temp file. We only reach here if the
    // write or the rename threw, so the rename never completed and the
    // target still holds its previous contents.
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

// **** log output bounding

/**
 * Default cap for untrusted scalar values reaching a log message or
 * structured log metadata (truncateForLog / truncateForLogList). Exported so
 * call sites and tests reference the single project limit instead of
 * hard-coding 256 in a second place.
 */
export const LOG_VALUE_MAX_LENGTH = 256;

/**
 * Bound an untrusted value for inclusion in a log message or structured log
 * metadata. Prometheus label values are already charset/length/cardinality
 * bounded, but the logging path was not: MQTT payload values such as source,
 * device, message_type, and individual degraded reasons are attacker
 * controlled and can be arbitrarily long, so logging them raw lets a hostile
 * publisher create disproportionately large log entries.
 *
 * Strings pass through as-is; other scalars (numbers, booleans, null,
 * undefined) stringify exactly as String(value) always has. Arrays are the
 * one value class String() cannot safely handle: array-to-string conversion
 * joins element by element and recurses on nested arrays, so a deeply nested
 * hostile payload (e.g. a degraded_reasons element) throws RangeError
 * (Maximum call stack size exceeded). Arrays are therefore structurally
 * bounded first — depth, item count, and per-string length, all capped by
 * boundForLog — and serialized with JSON.stringify, which cannot recurse or
 * throw on the finite bounded graph.
 *
 * If the result exceeds `maxLength` the first `maxLength` characters are kept
 * followed by a Unicode ellipsis, so the value stays recognizable rather than
 * being silently dropped. Values at or under `maxLength` are returned
 * unchanged. A new string is always produced; the input is never mutated.
 */
export function truncateForLog(value: unknown, maxLength: number = LOG_VALUE_MAX_LENGTH): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    // boundForLog first: a bare JSON.stringify of the raw value would still
    // recurse deeply enough to throw before the length cap could apply.
    text = JSON.stringify(boundForLog(value)) ?? String(value);
  } else {
    text = String(value);
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

/**
 * Bound a list of untrusted values for logging: keep at most `maxItems`
 * elements, each truncated to `maxLength` via truncateForLog. Used for
 * degraded_reasons so a hostile publisher cannot emit an unbounded number of
 * unbounded-length reasons in a single log entry (both the number of emitted
 * elements and the length of each are bounded). Returns a new array; the
 * input is not mutated.
 */
export function truncateForLogList(
  values: readonly unknown[],
  maxItems: number = 10,
  maxLength: number = LOG_VALUE_MAX_LENGTH,
): string[] {
  return values.slice(0, maxItems).map((value) => truncateForLog(value, maxLength));
}

// Caps for bounding untrusted STRUCTURED metadata (boundForLog). String
// length and list length match truncateForLog/truncateForLogList so every
// bounding path enforces the same per-value limits; the property-count and
// depth caps are what structured data additionally needs, and the depth cap
// exists because the Logger's redaction pass recurses through the metadata —
// an arbitrarily deep MQTT payload would exhaust the call stack otherwise.
// The depth cap and marker are also the Logger's own redaction depth guard
// (shared constants, so the two bounding passes cannot drift).
const LOG_BOUND_MAX_ITEMS = 10;
const LOG_BOUND_MAX_KEYS = 10;
export const LOG_BOUND_MAX_DEPTH = 8;
export const LOG_BOUND_DEPTH_MARKER = "[truncated: max depth]";

/**
 * Bound an untrusted structured value (object/array graph) for inclusion in
 * log metadata, preserving its structure so Loki can keep indexing the
 * fields it uses:
 *
 * - strings (values AND object keys — keys become Loki labels too) are
 *   truncated via truncateForLog (256 chars + ellipsis)
 * - arrays keep at most LOG_BOUND_MAX_ITEMS elements
 * - objects keep at most LOG_BOUND_MAX_KEYS properties (the first, in
 *   insertion order; note two keys that truncate identically collapse,
 *   which is acceptable for a bounded log view)
 * - nesting deeper than LOG_BOUND_MAX_DEPTH is replaced wholesale with a
 *   marker string instead of recursing
 * - numbers, booleans, and null pass through unchanged
 *
 * A new graph is always produced; the input is never mutated.
 */
export function boundForLog(value: unknown, depth: number = 0): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? truncateForLog(value) : value;
  }
  if (depth >= LOG_BOUND_MAX_DEPTH) {
    return LOG_BOUND_DEPTH_MARKER;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, LOG_BOUND_MAX_ITEMS)
      .map((item) => boundForLog(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, val] of Object.entries(value)) {
    if (keys >= LOG_BOUND_MAX_KEYS) break;
    result[truncateForLog(key)] = boundForLog(val, depth + 1);
    keys++;
  }
  return result;
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
 * - Empty/whitespace strings are the protocol's "unset" marker (legacy
 *   firmware uses them for missing values); Number("") would coerce them to 0 and publish
 *   a false zero reading, so they are treated as absent and the next alias
 *   is tried.
 * - Values that do not parse to a finite number are likewise absent.
 * - Fields whose name contains time/Time/millis/Millis (e.g. uptime_ms) are
 *   truncated to integer milliseconds.
 *
 * Returns undefined if no field holds a valid finite number.
 */
export function get_numeric_field(
  obj: JsonObject,
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

/**
 * Extract a string scalar from an untrusted JSON object, trying each field
 * name in order (pass snake_case/camelCase aliases in either order).
 *
 * MQTT protocol fields that are conceptually scalar (message_type, device,
 * source, firmware_version, log level, health status) must be proven scalar
 * at the MQTT boundary before entering internal processing. A blanket
 * String(value) on arbitrary JSON is not validation: JavaScript's
 * array-to-string conversion recursively joins nested arrays and throws
 * RangeError (Maximum call stack size exceeded) on deeply nested hostile
 * payloads, and the coercion silently turns booleans and objects into
 * plausible-looking garbage strings.
 *
 * Only actual strings are accepted, including the empty string; anything
 * else (number, boolean, null, object, array — nested or not) is treated as
 * absent and the next alias is tried. Identifier fields where legacy
 * firmware may emit a number (source, device, firmware_version) use
 * getStringOrFiniteNumberField instead.
 *
 * Returns undefined if no field holds a string.
 */
export function getStringField(
  obj: JsonObject | null | undefined,
  ...fieldNames: string[]
): string | undefined {
  if (obj === null || obj === undefined) return undefined;
  for (const fieldName of fieldNames) {
    const value = obj[fieldName];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Extract a string scalar with legacy numeric-scalar compatibility: a
 * finite number is converted to its string form (123 -> "123", 0 -> "0"),
 * because legacy firmware emits identifier fields such as source, device,
 * and firmware_version as numbers.
 *
 * Everything else follows getStringField's contract exactly: non-finite
 * numbers (NaN, +/-Infinity), booleans, null, objects, and arrays are
 * rejected as absent and the next alias is tried — never String()-converted,
 * so a deeply nested value cannot recurse through array-to-string
 * conversion (RangeError) or masquerade as a usable label.
 *
 * Returns undefined if no field holds a string or finite number.
 */
export function getStringOrFiniteNumberField(
  obj: JsonObject | null | undefined,
  ...fieldNames: string[]
): string | undefined {
  if (obj === null || obj === undefined) return undefined;
  for (const fieldName of fieldNames) {
    const value = obj[fieldName];
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value.toString();
    }
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

/**
 * Outcome of the startup wait for the Prometheus server to become ready.
 *
 * - "ready"    — the server reported ready; startup proceeds.
 * - "shutdown" — a shutdown is in flight (an operator stop signal or a
 *                fatal error that began the close); termination is owned by
 *                the shutdown path, so the caller must NOT report a startup
 *                failure or call process.exit on its own.
 * - "timeout"  — the deadline elapsed with no readiness and no shutdown;
 *                the caller reports prometheus_startup_failed and exits 1.
 */
export type StartupWaitResult = "ready" | "shutdown" | "timeout";

/**
 * Poll until the Prometheus server reports ready, a shutdown is initiated,
 * or the timeout elapses.
 *
 * The shutdown check comes first on purpose: the shutdown path's close()
 * clears the server's ready flag, so a wait that polled readiness alone
 * would run to its full deadline and report a spurious
 * "prometheus_startup_failed" while an operator stop (exit 0) or a fatal
 * error (exit 1) is already owning the exit. When a shutdown is in flight
 * the wait bails out early and reports "shutdown", so the caller defers to
 * the shutdown path instead of racing it with its own process.exit.
 *
 * isReady/isShuttingDown are injected as callbacks (rather than a networking
 * object) so the wait is pure control flow, unit-testable without a live
 * HTTP server or a real signal, and independent of MqttNetworking's shape.
 */
export async function wait_for_prometheus(
  isReady: () => boolean,
  isShuttingDown: () => boolean,
  maxWaitMs: number = 5000,
  waitIntervalMs: number = 100
): Promise<StartupWaitResult> {
  let elapsed = 0;
  while (!isShuttingDown() && !isReady() && elapsed < maxWaitMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitIntervalMs));
    elapsed += waitIntervalMs;
  }
  // Re-check shutdown after the loop (not just in the condition) so a
  // shutdown that begins on the final iteration is still reported as
  // "shutdown" rather than misread as a readiness "timeout".
  if (isShuttingDown()) {
    return "shutdown";
  }
  return isReady() ? "ready" : "timeout";
}
