/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  CONFIG_FILE_CANDIDATES,
  read_file_yaml_first,
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

  it("falls back to the repo-root config.yml for fresh clones (npm run dev)", () => {
    expect(CONFIG_FILE_CANDIDATES).toContain("./config.yml");
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

  it("prefers dist/config.yml over the root config when both exist (npm start)", () => {
    writeConfig(path.join(workDir, "dist"), "logLevel: debug");
    writeConfig(workDir);

    const result = read_file_yaml_first<Record<string, unknown>>(
      CONFIG_FILE_CANDIDATES
    );

    expect(result.error).toBeNull();
    expect(result.source).toBe("./dist/config.yml");
    expect(result.data).toEqual({ logLevel: "debug" });
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
