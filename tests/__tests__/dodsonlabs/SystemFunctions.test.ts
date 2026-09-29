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
} from "../../../src/dodsonlabs/SystemFunctions";

const VALID_CONFIG_YAML = [
  "logLevel: info",
  "prometheusPort: 3301",
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
      prometheusPort: 3301,
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
