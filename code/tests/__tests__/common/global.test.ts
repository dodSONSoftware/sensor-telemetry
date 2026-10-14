/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import path from "path";
import { aboutDude, serviceMetadata } from "../../../src/common/global";
import { APP_NAME, APP_VERSION } from "../../../src/version";

// src/version.ts is the authoritative application version, which
// serviceMetadata.version must report — package.json must stay in sync.
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../..", "package.json"), "utf8")
) as { version: string };

describe("serviceMetadata (shared service identity)", () => {
  it("carries the canonical identity and legal metadata", () => {
    expect(serviceMetadata.name).toBe("Sensor Telemetry Services");
    expect(serviceMetadata.author).toBe("Randel Dodson");
    expect(serviceMetadata.copyright).toBe(
      "Copyright © 2026 dodson Software ( dodson labs )"
    );
    expect(serviceMetadata.license).toBe("MIT");
  });

  it("reports the authoritative application version from src/version.ts", () => {
    expect(serviceMetadata.version).toBe(APP_VERSION);
    // package.json must stay in sync with src/version.ts
    expect(packageJson.version).toBe(APP_VERSION);
  });

  it("reports the release codename from src/version.ts", () => {
    expect(serviceMetadata.release).toBe(APP_NAME);
  });
});

describe("aboutDude()", () => {
  it("consumes the shared metadata for its common fields", () => {
    const about = aboutDude().about;
    expect(about.name).toBe(serviceMetadata.name);
    expect(about.version).toBe(serviceMetadata.version);
    expect(about.author).toBe(serviceMetadata.author);
    expect(about.copyright).toBe(serviceMetadata.copyright);
    expect(about.license).toBe(serviceMetadata.license);
  });

  it("keeps its own description text (not shared with /about)", () => {
    expect(aboutDude().about.description).toBe(
      "MQTT-to-Prometheus telemetry bridge for IoT sensors."
    );
  });
});
