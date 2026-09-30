/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import http from "http";
import { timingSafeEqual } from "crypto";
import { register, Gauge, Counter } from "prom-client";
import { createRequire } from "module";
import type { ILogger, IMqttNetworking } from "./Interfaces";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";
import { validateConfig } from "../schemas/config";
import { ensureError, get_numeric_field, read_file_yaml, write_file_yaml } from "./SystemFunctions";

// Load version from package.json at module load time
const pkgRequire = createRequire(__filename);
const packageJsonPath = pkgRequire.resolve("../../package.json");
const { version } = pkgRequire(packageJsonPath) as { version: string };

export class PrometheusWriter {
    // ******** private properties

    private readonly logger: ILogger;
    private readonly prometheus_port: number;
    private server: http.Server | undefined;
    private _ready: boolean = false;
    // ----
    private prometheus_Gauge_AirTemp: Gauge | undefined;
    private prometheus_Gauge_AirHumidity: Gauge | undefined;
    private prometheus_Gauge_AirPressure: Gauge | undefined;
    private prometheus_Gauge_LightUvIndex: Gauge | undefined;
    private prometheus_Gauge_LightLux: Gauge | undefined;
    private prometheus_Gauge_RainInches: Gauge | undefined;
    private prometheus_Gauge_WindSpeed: Gauge | undefined;
    private prometheus_Gauge_WindGusts: Gauge | undefined;
    private prometheus_Gauge_WaterTemp: Gauge | undefined;
    private prometheus_Gauge_Lightning: Gauge | undefined;
    // ---- System info gauges
    private prometheus_Gauge_CpuTemp: Gauge | undefined;
    private prometheus_Gauge_HeapFreeBytes: Gauge | undefined;
    private prometheus_Gauge_HeapUsedPercent: Gauge | undefined;
    private prometheus_Gauge_SensorReadFailures: Gauge | undefined;
    private prometheus_Gauge_SensorReadCounter: Gauge | undefined;
    private prometheus_Gauge_WifiRssiDbm: Gauge | undefined;
    // ---- V3 health gauges
    private prometheus_Gauge_SensorHealthUp: Gauge | undefined;
    private prometheus_Gauge_SensorUptime: Gauge | undefined;
    // ---- air altitude (V3 bme280 altitude_m)
    private prometheus_Gauge_AirAltitude: Gauge | undefined;
    // ---- soil (V3 yl69_fc28 / plantmate_soil)
    private prometheus_Gauge_SoilMoisturePercent: Gauge | undefined;
    private prometheus_Gauge_SoilMoistureRaw: Gauge | undefined;
    // ---- V4 health gauges
    private prometheus_Gauge_MinHeapFreeBytes: Gauge | undefined;
    private prometheus_Gauge_DevicesActive: Gauge | undefined;
    private prometheus_Gauge_DevicesConfigured: Gauge | undefined;
    private prometheus_Gauge_NetworkStackReady: Gauge | undefined;
    private prometheus_Gauge_WifiConnected: Gauge | undefined;
    private prometheus_Gauge_MqttConnected: Gauge | undefined;
    private prometheus_Gauge_Core1Active: Gauge | undefined;
    private prometheus_Gauge_OutboundQueueDepth: Gauge | undefined;
    private prometheus_Gauge_OutboundEvicted: Gauge | undefined;
    private prometheus_Gauge_OutboundRejected: Gauge | undefined;
    private prometheus_Gauge_UtcValid: Gauge | undefined;
    private prometheus_Gauge_UtcSyncAgeSec: Gauge | undefined;
    // ----
    private prometheus_counter_telemetry_messages: Counter | undefined;
    // ---- config storage for read/write/reload endpoints
    private config: z.infer<typeof configSchema>;
    private configSource: string;
    // ---- system start date
    private startDate: string;
    // ---- MQTT networking reference for health checks
    private mqttNetworking?: IMqttNetworking;
    // ---- optional callback for config changes
    private configChangeCallback?: (newConfig: z.infer<typeof configSchema>) => void;
    // ---- optional shared secret protecting /write-config and /reload-config.
    // Read from the environment (not config.yml, which /read-config would
    // expose) at construction. When unset, the endpoints remain open for
    // trusted-LAN deployments and a warning is logged at startup.
    private readonly configToken: string | undefined;

    // ******** constants
    private readonly MAX_SOURCE_LENGTH: number;
    private readonly VALID_CHARS: RegExp;
    // Cap for /write-config request bodies. A valid config is < 2 KiB, so
    // anything larger is a misbehaving or hostile client, not a config.
    private static readonly MAX_CONFIG_BODY_BYTES = 64 * 1024;

    // ******** ctor

    /**
     * Configure Prometheus gauge label sanitization.
     * - sensor-source-max-length: Maximum length for source labels (default: 30)
     * - sensor-source-valid-chars-regex: Character whitelist for source names (default: a-zA-Z0-9._-)
     * These prevent unbounded Prometheus cardinality from arbitrary MQTT source names.
     *
     * Note: The VALID_CHARS regex uses the global flag to replace ALL invalid characters,
     * not just the first match encountered.
     */
    constructor(
        config: z.infer<typeof configSchema>,
        logger: ILogger,
        configSource: string = "/app/configs/config.yml",
        configChangeCallback?: (newConfig: z.infer<typeof configSchema>) => void
    ) {
        // read configuration items
        this.prometheus_port = config.apiPort;
        this.MAX_SOURCE_LENGTH = config.sensorSourceMaxLength ?? 30;
        const validChars = config.sensorSourceValidCharsRegex ?? "a-zA-Z0-9._-";
        // Escape regex metacharacters in the valid chars pattern to prevent syntax errors
        const escapedValidChars = validChars.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
        // Use global flag to replace ALL invalid characters, not just the first match
        this.VALID_CHARS = new RegExp(`[^${escapedValidChars}]+`, "g");

        // save config and source for endpoint access
        this.config = { ...config };
        this.configSource = configSource;

        // save system start date
        this.startDate = new Date().toISOString();

        // save parameters
        this.logger = logger;

        // Set config change callback early (before server starts accepting requests)
        this.configChangeCallback = configChangeCallback;
        this.configToken = process.env.SENSOR_TELEMETRY_CONFIG_TOKEN || undefined;
        if (this.configToken === undefined) {
            logger.write_warn(
                "prometheus/constructor",
                "SENSOR_TELEMETRY_CONFIG_TOKEN is not set — /write-config and /reload-config are unauthenticated",
                {
                    event: "config_token_not_set",
                    logType: "service",
                }
            );
        }

        // create prometheus gauges
        this.create_prometheus_gauges();

        // create telemetry messages counter
        // Note: firmware_version added to reduce cardinality compared to runtime_id
        this.prometheus_counter_telemetry_messages = new Counter({
            name: "telemetry_messages_total",
            help: "Total number of telemetry messages received, labeled by sensor type and firmware version.",
            labelNames: ["source_type", "firmware_version"] as const,
        });

        // --------------------------------
        // setup http server
        const server = http.createServer(async (req, res) => {
            // Route on the path only: req.url includes any query string
            // (e.g. /health?probe=20260929), and exact-string matching
            // against it 404s well-formed requests. The full req.url is
            // still logged where it matters for diagnostics.
            const path = (req.url ?? "/").split("?")[0];

            // Suppress logging for successful /metrics and /health requests
            if (path !== "/metrics" && path !== "/health") {
                this.logger.write_debug(
                    "prometheus/httpRequest",
                    "HTTP request received",
                    {
                        event: "http_request_received",
                        logType: "service",
                        method: req.method || "UNKNOWN",
                        url: req.url || "/",
                    }
                );
            }

            if (path === "/metrics") {
                res.setHeader("Content-Type", register.contentType);
                res.end(await register.metrics());
            } else if (path === "/health") {
                const mqttStatus = this.mqttNetworking?.is_connected() ? "connected" : "disconnected";
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({
                    status: "healthy",
                    mqtt: mqttStatus,
                    timestamp: new Date().toISOString()
                }));
            } else if (path === "/about") {
                this.handleAbout(req, res);
            } else if (path === "/endpoints") {
                this.handleEndpoints(req, res);
            } else if (path === "/read-config") {
                if (!this.requireMethod(req, res, "GET")) {
                    return;
                }
                await this.handleReadConfig(req, res);
            } else if (path === "/write-config") {
                if (!this.requireMethod(req, res, "POST")) {
                    return;
                }
                if (!this.verifyConfigToken(req, res)) {
                    return;
                }
                await this.handleWriteConfig(req, res);
            } else if (path === "/reload-config") {
                if (!this.requireMethod(req, res, "GET")) {
                    return;
                }
                if (!this.verifyConfigToken(req, res)) {
                    return;
                }
                await this.handleReloadConfig(req, res);
            } else {
                res.statusCode = 404;
                res.end("Not Found");

                this.logger.write_warn(
                    "prometheus/routeNotFound",
                    "HTTP route not found",
                    {
                        event: "route_not_found",
                        logType: "service",
                        requestId: req.headers["x-request-id"] as string | undefined,
                        method: req.method,
                        path: req.url || "/",
                        statusCode: 404,
                    }
                );
            }
        });

        // starting the http server
        this.server = server.listen(this.prometheus_port, () => {
            this._ready = true;

            // log-it
            this.logger.write_info(
                "prometheus/serverStarted",
                "HTTP Server for Prometheus metrics is running",
                {
                    event: "prometheus_server_started",
                    logType: "service",
                    port: this.prometheus_port,
                    metricsEndpoint: `/metrics`,
                }
            );
            this.logger.write_info(
                "prometheus/metricsReady",
                "Prometheus metrics available",
                {
                    event: "prometheus_metrics_ready",
                    logType: "service",
                    metricsUrl: `http://localhost:${this.prometheus_port}/metrics`,
                }
            );
        });

        // handle listen errors (e.g., port already in use)
        this.server.on("error", (err: NodeJS.ErrnoException) => {
            this.logger.write_error(
                "prometheus/serverStartFailed",
                `Prometheus server failed to start: ${err.message}`,
                {
                    event: "prometheus_server_start_failed",
                    logType: "service",
                    fatal: true,
                    exitCode: 1,
                    error: err,
                }
            );
        });

        // log-it
        const msg = "PrometheusWriter class initialized.";
        logger.write_info("prometheus/constructor", msg, {
            event: "prometheus_writer_initialized",
            logType: "service",
        });
    }

    // ******** public methods

    /** Set MQTT networking reference for health checks */
    setMqttNetworking(networking: IMqttNetworking): void {
        this.mqttNetworking = networking;
    }

    // ******** private methods for HTTP handlers

    private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(statusCode);
        res.end(JSON.stringify(data));
    }

    /**
     * Enforce the single HTTP method a route accepts. Returns true when the
     * request method matches and the caller should continue; otherwise sends
     * a 405 with an Allow header naming the accepted method and returns false.
     * Checked before authentication so an unsupported method is rejected
     * (405) rather than misread as an auth failure (401).
     */
    private requireMethod(req: http.IncomingMessage, res: http.ServerResponse, allowed: string): boolean {
        if (req.method === allowed) {
            return true;
        }
        res.setHeader("Allow", allowed);
        this.sendJson(res, 405, { success: false, message: `method not allowed; use ${allowed}` });
        return false;
    }

    /**
     * Verify the shared secret protecting /write-config and /reload-config.
     * Returns true (no-op) when no token is configured; otherwise the
     * request must carry a matching x-config-token header, compared in
     * constant time. Responds with 401 and returns false on failure.
     */
    private verifyConfigToken(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        if (this.configToken === undefined) {
            return true;
        }
        const header = req.headers["x-config-token"];
        const provided = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
        const expected = Buffer.from(this.configToken, "utf8");
        const actual = Buffer.from(provided, "utf8");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            this.logger.write_warn(
                "prometheus/configTokenRejected",
                "Rejected config request with missing or invalid x-config-token",
                {
                    event: "config_token_rejected",
                    logType: "audit",
                    method: req.method || "UNKNOWN",
                    url: req.url || "/",
                    statusCode: 401,
                }
            );
            this.sendJson(res, 401, { success: false, message: "missing or invalid x-config-token" });
            return false;
        }
        return true;
    }

    private handleAbout(_req: http.IncomingMessage, res: http.ServerResponse): void {
        const mqttStatus = this.mqttNetworking?.is_connected() ? "connected" : "disconnected";
        const aboutInfo = {
            about: {
                name: "Sensor Telemetry Services",
                version: version ?? "unknown",
                author: "Randy Dodson (dodsonsoftware@gmail.com)",
                description: "**Sensor Telemetry Service** is the telemetry ingestion service for the SensorNET platform. Built with Node.js and TypeScript, it connects to MQTT-enabled IoT sensors, processes environmental and system telemetry, and exposes the collected data as Prometheus metrics for monitoring and visualization.\n\n**Sensor Telemetry Service** subscribes to MQTT telemetry and log topics, automatically reconnects when connectivity is interrupted, and supports V1, V2, and V3 (per-device) telemetry message formats. Incoming messages are parsed, validated, and converted into standardized Prometheus gauges with normalized source labels. Supported telemetry includes air and water temperature, humidity, pressure, wind speed and gusts, rainfall, UV index, light intensity, lightning strikes, CPU temperature, memory usage, Wi-Fi signal strength, and sensor health metrics. Unit conversions and derived values are calculated automatically.\n\n**Sensor Telemetry Service** exposes Prometheus metrics alongside HTTP endpoints for health monitoring, service information, runtime configuration management, and configuration reloading. Sensor log messages are forwarded using Loki-compatible structured labels, while sensitive configuration values are automatically redacted from application logs.\n\nProduction-focused features—including runtime configuration updates, source label sanitization to control Prometheus cardinality, graceful shutdown, resilient MQTT reconnection, secret redaction, and structured logging—help ensure reliable telemetry collection across the SensorNET environment.",
                copyright: "Copyright © 2026 dodson Software ( dodson labs )",
                license: "MIT License"
            },
            system: {
                status: "healthy",
                mqtt: mqttStatus,
                bootdate: this.startDate
            },
            routes: [
                { route: "/about", description: "Returns service information and available commands." },
                { route: "/endpoints", description: "Returns detailed information about each API endpoint." },
                { route: "/health", description: "Health check endpoint." },
                { route: "/metrics", description: "Prometheus metrics endpoint." },
                { route: "/read-config", description: "Reads the current configuration." },
                { route: "/write-config", description: "Updates the configuration and reloads it." },
                { route: "/reload-config", description: "Reloads the configuration from disk without changing the payload." }
            ]
        };
        this.sendJson(res, 200, aboutInfo);
    }

    private handleEndpoints(_req: http.IncomingMessage, res: http.ServerResponse): void {
        const endpoints = [
            {
                name: "About",
                route: "/about",
                verb: "GET",
                requestBody: "None",
                responseBody: "Service information including about, system, and routes sections",
                description: "Returns service information and available API endpoints."
            },
            {
                name: "Endpoints",
                route: "/endpoints",
                verb: "GET",
                requestBody: "None",
                responseBody: "Object containing an array of endpoint details",
                description: "Returns detailed information about each API endpoint."
            },
            {
                name: "Health",
                route: "/health",
                verb: "GET",
                requestBody: "None",
                responseBody: "{ status: \"healthy\", mqtt: \"connected|disconnected\", timestamp: \"ISO-date-string\" }",
                description: "Health check endpoint for container orchestration."
            },
            {
                name: "Metrics",
                route: "/metrics",
                verb: "GET",
                requestBody: "None",
                responseBody: "Prometheus metrics in text format",
                description: "Returns Prometheus metrics for scraped devices."
            },
            {
                name: "Read Config",
                route: "/read-config",
                verb: "GET",
                requestBody: "None",
                responseBody: "Current YAML configuration loaded from disk",
                description: "Reads the current configuration."
            },
            {
                name: "Write Config",
                route: "/write-config",
                verb: "POST",
                requestBody: "JSON object with keys: logLevel (error|warn|info|debug|critical), apiPort (positive integer), mqttBrokerIpAddress (string), mqttTopicTelemetry (string), mqttTopicLog (string, optional), mqttTopicHealth (string, optional), sensorSourceMaxLength (positive integer, optional), sensorSourceValidCharsRegex (string, optional), forwardSensorLogs (boolean, optional), forwardSensorLogsLevel (error|warn|info|debug|critical, optional). Requires the x-config-token header when SENSOR_TELEMETRY_CONFIG_TOKEN is set.",
                responseBody: "{ success: boolean, message: string }",
                description: "Validates the new configuration, persists it to disk, and applies the runtime-effective keys (logLevel, forwardSensorLogs, forwardSensorLogsLevel). Changes to mqttBrokerIpAddress, the MQTT topics, apiPort, sensorSourceMaxLength, or sensorSourceValidCharsRegex take effect on the next restart."
            },
            {
                name: "Reload Config",
                route: "/reload-config",
                verb: "GET",
                requestBody: "None. Requires the x-config-token header when SENSOR_TELEMETRY_CONFIG_TOKEN is set.",
                responseBody: "{ success: true, message: \"Configuration reloaded successfully\", config: object }",
                description: "Reloads the configuration from disk and applies the runtime-effective keys; other keys take effect on the next restart."
            }
        ];
        this.sendJson(res, 200, { endpoints });
    }

    private async handleReadConfig(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            // Pure read: report what is on disk without mutating in-memory
            // state. Silently overwriting this.config here could roll back a
            // newer in-memory config (e.g. after a failed disk write) and
            // would desynchronize MqttNetworking, which is only updated via
            // the config change callback. Use /reload-config to apply disk
            // contents to the running service.
            const result = read_file_yaml<z.infer<typeof configSchema>>(this.configSource);
            if (result.data !== null) {
                const validatedConfig = validateConfig(result.data);
                this.sendJson(res, 200, validatedConfig);
            } else {
                this.sendJson(res, 500, {
                    success: false,
                    message: result.error ?? "unknown error"
                });
            }
        } catch (error) {
            const err = ensureError(error);
            this.sendJson(res, 500, {
                success: false,
                message: err.message
            });
        }
    }

    private async handleWriteConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Accumulate raw bytes and decode once at the end: decoding each TCP
        // chunk independently corrupts multi-byte UTF-8 sequences that
        // straddle chunk boundaries (each half becomes a U+FFFD replacement
        // character) before JSON.parse ever sees them.
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let rejected = false;
        req.on("data", (chunk: Buffer) => {
            if (rejected) return;
            receivedBytes += chunk.length;
            if (receivedBytes > PrometheusWriter.MAX_CONFIG_BODY_BYTES) {
                rejected = true;
                this.logger.write_warn(
                    "prometheus/writeConfigBodyTooLarge",
                    `Rejected /write-config body exceeding ${PrometheusWriter.MAX_CONFIG_BODY_BYTES} bytes`,
                    {
                        event: "config_body_too_large",
                        logType: "audit",
                        statusCode: 413,
                    }
                );
                this.sendJson(res, 413, {
                    success: false,
                    message: `request body too large (max ${PrometheusWriter.MAX_CONFIG_BODY_BYTES} bytes)`,
                });
                // Stop accumulating; remaining chunks are dropped (see the
                // `rejected` guard above) so memory stays bounded.
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", async () => {
            if (rejected) return;
            try {
                const body = Buffer.concat(chunks).toString("utf8");
                const newConfigRaw = JSON.parse(body);
                const validatedConfig = validateConfig(newConfigRaw);

                // Extract old and new log levels
                const oldLogLevel = this.config.logLevel;
                const newLogLevel = validatedConfig.logLevel;

                // Update internal config
                this.config = { ...validatedConfig };

                // Write to disk
                const writeSuccess = write_file_yaml(this.configSource, this.config, this.logger);
                if (!writeSuccess) {
                    this.sendJson(res, 500, {
                        success: false,
                        message: "Configuration updated in memory but failed to write to disk"
                    });
                    return;
                }

                // Apply log level change if it differs
                this.applyLogLevelChange(oldLogLevel, newLogLevel);

                // Notify callback of config change
                if (this.configChangeCallback) {
                    this.configChangeCallback(validatedConfig);
                }

                this.sendJson(res, 200, {
                    success: true,
                    message: "Configuration updated successfully"
                });
            } catch (error) {
                const err = ensureError(error);
                this.sendJson(res, 400, {
                    success: false,
                    message: err.message
                });
            }
        });
    }

    private async handleReloadConfig(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const result = read_file_yaml<z.infer<typeof configSchema>>(this.configSource);
            if (result.data !== null) {
                const validatedConfig = validateConfig(result.data);
                const oldLogLevel = this.config.logLevel;
                this.config = { ...validatedConfig };

                // Apply log level change if the on-disk level differs from
                // the running one, matching /write-config's behavior.
                this.applyLogLevelChange(oldLogLevel, validatedConfig.logLevel);

                // Notify callback of config change
                if (this.configChangeCallback) {
                    this.configChangeCallback(validatedConfig);
                }

                this.sendJson(res, 200, {
                    success: true,
                    message: "Configuration reloaded successfully"
                });
            } else {
                this.sendJson(res, 500, {
                    success: false,
                    message: result.error ?? "unknown error"
                });
            }
        } catch (error) {
            const err = ensureError(error);
            this.sendJson(res, 500, {
                success: false,
                message: err.message
            });
        }
    }

    // ******** private methods

    /**
     * Apply a log-level change to the running logger, auditing the
     * transition. Shared by /write-config and /reload-config so both paths
     * honor logLevel's documented runtime effectiveness.
     */
    private applyLogLevelChange(oldLogLevel: string, newLogLevel: string): void {
        if (oldLogLevel === newLogLevel || !this.logger.setLogLevel) {
            return;
        }
        this.logger.write_info(
            "prometheus/logLevelChanging",
            `Log level changing from "${oldLogLevel}" to "${newLogLevel}"`,
            {
                event: "log_level_change_initiated",
                logType: "audit",
                previousLevel: oldLogLevel,
                newLevel: newLogLevel,
            }
        );
        this.logger.setLogLevel(newLogLevel);
        this.logger.write_info(
            "prometheus/logLevelChanged",
            `New log level is now: ${this.logger.global_log_level_string()}`,
            {
                event: "log_level_changed",
                logType: "audit",
                newLevel: this.logger.global_log_level_string(),
            }
        );
    }

    /**
     * Sanitize source name for Prometheus gauge labels.
     * - Normalizes Unicode dashes to ASCII hyphens (preserves canonical source identity)
     * - Strips invalid characters (keeps only configured valid chars)
     * - Truncates to MAX_SOURCE_LENGTH
     * - Falls back to "unknown" when stripping leaves nothing, so distinct
     *   all-invalid sources do not collide on an empty label
     * - Logs only when sanitization actually modifies the source beyond normalization
     */
    private sanitizeSource(source: string): string {
        if (!source) {
            return "unknown";
        }

        // Normalize common Unicode dash characters to ASCII hyphen-minus
        // This ensures consistent source identity across logs and metrics
        let normalized = source
            .replace(/[‐-―−]/g, "-"); // Unicode dash variants

        // Strip invalid characters, keeping only valid ones
        let sanitized = normalized.replace(this.VALID_CHARS, "");

        // Truncate if too long
        if (sanitized.length > this.MAX_SOURCE_LENGTH) {
            sanitized = sanitized.substring(0, this.MAX_SOURCE_LENGTH);
        }

        // A source composed entirely of invalid characters would otherwise
        // collapse to "" and collide with every other all-invalid source on
        // a single empty label. Warn (not debug) because this is a data
        // collision that must be visible at the default log level.
        if (sanitized === "") {
            this.logger.write_warn(
                "prometheus/sourceSanitized",
                `Source '${normalized}' contains no valid characters — using 'unknown' label`,
                {
                    event: "sensor_source_sanitized",
                    logType: "sensor",
                    originalSource: normalized,
                    sanitizedSource: "unknown",
                }
            );
            return "unknown";
        }

        // Log only if sanitization actually modified the source (beyond normalization)
        // This prevents duplicate debug entries for no-op sanitizations
        if (sanitized !== normalized) {
            this.logger.write_debug(
                "prometheus/sourceSanitized",
                `Sanitized source '${normalized}' -> '${sanitized}'`,
                {
                    event: "sensor_source_sanitized",
                    logType: "sensor",
                    originalSource: normalized,
                    sanitizedSource: sanitized,
                }
            );
        }

        return sanitized;
    }

    // ******** public methods

    is_ready(): boolean {
        return this._ready;
    }

    close() {
        this._ready = false;
        if (!this.server) {
            // close() must be idempotent: a second shutdown signal while the
            // first is still in flight would otherwise call server.close()
            // on a server that is already closing and throw
            // ERR_SERVER_NOT_RUNNING.
            return;
        }
        const server = this.server;
        this.server = undefined;
        server.close(() => {
            this.logger.write_info(
                "prometheus/serverClosed",
                "Prometheus metrics server closed.",
                {
                    event: "prometheus_server_closed",
                    logType: "service",
                }
            );
        });
    }

    publish_air(payload: any, source: string, firmwareVersion: string) {
        const sanitized = this.sanitizeSource(source);
        const air = payload?.["air"];
        if (!air) {
            this.logger.write_warn(
                "prometheus/publishAirMissing",
                `Source: ${sanitized}, missing 'air', skipping`,
                {
                    event: "telemetry_missing_section",
                    logType: "sensor",
                    source: sanitized,
                    section: "air",
                }
            );
            return;
        }

        // Use V2 snake_case field names
        const temp_f =
            (get_numeric_field(air, "temperature_c") ?? NaN) * 9 / 5 + 32;
        // A missing or non-numeric temperature means the reading is broken;
        // publishing the other gauges from the same message would leave a
        // mix of fresh and stale values for the source, so reject the whole
        // message rather than just the temperature gauge.
        if (!Number.isFinite(temp_f)) {
            this.logger.write_warn(
                "prometheus/publishAirInvalidTemp",
                `Source: ${sanitized}, invalid temperature_c, skipping message`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "temperature_c",
                    value: air["temperature_c"],
                }
            );
            return;
        } else if (temp_f < -100 || temp_f > 200) {
            this.logger.write_warn(
                "prometheus/publishAirTempOutOfRange",
                `Source: ${sanitized}, temperature_c out of physical range (${air["temperature_c"]}C = ${temp_f}F), skipping Air_Temperature gauge`,
                {
                    event: "telemetry_out_of_range",
                    logType: "sensor",
                    source: sanitized,
                    field: "temperature_c",
                    value: air["temperature_c"],
                    convertedValue: temp_f,
                    minRange: -100,
                    maxRange: 200,
                }
            );
        } else {
            this.prometheus_Gauge_AirTemp!.set({ source: sanitized }, temp_f);
        }

        const humidity = get_numeric_field(air, "humidity_percent");
        // V3 renamed the pressure field to pressure_pa; accept both
        const pressure = this.pascalToInHg(get_numeric_field(air, "pressure_pa", "pressure_pascal") ?? NaN);

        this.logger.write_debug(
            "prometheus/publishAirData",
            `Source: ${sanitized}, Temperature: ${temp_f}, Humidity: ${humidity}, Pressure: ${pressure}`,
            {
                event: "air_telemetry_published",
                logType: "sensor",
                source: sanitized,
                temperatureF: temp_f,
                humidityPercent: humidity,
                pressureInhg: pressure,
            }
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "air", firmware_version: firmwareVersion });

        // air telemetry
        if (humidity !== undefined) {
            this.prometheus_Gauge_AirHumidity!.set({ source: sanitized }, humidity);
            this.logger.write_debug(
                "prometheus/publishAirData",
                `Set Air_Humidity gauge: ${humidity}`,
                {
                    event: "gauge_set",
                    logType: "sensor",
                    source: sanitized,
                    gauge: "Air_Humidity",
                    value: humidity,
                }
            );
        }
        // NaN check (not undefined): SHT35 messages carry no pressure, and
        // writing NaN would poison the gauge for sources that do report it.
        if (Number.isFinite(pressure)) {
            this.prometheus_Gauge_AirPressure!.set({ source: sanitized }, pressure);
            this.logger.write_debug(
                "prometheus/publishAirData",
                `Set Air_Pressure gauge: ${pressure}`,
                {
                    event: "gauge_set",
                    logType: "sensor",
                    source: sanitized,
                    gauge: "Air_Pressure",
                    value: pressure,
                }
            );
        }

        // V3 bme280 messages carry altitude in meters (null when the adjusted
        // pressure is non-positive); only bme280 devices send it.
        const altitudeM = get_numeric_field(air, "altitude_m");
        const altitudeFt = altitudeM === undefined ? NaN : this.metersToFeet(altitudeM);
        if (Number.isFinite(altitudeFt)) {
            this.prometheus_Gauge_AirAltitude!.set({ source: sanitized }, altitudeFt);
            this.logger.write_debug(
                "prometheus/publishAirData",
                `Set Air_Altitude gauge: ${altitudeFt}`,
                {
                    event: "gauge_set",
                    logType: "sensor",
                    source: sanitized,
                    gauge: "Air_Altitude",
                    value: altitudeFt,
                }
            );
        }

        this.logger.write_debug(
            "prometheus/publishAirComplete",
            `Published all air metrics for source: ${sanitized}`,
            {
                event: "metrics_published",
                logType: "sensor",
                source: sanitized,
                metricsCount: 4, // temp, humidity, pressure, altitude
            }
        );
    }

    publish_light(payload: any, source: string, firmwareVersion: string) {
        const sanitized = this.sanitizeSource(source);
        const light = payload?.["light"];
        if (!light) {
            this.logger.write_warn(
                "prometheus/publishLightMissing",
                `Source: ${sanitized}, missing 'light', skipping`,
                {
                    event: "telemetry_missing_section",
                    logType: "sensor",
                    source: sanitized,
                    section: "light",
                }
            );
            return;
        }

        // Use V2 snake_case field names
        const uvIndex = get_numeric_field(light, "uv_index");
        if (uvIndex === undefined) {
            this.logger.write_warn(
                "prometheus/publishLightInvalidUv",
                `Source: ${sanitized}, invalid uv_index, skipping Light_UV_Index gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "uv_index",
                    value: light["uv_index"],
                }
            );
        } else {
            this.prometheus_Gauge_LightUvIndex!.set({ source: sanitized }, uvIndex);
        }

        const lux = get_numeric_field(light, "lux");
        if (lux === undefined) {
            this.logger.write_warn(
                "prometheus/publishLightInvalidLux",
                `Source: ${sanitized}, invalid lux, skipping Light_LUX gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "lux",
                    value: light["lux"],
                }
            );
        } else {
            this.prometheus_Gauge_LightLux!.set({ source: sanitized }, lux);
        }

        this.logger.write_debug(
            "prometheus/publishLightData",
            `Source: ${sanitized}, uvIndex: ${uvIndex}, lux: ${lux}`,
            {
                event: "light_telemetry_published",
                logType: "sensor",
                source: sanitized,
                uvIndex,
                lux,
            }
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "light", firmware_version: firmwareVersion });
    }

    publish_rain(payload: any, source: string, firmwareVersion: string) {
        const sanitized = this.sanitizeSource(source);
        const rain = payload?.["rain"];
        if (!rain) {
            this.logger.write_warn(
                "prometheus/publishRainMissing",
                `Source: ${sanitized}, missing 'rain', skipping`,
                {
                    event: "telemetry_missing_section",
                    logType: "sensor",
                    source: sanitized,
                    section: "rain",
                }
            );
            return;
        }

        // Use V2 snake_case field names
        const inches = get_numeric_field(rain, "in_h2o");
        if (inches === undefined) {
            this.logger.write_warn(
                "prometheus/publishRainInvalid",
                `Source: ${sanitized}, invalid in_h2o, skipping Rain_In_H2O gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "in_h2o",
                    value: rain["in_h2o"],
                }
            );
        } else {
            this.prometheus_Gauge_RainInches!.set({ source: sanitized }, inches);
        }

        this.logger.write_debug(
            "prometheus/publishRainData",
            `Source: ${sanitized}, in_h2o: ${inches}`,
            {
                event: "rain_telemetry_published",
                logType: "sensor",
                source: sanitized,
                rainInches: inches,
            }
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "rain", firmware_version: firmwareVersion });
    }

    publish_wind(payload: any, source: string, firmwareVersion: string) {
        const sanitized = this.sanitizeSource(source);
        const wind = payload?.["wind"];
        if (!wind) {
            this.logger.write_warn(
                "prometheus/publishWindMissing",
                `Source: ${sanitized}, missing 'wind', skipping`,
                {
                    event: "telemetry_missing_section",
                    logType: "sensor",
                    source: sanitized,
                    section: "wind",
                }
            );
            return;
        }

        // Use V2 snake_case field names
        const speed = this.cmPerSecToMph(get_numeric_field(wind, "wind_speed_cm_sec") ?? NaN);
        if (!Number.isFinite(speed)) {
            this.logger.write_warn(
                "prometheus/publishWindInvalidSpeed",
                `Source: ${sanitized}, invalid wind_speed_cm_sec, skipping Wind_Speed gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "wind_speed_cm_sec",
                    value: wind["wind_speed_cm_sec"],
                }
            );
        } else {
            this.prometheus_Gauge_WindSpeed!.set({ source: sanitized }, speed);
        }

        const gusts = this.cmPerSecToMph(get_numeric_field(wind, "gusts_cm_sec") ?? NaN);
        if (!Number.isFinite(gusts)) {
            this.logger.write_warn(
                "prometheus/publishWindInvalidGusts",
                `Source: ${sanitized}, invalid gusts_cm_sec, skipping Wind_Gusts gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "gusts_cm_sec",
                    value: wind["gusts_cm_sec"],
                }
            );
        } else {
            this.prometheus_Gauge_WindGusts!.set({ source: sanitized }, gusts);
        }

        this.logger.write_debug(
            "prometheus/publishWindData",
            `Source: ${sanitized}, speed: ${speed}, gusts: ${gusts}`,
            {
                event: "wind_telemetry_published",
                logType: "sensor",
                source: sanitized,
                speedMph: speed,
                gustsMph: gusts,
            }
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "wind", firmware_version: firmwareVersion });
    }

    publish_water(payload: any, source: string, firmwareVersion: string) {
        const sanitized = this.sanitizeSource(source);
        const water = payload?.["water"];
        if (!water) {
            this.logger.write_warn(
                "prometheus/publishWaterMissing",
                `Source: ${sanitized}, missing 'water', skipping`,
                {
                    event: "telemetry_missing_section",
                    logType: "sensor",
                    source: sanitized,
                    section: "water",
                }
            );
            return;
        }

        // Use V2 snake_case field names
        const temp_f = (get_numeric_field(water, "temperature_c") ?? NaN) * 9 / 5 + 32;
        if (!Number.isFinite(temp_f)) {
            this.logger.write_warn(
                "prometheus/publishWaterInvalidTemp",
                `Source: ${sanitized}, invalid temperature_c, skipping Water_Temperature gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "temperature_c",
                    value: water["temperature_c"],
                }
            );
        } else if (temp_f < -50 || temp_f > 212) {
            this.logger.write_warn(
                "prometheus/publishWaterTempOutOfRange",
                `Source: ${sanitized}, temperature_c out of physical range (${water["temperature_c"]}C = ${temp_f}F), skipping Water_Temperature gauge`,
                {
                    event: "telemetry_out_of_range",
                    logType: "sensor",
                    source: sanitized,
                    field: "temperature_c",
                    value: water["temperature_c"],
                    convertedValue: temp_f,
                    minRange: -50,
                    maxRange: 212,
                }
            );
        } else {
            this.prometheus_Gauge_WaterTemp!.set({ source: sanitized }, temp_f);
        }

        this.logger.write_debug(
            "prometheus/publishWaterData",
            `Source: ${sanitized}, Temperature: ${temp_f}`,
            {
                event: "water_telemetry_published",
                logType: "sensor",
                source: sanitized,
                temperatureF: temp_f,
            }
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "water", firmware_version: firmwareVersion });
    }

    publish_lightning(payload: any, source: string, firmwareVersion: string) {
        const sanitized = this.sanitizeSource(source);
        const lightning = payload?.["lightning"];
        if (!lightning) {
            this.logger.write_warn(
                "prometheus/publishLightningMissing",
                `Source: ${sanitized}, missing 'lightning', skipping`,
                {
                    event: "telemetry_missing_section",
                    logType: "sensor",
                    source: sanitized,
                    section: "lightning",
                }
            );
            return;
        }

        // Use V2 snake_case field names
        const count = get_numeric_field(lightning, "lightning_count");
        if (count === undefined) {
            this.logger.write_warn(
                "prometheus/publishLightningInvalid",
                `Source: ${sanitized}, invalid lightning_count, skipping Lightning gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "lightning_count",
                    value: lightning["lightning_count"],
                }
            );
        } else {
            this.prometheus_Gauge_Lightning!.set({ source: sanitized }, count);
        }

        this.logger.write_debug(
            "prometheus/publishLightningData",
            `Source: ${sanitized}, Strikes: ${count}`,
            {
                event: "lightning_telemetry_published",
                logType: "sensor",
                source: sanitized,
                strikeCount: count,
            }
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "lightning", firmware_version: firmwareVersion });
    }

    publish_soil(payload: any, source: string, firmwareVersion: string) {
        const sanitized = this.sanitizeSource(source);
        const soil = payload?.["soil"];
        if (!soil) {
            this.logger.write_warn(
                "prometheus/publishSoilMissing",
                `Source: ${sanitized}, missing 'soil', skipping`,
                {
                    event: "telemetry_missing_section",
                    logType: "sensor",
                    source: sanitized,
                    section: "soil",
                }
            );
            return;
        }

        // V3 snake_case field names (yl69_fc28 / plantmate_soil)
        const percent = get_numeric_field(soil, "relative_moisture_percent");
        if (percent === undefined) {
            this.logger.write_warn(
                "prometheus/publishSoilInvalidPercent",
                `Source: ${sanitized}, invalid relative_moisture_percent, skipping Soil_Moisture_Percent gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "relative_moisture_percent",
                    value: soil["relative_moisture_percent"],
                }
            );
        } else if (percent < 0 || percent > 100) {
            this.logger.write_warn(
                "prometheus/publishSoilPercentOutOfRange",
                `Source: ${sanitized}, relative_moisture_percent out of physical range (${percent}%), skipping Soil_Moisture_Percent gauge`,
                {
                    event: "telemetry_out_of_range",
                    logType: "sensor",
                    source: sanitized,
                    field: "relative_moisture_percent",
                    value: percent,
                    minRange: 0,
                    maxRange: 100,
                }
            );
        } else {
            this.prometheus_Gauge_SoilMoisturePercent!.set({ source: sanitized }, percent);
            this.logger.write_debug(
                "prometheus/publishSoilData",
                `Set Soil_Moisture_Percent gauge: ${percent}%`,
                {
                    event: "gauge_set",
                    logType: "sensor",
                    source: sanitized,
                    gauge: "Soil_Moisture_Percent",
                    value: percent,
                }
            );
        }

        // raw is an optional uncalibrated 16-bit ADC value
        const raw = get_numeric_field(soil, "raw");
        if (raw !== undefined) {
            if (raw < 0 || raw > 65535) {
                this.logger.write_warn(
                    "prometheus/publishSoilRawOutOfRange",
                    `Source: ${sanitized}, raw out of 16-bit ADC range (${raw}), skipping Soil_Moisture_Raw gauge`,
                    {
                        event: "telemetry_out_of_range",
                        logType: "sensor",
                        source: sanitized,
                        field: "raw",
                        value: raw,
                        minRange: 0,
                        maxRange: 65535,
                    }
                );
            } else {
                this.prometheus_Gauge_SoilMoistureRaw!.set({ source: sanitized }, raw);
                this.logger.write_debug(
                    "prometheus/publishSoilData",
                    `Set Soil_Moisture_Raw gauge: ${raw}`,
                    {
                        event: "gauge_set",
                        logType: "sensor",
                        source: sanitized,
                        gauge: "Soil_Moisture_Raw",
                        value: raw,
                    }
                );
            }
        }

        // Note: digital_state (yl69_fc28 only, nullable) is intentionally not
        // published — it is null on most boards and not a useful gauge.
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "soil", firmware_version: firmwareVersion });
    }

    // ******** public methods for system info metrics

    set_cpu_temp(source: string, tempC: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(tempC)) {
            this.logger.write_warn(
                "prometheus/setCpuTempInvalid",
                `Source: ${sanitized}, invalid cpu_temp_c`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "cpu_temp_c",
                    value: tempC,
                }
            );
            return;
        }
        this.prometheus_Gauge_CpuTemp!.set({ source: sanitized }, tempC);
        this.logger.write_debug(
            "prometheus/setCpuTemp",
            `Set Cpu_Temp gauge: ${tempC}°C`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Cpu_Temp",
                value: tempC,
            }
        );
    }

    set_heap_free_bytes(source: string, bytes: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(bytes) || bytes < 0) {
            this.logger.write_warn(
                "prometheus/setHeapFreeBytesInvalid",
                `Source: ${sanitized}, invalid heap_free_bytes`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "heap_free_bytes",
                    value: bytes,
                }
            );
            return;
        }
        this.prometheus_Gauge_HeapFreeBytes!.set({ source: sanitized }, bytes);
        this.logger.write_debug(
            "prometheus/setHeapFreeBytes",
            `Set Heap_Free_Bytes gauge: ${bytes}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Heap_Free_Bytes",
                value: bytes,
            }
        );
    }

    set_heap_used_percent(source: string, percent: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
            this.logger.write_warn(
                "prometheus/setHeapUsedPercentInvalid",
                `Source: ${sanitized}, invalid heap_used_percent (${percent})`,
                {
                    event: "telemetry_out_of_range",
                    logType: "sensor",
                    source: sanitized,
                    field: "heap_used_percent",
                    value: percent,
                    minRange: 0,
                    maxRange: 100,
                }
            );
            return;
        }
        this.prometheus_Gauge_HeapUsedPercent!.set({ source: sanitized }, percent);
        this.logger.write_debug(
            "prometheus/setHeapUsedPercent",
            `Set Heap_Used_Percent gauge: ${percent}%`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Heap_Used_Percent",
                value: percent,
            }
        );
    }

    set_sensor_read_failures(source: string, failures: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(failures) || failures < 0) {
            this.logger.write_warn(
                "prometheus/setSensorReadFailuresInvalid",
                `Source: ${sanitized}, invalid sensor_read_failures`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "sensor_read_failures",
                    value: failures,
                }
            );
            return;
        }
        this.prometheus_Gauge_SensorReadFailures!.set({ source: sanitized }, failures);
        this.logger.write_debug(
            "prometheus/setSensorReadFailures",
            `Set Sensor_Read_Failures gauge: ${failures}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Read_Failures",
                value: failures,
            }
        );
    }

    set_sensor_read_counter(source: string, counter: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(counter) || counter < 0) {
            this.logger.write_warn(
                "prometheus/setSensorReadCounterInvalid",
                `Source: ${sanitized}, invalid sensor_read_counter`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "sensor_read_counter",
                    value: counter,
                }
            );
            return;
        }
        this.prometheus_Gauge_SensorReadCounter!.set({ source: sanitized }, counter);
        this.logger.write_debug(
            "prometheus/setSensorReadCounter",
            `Set Sensor_Read_Counter gauge: ${counter}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Read_Counter",
                value: counter,
            }
        );
    }

    set_wifi_rssi_dbm(source: string, rssi: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(rssi)) {
            this.logger.write_warn(
                "prometheus/setWifiRssiDbmInvalid",
                `Source: ${sanitized}, invalid wifi_rssi_dbm`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "wifi_rssi_dbm",
                    value: rssi,
                }
            );
            return;
        }
        this.prometheus_Gauge_WifiRssiDbm!.set({ source: sanitized }, rssi);
        this.logger.write_debug(
            "prometheus/setWifiRssiDbm",
            `Set Wifi_RSSI_DBM gauge: ${rssi} dBm`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Wifi_RSSI_DBM",
                value: rssi,
            }
        );
    }

    /**
     * Set the V3 health up/down gauge.
     * @param source - Sensor source name
     * @param up - 1 if the sensor reports status "healthy", 0 otherwise
     */
    set_health_up(source: string, up: 0 | 1): void {
        const sanitized = this.sanitizeSource(source);
        this.prometheus_Gauge_SensorHealthUp!.set({ source: sanitized }, up);
        this.logger.write_debug(
            "prometheus/setHealthUp",
            `Set Sensor_Health_Up gauge: ${up}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Health_Up",
                value: up,
            }
        );
    }

    /**
     * Set the V3 sensor uptime gauge.
     * @param source - Sensor source name
     * @param seconds - Uptime in seconds
     */
    set_uptime_seconds(source: string, seconds: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(seconds) || seconds < 0) {
            this.logger.write_warn(
                "prometheus/setUptimeSecondsInvalid",
                `Source: ${sanitized}, invalid uptime (${seconds})`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "uptime_ms",
                    value: seconds,
                }
            );
            return;
        }
        this.prometheus_Gauge_SensorUptime!.set({ source: sanitized }, seconds);
        this.logger.write_debug(
            "prometheus/setUptimeSeconds",
            `Set Sensor_Uptime gauge: ${seconds}s`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Uptime",
                value: seconds,
            }
        );
    }

    // ******** public methods for V4 health metrics

    set_min_heap_free_bytes(source: string, bytes: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(bytes) || bytes < 0) {
            this.logger.write_warn(
                "prometheus/setMinHeapFreeBytesInvalid",
                `Source: ${sanitized}, invalid minimum_free_heap_bytes`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "minimum_free_heap_bytes",
                    value: bytes,
                }
            );
            return;
        }
        this.prometheus_Gauge_MinHeapFreeBytes!.set({ source: sanitized }, bytes);
        this.logger.write_debug(
            "prometheus/setMinHeapFreeBytes",
            `Set Heap_Min_Free_Bytes gauge: ${bytes}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Heap_Min_Free_Bytes",
                value: bytes,
            }
        );
    }

    set_devices_active(source: string, count: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(count) || count < 0) {
            this.logger.write_warn(
                "prometheus/setDevicesActiveInvalid",
                `Source: ${sanitized}, invalid devices_active`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "devices_active",
                    value: count,
                }
            );
            return;
        }
        this.prometheus_Gauge_DevicesActive!.set({ source: sanitized }, count);
        this.logger.write_debug(
            "prometheus/setDevicesActive",
            `Set Sensor_Devices_Active gauge: ${count}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Devices_Active",
                value: count,
            }
        );
    }

    set_devices_configured(source: string, count: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(count) || count < 0) {
            this.logger.write_warn(
                "prometheus/setDevicesConfiguredInvalid",
                `Source: ${sanitized}, invalid devices_configured`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "devices_configured",
                    value: count,
                }
            );
            return;
        }
        this.prometheus_Gauge_DevicesConfigured!.set({ source: sanitized }, count);
        this.logger.write_debug(
            "prometheus/setDevicesConfigured",
            `Set Sensor_Devices_Configured gauge: ${count}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Devices_Configured",
                value: count,
            }
        );
    }

    set_network_stack_ready(source: string, up: 0 | 1): void {
        const sanitized = this.sanitizeSource(source);
        this.prometheus_Gauge_NetworkStackReady!.set({ source: sanitized }, up);
        this.logger.write_debug(
            "prometheus/setNetworkStackReady",
            `Set Sensor_Network_Stack_Ready gauge: ${up}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Network_Stack_Ready",
                value: up,
            }
        );
    }

    set_wifi_connected(source: string, up: 0 | 1): void {
        const sanitized = this.sanitizeSource(source);
        this.prometheus_Gauge_WifiConnected!.set({ source: sanitized }, up);
        this.logger.write_debug(
            "prometheus/setWifiConnected",
            `Set Sensor_Wifi_Connected gauge: ${up}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Wifi_Connected",
                value: up,
            }
        );
    }

    set_mqtt_connected(source: string, up: 0 | 1): void {
        const sanitized = this.sanitizeSource(source);
        this.prometheus_Gauge_MqttConnected!.set({ source: sanitized }, up);
        this.logger.write_debug(
            "prometheus/setMqttConnected",
            `Set Sensor_Mqtt_Connected gauge: ${up}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Mqtt_Connected",
                value: up,
            }
        );
    }

    set_core_1_active(source: string, up: 0 | 1): void {
        const sanitized = this.sanitizeSource(source);
        this.prometheus_Gauge_Core1Active!.set({ source: sanitized }, up);
        this.logger.write_debug(
            "prometheus/setCore1Active",
            `Set Sensor_Core_1_Active gauge: ${up}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Core_1_Active",
                value: up,
            }
        );
    }

    set_outbound_queue_depth(source: string, depth: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(depth) || depth < 0) {
            this.logger.write_warn(
                "prometheus/setOutboundQueueDepthInvalid",
                `Source: ${sanitized}, invalid outbound_queue_depth`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "outbound_queue_depth",
                    value: depth,
                }
            );
            return;
        }
        this.prometheus_Gauge_OutboundQueueDepth!.set({ source: sanitized }, depth);
        this.logger.write_debug(
            "prometheus/setOutboundQueueDepth",
            `Set Sensor_Outbound_Queue_Depth gauge: ${depth}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Outbound_Queue_Depth",
                value: depth,
            }
        );
    }

    set_outbound_evicted(source: string, count: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(count) || count < 0) {
            this.logger.write_warn(
                "prometheus/setOutboundEvictedInvalid",
                `Source: ${sanitized}, invalid outbound_evicted`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "outbound_evicted",
                    value: count,
                }
            );
            return;
        }
        this.prometheus_Gauge_OutboundEvicted!.set({ source: sanitized }, count);
        this.logger.write_debug(
            "prometheus/setOutboundEvicted",
            `Set Sensor_Outbound_Evicted gauge: ${count}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Outbound_Evicted",
                value: count,
            }
        );
    }

    set_outbound_rejected(source: string, count: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(count) || count < 0) {
            this.logger.write_warn(
                "prometheus/setOutboundRejectedInvalid",
                `Source: ${sanitized}, invalid outbound_rejected`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "outbound_rejected",
                    value: count,
                }
            );
            return;
        }
        this.prometheus_Gauge_OutboundRejected!.set({ source: sanitized }, count);
        this.logger.write_debug(
            "prometheus/setOutboundRejected",
            `Set Sensor_Outbound_Rejected gauge: ${count}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Outbound_Rejected",
                value: count,
            }
        );
    }

    set_utc_valid(source: string, up: 0 | 1): void {
        const sanitized = this.sanitizeSource(source);
        this.prometheus_Gauge_UtcValid!.set({ source: sanitized }, up);
        this.logger.write_debug(
            "prometheus/setUtcValid",
            `Set Sensor_Utc_Valid gauge: ${up}`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Utc_Valid",
                value: up,
            }
        );
    }

    set_utc_sync_age_sec(source: string, seconds: number): void {
        const sanitized = this.sanitizeSource(source);
        if (!Number.isFinite(seconds) || seconds < 0) {
            this.logger.write_warn(
                "prometheus/setUtcSyncAgeSecInvalid",
                `Source: ${sanitized}, invalid utc_sync_age_sec`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "utc_sync_age_sec",
                    value: seconds,
                }
            );
            return;
        }
        this.prometheus_Gauge_UtcSyncAgeSec!.set({ source: sanitized }, seconds);
        this.logger.write_debug(
            "prometheus/setUtcSyncAgeSec",
            `Set Sensor_Utc_Sync_Age gauge: ${seconds}s`,
            {
                event: "gauge_set",
                logType: "sensor",
                source: sanitized,
                gauge: "Sensor_Utc_Sync_Age",
                value: seconds,
            }
        );
    }

    // ******** private methods

    private create_prometheus_gauges() {
        // ******** air

        this.prometheus_Gauge_AirTemp = new Gauge({
            name: "air_temperature",
            help: "This indicator shows the temperature in fahrenheit.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_AirHumidity = new Gauge({
            name: "air_humidity",
            help: "This indicator shows the humidity percentage.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_AirPressure = new Gauge({
            name: "air_pressure",
            help: "This indicator shows the air pressure in in/Hg.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_AirAltitude = new Gauge({
            name: "air_altitude_ft",
            help: "This indicator shows the air altitude in feet.",
            labelNames: ["source"],
        });

        // ******** light

        this.prometheus_Gauge_LightUvIndex = new Gauge({
            name: "light_uv_index",
            help: "This indicator shows the UV Index.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_LightLux = new Gauge({
            name: "light_lux",
            help: "This indicator shows the Light LUX value.",
            labelNames: ["source"],
        });

        // ******** rain

        this.prometheus_Gauge_RainInches = new Gauge({
            name: "rain_in_h2o",
            help: "This indicator shows the accumulated Rain inches.",
            labelNames: ["source"],
        });

        // ******** wind

        this.prometheus_Gauge_WindSpeed = new Gauge({
            name: "wind_speed",
            help: "This indicator shows the Wind Speed in mph.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_WindGusts = new Gauge({
            name: "wind_gusts",
            help: "This indicator shows the Wind Gusts in mph.",
            labelNames: ["source"],
        });

        // ******** water

        this.prometheus_Gauge_WaterTemp = new Gauge({
            name: "water_temperature",
            help: "This indicator shows the temperature in fahrenheit.",
            labelNames: ["source"],
        });

        // ******** lightning

        this.prometheus_Gauge_Lightning = new Gauge({
            name: "lightning_strikes_total",
            help: "This indicator shows the number of lightning strikes.",
            labelNames: ["source"],
        });

        // ******** soil

        this.prometheus_Gauge_SoilMoisturePercent = new Gauge({
            name: "soil_moisture_percent",
            help: "This indicator shows the soil moisture percentage (0-100).",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_SoilMoistureRaw = new Gauge({
            name: "soil_moisture_raw",
            help: "This indicator shows the raw soil moisture sensor value.",
            labelNames: ["source"],
        });

        // ******** system info

        this.prometheus_Gauge_CpuTemp = new Gauge({
            name: "sensor_health_cpu_temperature_c",
            help: "CPU temperature in Celsius.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_HeapFreeBytes = new Gauge({
            name: "sensor_health_heap_free_bytes",
            help: "Free heap memory in bytes.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_HeapUsedPercent = new Gauge({
            name: "sensor_health_heap_used_percent",
            help: "Percentage of heap memory used.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_SensorReadFailures = new Gauge({
            name: "sensor_health_read_failures_total",
            help: "Total number of sensor read failures.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_SensorReadCounter = new Gauge({
            name: "sensor_health_read_counter_total",
            help: "Total number of successful sensor reads.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_WifiRssiDbm = new Gauge({
            name: "sensor_health_wifi_rssi_dbm",
            help: "WiFi signal strength in dBm.",
            labelNames: ["source"],
        });

        // ******** V3 health

        this.prometheus_Gauge_SensorHealthUp = new Gauge({
            name: "sensor_health_up",
            help: "Sensor health status from V3 health messages (1 = healthy, 0 = degraded/unknown).",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_SensorUptime = new Gauge({
            name: "sensor_health_uptime_seconds",
            help: "Sensor uptime in seconds from V3 health messages.",
            labelNames: ["source"],
        });

        // ******** V4 health

        this.prometheus_Gauge_MinHeapFreeBytes = new Gauge({
            name: "sensor_health_heap_min_free_bytes",
            help: "Lowest free heap memory in bytes observed since boot.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_DevicesActive = new Gauge({
            name: "sensor_health_devices_active",
            help: "Number of active sensor devices.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_DevicesConfigured = new Gauge({
            name: "sensor_health_devices_configured",
            help: "Number of configured sensor devices.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_NetworkStackReady = new Gauge({
            name: "sensor_health_network_stack_ready",
            help: "Network stack status (1 = ready, 0 = not ready).",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_WifiConnected = new Gauge({
            name: "sensor_health_wifi_connected",
            help: "WiFi connection status (1 = connected, 0 = not connected).",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_MqttConnected = new Gauge({
            name: "sensor_health_mqtt_connected",
            help: "MQTT connection status (1 = connected, 0 = not connected).",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_Core1Active = new Gauge({
            name: "sensor_health_core_1_active",
            help: "Core 1 (sensor core) status (1 = active, 0 = inactive).",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_OutboundQueueDepth = new Gauge({
            name: "sensor_health_outbound_queue_depth",
            help: "Depth of the outbound MQTT publish queue.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_OutboundEvicted = new Gauge({
            name: "sensor_health_outbound_evicted",
            help: "Total outbound messages evicted from the queue.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_OutboundRejected = new Gauge({
            name: "sensor_health_outbound_rejected",
            help: "Total outbound messages rejected by the queue.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_UtcValid = new Gauge({
            name: "sensor_health_utc_valid",
            help: "UTC time sync status (1 = valid, 0 = not valid).",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_UtcSyncAgeSec = new Gauge({
            name: "sensor_health_utc_sync_age_sec",
            help: "Age of the last successful UTC time sync in seconds.",
            labelNames: ["source"],
        });
    }

    private cmPerSecToMph(cmSec: number): number {
        const cmToMiles = 1 / 160934.4; // Convert centimeters to miles
        const secondsToHours = 3600; // Convert seconds to hours

        return cmSec * cmToMiles * secondsToHours;
    }

    private pascalToInHg(pa: number): number {
        const pascalToInHg = 1 / 3386.39; // Conversion factor

        return pa * pascalToInHg;
    }

    private metersToFeet(meters: number): number {
        const metersToFeet = 3.28084; // Conversion factor

        return meters * metersToFeet;
    }
}
