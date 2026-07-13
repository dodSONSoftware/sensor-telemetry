/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import winston from "winston";
import { LogLevel } from "./Interfaces";
import type { ILogger } from "./Interfaces";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";

const { combine, timestamp, printf, colorize, simple } = winston.format;

export class Logger implements ILogger {
    private readonly logger: winston.Logger;
    private global_log_level_value: LogLevel;
    private global_log_level_name: string;

    constructor(config: z.infer<typeof configSchema>) {
        this.global_log_level_value = convertFromWinstonLevel(config.logLevel);
        this.global_log_level_name = config.logLevel;

        // Format log messages
        const customFormat = printf(({ level, message, ...meta }) => {
            return `[${level.toUpperCase()}] ${message}${
                Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""
            }`;
        });

        // Always add console transport
        const transports = [
            new winston.transports.Console({
                format: combine(
                    colorize(),
                    timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
                    simple()
                ),
            }),
        ];

        this.logger = winston.createLogger({
            level: this.global_log_level_name,
            format: customFormat,
            transports,
        });
    }

    global_log_level(): LogLevel {
        return this.global_log_level_value;
    }

    global_log_level_string(): string {
        return this.global_log_level_name;
    }

    /**
     * Update the log level at runtime.
     * @param level - New log level string ("error", "warn", "info", "debug")
     */
    public setLogLevel(level: string): void {
        this.global_log_level_value = convertFromWinstonLevel(level);
        this.global_log_level_name = level;
        this.logger.level = level;
    }

    write_info(originator: string, message: string): void {
        this.logger.info(`[${originator}] ${message}`);
    }

    write_warn(originator: string, message: string): void {
        this.logger.warn(`[${originator}] ${message}`);
    }

    write_error(originator: string, message: string): void {
        this.logger.error(`[${originator}] ${message}`);
    }

    write_debug(originator: string, message: string): void {
        this.logger.debug(`[${originator}] ${message}`);
    }
}

function convertFromWinstonLevel(level: string): LogLevel {
    switch (level?.toLowerCase()) {
        case "error":
            return LogLevel.Error;
        case "warn":
            return LogLevel.Warn;
        case "info":
            return LogLevel.Info;
        case "debug":
            return LogLevel.Debug;
        default:
            return LogLevel.Info;
    }
}
