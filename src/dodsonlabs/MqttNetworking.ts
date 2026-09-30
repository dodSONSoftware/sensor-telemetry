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
        this.mqtt_topic_log = config.mqttTopicLog || "";
        this.mqtt_topic_health = config.mqttTopicHealth || "";
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
        this.logger.write_info(
            "networking/constructor",
            "MQTT networking initialized",
            {
                event: "mqtt_networking_initialized",
                logType: "service",
                mqttBrokerIp: this.mqtt_server_ip_address,
                mqttTopicTelemetry: this.mqtt_topic_telemetry,
                mqttTopicLog: this.mqtt_topic_log,
                mqttTopicHealth: this.mqtt_topic_health,
            }
        );
    }

    // ********
    // ******** PUBLIC METHODS

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
    public readonly mqtt_topic_log: string;
    public readonly mqtt_topic_health: string;
    // ----
    private readonly originator: string;
    // ----
    private forward_sensor_logs: boolean;
    private forward_sensor_logs_level: LogLevel;
    // ----
    // Per-topic subscription state, confirmed by the broker's SUBACK.
    // /ready and the mqtt_subscription_active gauge rely on this because a
    // broker can grant CONNECT while denying SUBSCRIBE (ACL, rejected topic
    // filter), leaving the client "connected" but ingesting nothing.
    private subscription_active = new Map<string, boolean>();
    // ----
    // Cached close promise: close() must be idempotent, so a second signal
    // during an in-flight close reuses the first close instead of re-entering
    // the client's end() path.
    private closePromise: Promise<void> | undefined;

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

    /**
     * True once the broker has acknowledged every configured subscription
     * (telemetry, plus the log/health topics when set). False before the
     * first SUBACK and after any denied or lost subscription. /ready ANDs
     * this into its decision so a broker that grants CONNECT but denies
     * SUBSCRIBE cannot masquerade as a service that ingests telemetry.
     */
    public subscriptions_active(): boolean {
        if (this.subscription_active.size === 0) {
            // No connect/SUBACK cycle has completed yet.
            return false;
        }
        for (const active of this.subscription_active.values()) {
            if (!active) return false;
        }
        return true;
    }

    /** Per-topic subscription state, consumed by the mqtt_subscription_active gauge. */
    public get_subscription_states(): Array<{ topic: string; active: boolean }> {
        return [...this.subscription_active.entries()].map(([topic, active]) => ({
            topic,
            active,
        }));
    }

    public prometheus_server_ready(): boolean {
        return this.promWriter.is_ready();
    }

    public async close(timeout_ms: number = 5000): Promise<void> {
        if (this.closePromise) {
            // A second close while one is still in flight (e.g. a repeated
            // shutdown signal): reuse the first close's promise rather than
            // re-entering the client's end() path.
            return this.closePromise;
        }
        this.closePromise = this.perform_close(timeout_ms);
        return this.closePromise;
    }

    private async perform_close(timeout_ms: number): Promise<void> {
        this.logger.write_info(
            "networking/close",
            `Shutting down MQTT client (timeout: ${timeout_ms}ms)...`,
            {
                event: "mqtt_client_closing",
                logType: "service",
                timeoutMs: timeout_ms,
            }
        );

        // Close Prometheus writer first (no timeout needed)
        this.promWriter.close();

        // Close MQTT client with timeout
        const closePromise = new Promise<void>((resolve) => {
            this.mqtt_client.end(() => {
                this.logger.write_info(
                    "networking/close",
                    "MQTT client disconnected.",
                    {
                        event: "mqtt_client_disconnected",
                        logType: "service",
                    }
                );
                resolve();
            });
        });

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((resolve) => {
            timeoutHandle = setTimeout(() => {
                this.logger.write_error(
                    "networking/close_timeout",
                    `MQTT client close timed out after ${timeout_ms}ms, forcing disconnect.`,
                    {
                        event: "mqtt_client_close_timeout",
                        logType: "service",
                        timeoutMs: timeout_ms,
                    }
                );
                // Force close as a last resort — force=true skips waiting for
                // pending packets to be acknowledged, avoiding the hang.
                this.mqtt_client.end(true, () => resolve());
            }, timeout_ms);
        });

        try {
            await Promise.race([closePromise, timeoutPromise]);
        } finally {
            // Clear the pending timer if the normal close won the race, so it
            // cannot fire later and log a false "close timed out" error.
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    /**
     * Update configuration at runtime.
     * Only logLevel and the forward_sensor_logs settings take effect at
     * runtime; the MQTT connection (broker, topics), the HTTP port, and the
     * PrometheusWriter's source-label sanitization constants (captured in
     * its constructor) require a restart.
     * @param newConfig - New configuration object
     */
    public updateConfig(newConfig: z.infer<typeof configSchema>): void {
        // Keys that are captured at construction and cannot be hot-reloaded.
        const restartOnlyKeys: Array<keyof z.infer<typeof configSchema>> = [
            "mqttBrokerIpAddress",
            "mqttTopicTelemetry",
            "mqttTopicLog",
            "mqttTopicHealth",
            "apiPort",
            "sensorSourceMaxLength",
            "sensorSourceValidCharsRegex",
            "sensorSourceCardinalityCap",
        ];
        const restartOnlyChanged = restartOnlyKeys.filter(
            (key) => !Object.is(this.configuration[key], newConfig[key])
        );

        this.configuration = { ...newConfig };

        // Update forward_sensor_logs settings
        this.forward_sensor_logs = newConfig.forwardSensorLogs !== undefined ? newConfig.forwardSensorLogs : true;

        // Update forward_sensor_logs_level threshold
        this.forward_sensor_logs_level = newConfig.forwardSensorLogsLevel
            ? sysFunc.convert_from_log_level_string_to_enum(newConfig.forwardSensorLogsLevel)
            : LogLevel.Debug;

        this.logger.write_info(
            "networking/updateConfig",
            "Configuration updated",
            {
                event: "configuration_updated",
                logType: "audit",
                source: this.originator,
                logLevel: newConfig.logLevel,
                forwardSensorLogs: this.forward_sensor_logs,
            }
        );

        if (restartOnlyChanged.length > 0) {
            this.logger.write_warn(
                "networking/updateConfig",
                `Configuration keys ${restartOnlyChanged.join(", ")} changed but take effect on the next restart; the running service keeps their previous values`,
                {
                    event: "configuration_restart_only_keys",
                    logType: "audit",
                    source: this.originator,
                    keys: restartOnlyChanged,
                }
            );
        }
    }

    // ****************************************************************
    // ****************************************************************
    // ******** MQTT HANDLER FUNCTIONS

    private async on_connect(): Promise<void> {
        // log-it
        this.logger.write_debug(
            "networking/onConnect",
            "Connected to the MQTT broker",
            {
                event: "mqtt_connected",
                logType: "service",
            }
        );

        // A new MQTT session starts with no broker-side subscriptions: seed
        // every configured topic as inactive so the gauge shows them while
        // the SUBACKs are still outstanding, and /ready does not report
        // ready before the broker has acknowledged the telemetry topic.
        this.subscription_active.clear();
        this.subscription_active.set(this.mqtt_topic_telemetry, false);
        if (this.mqtt_topic_log && this.mqtt_topic_log.length > 0) {
            this.subscription_active.set(this.mqtt_topic_log, false);
        }
        if (this.mqtt_topic_health && this.mqtt_topic_health.length > 0) {
            this.subscription_active.set(this.mqtt_topic_health, false);
        }

        // subscribe to telemetry topic
        this.logger.write_debug(
            "networking/onConnect",
            `Subscribing to Topic: ${this.mqtt_topic_telemetry}`,
            {
                event: "mqtt_subscription_started",
                logType: "service",
                mqttTopic: this.mqtt_topic_telemetry,
            }
        );
        this.mqtt_client.subscribe(this.mqtt_topic_telemetry, (err, granted) =>
            this.on_subscribe_result(this.mqtt_topic_telemetry, err, granted)
        );

        // subscribe to log topic if configured
        if (this.mqtt_topic_log && this.mqtt_topic_log.length > 0) {
            this.logger.write_debug(
                "networking/onConnect",
                `Subscribing to Log Topic: ${this.mqtt_topic_log}`,
                {
                    event: "mqtt_subscription_started",
                    logType: "service",
                    mqttTopic: this.mqtt_topic_log,
                }
            );
            this.mqtt_client.subscribe(this.mqtt_topic_log, (err, granted) =>
                this.on_subscribe_result(this.mqtt_topic_log, err, granted)
            );
        }

        // subscribe to health topic if configured (V3)
        if (this.mqtt_topic_health && this.mqtt_topic_health.length > 0) {
            this.logger.write_debug(
                "networking/onConnect",
                `Subscribing to Health Topic: ${this.mqtt_topic_health}`,
                {
                    event: "mqtt_subscription_started",
                    logType: "service",
                    mqttTopic: this.mqtt_topic_health,
                }
            );
            this.mqtt_client.subscribe(this.mqtt_topic_health, (err, granted) =>
                this.on_subscribe_result(this.mqtt_topic_health, err, granted)
            );
        }
    }

    /**
     * Handle the broker's SUBACK for a topic. Without this callback the
     * mqtt library delivers SUBACK failures (ACL denial, rejected topic
     * filter) to a no-op, so the service could stay "connected" while
     * ingesting nothing — log the error and record the state that /ready
     * and the mqtt_subscription_active gauge report.
     */
    private on_subscribe_result(
        topic: string,
        error: Error | null | undefined,
        granted: mqtt.ISubscriptionGrant[] | undefined
    ): void {
        if (error) {
            this.subscription_active.set(topic, false);
            this.logger.write_error(
                "networking/subscribe",
                `Failed to subscribe to topic: ${topic} — ${(error as Error).message}`,
                {
                    event: "mqtt_subscription_failed",
                    logType: "service",
                    mqttTopic: topic,
                    error,
                }
            );
            return;
        }
        this.subscription_active.set(topic, true);
        this.logger.write_debug(
            "networking/subscribe",
            `Subscribed to topic: ${topic}`,
            {
                event: "mqtt_subscribed",
                logType: "service",
                mqttTopic: topic,
                granted,
            }
        );
    }

    private on_disconnect(): void {
        this.logger.write_warn(
            "networking/onDisconnect",
            "Disconnected from MQTT broker",
            {
                event: "mqtt_disconnected",
                logType: "service",
            }
        );
        // The mqtt library will auto-reconnect (reconnectPeriod: 5000).
        // When it does, the 'connect' event fires on_connect() which resubscribes.
        // The broker-side subscriptions are gone with the session, so mark
        // every topic inactive until the new session's SUBACKs arrive.
        for (const topic of this.subscription_active.keys()) {
            this.subscription_active.set(topic, false);
        }
    }

    private on_message(
        topic: string,
        payload: Buffer,
        _packet: mqtt.IPublishPacket
    ): void {
        try {
            const json_doc = JSON.parse(payload.toString());

            // Debug: log incoming message details with case-normalized comparison
            const topicLower = topic.toLowerCase();
            const telemetryTopicLower = this.mqtt_topic_telemetry.toLowerCase();
            const logTopicLower = this.mqtt_topic_log ? this.mqtt_topic_log.toLowerCase() : "";
            const healthTopicLower = this.mqtt_topic_health ? this.mqtt_topic_health.toLowerCase() : "";

            this.logger.write_debug(
                "networking/onMessage",
                `Received message on topic: ${topic} (normalized: ${topicLower})`,
                {
                    event: "mqtt_message_received",
                    logType: "sensor",
                    topic,
                    normalizedTopic: topicLower,
                    expectedTelemetryTopic: this.mqtt_topic_telemetry,
                    expectedTelemetryTopicNormalized: telemetryTopicLower,
                    expectedLogTopic: this.mqtt_topic_log,
                    expectedLogTopicNormalized: logTopicLower,
                    expectedHealthTopic: this.mqtt_topic_health,
                    expectedHealthTopicNormalized: healthTopicLower,
                    isLogTopic: !!this.mqtt_topic_log && topicLower === logTopicLower,
                    isHealthTopic: !!this.mqtt_topic_health && topicLower === healthTopicLower,
                    isTelemetryTopic: topicLower === telemetryTopicLower,
                    messageType: json_doc.message_type,
                    source: json_doc.source,
                }
            );

            // Route message based on topic (case-insensitive comparison)
            if (this.mqtt_topic_log && topicLower === logTopicLower) {
                // Message from log topic - treat as log message
                this.logger.write_debug(
                    "networking/onMessage",
                    `Routing to log handler (topic matches log topic)`,
                    { event: "route_log", logType: "sensor", topic }
                );
                if (this.forward_sensor_logs) {
                    this.handle_mqtt_message_log(json_doc);
                }
            } else if (this.mqtt_topic_health && topicLower === healthTopicLower) {
                // Message from health topic (V3) - publish health metrics
                this.logger.write_debug(
                    "networking/onMessage",
                    `Routing to health handler (topic matches health topic)`,
                    { event: "route_health", logType: "sensor", topic }
                );
                this.handle_mqtt_message_health(json_doc);
            } else {
                // Message from telemetry topic - route by message_type
                this.logger.write_debug(
                    "networking/onMessage",
                    `Routing to telemetry handler`,
                    { event: "route_telemetry", logType: "sensor", topic }
                );
                this.handle_mqtt_message(json_doc).catch((error) => {
                    this.logger.write_error(
                        "networking/onMessage",
                        `Error handling MQTT message: ${error}`,
                        {
                            event: "mqtt_message_handling_error",
                            logType: "sensor",
                            error,
                        }
                    );
                });
            }

        } catch (error) {
            this.logger.write_error(
                "networking/onMessageParse",
                `Failed to parse MQTT message: ${error}`,
                {
                    event: "mqtt_message_parse_error",
                    logType: "sensor",
                    error,
                }
            );
        }
    }

    private on_error(error: any): void {
        this.logger.write_error(
            "networking/onError",
            `Cannot connect! ERROR=${sysFunc.ensureError(error).message}`,
            {
                event: "mqtt_connection_error",
                logType: "service",
                error: sysFunc.ensureError(error),
            }
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
        const msg_type_raw = json_doc.message_type ?? json_doc["message-type"];
        if (msg_type_raw === undefined) {
            this.logger.write_error(
                "networking/handleMessage",
                "Missing 'message_type' key, dropping message",
                {
                    event: "mqtt_message_missing_type",
                    logType: "sensor",
                }
            );
            return;
        }
        const msg_type: string = msg_type_raw.toString();

        // process message by 'message_type'
        switch (msg_type) {
        case "telemetry":
            this.handle_mqtt_message_telemetry(json_doc);
            break;

        case "log":
            if (this.forward_sensor_logs) {
                this.handle_mqtt_message_log(json_doc);
            }
            break;

        case "health":
            this.handle_mqtt_message_health(json_doc);
            break;

        default:
            this.logger.write_warn(
                "networking/handleMessage",
                `Unknown message_type '${msg_type}', dropping message`,
                {
                    event: "mqtt_unknown_message_type",
                    logType: "sensor",
                    messageType: msg_type,
                }
            );
        }
    }



    // ****************************************************************
    // ****************************************************************
    // ******** HANDLE MQTT LOG MESSAGES

    /**
     * Get a value from an object using snake_case field names (V2 format).
     * Supports both snake_case and camelCase for backward compatibility.
     */
    private getField(obj: any, ...fieldNames: string[]): any {
        for (const fieldName of fieldNames) {
            const value = obj[fieldName];
            if (value !== undefined && value !== null) {
                return value;
            }
        }
        return undefined;
    }

    /**
     * Get a boolean value from an object using snake_case field names (V3 format).
     * Returns true/false only for actual boolean values; anything else (including
     * null) is treated as absent so malformed values never become 0/1 gauges.
     */
    private getBoolField(obj: any, ...fieldNames: string[]): boolean | undefined {
        for (const fieldName of fieldNames) {
            const value = obj[fieldName];
            if (typeof value === "boolean") {
                return value;
            }
        }
        return undefined;
    }

    /**
     * Get a value from log data using snake_case field names (V2 format).
     */
    private getLogField(logData: any, ...fieldNames: string[]): any {
        return this.getField(logData, ...fieldNames);
    }

    private handle_mqtt_message_log(json_doc: any): void {
        // Extract payload if present (V2 format), otherwise use json_doc directly (V1 format)
        let logData = json_doc["payload"] || json_doc;

        // For V2/V3 format, extract top-level fields for metadata
        // V3 renamed schema_version to message_schema_version
        const schemaVersion = this.getField(json_doc, "message_schema_version", "schema_version");
        const runtimeId = this.getField(json_doc, "runtime_id");
        const firmwareVersion = this.getField(json_doc, "firmware_version");
        const uptimeMs = sysFunc.get_numeric_field(json_doc, "uptime_ms");
        const sequence = sysFunc.get_numeric_field(json_doc, "sequence");

        // Remove service-managed fields from log data (not metadata)
        delete logData["schema_version"];
        delete logData["runtime_id"];
        delete logData["firmware_version"];
        delete logData["uptime_ms"];

        // Add timestamp as if it came from the sender
        logData["timestamp"] = sysFunc.get_timestamp_iso();

        // Use V2 snake_case field names (with camelCase fallbacks where needed)
        // Source can be in logData (V1) or at top level (V2)
        const source = this.getLogField(logData, "source") ?? json_doc["source"] ?? "unknown";
        const level = this.getLogField(logData, "level", "log_level") ?? "info";
        const message = this.getLogField(logData, "message", "msg") ?? logData;

        // Gate: only forward if the sensor's log level meets the configured threshold
        const sensor_level = this.sensor_log_level_to_enum(String(level).toLowerCase());
        if (sensor_level < this.forward_sensor_logs_level) {
            return;
        }

        // Forward sensor log messages to the application logger at the appropriate level
        const logMessage = `[${source}] ${JSON.stringify(message)}`;

        // Build metadata from log data for Loki compatibility
        // Loki uses labels for indexing: source, module, function, level
        const metadata: Record<string, unknown> = {
            event: this.getLogField(logData, "event", "message_type") ?? "sensor_log_generic",
            logType: "sensor",
            source,
            // Add Loki-compatible labels
            module: this.getLogField(logData, "module"),
            function: this.getLogField(logData, "function"),
            level: String(level).toLowerCase(),
        };

        // Add V2/V3 format fields to metadata if available
        if (runtimeId !== undefined) metadata.runtime_id = runtimeId;
        if (firmwareVersion !== undefined) metadata.firmware_version = firmwareVersion;
        if (uptimeMs !== undefined) metadata.uptime_ms = uptimeMs;
        if (schemaVersion !== undefined) metadata.schema_version = schemaVersion;
        if (sequence !== undefined) metadata.sequence = sequence;

        // V3 log messages carry a nested 'data' object with event details —
        // include it as structured metadata for Loki compatibility
        const data = this.getLogField(logData, "data");
        if (data !== undefined) metadata.data = data;

        // Add optional fields if present (snake_case preferred, with camelCase fallbacks)
        const commandId = this.getLogField(logData, "command_id", "commandId");
        if (commandId !== undefined) metadata.commandId = commandId;
        const target = this.getLogField(logData, "target", "Target");
        if (target !== undefined) metadata.target = target;
        const targeted = this.getLogField(logData, "targeted", "Targeted");
        if (targeted !== undefined) metadata.targeted = targeted;
        const responseTopic = this.getLogField(logData, "response_topic", "responseTopic");
        if (responseTopic !== undefined) metadata.responseTopic = responseTopic;
        const payloadSize = sysFunc.get_numeric_field(logData, "payload_size", "payloadSize");
        if (payloadSize !== undefined) metadata.payloadSize = payloadSize;
        const durationMs = sysFunc.get_numeric_field(logData, "duration_ms", "durationMs");
        if (durationMs !== undefined) metadata.durationMs = durationMs;
        const deviceIp = this.getLogField(logData, "device_ip", "deviceIp");
        if (deviceIp !== undefined) metadata.deviceIp = deviceIp;
        const deviceSource = this.getLogField(logData, "device_source", "deviceSource");
        if (deviceSource !== undefined) metadata.deviceSource = deviceSource;

        switch (sensor_level) {
        case LogLevel.Critical:
            this.logger.write_critical(
                "networking/logCritical",
                logMessage,
                {
                    ...metadata,
                    severity: "critical",
                    fatal: false,
                    version: undefined,  // Override defaultMeta version
                }
            );
            break;
        case LogLevel.Error:
            this.logger.write_error(
                "networking/logError",
                logMessage,
                {
                    ...metadata,
                    severity: "standard",
                    version: undefined,  // Override defaultMeta version
                }
            );
            break;
        case LogLevel.Warn:
            this.logger.write_warn(
                "networking/logWarn",
                logMessage,
                {
                    ...metadata,
                    version: undefined,  // Override defaultMeta version
                }
            );
            break;
        case LogLevel.Debug:
            this.logger.write_debug(
                "networking/logDebug",
                logMessage,
                {
                    ...metadata,
                    version: undefined,  // Override defaultMeta version
                }
            );
            break;
        default:
            this.logger.write_info(
                "networking/logInfo",
                logMessage,
                {
                    ...metadata,
                    version: undefined,  // Override defaultMeta version
                }
            );
        }
    }

    /**
     * Map a sensor log level string to the internal LogLevel enum.
     * Accepts aliases like "err"/"wrn"/"dbg"/"crit" and falls back to Info for unknown values.
     */
    private sensor_log_level_to_enum(level: string): LogLevel {
        switch (level) {
        case "critical":
        case "crit":
            return LogLevel.Critical;
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

    /**
     * Extract firmware version from telemetry message.
     * Supports both top-level firmware_version field and nested system_info.firmware_version.
     * The value is admitted through PrometheusWriter at extraction time:
     * firmware_version is a Prometheus counter label and MQTT payload values
     * are untrusted, so charset/length sanitization and the distinct-value
     * cardinality cap apply here rather than at each label site.
     */
    private getFirmwareVersion(json_doc: any): string {
        // Try top-level firmware_version first (V2 format)
        const fwTopLevel = this.getField(json_doc, "firmware_version");
        if (fwTopLevel !== undefined) {
            return this.promWriter.admitFirmwareVersion(String(fwTopLevel));
        }
        // Fallback to system_info.firmware_version
        const payload = json_doc?.["payload"];
        const systemInfo = payload?.["system_info"];
        const fwSystem = this.getField(systemInfo, "firmware_version");
        if (fwSystem !== undefined) {
            return this.promWriter.admitFirmwareVersion(String(fwSystem));
        }
        return "unknown";
    }

    // V3 telemetry is per-device: each message carries a top-level `device`
    // field and a payload with only that device's readings. Map the known
    // device types to the metric category they feed (V2 section names).
    // Unknown devices are dropped with a warning so new firmware device
    // names surface in the logs instead of being mislabeled.
    private static readonly V3_DEVICE_CATEGORIES: Record<string, string> = {
        bme280: "air",
        sht35: "air",
        ds18b20: "water",
        ltr390: "light",
        yl69_fc28: "soil",
        plantmate_soil: "soil",
    };

    /**
     * Handle a V3 per-device telemetry message.
     * Routes the device payload to the matching PrometheusWriter publisher.
     */
    private handle_v3_device_telemetry(json_doc: any, device: string): void {
        // Coerce the untrusted payload value: firmware may emit source as a
        // number, which would throw in sanitizeSource's .replace and drop the
        // message. String(123) = "123" — a usable, distinct label.
        const source = String(json_doc?.["source"] ?? "unknown");
        const devicePayload = json_doc?.["payload"];
        if (devicePayload === undefined || devicePayload === null) {
            this.logger.write_error(
                "networking/handleV3Telemetry",
                "Missing 'payload', dropping V3 telemetry message",
                {
                    event: "mqtt_telemetry_missing_payload",
                    logType: "sensor",
                    source,
                    device,
                }
            );
            return;
        }

        const category = MqttNetworking.V3_DEVICE_CATEGORIES[device];
        if (category === undefined) {
            this.logger.write_warn(
                "networking/handleV3Telemetry",
                `Unknown V3 device type '${device}', dropping message`,
                {
                    event: "mqtt_unknown_v3_device",
                    logType: "sensor",
                    source,
                    device,
                }
            );
            return;
        }

        const firmwareVersion = this.getFirmwareVersion(json_doc);

        this.logger.write_debug(
            "networking/handleV3Telemetry",
            `Processing V3 telemetry: device ${device} -> ${category} for source: ${source}`,
            {
                event: "v3_telemetry_processing_start",
                logType: "sensor",
                source,
                device,
                category,
                firmwareVersion,
            }
        );

        // Reuse the V2 publishers by wrapping the device payload in the
        // section envelope they expect (e.g. { air: {...} }).
        switch (category) {
        case "air":
            // BME280 reports barometric pressure; the SHT35 has no pressure
            // sensor, so pressure is only required for devices that carry it.
            const pressureRequired = device === "bme280";
            if (this.is_telemetry_valid(devicePayload, ["temperature_c", "humidity_percent"], source) &&
                (!pressureRequired || sysFunc.get_numeric_field(devicePayload, "pressure_pa", "pressure_pascal") !== undefined)) {
                this.promWriter.publish_air({ air: devicePayload }, source, firmwareVersion);
            }
            break;

        case "water":
            if (this.is_telemetry_valid(devicePayload, ["temperature_c"], source)) {
                this.promWriter.publish_water({ water: devicePayload }, source, firmwareVersion);
            }
            break;

        case "light":
            if (this.is_telemetry_valid(devicePayload, ["lux", "uv_index"], source)) {
                this.promWriter.publish_light({ light: devicePayload }, source, firmwareVersion);
            }
            break;

        case "soil":
            // yl69_fc28 / plantmate_soil: relative_moisture_percent is the
            // calibrated reading; raw (16-bit ADC) is optional and
            // digital_state is ignored (nullable, not a useful gauge).
            if (this.is_telemetry_valid(devicePayload, ["relative_moisture_percent"], source)) {
                this.promWriter.publish_soil({ soil: devicePayload }, source, firmwareVersion);
            }
            break;
        }
    }

    /**
     * Handle a V3 health message (iot/v3/health topic or message_type "health").
     * Reuses the system-info gauges for overlapping fields and adds the
     * sensor_health_up / sensor_uptime_seconds gauges.
     */
    private handle_mqtt_message_health(json_doc: any): void {
        // Coerce the untrusted payload value: firmware may emit source as a
        // number, which would throw in sanitizeSource's .replace and drop the
        // message. String(123) = "123" — a usable, distinct label.
        const source = String(json_doc?.["source"] ?? "unknown");
        const payload = json_doc?.["payload"];
        if (payload === undefined || payload === null) {
            this.logger.write_error(
                "networking/handleHealth",
                "Missing 'payload', dropping V3 health message",
                {
                    event: "mqtt_health_missing_payload",
                    logType: "sensor",
                    source,
                }
            );
            return;
        }

        // Overlapping system-info gauges (V3 field names)
        const cpuTempC = sysFunc.get_numeric_field(payload, "cpu_temperature_c", "cpu_temp_c");
        if (cpuTempC !== undefined) {
            this.promWriter.set_cpu_temp(source, cpuTempC);
        }
        const freeHeapBytes = sysFunc.get_numeric_field(payload, "free_heap_bytes");
        if (freeHeapBytes !== undefined) {
            this.promWriter.set_heap_free_bytes(source, freeHeapBytes);
        }
        const wifiRssiDbm = sysFunc.get_numeric_field(payload, "wifi_rssi_dbm");
        if (wifiRssiDbm !== undefined) {
            this.promWriter.set_wifi_rssi_dbm(source, wifiRssiDbm);
        }

        // V4 health numeric gauges (all optional; null/missing are skipped)
        const minHeapFreeBytes = sysFunc.get_numeric_field(payload, "minimum_free_heap_bytes");
        if (minHeapFreeBytes !== undefined) {
            this.promWriter.set_min_heap_free_bytes(source, minHeapFreeBytes);
        }
        const devicesActive = sysFunc.get_numeric_field(payload, "devices_active");
        if (devicesActive !== undefined) {
            this.promWriter.set_devices_active(source, devicesActive);
        }
        const devicesConfigured = sysFunc.get_numeric_field(payload, "devices_configured");
        if (devicesConfigured !== undefined) {
            this.promWriter.set_devices_configured(source, devicesConfigured);
        }
        const outboundQueueDepth = sysFunc.get_numeric_field(payload, "outbound_queue_depth");
        if (outboundQueueDepth !== undefined) {
            this.promWriter.set_outbound_queue_depth(source, outboundQueueDepth);
        }
        const outboundEvicted = sysFunc.get_numeric_field(payload, "outbound_evicted");
        if (outboundEvicted !== undefined) {
            this.promWriter.set_outbound_evicted(source, outboundEvicted);
        }
        const outboundRejected = sysFunc.get_numeric_field(payload, "outbound_rejected");
        if (outboundRejected !== undefined) {
            this.promWriter.set_outbound_rejected(source, outboundRejected);
        }
        const utcSyncAgeSec = sysFunc.get_numeric_field(payload, "utc_sync_age_sec");
        if (utcSyncAgeSec !== undefined) {
            this.promWriter.set_utc_sync_age_sec(source, utcSyncAgeSec);
        }

        // V4 health boolean gauges (true/false only; anything else is skipped)
        const networkStackReady = this.getBoolField(payload, "network_stack_ready");
        if (networkStackReady !== undefined) {
            this.promWriter.set_network_stack_ready(source, networkStackReady ? 1 : 0);
        }
        const wifiConnected = this.getBoolField(payload, "wifi_connected");
        if (wifiConnected !== undefined) {
            this.promWriter.set_wifi_connected(source, wifiConnected ? 1 : 0);
        }
        const mqttConnected = this.getBoolField(payload, "mqtt_connected");
        if (mqttConnected !== undefined) {
            this.promWriter.set_mqtt_connected(source, mqttConnected ? 1 : 0);
        }
        const core1Active = this.getBoolField(payload, "core_1_active");
        if (core1Active !== undefined) {
            this.promWriter.set_core_1_active(source, core1Active ? 1 : 0);
        }
        const utcValid = this.getBoolField(payload, "utc_valid");
        if (utcValid !== undefined) {
            this.promWriter.set_utc_valid(source, utcValid ? 1 : 0);
        }

        // V3-only gauges
        const status = payload["status"];
        if (status !== undefined) {
            this.promWriter.set_health_up(source, String(status) === "healthy" ? 1 : 0);
        }

        // V4: degraded_reasons is a string array (e.g. "low_free_heap",
        // "mqtt_not_connected") — arrays don't map cleanly to Prometheus
        // labels, so surface it as a structured warn log for Loki instead.
        const degradedReasons = Array.isArray(payload["degraded_reasons"]) ? payload["degraded_reasons"] : undefined;
        if (degradedReasons !== undefined && degradedReasons.length > 0) {
            this.logger.write_warn(
                "networking/handleHealth",
                `Source: ${source} reports degraded health: ${degradedReasons.join(", ")}`,
                {
                    event: "v3_health_degraded",
                    logType: "sensor",
                    source,
                    status,
                    degraded_reasons: degradedReasons,
                }
            );
        }
        // uptime_ms sits at the top level of V3 messages (fallback to payload)
        let uptimeMs = sysFunc.get_numeric_field(json_doc, "uptime_ms");
        if (uptimeMs === undefined) {
            uptimeMs = sysFunc.get_numeric_field(payload, "uptime_ms");
        }
        if (uptimeMs !== undefined) {
            this.promWriter.set_uptime_seconds(source, uptimeMs / 1000);
        }

        this.logger.write_debug(
            "networking/handleHealth",
            `Processed V3 health for source: ${source}`,
            {
                event: "v3_health_processed",
                logType: "sensor",
                source,
                status,
                degraded_reasons: degradedReasons,
            }
        );
    }

    private handle_mqtt_message_telemetry(json_doc: any): void {
        // V3 format: one message per device, identified by a top-level `device`
        // field. V2 messages never carry a top-level device key, so its
        // presence is a reliable format discriminator.
        const device = this.getField(json_doc, "device");
        if (device !== undefined && device !== null && String(device).length > 0) {
            this.handle_v3_device_telemetry(json_doc, String(device));
            return;
        }

        // V2 format: section-based payload (air/light/rain/wind/water/lightning)
        // Get system-info for timestamp handling
        const payload = json_doc?.["payload"];
        if (!payload) {
            this.logger.write_error(
                "networking/handleTelemetry",
                "Missing 'payload', dropping telemetry message",
                {
                    event: "mqtt_telemetry_missing_payload",
                    logType: "sensor",
                }
            );
            return;
        }

        const systemInfo = payload?.["system_info"];

        // Handle timestamp fields - support both V1 (empty strings) and V2 (proper dates)
        // V2 uses empty strings for unset timestamps; V1 may have missing keys
        const bootDateUtc = systemInfo?.["boot_date_utc"] ?? systemInfo?.["boot-date-utc"];
        const restartDateUtc = systemInfo?.["restart_date_utc"] ?? systemInfo?.["restart-date-utc"];

        const boot_date_ok = bootDateUtc !== undefined && bootDateUtc !== "";
        const restart_date_ok = restartDateUtc !== undefined && restartDateUtc !== "";

        // Add missing timestamps to system-info if needed
        if (!boot_date_ok || !restart_date_ok) {
            // get the time_stamp from the time service
            const time_stamp = sysFunc.get_timestamp_iso();

            // Set both V1 and V2 timestamp keys for compatibility
            if (systemInfo) {
                if (!boot_date_ok) {
                    systemInfo["boot_date_utc"] = time_stamp;
                    systemInfo["boot-date-utc"] = time_stamp;
                }
                if (!restart_date_ok) {
                    systemInfo["restart_date_utc"] = time_stamp;
                    systemInfo["restart-date-utc"] = time_stamp;
                }
            }
        }

        // process telemetry
        // Coerce the untrusted payload value: firmware may emit source as a
        // number, which would throw in sanitizeSource's .replace and drop the
        // message. String(123) = "123" — a usable, distinct label.
        const source = String(json_doc?.["source"] ?? "unknown");
        const firmwareVersion = this.getFirmwareVersion(json_doc);

        // Debug log for telemetry processing
        this.logger.write_debug(
            "networking/handleTelemetry",
            `Processing telemetry from source: ${source} (firmware: ${firmwareVersion})`,
            {
                event: "telemetry_processing_start",
                logType: "sensor",
                source,
                firmwareVersion,
            }
        );

        const air_telemetry = payload?.["air"];
        if (air_telemetry !== undefined) {
            this.logger.write_debug(
                "networking/handleTelemetry",
                "Found air telemetry section",
                {
                    event: "telemetry_section_found",
                    logType: "sensor",
                    source,
                    section: "air",
                }
            );
            this.publish_air_telemetry(payload, source, firmwareVersion);
        }

        const light_telemetry = payload?.["light"];
        if (light_telemetry !== undefined) {
            this.publish_light_telemetry(payload, source, firmwareVersion);
        }

        const rain_telemetry = payload?.["rain"];
        if (rain_telemetry !== undefined) {
            this.publish_rain_telemetry(payload, source, firmwareVersion);
        }

        const wind_telemetry = payload?.["wind"];
        if (wind_telemetry !== undefined) {
            this.publish_wind_telemetry(payload, source, firmwareVersion);
        }

        const water_telemetry = payload?.["water"];
        if (water_telemetry !== undefined) {
            this.publish_water_telemetry(payload, source, firmwareVersion);
        }

        const lightning_telemetry = payload?.["lightning"];
        if (lightning_telemetry !== undefined) {
            this.publish_lightning_telemetry(payload, source, firmwareVersion);
        }

        // Publish system info metrics (hardware, wifi, sensor health)
        this.publish_system_metrics(payload, source);
    }

    // ******** private telemetry publish helpers

    /** Validate numeric fields in a telemetry section before forwarding.
     *  Uses V2 snake_case field names. Returns true only if ALL fields are valid. */
    private is_telemetry_valid(section: any, fields: string[], source: string): boolean {
        for (const field of fields) {
            const value = sysFunc.get_numeric_field(section, field);
            if (value === undefined) {
                this.logger.write_warn(
                    "networking/isTelemetryValid",
                    `Source: ${source}, missing or invalid field '${field}', skipping`,
                    {
                        event: "telemetry_field_missing",
                        logType: "sensor",
                        source,
                        field,
                    }
                );
                return false;
            }
        }
        return true;
    }

    private publish_air_telemetry(payload: any, source: string, firmwareVersion: string): void {
        const air = payload?.["air"];
        if (!air) return;
        // V2 snake_case field names
        if (this.is_telemetry_valid(air, [
            "temperature_c", "humidity_percent", "pressure_pascal",
        ], source)) {
            this.promWriter.publish_air(payload, source, firmwareVersion);
        }
    }

    private publish_light_telemetry(payload: any, source: string, firmwareVersion: string): void {
        const light = payload?.["light"];
        if (!light) return;
        // V2 snake_case field names
        if (this.is_telemetry_valid(light, ["uv_index", "lux"], source)) {
            this.promWriter.publish_light(payload, source, firmwareVersion);
        }
    }

    private publish_rain_telemetry(payload: any, source: string, firmwareVersion: string): void {
        const rain = payload?.["rain"];
        if (!rain) return;
        // V2 snake_case field names
        if (this.is_telemetry_valid(rain, ["in_h2o"], source)) {
            this.promWriter.publish_rain(payload, source, firmwareVersion);
        }
    }

    private publish_wind_telemetry(payload: any, source: string, firmwareVersion: string): void {
        const wind = payload?.["wind"];
        if (!wind) return;
        // V2 snake_case field names
        if (this.is_telemetry_valid(wind, ["wind_speed_cm_sec", "gusts_cm_sec"], source)) {
            this.promWriter.publish_wind(payload, source, firmwareVersion);
        }
    }

    private publish_water_telemetry(payload: any, source: string, firmwareVersion: string): void {
        const water = payload?.["water"];
        if (!water) return;
        // V2 snake_case field names
        if (this.is_telemetry_valid(water, ["temperature_c"], source)) {
            this.promWriter.publish_water(payload, source, firmwareVersion);
        }
    }

    private publish_lightning_telemetry(payload: any, source: string, firmwareVersion: string): void {
        const lightning = payload?.["lightning"];
        if (!lightning) return;
        // V2 snake_case field names
        if (this.is_telemetry_valid(lightning, ["lightning_count"], source)) {
            this.promWriter.publish_lightning(payload, source, firmwareVersion);
        }
    }

    // ****************************************************************
    // ****************************************************************
    // ******** PUBLISH SYSTEM INFO METRICS

    /**
     * Publish system info metrics (hardware, wifi, sensor health).
     * Extracts data from payload.system_info and publishes to Prometheus.
     */
    private publish_system_metrics(payload: any, source: string): void {
        const systemInfo = payload?.["system_info"];
        if (!systemInfo) return;

        // Hardware info
        const hardwareInfo = systemInfo?.["hardware_info"] || systemInfo?.["hardwareInfo"];
        if (hardwareInfo) {
            // CPU temperature
            const cpuTempC = sysFunc.get_numeric_field(hardwareInfo, "cpu_temp_c", "cpuTemperatureC");
            if (cpuTempC !== undefined && Number.isFinite(cpuTempC)) {
                this.promWriter.set_cpu_temp(source, cpuTempC);
            }

            // Heap free bytes
            const heapFreeBytes = sysFunc.get_numeric_field(hardwareInfo, "heap_free_bytes", "heapFreeBytes");
            if (heapFreeBytes !== undefined && Number.isFinite(heapFreeBytes)) {
                this.promWriter.set_heap_free_bytes(source, heapFreeBytes);
            }

            // Heap used percent
            const heapUsedPercent = sysFunc.get_numeric_field(hardwareInfo, "heap_used_percent", "heapUsedPercent");
            if (heapUsedPercent !== undefined && Number.isFinite(heapUsedPercent)) {
                this.promWriter.set_heap_used_percent(source, heapUsedPercent);
            }
        }

        // Wifi info
        const wifiInfo = systemInfo?.["wifi_info"] || systemInfo?.["wifiInfo"];
        if (wifiInfo) {
            // WiFi RSSI
            const wifiRssiDbm = sysFunc.get_numeric_field(wifiInfo, "wifi_rssi_dbm", "wifiRssiDbm");
            if (wifiRssiDbm !== undefined && Number.isFinite(wifiRssiDbm)) {
                this.promWriter.set_wifi_rssi_dbm(source, wifiRssiDbm);
            }
        }

        // Sensor info
        const sensorInfo = systemInfo?.["sensor_info"] || systemInfo?.["sensorInfo"];
        if (sensorInfo) {
            // Sensor read failures
            const sensorReadFailures = sysFunc.get_numeric_field(sensorInfo, "sensor_read_failures", "sensorReadFailures");
            if (sensorReadFailures !== undefined && Number.isFinite(sensorReadFailures)) {
                this.promWriter.set_sensor_read_failures(source, sensorReadFailures);
            }

            // Sensor read counter
            const sensorReadCounter = sysFunc.get_numeric_field(sensorInfo, "sensor_read_counter", "sensorReadCounter");
            if (sensorReadCounter !== undefined && Number.isFinite(sensorReadCounter)) {
                this.promWriter.set_sensor_read_counter(source, sensorReadCounter);
            }
        }
    }
}
