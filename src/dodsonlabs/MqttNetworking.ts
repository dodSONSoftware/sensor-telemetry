/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import mqtt from "mqtt";
import * as sysFunc from "./SystemFunctions";
import { PrometheusWriter } from "./PrometheusWriter";
import { LogLevel, isJsonObject } from "./Interfaces";
import type { ILogger, IMqttNetworking, JsonObject } from "./Interfaces";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";

/**
 * Application-level MQTT payload size cap, checked in on_message before
 * toString() and JSON.parse(). MQTT.js has already received the packet
 * into memory by the time the "message" event fires, so this does not
 * bound what the broker can deliver — it bounds the string conversion,
 * the JSON parser allocations, the parsed object graph, and all
 * downstream handling. 64 KiB is far larger than any legitimate
 * telemetry, health, or log message for this service, consistent with
 * the application's bounded-input posture elsewhere (HTTP config bodies,
 * log field lengths, label cardinality).
 */
export const MAX_MQTT_PAYLOAD_BYTES = 64 * 1024;

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
            // The application owns subscription establishment: on_connect()
            // subscribes every configured topic and their SUBACK callbacks
            // drive subscription_active (/ready and the
            // mqtt_subscription_active gauge). MQTT.js defaults to
            // resubscribe: true, which would replay the internal
            // _resubscribe() on every reconnect on top of our on_connect(),
            // sending a duplicate SUBSCRIBE per topic — disable it so the
            // app is the single owner of resubscription.
            resubscribe: false,
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

    /**
     * Shut down the MQTT client and the Prometheus HTTP server.
     * timeout_ms is a deadline for the ENTIRE close path — the HTTP
     * connection drain and the MQTT disconnect share one budget — so the
     * returned promise settles within roughly timeout_ms even when an
     * in-flight HTTP request would otherwise hold the server's drain open
     * indefinitely.
     */
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
            `Shutting down service (total close deadline: ${timeout_ms}ms)...`,
            {
                event: "mqtt_client_closing",
                logType: "service",
                timeoutMs: timeout_ms,
            }
        );

        // A single deadline bounds the ENTIRE close path, not just the MQTT
        // phase: server.close() stops accepting new connections but waits for
        // in-flight HTTP requests to finish, so a stuck request (e.g. an
        // aborted /write-config body) can hold the drain open for an
        // arbitrary time. Awaiting the drain before starting the MQTT timer
        // would make close(5000) mean "unbounded HTTP drain + 5 s of MQTT
        // shutdown", and an orchestrator with a shorter stop window would
        // escalate to SIGKILL. Both phases therefore share one deadline, and
        // the MQTT phase gets only what the drain leaves.
        const deadline = Date.now() + timeout_ms;

        // Phase 1: Prometheus writer — stop accepting connections and drain
        // existing ones, bounded by the shared deadline. If the drain does
        // not finish in time, abandon the wait rather than extend shutdown:
        // the process is about to exit, and its remaining connections die
        // with it.
        const prometheusClose = this.promWriter.close();
        let prometheusTimer: NodeJS.Timeout | undefined;
        const prometheusDeadline = new Promise<void>((resolve) => {
            prometheusTimer = setTimeout(() => {
                this.logger.write_error(
                    "networking/close_timeout",
                    `Prometheus server still draining ${timeout_ms}ms after close started; abandoning the wait.`,
                    {
                        event: "prometheus_server_close_timeout",
                        logType: "service",
                        timeoutMs: timeout_ms,
                    }
                );
                resolve();
            }, timeout_ms);
        });
        try {
            await Promise.race([prometheusClose, prometheusDeadline]);
        } finally {
            // Clear the pending timer if the drain won the race, so it cannot
            // fire later and log a false "still draining" error.
            if (prometheusTimer) {
                clearTimeout(prometheusTimer);
            }
        }

        // Phase 2: MQTT client, with whatever the drain left on the deadline.
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            // The drain consumed the entire deadline. Best effort: send a
            // forced DISCONNECT without waiting for it — the process is
            // exiting, the socket dies with it, and the broker notices the
            // disconnect on its own.
            this.logger.write_error(
                "networking/close_timeout",
                "Close deadline exhausted by the HTTP drain; forcing MQTT disconnect without waiting.",
                {
                    event: "mqtt_close_forced_deadline_exhausted",
                    logType: "service",
                    timeoutMs: timeout_ms,
                }
            );
            this.mqtt_client.end(true);
            return;
        }

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
                    `MQTT client close timed out after ${remainingMs}ms, forcing disconnect.`,
                    {
                        event: "mqtt_client_close_timeout",
                        logType: "service",
                        timeoutMs: remainingMs,
                    }
                );
                // Force close as a last resort — force=true skips waiting for
                // pending packets to be acknowledged, avoiding the hang.
                this.mqtt_client.end(true, () => resolve());
            }, remainingMs);
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
        // Payload size guard, before toString() and JSON.parse(): an
        // oversized body would otherwise flow through string conversion
        // and the JSON parser into a large object graph and downstream
        // handling. Log only bounded metadata (topic, lengths) — never
        // the payload contents, which are untrusted.
        if (payload.length > MAX_MQTT_PAYLOAD_BYTES) {
            this.logger.write_warn(
                "networking/onMessageSize",
                `Dropping MQTT message exceeding ${MAX_MQTT_PAYLOAD_BYTES} bytes`,
                {
                    event: "mqtt_payload_too_large",
                    logType: "sensor",
                    topic,
                    byteLength: payload.length,
                    maxBytes: MAX_MQTT_PAYLOAD_BYTES,
                }
            );
            return;
        }
        try {
            const parsed: unknown = JSON.parse(payload.toString());
            // A valid-JSON body can still be an array or a primitive, which
            // the handlers cannot index; drop it before routing.
            if (!isJsonObject(parsed)) {
                this.logger.write_warn(
                    "networking/onMessageParse",
                    "MQTT message is valid JSON but not an object, dropping message",
                    {
                        event: "mqtt_message_not_object",
                        logType: "sensor",
                        topic,
                    }
                );
                return;
            }
            const json_doc: JsonObject = parsed;

            // Debug: log incoming message details with case-normalized comparison
            const topicLower = topic.toLowerCase();
            const telemetryTopicLower = this.mqtt_topic_telemetry.toLowerCase();
            const logTopicLower = this.mqtt_topic_log ? this.mqtt_topic_log.toLowerCase() : "";
            const healthTopicLower = this.mqtt_topic_health ? this.mqtt_topic_health.toLowerCase() : "";
            // Scalar protocol fields, proven scalar at the boundary (never
            // String()-converted — that recurses on nested structures);
            // bounded for the log channel like every other untrusted value.
            const debugMessageType = sysFunc.getStringField(json_doc, "message_type", "message-type");
            const debugSource = sysFunc.getStringOrFiniteNumberField(json_doc, "source");

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
                    messageType: debugMessageType === undefined ? undefined : sysFunc.truncateForLog(debugMessageType),
                    source: debugSource === undefined ? undefined : sysFunc.truncateForLog(debugSource),
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

    private on_error(error: unknown): void {
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

    private async handle_mqtt_message(json_doc: JsonObject): Promise<void> {
        // initialize
        // message_type is a scalar protocol field: proven scalar at the
        // boundary (a non-string value such as a nested array is treated as
        // missing, never String()-converted — that recursion throws
        // RangeError on deeply nested payloads).
        const msg_type: string | undefined = sysFunc.getStringField(
            json_doc,
            "message_type",
            "message-type"
        );
        if (msg_type === undefined) {
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
                `Unknown message_type '${sysFunc.truncateForLog(msg_type)}', dropping message`,
                {
                    event: "mqtt_unknown_message_type",
                    logType: "sensor",
                    messageType: sysFunc.truncateForLog(msg_type),
                }
            );
        }
    }



    // ****************************************************************
    // ****************************************************************
    // ******** HANDLE MQTT LOG MESSAGES

    /**
     * Get a value from an object, trying each field name in order.
     * Callers pass snake_case names first, with legacy camelCase
     * fallbacks where older firmware used them.
     */
    private getField(obj: JsonObject | null | undefined, ...fieldNames: string[]): unknown {
        // A missing object (e.g. an optional section of the payload) is
        // absent data, not an error — return undefined so callers'
        // fallbacks apply instead of a TypeError dropping the whole message.
        if (obj === undefined || obj === null) {
            return undefined;
        }
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
    private getBoolField(obj: JsonObject | null | undefined, ...fieldNames: string[]): boolean | undefined {
        if (obj === undefined || obj === null) {
            return undefined;
        }
        for (const fieldName of fieldNames) {
            const value = obj[fieldName];
            if (typeof value === "boolean") {
                return value;
            }
        }
        return undefined;
    }

    /**
     * Get a value from log data, trying each field name in order.
     */
    private getLogField(logData: JsonObject | null | undefined, ...fieldNames: string[]): unknown {
        return this.getField(logData, ...fieldNames);
    }

    private handle_mqtt_message_log(json_doc: JsonObject): void {
        // Extract the log data from the "payload" envelope when present
        // (current log messages wrap the fields in "payload"), otherwise
        // use the top-level document (legacy log messages).
        // A non-object "payload" is not the log data, so it falls back to
        // the top-level document.
        let logData: JsonObject = isJsonObject(json_doc["payload"]) ? json_doc["payload"] : json_doc;

        // Extract top-level fields for metadata; V3 renamed schema_version
        // to message_schema_version, so both keys are accepted. All are
        // scalar protocol fields, proven scalar at the boundary (structured
        // values are treated as absent, never String()-converted).
        const schemaVersion = sysFunc.getStringField(json_doc, "message_schema_version", "schema_version");
        const runtimeId = sysFunc.getStringField(json_doc, "runtime_id");
        const firmwareVersion = sysFunc.getStringOrFiniteNumberField(json_doc, "firmware_version");
        const uptimeMs = sysFunc.get_numeric_field(json_doc, "uptime_ms");
        const sequence = sysFunc.get_numeric_field(json_doc, "sequence");

        // Remove service-managed fields from log data (not metadata)
        delete logData["schema_version"];
        delete logData["runtime_id"];
        delete logData["firmware_version"];
        delete logData["uptime_ms"];

        // Add timestamp as if it came from the sender
        logData["timestamp"] = sysFunc.get_timestamp_iso();

        // Snake_case field names, with legacy fallbacks where older
        // firmware used different keys.
        // Source can be in the log data (legacy log messages) or at the
        // top level (V3). Source and level are scalar protocol fields:
        // proven scalar at the boundary, so a structured value is treated
        // as absent (source falls back to "unknown", level to "info")
        // instead of being String()-converted.
        const source =
            sysFunc.getStringOrFiniteNumberField(logData, "source") ??
            sysFunc.getStringOrFiniteNumberField(json_doc, "source") ??
            "unknown";
        const level = sysFunc.getStringField(logData, "level", "log_level") ?? "info";
        const message = this.getLogField(logData, "message", "msg") ?? logData;

        // Gate: only forward if the sensor's log level meets the configured threshold
        const sensor_level = this.sensor_log_level_to_enum(level.toLowerCase());
        if (sensor_level < this.forward_sensor_logs_level) {
            return;
        }

        // Forward sensor log messages to the application logger at the appropriate level.
        // The source prefix and the JSON body are both untrusted, attacker-controlled
        // MQTT payload content — bound each so a hostile publisher cannot emit an
        // unbounded log entry (the body can be the entire forwarded payload object).
        const logMessage = `[${sysFunc.truncateForLog(source)}] ${sysFunc.truncateForLog(JSON.stringify(message))}`;

        // Build metadata from log data for Loki compatibility
        // Loki uses labels for indexing: source, module, function, level
        // Every label value comes from the untrusted payload, so each is
        // bounded for the log channel the same way the message text is.
        const metadata: Record<string, unknown> = {
            // Scalar label fields, proven scalar at the boundary: an absent
            // field stringifies to "undefined" exactly as it always has, and
            // a structured value is treated as absent rather than recursed.
            event: sysFunc.truncateForLog(sysFunc.getStringField(logData, "event", "message_type") ?? "sensor_log_generic"),
            logType: "sensor",
            source: sysFunc.truncateForLog(source),
            // Add Loki-compatible labels
            module: sysFunc.truncateForLog(sysFunc.getStringField(logData, "module")),
            function: sysFunc.truncateForLog(sysFunc.getStringField(logData, "function")),
            level: sysFunc.truncateForLog(level.toLowerCase()),
        };

        // Add remaining top-level fields to metadata if available
        if (runtimeId !== undefined) metadata.runtime_id = sysFunc.truncateForLog(runtimeId);
        // firmware_version here is the raw, unadmitted payload value (the telemetry
        // paths run it through admitFirmwareVersion); bound it for the log channel.
        if (firmwareVersion !== undefined) metadata.firmware_version = sysFunc.truncateForLog(firmwareVersion);
        if (uptimeMs !== undefined) metadata.uptime_ms = uptimeMs;
        if (schemaVersion !== undefined) metadata.schema_version = sysFunc.truncateForLog(schemaVersion);
        if (sequence !== undefined) metadata.sequence = sequence;

        // V3 log messages carry a nested 'data' object with event details —
        // include it as structured metadata for Loki compatibility, bounded
        // (string length, property/item counts, nesting depth) so the
        // structure stays queryable without becoming an unbounded log entry.
        const data = this.getLogField(logData, "data");
        if (data !== undefined) metadata.data = sysFunc.boundForLog(data);

        // Add optional fields if present (snake_case preferred, with camelCase fallbacks).
        // Each is a scalar protocol field, proven scalar at the boundary.
        const commandId = sysFunc.getStringField(logData, "command_id", "commandId");
        if (commandId !== undefined) metadata.commandId = sysFunc.truncateForLog(commandId);
        const target = sysFunc.getStringField(logData, "target", "Target");
        if (target !== undefined) metadata.target = sysFunc.truncateForLog(target);
        const targeted = sysFunc.getStringField(logData, "targeted", "Targeted");
        if (targeted !== undefined) metadata.targeted = sysFunc.truncateForLog(targeted);
        const responseTopic = sysFunc.getStringField(logData, "response_topic", "responseTopic");
        if (responseTopic !== undefined) metadata.responseTopic = sysFunc.truncateForLog(responseTopic);
        const payloadSize = sysFunc.get_numeric_field(logData, "payload_size", "payloadSize");
        if (payloadSize !== undefined) metadata.payloadSize = payloadSize;
        const durationMs = sysFunc.get_numeric_field(logData, "duration_ms", "durationMs");
        if (durationMs !== undefined) metadata.durationMs = durationMs;
        const deviceIp = sysFunc.getStringField(logData, "device_ip", "deviceIp");
        if (deviceIp !== undefined) metadata.deviceIp = sysFunc.truncateForLog(deviceIp);
        const deviceSource = sysFunc.getStringField(logData, "device_source", "deviceSource");
        if (deviceSource !== undefined) metadata.deviceSource = sysFunc.truncateForLog(deviceSource);

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
     * Extract firmware version from telemetry message (V3 contract: the
     * top-level firmware_version field, "unknown" when absent).
     * The value is admitted through PrometheusWriter at extraction time:
     * firmware_version is a Prometheus counter label and MQTT payload values
     * are untrusted, so charset/length sanitization and the distinct-value
     * cardinality cap apply here rather than at each label site.
     */
    private getFirmwareVersion(json_doc: JsonObject): string {
        // firmware_version is a scalar protocol field: proven scalar at the
        // boundary (a structured value reads as absent rather than being
        // String()-converted into garbage — or a RangeError on nesting).
        const fwTopLevel = sysFunc.getStringOrFiniteNumberField(json_doc, "firmware_version");
        if (fwTopLevel !== undefined) {
            return this.promWriter.admitFirmwareVersion(fwTopLevel);
        }
        return "unknown";
    }

    // V3 telemetry is per-device: each message carries a top-level `device`
    // field and a payload with only that device's readings. Map the known
    // device types to the metric category they feed (the section envelope
    // name the PrometheusWriter publishers take).
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
    private handle_v3_device_telemetry(json_doc: JsonObject, device: string): void {
        // Firmware may emit source as a number, which would throw in
        // sanitizeSource's .replace and drop the message: a finite number
        // is coerced to its string form (123 -> "123"), a usable, distinct
        // label. Anything else is "unknown" — never String()-converted.
        const source = sysFunc.getStringOrFiniteNumberField(json_doc, "source") ?? "unknown";
        const rawDevicePayload = json_doc?.["payload"];
        if (rawDevicePayload === undefined || rawDevicePayload === null) {
            this.logger.write_error(
                "networking/handleV3Telemetry",
                "Missing 'payload', dropping V3 telemetry message",
                {
                    event: "mqtt_telemetry_missing_payload",
                    logType: "sensor",
                    source: sysFunc.truncateForLog(source),
                    device: sysFunc.truncateForLog(device),
                }
            );
            return;
        }
        // Non-object payloads read as empty rather than indexing a primitive.
        const devicePayload: JsonObject = isJsonObject(rawDevicePayload) ? rawDevicePayload : {};

        const category = MqttNetworking.V3_DEVICE_CATEGORIES[device];
        if (category === undefined) {
            this.logger.write_warn(
                "networking/handleV3Telemetry",
                `Unknown V3 device type '${sysFunc.truncateForLog(device)}', dropping message`,
                {
                    event: "mqtt_unknown_v3_device",
                    logType: "sensor",
                    source: sysFunc.truncateForLog(source),
                    device: sysFunc.truncateForLog(device),
                }
            );
            return;
        }

        const firmwareVersion = this.getFirmwareVersion(json_doc);

        this.logger.write_debug(
            "networking/handleV3Telemetry",
            `Processing V3 telemetry: device ${sysFunc.truncateForLog(device)} -> ${category} for source: ${sysFunc.truncateForLog(source)}`,
            {
                event: "v3_telemetry_processing_start",
                logType: "sensor",
                source: sysFunc.truncateForLog(source),
                device: sysFunc.truncateForLog(device),
                category,
                firmwareVersion,
            }
        );

        // Wrap the device payload in the section envelope the
        // PrometheusWriter publishers take (e.g. { air: {...} }).
        // `accepted` tracks whether the message was admitted (known device
        // type AND its required fields valid): only then does the source
        // count as "seen" for the freshness gauge — a dropped reading is
        // not sensor activity.
        let accepted = false;
        switch (category) {
        case "air":
            // BME280 reports barometric pressure; the SHT35 has no pressure
            // sensor, so pressure is only required for devices that carry it.
            const pressureRequired = device === "bme280";
            if (this.is_telemetry_valid(devicePayload, ["temperature_c", "humidity_percent"], source) &&
                (!pressureRequired || sysFunc.get_numeric_field(devicePayload, "pressure_pa", "pressure_pascal") !== undefined)) {
                this.promWriter.publish_air({ air: devicePayload }, source, firmwareVersion);
                accepted = true;
            }
            break;

        case "water":
            if (this.is_telemetry_valid(devicePayload, ["temperature_c"], source)) {
                this.promWriter.publish_water({ water: devicePayload }, source, firmwareVersion);
                accepted = true;
            }
            break;

        case "light":
            if (this.is_telemetry_valid(devicePayload, ["lux", "uv_index"], source)) {
                this.promWriter.publish_light({ light: devicePayload }, source, firmwareVersion);
                accepted = true;
            }
            break;

        case "soil":
            // yl69_fc28 / plantmate_soil: relative_moisture_percent is the
            // calibrated reading; raw (16-bit ADC) is optional and
            // digital_state is ignored (nullable, not a useful gauge).
            if (this.is_telemetry_valid(devicePayload, ["relative_moisture_percent"], source)) {
                this.promWriter.publish_soil({ soil: devicePayload }, source, firmwareVersion);
                accepted = true;
            }
            break;
        }

        if (accepted) {
            this.promWriter.mark_source_seen(source);
        }
    }

    /**
     * Handle a V3 health message (iot/v3/health topic or message_type "health").
     * Reuses the system-info gauges for overlapping fields and adds the
     * sensor_health_up / sensor_uptime_seconds gauges.
     */
    private handle_mqtt_message_health(json_doc: JsonObject): void {
        // Firmware may emit source as a number, which would throw in
        // sanitizeSource's .replace and drop the message: a finite number
        // is coerced to its string form (123 -> "123"), a usable, distinct
        // label. Anything else is "unknown" — never String()-converted.
        const source = sysFunc.getStringOrFiniteNumberField(json_doc, "source") ?? "unknown";
        const rawPayload = json_doc?.["payload"];
        if (rawPayload === undefined || rawPayload === null) {
            this.logger.write_error(
                "networking/handleHealth",
                "Missing 'payload', dropping V3 health message",
                {
                    event: "mqtt_health_missing_payload",
                    logType: "sensor",
                    source: sysFunc.truncateForLog(source),
                }
            );
            return;
        }
        // Non-object payloads (a string, number, boolean, or array) are not
        // a health object — reject them rather than coercing to {}, which
        // would let a garbage body count as accepted activity and refresh
        // the source's freshness stamp.
        if (!isJsonObject(rawPayload)) {
            this.logger.write_warn(
                "networking/handleHealth",
                "Invalid health payload, expected an object",
                {
                    event: "mqtt_health_invalid_payload",
                    logType: "sensor",
                    source: sysFunc.truncateForLog(source),
                }
            );
            return;
        }
        const payload: JsonObject = rawPayload;

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
        const degradedReasonsRaw = payload["degraded_reasons"];
        const degradedReasons = Array.isArray(degradedReasonsRaw) ? degradedReasonsRaw : undefined;
        if (degradedReasons !== undefined && degradedReasons.length > 0) {
            // Bound both the number of reasons and each reason's length for the log
            // channel; the payload array itself is left untouched.
            const boundedDegradedReasons = sysFunc.truncateForLogList(degradedReasons);
            this.logger.write_warn(
                "networking/handleHealth",
                `Source: ${sysFunc.truncateForLog(source)} reports degraded health: ${boundedDegradedReasons.join(", ")}`,
                {
                    event: "v3_health_degraded",
                    logType: "sensor",
                    source: sysFunc.truncateForLog(source),
                    status,
                    degraded_reasons: boundedDegradedReasons,
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

        // Freshness: reaching here means the message carried a structurally
        // valid (object) payload — accepted sensor activity, stamped once
        // per message rather than once per gauge.
        this.promWriter.mark_source_seen(source);

        this.logger.write_debug(
            "networking/handleHealth",
            `Processed V3 health for source: ${sysFunc.truncateForLog(source)}`,
            {
                event: "v3_health_processed",
                logType: "sensor",
                source: sysFunc.truncateForLog(source),
                status,
                degraded_reasons: degradedReasons === undefined ? undefined : sysFunc.truncateForLogList(degradedReasons),
            }
        );
    }

    private handle_mqtt_message_telemetry(json_doc: JsonObject): void {
        // V3 format: one message per device, identified by a top-level `device`
        // field. The legacy V2 section-based path was removed, so a telemetry
        // message without a usable device is rejected rather than falling
        // through to an alternate schema.
        // device is a scalar protocol field: proven scalar at the boundary
        // (a structured value reads as absent, never String()-converted —
        // that recursion throws RangeError on deeply nested payloads).
        const device = sysFunc.getStringOrFiniteNumberField(json_doc, "device");
        if (device === undefined || device.trim().length === 0) {
            this.logger.write_warn(
                "networking/handleTelemetry",
                "Missing 'device', dropping telemetry message",
                {
                    event: "mqtt_telemetry_missing_device",
                    logType: "sensor",
                    source: sysFunc.truncateForLog(
                        sysFunc.getStringOrFiniteNumberField(json_doc, "source") ?? "unknown"
                    ),
                }
            );
            return;
        }
        this.handle_v3_device_telemetry(json_doc, device);
    }

    // ******** private telemetry publish helpers

    /** Validate numeric fields in a telemetry section before forwarding.
     *  Returns true only if ALL fields are valid. */
    private is_telemetry_valid(section: JsonObject, fields: string[], source: string): boolean {
        for (const field of fields) {
            const value = sysFunc.get_numeric_field(section, field);
            if (value === undefined) {
                this.logger.write_warn(
                    "networking/isTelemetryValid",
                    `Source: ${sysFunc.truncateForLog(source)}, missing or invalid field '${field}', skipping`,
                    {
                        event: "telemetry_field_missing",
                        logType: "sensor",
                        source: sysFunc.truncateForLog(source),
                        field,
                    }
                );
                return false;
            }
        }
        return true;
    }

}
