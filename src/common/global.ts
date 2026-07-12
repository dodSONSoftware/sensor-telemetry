/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import os from "os";
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
        const sys_info: { key: string; value: string }[] = [
            { key: "platform", value: os.platform() },
            { key: "arch", value: os.arch() },
            { key: "hostname", value: os.hostname() },
            { key: "uptime_seconds", value: String(Math.floor(os.uptime())) },
            { key: "total_memory", value: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB` },
            { key: "free_memory", value: `${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB` },
        ];

        _aboutDudeInfo = {
            about: {
                name: "Sensor Telemetry Service",
                version,
                author: "Randy Dodson (dodsonsoftware@gmail.com)",
                description: "MQTT-to-Prometheus telemetry bridge for IoT sensors.",
                copyright: "Copyright (c) 2025-2026 dodson Software ( dodson labs )",
                license: "Licensed under the MIT License with Patent Grant and NOTICE preservation."
            },
            system_info: sys_info
        };
    }

    return _aboutDudeInfo;
}
