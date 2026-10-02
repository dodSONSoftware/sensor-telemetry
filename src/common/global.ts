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

// **** public functions

let _logger: Logger | undefined;

export function setLogger(l: Logger) { _logger = l; }
export const logger = () => _logger;

export const createLogger = (config: z.infer<typeof configSchema>) => {
    setLogger(new Logger(config));
};


let _aboutDudeInfo: IAbout | null = null;

export function aboutDude(): IAbout {
    if (_aboutDudeInfo === null) {
        _aboutDudeInfo = {
            about: {
                name: "Sensor Telemetry Services",
                version,
                author: "Randy Dodson (dodsonsoftware@gmail.com)",
                description: "MQTT-to-Prometheus telemetry bridge for IoT sensors.",
                copyright: "Copyright © 2025-2026 dodson Software ( dodson labs )",
                license: "Licensed under the MIT License with Patent Grant and NOTICE preservation."
            },
        };
    }

    return _aboutDudeInfo;
}
