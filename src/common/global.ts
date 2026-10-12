/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type { IAbout } from "../dodsonlabs/Interfaces";
import { Logger } from "../dodsonlabs/Logger";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";

// The app version comes from src/version.ts — the version's source of truth
// (reported by /about). package.json is kept in sync with it by the
// /git-commit workflow, so no module-load lookup is needed.
import { APP_VERSION } from "../version";

// Single source of truth for the service's common identity and legal
// metadata, shared by aboutDude() and the /about endpoint. Each
// consumer keeps its own description text; only the common fields live here.
export const serviceMetadata = {
    name: "Sensor Telemetry Services",
    version: APP_VERSION,
    author: "Randel Dodson",
    copyright: "Copyright © 2026 dodson Software ( dodson labs )",
    license: "MIT",
} as const;

// **** public functions

export const createLogger = (config: z.infer<typeof configSchema>): Logger =>
    new Logger(config);


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
