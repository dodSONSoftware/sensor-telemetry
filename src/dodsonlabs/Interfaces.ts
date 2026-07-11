/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

// **** Common

export interface CommandHelp {
  name: string;
  help: Record<string, unknown>;
}

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
  commands: CommandHelp[];
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
  write_info(originator: string, message: string, start_date?: Date, requestId?: string): void;
  write_warn(originator: string, message: string, start_date?: Date, requestId?: string): void;
  write_error(originator: string, message: string, start_date?: Date, requestId?: string): void;
  write_debug(originator: string, message: string, start_date?: Date, requestId?: string): void;
}

export interface IMqttNetworking {
  //start_networking(): void;
  publish_mqtt_message(topic: string, message: Record<string, any>): void;
  is_connected(): boolean;
  close(): Promise<void>;
  // on_connect(): void;
  // on_disconnect(): void;
  // on_message(topic: string, payload: Buffer, packet: mqtt.IPublishPacket): void;
  // on_error(error: any): void;

  // write_health(is_healthy: boolean, heartbeat_sec: number, explanation: string): void;
  // write_info(originator: string, message: string, start_date?: Date): void;
  // write_error(originator: string, message: string, start_date?: Date): void;
  // write_debug(originator: string, message: string, start_date?: Date): void;
}

export interface MqttCommandResult {
  source: string;
  payload: Record<string, unknown>;
}

export interface IMqttCommandControl {
  is_running: boolean;
  is_timed_out: boolean;
  timeout: NodeJS.Timeout | null;
  results: MqttCommandResult[];
  initialize(): void;
  deinitialize(): void;
  clear_results(): void;
  restart_clock(): void;
  cancel_clock(): void;
  waitForCompletion(): Promise<void>;
}
