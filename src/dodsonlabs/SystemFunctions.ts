/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import { ILogger, LogLevel } from "./Interfaces";
import * as yaml from "js-yaml";

// **** error functions

export function ensureError(value: unknown): Error {
    // check for undefined
    if (value === undefined) return Error("<<< Error is undefined >>>");

    // check for error
    if (value instanceof Error) return value;

    // convert to json string
    let result =
        "Unknown Error: error value cannot be converted to a json string.";
    try {
        result = JSON.stringify(value);
    } catch { }

    // return new error
    return new Error(result);
}

// **** file functions

/** Result of a file read operation — distinguishes "not found" from parse errors. */
export interface ReadFileResult<T> {
    data: T | null;
    error: string | null;
}

export function write_file(
    filename: string,
    content: string,
    logger?: ILogger
): boolean {
    try {
        fs.writeFileSync(filename, content);
        return true;
    } catch (error) {
        const msg = `write_file: failed to write '${filename}': ${(error as Error).message}`;
        if (logger) {
            logger.write_error("SystemFunctions.write_file", msg);
        } else {
            console.error(msg);
        }
        return false;
    }
}

export function read_file(
    filename: string,
    logger?: ILogger
): string | null {
    try {
        const buffer = fs.readFileSync(filename, "utf8");
        return buffer.toString();
    } catch (error) {
        const msg = `read_file: failed to read '${filename}': ${(error as Error).message}`;
        if (logger) {
            logger.write_error("SystemFunctions.read_file", msg);
        } else {
            console.error(msg);
        }
        return null;
    }
}

export function read_file_json<T>(
    filename: string,
    logger?: ILogger
): ReadFileResult<T> {
    const data = read_file(filename, logger);
    if (data == null) {
        return { data: null, error: `read_file_json: could not read '${filename}'` };
    }
    try {
        return { data: JSON.parse(data), error: null };
    } catch (error) {
        const msg = `read_file_json: failed to parse '${filename}': ${(error as Error).message}`;
        if (logger) {
            logger.write_error("SystemFunctions.read_file_json", msg);
        } else {
            console.error(msg);
        }
        return { data: null, error: msg };
    }
}

export function read_file_yaml<T>(
    filename: string,
    logger?: ILogger
): ReadFileResult<T> {
    const data = read_file(filename, logger);
    if (data == null) {
        return { data: null, error: `read_file_yaml: could not read '${filename}'` };
    }
    try {
        return { data: yaml.load(data) as T, error: null };
    } catch (error) {
        const msg = `read_file_yaml: failed to parse '${filename}': ${(error as Error).message}`;
        if (logger) {
            logger.write_error("SystemFunctions.read_file_yaml", msg);
        } else {
            console.error(msg);
        }
        return { data: null, error: msg };
    }
}

// ******** log level string to enum conversion

export function convert_from_log_level_string_to_enum(
    logLevelString: string
): LogLevel {
    switch (logLevelString.toLowerCase()) {
        case "error":
            return LogLevel.Error;
        case "warn":
            return LogLevel.Warn;
        case "info":
            return LogLevel.Info;
        case "debug":
            return LogLevel.Debug;
        default:
            // Unknown log level — default to Info (forward most messages)
            // rather than None (silently drop everything).
            return LogLevel.Info;
    }
}

// **** sleep functions

export async function sleep(delayMS: number): Promise<void> {
    if (typeof delayMS !== "number" || delayMS < 0) {
        throw new Error("delayMS must be a non-negative number");
    }
    if (delayMS === 0) {
        return Promise.resolve(); // Resolves immediately
    }
    return new Promise((resolve) => setTimeout(resolve, delayMS)); // Normal sleep
}

// **** general functions

export function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// **** time-related functions

export function get_timestamp_iso(): string {
    return new Date().toISOString().slice(0, -1);
}

export function get_timestamp(include_ms: boolean): string {
    // init
    const dt = new Date();

    // get date and time components
    const year = String(dt.getFullYear());
    const month = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    const h = String(dt.getHours()).padStart(2, "0");
    const m = String(dt.getMinutes()).padStart(2, "0");
    const s = String(dt.getSeconds()).padStart(2, "0");
    const ms = String(dt.getMilliseconds()).padStart(3, "0");

    // get the timestamp
    let dude = `${year}-${month}-${day} ${h}:${m}:${s}`;

    // check if including milliseconds
    if (include_ms) {
        dude = `${dude}.${ms}`;
    }

    // return results
    return dude;
}

/**
 * @param start_time - Populate with a Date.now()
 * @returns Returns a string formatted to show the elapsed time
 */
export function elapsed_time(start_time: Date | undefined): string {
    let start_time_value = Date.now();

    if (start_time !== undefined) {
        start_time_value = start_time.valueOf();
    }

    return formatElapsedTime(Date.now() - start_time_value);
}

export function elapsed_time_seconds(start_date: Date): number {
    return (Date.now() - start_date.valueOf()) / 1000;
}

export function formatElapsedTime(ms: number): string {
    // Calculate hours, minutes, seconds, and remaining milliseconds
    const hours = Math.floor(ms / 3600000);
    ms %= 3600000; // Remaining milliseconds after hours
    const minutes = Math.floor(ms / 60000);
    ms %= 60000; // Remaining milliseconds after minutes
    const seconds = Math.floor(ms / 1000);
    const milliseconds = ms % 1000; // Remaining milliseconds

    // Format the result
    const hours_str = hours.toString().padStart(2, "0");
    const minutes_str = minutes.toString().padStart(2, "0");
    const seconds_str = seconds.toString().padStart(2, "0");
    const ms_str = milliseconds.toString().padStart(3, "0");
    return `${hours_str}:${minutes_str}:${seconds_str}.${ms_str}`;
}

// **** process functions

/**
 * @deprecated DO NOT USE. This function executes arbitrary shell commands and
 * is vulnerable to command injection if the input is ever derived from user data.
 * It has no callers and will be removed in a future release.
 */
// export async function executeBashCommand(cmd: string): Promise<string> {
//   return new Promise<string>((resolve, reject) => {
//     childProc.exec(cmd, (error, stdout, stderr) => {
//       if (error) {
//         const msg = `Error executing script: ${error.message}`;
//         reject(new Error(msg));
//       }
//       if (stderr) {
//         const msg = `Script error output: ${stderr}`;
//         reject(new Error(msg));
//       }
//       resolve(stdout); // Resolve with the standard output
//     });
//   });
//}
// test change
// test change
// another test
// final test
// test
