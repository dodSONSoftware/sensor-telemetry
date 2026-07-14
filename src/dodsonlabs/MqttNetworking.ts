/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import mqtt from "mqtt";
import * as sysFunc from "./SystemFunctions";
import { PrometheusWriter } from "./PrometheusWriter";
import { LogLevel } from "./Interfaces";
import type { ILogger, IMqttNetworking } from "./Interfaces";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";

export class MqttNetworking implements IMqttNetworking {

    // ********
    // ******** CONSTANTS

    // Heat index calculation threshold (Celsius)
    // Below this temperature, feels-like equals actual temperature
    private static readonly HEAT_INDEX_THRESHOLD_C: number = 20;

    // ********
    // ******** CTOR

    constructor(
        config: z.infer<typeof configSchema>,
        logger: ILogger,
        configSource: string = "/app/configs/config.yml",
        configChangeCallback?: (newConfig: z.infer<typeof configSchema>) => void
    ) {
        // save parameters
        this.configuration = config;
        this.mqtt_server_ip_address = config.mqttBrokerIpAddress;
        this.mqtt_topic_telemetry = config.mqttTopicTelemetry;
        // ----
        this.logger = logger;
        this.originator = "networking";
        // ---- sensor log forwarding (default true for backward compatibility)
        this.forward_sensor_logs = config.forwardSensorLogs ?? true;
        // ---- sensor log level threshold (default debug = forward everything)
        this.forward_sensor_logs_level = config.forwardSensorLogsLevel
            ? sysFunc.convert_from_log_level_string_to_enum(config.forwardSensorLogsLevel)
            : LogLevel.Debug;

        // create mqtt client and connect to mqtt broker first
        this.mqtt_client = this.connect_to_mqtt_broker();

        // Create PrometheusWriter with callback (registered before server starts)
        this.promWriter = new PrometheusWriter(this.configuration, this.logger, configSource, configChangeCallback);
        this.promWriter.setMqttNetworking(this);

        // log-it
        this.logger.write_info("MqttNetworking::ctor()", "MqttNetworking Initialized");
    }

    // ********
    // ******** PUBLIC METHODS

    /**
     * Calculate heat index (feels like temperature) from temperature and humidity.
     * Uses the Rothfusz regression formula.
     * @param tempC Temperature in Celsius
     * @param humidity Relative humidity (0-100)
     * @returns Heat index in Celsius (4 decimal places), or original temp if conditions are not suitable
     */
    public calculateHeatIndex(tempC: number | undefined, humidity: number | undefined): number | undefined {
        if (tempC === undefined || humidity === undefined) {
            return undefined;
        }

        // Heat index is only calculated for temperatures >= 20°C (68°F)
        // Below this, the air temperature is a good approximation of feels like
        if (tempC < MqttNetworking.HEAT_INDEX_THRESHOLD_C) {
            return tempC;
        }

        // Convert Celsius to Fahrenheit for the formula
        const tempF = tempC * 9 / 5 + 32;

        // Rothfusz regression formula
        let hi = 0.5 * (tempF + 61.0 + ((tempF - 68.0) * 1.2) + (humidity * 0.094));

        // Apply adjustment for high humidity and high temperature
        if (hi > 79) {
            hi += -0.1 * (humidity - 85) * (107 - tempF) * 0.0001;
        }

        // Return result in Celsius
        return (hi - 32) * 5 / 9;
    }

    // ********
    // ******** PRIVATE PROPERTIES

    private configuration: z.infer<typeof configSchema>;
    // ----
    private mqtt_client: mqtt.MqttClient;
    private readonly logger: ILogger;
    private promWriter: PrometheusWriter;
    // ----
    private readonly mqtt_server_ip_address: string;
    public readonly mqtt_topic_telemetry: string;
    // ----
    private readonly originator: string;
    // ----
    private forward_sensor_logs: boolean;
    private forward_sensor_logs_level: LogLevel;

    // ********
    // ******** PRIVATE FUNCTIONS

    private connect_to_mqtt_broker(): mqtt.MqttClient {
        const client = mqtt.connect(`mqtt://${this.mqtt_server_ip_address}`, {
            clientId: `dodsonlabs-${sysFunc.randomInt(100000, 999999)}-client-id`,
            clean: true,
            connectTimeout: 10000,
            reconnectPeriod: 5000,
        });

        // ----
        client.on("connect", () => this.on_connect());
        client.on("disconnect", () => this.on_disconnect());
        client.on("error", (err) => this.on_error(err));
        client.on(
            "message",
            (topic: string, payload: Buffer, packet: mqtt.IPublishPacket) =>
                this.on_message(topic, payload, packet)
        );

        // ----
        return client;
    }



    // ****************************************************************
    // ****************************************************************
    // ******** INETWORKLOGGER FUNCTIONS

    public is_connected(): boolean {
        return this.mqtt_client?.connected ?? false;
    }

    public prometheus_server_ready(): boolean {
        return this.promWriter.is_ready();
    }

    /**
     * Get the PrometheusWriter instance for config management.
     */
    public getPrometheusWriter(): PrometheusWriter | undefined {
        return this.promWriter;
    }

    /**
     * Set callback to invoke when config is updated via /write-config.
     */
    public setConfigChangeCallback(callback: (newConfig: z.infer<typeof configSchema>) => void): void {
        // Register with PrometheusWriter if already created
        if (this.promWriter) {
            this.promWriter.setConfigChangeCallback(callback);
        }
    }

    public async close(timeout_ms: number = 5000): Promise<void> {
        this.logger.write_info(this.originator, `<close> => Shutting down MQTT client (timeout: ${timeout_ms}ms)...`);

        // Close Prometheus writer first (no timeout needed)
        this.promWriter.close();

        // Close MQTT client with timeout
        const closePromise = new Promise<void>((resolve) => {
            this.mqtt_client.end(() => {
                this.logger.write_info(this.originator, "<close> => MQTT client disconnected.");
                resolve();
            });
        });

        const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                this.logger.write_error(
                    this.originator,
                    `<close> => MQTT client close timed out after ${timeout_ms}ms, forcing disconnect.`
                );
                // Force close as a last resort — force=true skips waiting for
                // pending packets to be acknowledged, avoiding the hang.
                this.mqtt_client.end(true, () => resolve());
            }, timeout_ms);
        });

        await Promise.race([closePromise, timeoutPromise]);
    }

    /**
     * Update configuration at runtime.
     * @param newConfig - New configuration object
     */
    public updateConfig(newConfig: z.infer<typeof configSchema>): void {
        this.configuration = { ...newConfig };

        // Update forward_sensor_logs settings
        this.forward_sensor_logs = newConfig.forwardSensorLogs !== undefined ? newConfig.forwardSensorLogs : true;

        // Update forward_sensor_logs_level threshold
        this.forward_sensor_logs_level = newConfig.forwardSensorLogsLevel
            ? sysFunc.convert_from_log_level_string_to_enum(newConfig.forwardSensorLogsLevel)
            : LogLevel.Debug;

        this.logger.write_info(
            this.originator + ".updateConfig",
            `Configuration updated: logLevel=${newConfig.logLevel}, forwardSensorLogs=${this.forward_sensor_logs}`
        );
    }

    // ****************************************************************
    // ****************************************************************
    // ******** MQTT HANDLER FUNCTIONS

    private async on_connect(): Promise<void> {
    // log-it
        this.logger.write_debug(this.originator, "<on_connect> => Connected to the MQTT broker");

        // subscribe to topic
        this.logger.write_debug(this.originator, `<on_connect> => Subscribing to Topic: ${this.mqtt_topic_telemetry}`);
        this.mqtt_client.subscribe(this.mqtt_topic_telemetry);
    }

    private on_disconnect(): void {
        this.logger.write_warn(this.originator, "<on_disconnect> => Disconnected from MQTT broker");
    // The mqtt library will auto-reconnect (reconnectPeriod: 5000).
    // When it does, the 'connect' event fires on_connect() which resubscribes.
    }

    private on_message(
        _topic: string,
        payload: Buffer,
        _packet: mqtt.IPublishPacket
    ): void {
        try {
            this.handle_mqtt_message(JSON.parse(payload.toString())).catch((error) => {
                this.logger.write_error(
                    this.originator,
                    `<on_message> => ERROR=${error}`
                );
            });

        } catch (error) {
            this.logger.write_error(
                this.originator,
                `<on_message> => ERROR=${error}`
            );
        }
    }

    private on_error(error: any): void {
        this.logger.write_error(
            this.originator,
            `<on_error> => Cannot connect! ERROR=${sysFunc.ensureError(error).message}`
        );
    // The mqtt library will auto-reconnect (reconnectPeriod: 5000).
    // Do NOT call on_connect() here — the client may be in an error state,
    // and calling subscribe() on it would trigger another error event.
    }



    // ****************************************************************
    // ****************************************************************
    // ******** PROCESSING MQTT MESSAGES

    private async handle_mqtt_message(json_doc: any): Promise<void> {
    // initialize
        const msg_type_raw = json_doc["message-type"];
        if (msg_type_raw === undefined) {
            this.logger.write_error(this.originator, "<handle_mqtt_message> => Missing 'message-type' key, dropping message");
            return;
        }
        const msg_type: string = msg_type_raw.toString();

        // process message by 'message-type'
        switch (msg_type) {
        case "telemetry":
            this.handle_mqtt_message_telemetry(json_doc);
            break;

        case "log":
            if (this.forward_sensor_logs) {
                this.handle_mqtt_message_log(json_doc);
            }
            break;

        default:
            this.logger.write_warn(
                this.originator,
                `<handle_mqtt_message> => Unknown message-type '${msg_type}', dropping message`
            );
        }
    }



    // ****************************************************************
    // ****************************************************************
    // ******** HANDLE MQTT LOG MESSAGES

    private handle_mqtt_message_log(json_doc: any): void {
        this.logger.write_debug(this.originator, "<handle_message_log>: message-type: LOG");

        const source = json_doc["source"] ?? "unknown";
        const level = json_doc["level"] ?? "info";
        const message = json_doc["message"] ?? json_doc;

        // Gate: only forward if the sensor's log level meets the configured threshold
        const sensor_level = this.sensor_log_level_to_enum(String(level).toLowerCase());
        if (sensor_level < this.forward_sensor_logs_level) {
            return;
        }

        // Forward sensor log messages to the application logger at the appropriate level
        const logMessage = `[${source}] ${JSON.stringify(message)}`;

        switch (sensor_level) {
        case LogLevel.Error:
            this.logger.write_error("MqttNetworking::log", logMessage);
            break;
        case LogLevel.Warn:
            this.logger.write_warn("MqttNetworking::log", logMessage);
            break;
        case LogLevel.Debug:
            this.logger.write_debug("MqttNetworking::log", logMessage);
            break;
        default:
            this.logger.write_info("MqttNetworking::log", logMessage);
        }
    }

    /**
     * Map a sensor log level string to the internal LogLevel enum.
     * Accepts aliases like "err"/"wrn"/"dbg" and falls back to Info for unknown values.
     */
    private sensor_log_level_to_enum(level: string): LogLevel {
        switch (level) {
        case "error":
        case "err":
            return LogLevel.Error;
        case "warn":
        case "wrn":
            return LogLevel.Warn;
        case "debug":
        case "dbg":
            return LogLevel.Debug;
        default:
            return LogLevel.Info;
        }
    }



    // ****************************************************************
    // ****************************************************************
    // ******** HANDLE MQTT TELEMETRY MESSAGES

    private handle_mqtt_message_telemetry(json_doc: any): void {
    // initialize
        // Get system-info for timestamp handling
        const payload = json_doc?.["payload"];
        if (!payload) {
            this.logger.write_error(this.originator, "<handle_mqtt_message_telemetry> => Missing 'payload', dropping telemetry message");
            return;
        }

        const systemInfo = payload?.["system-info"];

        // init
        const boot_date_ok = !(
            systemInfo?.["boot-date-utc"] === undefined ||
      systemInfo?.["boot-date-utc"] === ""
        );
        const restart_date_ok = !(
            systemInfo?.["restart-date-utc"] === undefined ||
      systemInfo?.["restart-date-utc"] === ""
        );

        // Add missing timestamps to system-info if needed
        if (!boot_date_ok || !restart_date_ok) {
            // get the time_stamp from the time service
            const time_stamp = sysFunc.get_timestamp_iso();

            // check for missing 'boot-date-utc'
            if (!boot_date_ok && systemInfo) {
                systemInfo["boot-date-utc"] = time_stamp;
            }
            // check for missing 'restart-date-utc'
            if (!restart_date_ok && systemInfo) {
                systemInfo["restart-date-utc"] = time_stamp;
            }
        }

        // process telemetry
        const source = json_doc?.["source"] ?? "unknown";
        const air_telemetry = payload?.["air"];
        if (air_telemetry !== undefined) {
            this.publish_air_telemetry(payload, source);
        }

        const light_telemetry = payload?.["light"];
        if (light_telemetry !== undefined) {
            this.publish_light_telemetry(payload, source);
        }

        const rain_telemetry = payload?.["rain"];
        if (rain_telemetry !== undefined) {
            this.publish_rain_telemetry(payload, source);
        }

        const wind_telemetry = payload?.["wind"];
        if (wind_telemetry !== undefined) {
            this.publish_wind_telemetry(payload, source);
        }

        const water_telemetry = payload?.["water"];
        if (water_telemetry !== undefined) {
            this.publish_water_telemetry(payload, source);
        }

        const lightning_telemetry = payload?.["lightning"];
        if (lightning_telemetry !== undefined) {
            this.publish_lightning_telemetry(payload, source);
        }
    }

    // ******** private telemetry publish helpers

    /** Validate numeric fields in a telemetry section before forwarding.
     *  Returns true only if ALL fields are valid; logs warnings for invalid ones. */
    private is_telemetry_valid(section: any, fields: string[], source: string): boolean {
        for (const field of fields) {
            const value = section[field];
            if (value === undefined || value === null) {
                this.logger.write_warn(
                    this.originator + ".is_telemetry_valid",
                    `Source: ${source}, missing field '${field}', skipping`
                );
                return false;
            } else if (!Number.isFinite(Number(value))) {
                this.logger.write_warn(
                    this.originator + ".is_telemetry_valid",
                    `Source: ${source}, invalid numeric value '${value}' for field '${field}', skipping`
                );
                return false;
            }
        }
        return true;
    }

    private publish_air_telemetry(payload: any, source: string): void {
        const air = payload?.["air"];
        if (!air) return;
        if (this.is_telemetry_valid(air, [
            "temperature-c", "humidity-percent", "pressure-pascal",
        ], source)) {
            this.promWriter.publish_air(payload, source);
        }
    }

    private publish_light_telemetry(payload: any, source: string): void {
        const light = payload?.["light"];
        if (!light) return;
        if (this.is_telemetry_valid(light, ["uv-index", "lux"], source)) {
            this.promWriter.publish_light(payload, source);
        }
    }

    private publish_rain_telemetry(payload: any, source: string): void {
        const rain = payload?.["rain"];
        if (!rain) return;
        if (this.is_telemetry_valid(rain, ["in-h2o"], source)) {
            this.promWriter.publish_rain(payload, source);
        }
    }

    private publish_wind_telemetry(payload: any, source: string): void {
        const wind = payload?.["wind"];
        if (!wind) return;
        if (this.is_telemetry_valid(wind, ["wind-speed-cm-sec", "gusts-cm-sec"], source)) {
            this.promWriter.publish_wind(payload, source);
        }
    }

    private publish_water_telemetry(payload: any, source: string): void {
        const water = payload?.["water"];
        if (!water) return;
        if (this.is_telemetry_valid(water, ["temperature-c"], source)) {
            this.promWriter.publish_water(payload, source);
        }
    }

    private publish_lightning_telemetry(payload: any, source: string): void {
        const lightning = payload?.["lightning"];
        if (!lightning) return;
        if (this.is_telemetry_valid(lightning, ["lightning-count"], source)) {
            this.promWriter.publish_lightning(payload, source);
        }
    }
}
