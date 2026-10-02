/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import path from "path";
import { aboutDude, serviceMetadata } from "../../../src/common/global";

// The authoritative application version (package.json), which
// serviceMetadata.version must reflect — never a hardcoded duplicate.
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

  it("reports the authoritative application version from package.json", () => {
    expect(serviceMetadata.version).toBe(packageJson.version);
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
