/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  boundForLog,
  buildSourceValidCharsRegex,
  CONFIG_FILE_CANDIDATES,
  get_numeric_field,
  get_timestamp_iso,
  read_file_yaml_first,
  truncateForLog,
  truncateForLogList,
  write_file_yaml,
} from "../../../src/dodsonlabs/SystemFunctions";

const VALID_CONFIG_YAML = [
  "logLevel: info",
  "apiPort: 3301",
  'mqttBrokerIpAddress: "127.0.0.1"',
  "mqttTopicTelemetry: iot/telemetry",
].join("\n");

describe("CONFIG_FILE_CANDIDATES", () => {
  it("tries the container mount path first", () => {
    expect(CONFIG_FILE_CANDIDATES[0]).toBe("/app/configs/config.yml");
  });

  it("tries the current working directory config before the build-output copy", () => {
    expect(CONFIG_FILE_CANDIDATES.indexOf("./config.yml")).toBeLessThan(
      CONFIG_FILE_CANDIDATES.indexOf("./dist/config.yml")
    );
    // The dist/ copy is the last resort, so an edited root config (not yet
    // rebuilt) is never shadowed by a stale build snapshot.
    expect(CONFIG_FILE_CANDIDATES[CONFIG_FILE_CANDIDATES.length - 1]).toBe(
      "./dist/config.yml"
    );
  });
});

describe("read_file_yaml_first", () => {
  // Each test runs from a throwaway directory so CWD-relative candidates
  // never pick up files from the checkout itself (e.g. a built dist/).
  let workDir: string;
  let previousCwd: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-resolution-"));
    previousCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function writeConfig(dir: string, contents: string = VALID_CONFIG_YAML): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), contents, "utf8");
  }

  it("resolves the root config on a tree with no dist/ (regression P3-5)", () => {
    writeConfig(workDir);

    const result = read_file_yaml_first<Record<string, unknown>>(
      CONFIG_FILE_CANDIDATES
    );

    expect(result.error).toBeNull();
    expect(result.source).toBe("./config.yml");
    expect(result.data).toEqual({
      logLevel: "info",
      apiPort: 3301,
      mqttBrokerIpAddress: "127.0.0.1",
      mqttTopicTelemetry: "iot/telemetry",
    });
  });

  it("prefers ./config.yml over a stale dist/config.yml when both exist (npm start)", () => {
    // Regression: after `npm run build` the root config is copied to dist/,
    // but editing the root config without rebuilding must take effect —
    // the current config wins over the stale build snapshot.
    writeConfig(path.join(workDir, "dist"), "logLevel: debug");
    writeConfig(workDir);

    const result = read_file_yaml_first<Record<string, unknown>>(
      CONFIG_FILE_CANDIDATES
    );

    expect(result.error).toBeNull();
    expect(result.source).toBe("./config.yml");
    expect(result.data).toEqual({
      logLevel: "info",
      apiPort: 3301,
      mqttBrokerIpAddress: "127.0.0.1",
      mqttTopicTelemetry: "iot/telemetry",
    });
  });

  it("resolves from inside dist/ when the config was copied there (cd dist && node index.js)", () => {
    writeConfig(workDir);
    writeConfig(path.join(workDir, "dist"));
    process.chdir(path.join(workDir, "dist"));

    const result = read_file_yaml_first<Record<string, unknown>>(
      CONFIG_FILE_CANDIDATES
    );

    expect(result.error).toBeNull();
    expect(result.source).toBe("./config.yml");
  });

  it("fails fast on a corrupt root config instead of a stale dist/ copy (regression P3-4)", () => {
    writeConfig(path.join(workDir, "dist"), "logLevel: debug");
    // Unterminated double-quoted scalar: guaranteed YAML parse error.
    writeConfig(workDir, 'logLevel: "info');

    const result = read_file_yaml_first<Record<string, unknown>>(
      CONFIG_FILE_CANDIDATES
    );

    expect(result.data).toBeNull();
    expect(result.source).toBe("./config.yml");
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("./config.yml");
    expect(result.error).toContain("failed to parse");
  });

  it("fails fast on an existing but empty candidate instead of falling through (regression P3-4)", () => {
    writeConfig(path.join(workDir, "dist"), "logLevel: debug");
    writeConfig(workDir, "");

    const result = read_file_yaml_first<Record<string, unknown>>(
      CONFIG_FILE_CANDIDATES
    );

    expect(result.data).toBeNull();
    expect(result.source).toBe("./config.yml");
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("./config.yml");
  });

  it("returns null data and combined errors when no candidate exists", () => {
    const result = read_file_yaml_first<Record<string, unknown>>([
      "./does-not-exist/config.yml",
      "./config.yml",
    ]);

    expect(result.data).toBeNull();
    expect(result.source).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error).toContain("./does-not-exist/config.yml");
    expect(result.error).toContain("./config.yml");
  });
});

describe("write_file_yaml", () => {
  // Each test runs in a throwaway directory; fs spies are restored
  // afterwards so cleanup (rmSync) keeps working.
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-file-yaml-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("writes parseable YAML and leaves no temp file behind", () => {
    const file = path.join(workDir, "config.yml");
    fs.writeFileSync(file, VALID_CONFIG_YAML, "utf8");

    const result = write_file_yaml(file, { apiPort: 3400 });

    expect(result).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("apiPort: 3400");
    expect(fs.readdirSync(workDir)).toEqual(["config.yml"]);
  });

  // Regression P2-2: a failure after the temp write (crash/rename failure)
  // must leave the existing config byte-identical so the next startup's
  // fail-fast on unparseable files never trips over a truncated file.
  it("leaves the existing file untouched and removes the temp file when the rename fails", () => {
    const file = path.join(workDir, "config.yml");
    const original = VALID_CONFIG_YAML;
    fs.writeFileSync(file, original, "utf8");
    jest
      .spyOn(fs, "renameSync")
      .mockImplementation(() => {
        throw new Error("simulated rename failure");
      });

    const result = write_file_yaml(file, { apiPort: 3400 });

    expect(result).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(workDir)).toEqual(["config.yml"]);
  });

  // Regression P2-2: ENOSPC mid-write (the realistic trigger) — the temp
  // write itself fails, so the target must be untouched and nothing left
  // behind; the caller's "no changes were applied" response depends on it.
  it("leaves the existing file untouched and returns false when the temp write fails (ENOSPC)", () => {
    const file = path.join(workDir, "config.yml");
    const original = VALID_CONFIG_YAML;
    fs.writeFileSync(file, original, "utf8");
    const enospc = new Error("no space left on device") as Error & { code: string };
    enospc.code = "ENOSPC";
    // Capture the original before spying: inside the mock implementation,
    // fs.writeFileSync is the mock itself.
    const realWrite = fs.writeFileSync as (...a: unknown[]) => unknown;
    jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation((...args: unknown[]) => {
        // Only fail write_file_yaml's temp-file write (tmp suffix); let
        // anything else through.
        const target = args[0] as string;
        if (target.includes(".tmp-")) {
          throw enospc;
        }
        return realWrite(...(args as [string, string, string]));
      });

    const result = write_file_yaml(file, { apiPort: 3400 });

    expect(result).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(workDir)).toEqual(["config.yml"]);
  });
});

describe("get_timestamp_iso", () => {
  it("returns the full ISO 8601 form with the Z suffix", () => {
    // The value lands in *_utc fields (boot_date_utc, forwarded-log
    // timestamps); the trailing Z is what makes it unambiguously UTC.
    const ts = get_timestamp_iso();
    expect(ts).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    // Round-trips as the same instant (not interpreted as local time).
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});

describe("get_numeric_field", () => {
  it("returns finite numbers as-is", () => {
    expect(get_numeric_field({ temperature_c: 21.5 }, "temperature_c")).toBe(
      21.5
    );
    expect(get_numeric_field({ raw: 0 }, "raw")).toBe(0);
  });

  it("parses numeric strings (V1/V2 compatibility)", () => {
    expect(get_numeric_field({ temperature_c: "21.5" }, "temperature_c")).toBe(
      21.5
    );
    expect(get_numeric_field({ raw: " 4096 " }, "raw")).toBe(4096);
  });

  it("treats empty/whitespace strings as absent and tries the next alias", () => {
    expect(
      get_numeric_field({ a: "", b: "7" }, "a", "b")
    ).toBe(7);
    expect(
      get_numeric_field({ a: "   " }, "a")
    ).toBeUndefined();
  });

  it("rejects non-number/non-string values that Number() would coerce", () => {
    // Number(false) === 0, Number(true) === 1, Number([]) === 0,
    // Number([7]) === 7 — all of these must be absent, not coerced.
    expect(
      get_numeric_field({ relative_moisture_percent: false }, "relative_moisture_percent")
    ).toBeUndefined();
    expect(get_numeric_field({ relative_moisture_percent: true }, "relative_moisture_percent")).toBeUndefined();
    expect(
      get_numeric_field({ relative_moisture_percent: [] }, "relative_moisture_percent")
    ).toBeUndefined();
    expect(
      get_numeric_field({ relative_moisture_percent: [7] }, "relative_moisture_percent")
    ).toBeUndefined();
    expect(
      get_numeric_field({ relative_moisture_percent: { v: 7 } }, "relative_moisture_percent")
    ).toBeUndefined();
  });

  it("treats non-finite numbers as absent and tries the next alias", () => {
    expect(get_numeric_field({ a: NaN, b: 3 }, "a", "b")).toBe(3);
    expect(get_numeric_field({ a: Infinity, b: 3 }, "a", "b")).toBe(3);
    expect(get_numeric_field({ a: "abc" }, "a")).toBeUndefined();
  });

  it("treats null/undefined as absent and tries the next alias", () => {
    expect(get_numeric_field({ a: null, b: 4 }, "a", "b")).toBe(4);
    expect(get_numeric_field({ a: undefined, b: 4 }, "a", "b")).toBe(4);
    expect(get_numeric_field({ a: 5 }, "b")).toBeUndefined();
  });

  it("skips a non-numeric value and falls through to a later alias", () => {
    expect(
      get_numeric_field({ a: false, b: "12" }, "a", "b")
    ).toBe(12);
  });

  it("truncates fields named time/Time/millis/Millis to integers", () => {
    expect(get_numeric_field({ uptime_ms: 1234.9 }, "uptime_ms")).toBe(1234);
    expect(get_numeric_field({ durationMillis: 87.4 }, "durationMillis")).toBe(87);
  });
});

describe("buildSourceValidCharsRegex", () => {
  // Single source of truth for the source-label sanitization regex: the
  // schema's constructibility check and the PrometheusWriter constructor
  // both call this, so the escape rule can never drift between them.
  it("builds a negated character class with the global flag", () => {
    const re = buildSourceValidCharsRegex("a-zA-Z0-9._-");
    expect(re.flags).toContain("g");
    // Whitelisted characters survive, everything else is stripped.
    expect("sensor_01-A".replace(re, "")).toBe("sensor_01-A");
    expect("s$en^sor!@#".replace(re, "")).toBe("sensor");
  });

  it("escapes metacharacters so configured chars match literally", () => {
    // An unescaped ']' in the whitelist would close the character class
    // early and leave the rest of the pattern to be interpreted as regex
    // outside the class — escaping keeps it a literal whitelist member.
    const re = buildSourceValidCharsRegex("a]b");
    expect("a]b".replace(re, "")).toBe("a]b");
    expect("a x] y b z".replace(re, "")).toBe("a]b");
  });

  it.each([
    ["z-a", "out-of-order range"],
    ["z-A", "descending range across letter cases"],
    ["a--b", "hyphen forming an out-of-order range with its neighbor"],
  ])("throws for %s (%s) instead of returning a broken regex", (chars, _label) => {
    expect(() => buildSourceValidCharsRegex(chars)).toThrow(SyntaxError);
  });
});

describe("truncateForLog", () => {
  it("returns short values unchanged (no ellipsis)", () => {
    expect(truncateForLog("air")).toBe("air");
    // Exactly at the limit: not over, so unchanged.
    expect(truncateForLog("a".repeat(256))).toBe("a".repeat(256));
  });

  it("bounds values over the limit to the first 256 chars plus an ellipsis", () => {
    const long = "x".repeat(1000);
    const result = truncateForLog(long);
    expect(result).toBe(`${"x".repeat(256)}…`);
    // Bounded: the log field cannot grow with the input length.
    expect(result.length).toBeLessThanOrEqual(257);
    expect(result).not.toBe(long);
  });

  it("coerces non-string values to their string form", () => {
    expect(truncateForLog(123)).toBe("123");
    expect(truncateForLog(null)).toBe("null");
    expect(truncateForLog(undefined)).toBe("undefined");
    expect(truncateForLog(true)).toBe("true");
    // Objects coerce via String() to their default representation — already
    // short and bounded, which is all the log bound needs (no deep serialize).
    expect(truncateForLog({ a: 1 })).toBe("[object Object]");
  });

  it("honors a custom maxLength", () => {
    expect(truncateForLog("abcdefghij", 4)).toBe("abcd…");
    expect(truncateForLog("abcd", 4)).toBe("abcd");
  });
});

describe("truncateForLogList", () => {
  it("returns short lists unchanged", () => {
    expect(truncateForLogList(["low_free_heap", "mqtt"])).toEqual([
      "low_free_heap",
      "mqtt",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(truncateForLogList([])).toEqual([]);
  });

  it("caps the number of elements at maxItems (default 10)", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `reason_${i}`);
    const result = truncateForLogList(twelve);
    expect(result).toHaveLength(10);
    expect(result).toEqual(
      Array.from({ length: 10 }, (_, i) => `reason_${i}`)
    );
  });

  it("bounds the length of each element", () => {
    const result = truncateForLogList(["y".repeat(500)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(`${"y".repeat(256)}…`);
    expect(result[0].length).toBeLessThanOrEqual(257);
  });

  it("caps both count and per-element length together", () => {
    const many = Array.from({ length: 20 }, () => "z".repeat(400));
    const result = truncateForLogList(many);
    expect(result).toHaveLength(10);
    for (const element of result) {
      expect(element.length).toBeLessThanOrEqual(257);
    }
  });

  it("returns a new array and does not mutate the input", () => {
    const input: unknown[] = ["a".repeat(300), "short"];
    const snapshot = [...input];
    const result = truncateForLogList(input);
    expect(result).not.toBe(input);
    expect(input).toEqual(snapshot);
  });
});

describe("boundForLog", () => {
  const ELL = "…";

  it("leaves small structured data structurally equivalent", () => {
    const input = {
      event: "command_ack",
      count: 3,
      ok: true,
      nothing: null,
      detail: { sensor: "bme280", retries: 1 },
      list: ["a", "b"],
    };
    expect(boundForLog(input)).toEqual(input);
  });

  it("truncates long string values with the ellipsis marker", () => {
    const result = boundForLog({ detail: "x".repeat(5000) }) as Record<
      string,
      unknown
    >;
    expect(result.detail).toBe(`${"x".repeat(256)}${ELL}`);
    expect((result.detail as string).length).toBeLessThanOrEqual(257);
  });

  it("truncates long object keys too (they become Loki labels)", () => {
    const longKey = "k".repeat(5000);
    const result = boundForLog({ [longKey]: "v" }) as Record<string, unknown>;
    const keys = Object.keys(result);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(`${"k".repeat(256)}${ELL}`);
    expect(result[keys[0]]).toBe("v");
  });

  it("keeps short keys exact so the Logger's secret redaction still matches", () => {
    const result = boundForLog({ password: "hunter2", apiKey: "abc" }) as Record<
      string,
      unknown
    >;
    // Key names are unchanged; the Logger's redaction pass is what replaces
    // the values, and it matches on these names.
    expect(Object.keys(result).sort()).toEqual(["apiKey", "password"]);
  });

  it("caps arrays at 10 elements", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => i);
    expect(boundForLog(twelve)).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  it("caps objects at 10 properties, keeping the first in insertion order", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < 15; i++) input[`key_${i}`] = i;
    const result = boundForLog(input) as Record<string, number>;
    expect(Object.keys(result)).toEqual(
      Array.from({ length: 10 }, (_, i) => `key_${i}`)
    );
  });

  it("bounds large strings nested inside arrays and objects", () => {
    const result = boundForLog({
      list: [{ detail: "d".repeat(500) }],
    }) as { list: Array<{ detail: string }> };
    expect(result.list[0].detail).toBe(`${"d".repeat(256)}${ELL}`);
  });

  it("replaces subtrees beyond the depth cap with a marker instead of recursing", () => {
    // 50 nested levels: without the depth cap this would both produce a
    // 50-level log graph and (via the Logger's recursive redaction) consume
    // 50 stack frames per log line.
    let node: Record<string, unknown> = { leaf: "bottom" };
    for (let i = 0; i < 50; i++) node = { child: node };
    expect(() => boundForLog(node)).not.toThrow();

    // Walk down: the chain is flat at the cap depth, marked, and shallow.
    let depth = 0;
    let current: unknown = boundForLog(node);
    while (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      "child" in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>).child;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(10);
    expect(typeof current).toBe("string");
  });

  it("does not mutate the input graph", () => {
    const input = {
      detail: "x".repeat(5000),
      list: Array.from({ length: 12 }, (_, i) => `item_${i}`),
      nested: { deep: "y".repeat(500) },
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    boundForLog(input);
    expect(input).toEqual(snapshot);
  });

  it("passes numbers, booleans, and null through unchanged", () => {
    expect(boundForLog(42)).toBe(42);
    expect(boundForLog(0)).toBe(0);
    expect(boundForLog(true)).toBe(true);
    expect(boundForLog(false)).toBe(false);
    expect(boundForLog(null)).toBe(null);
  });
});
