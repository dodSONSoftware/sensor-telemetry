/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type { z } from "zod";
import type { configSchema } from "../schemas/config";

// **** Common

export interface SystemInfo {
  key: string;
  value: string;
}

export interface IAbout {
  about: {
    name: string;
    version: string;
    author: string;
    copyright: string;
    license: string;
    description: string;
  }
  system_info: SystemInfo[];
}

// **** Logger

export const enum LogLevel {
  None = 0,
  Debug,
  Info,
  Warn,
  Error,
}

export interface ILogger {
  global_log_level(): LogLevel;
  global_log_level_string(): string;
  write_info(originator: string, message: string): void;
  write_warn(originator: string, message: string): void;
  write_error(originator: string, message: string): void;
  write_debug(originator: string, message: string): void;
  /**
   * Update the log level at runtime.
   * @param level - New log level string ("error", "warn", "info", "debug")
   */
  setLogLevel(level: string): void;
}

export interface IMqttNetworking {
  is_connected(): boolean;
  close(): Promise<void>;
  /**
   * Set callback to invoke when config is updated via /write-config.
   * @param callback - Function to call with new configuration
   */
  setConfigChangeCallback(callback: (newConfig: z.infer<typeof configSchema>) => void): void;
}
