/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import path from "path";
import type { IAbout } from "../dodsonlabs/Interfaces";
import { Logger } from "../dodsonlabs/Logger";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";

// Load version from package.json at module load time
import { createRequire } from "module";
const pkgRequire = createRequire(__filename);
// Resolve path relative to __dirname for reliability across environments
// __dirname is /app/dist/common when loaded from dist, so go up two levels
const packageJsonPath = path.join(__dirname, "../..", "package.json");
const { version } = pkgRequire(packageJsonPath) as { version: string };

// Single source of truth for the service's common identity and legal
// metadata, shared by aboutDude() and the /about endpoint. version comes
// from package.json (loaded above), never a hardcoded duplicate. Each
// consumer keeps its own description text; only the common fields live here.
export const serviceMetadata = {
    name: "Sensor Telemetry Services",
    version,
    author: "Randel Dodson",
    copyright: "Copyright © 2026 dodson Software ( dodson labs )",
    license: "MIT",
} as const;

// **** public functions

let _logger: Logger | undefined;

export function setLogger(l: Logger) { _logger = l; }
export const logger = () => _logger;

export const createLogger = (config: z.infer<typeof configSchema>): Logger => {
    const log = new Logger(config);
    setLogger(log);
    // Returning the constructed instance lets the startup path use it
    // directly instead of reading the global back through logger() and
    // asserting the type.
    return log;
};


let _aboutDudeInfo: IAbout | null = null;

export function aboutDude(): IAbout {
    if (_aboutDudeInfo === null) {
        _aboutDudeInfo = {
            about: {
                name: serviceMetadata.name,
                version: serviceMetadata.version,
                author: serviceMetadata.author,
                description: "MQTT-to-Prometheus telemetry bridge for IoT sensors.",
                copyright: serviceMetadata.copyright,
                license: serviceMetadata.license
            },
        };
    }

    return _aboutDudeInfo;
}
