/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import http from "http";
import { register, Gauge, Counter } from "prom-client";
import { createRequire } from "module";
import type { ILogger, IMqttNetworking } from "./Interfaces";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";
import { validateConfig } from "../schemas/config";
import { ensureError, read_file_yaml, write_file_yaml } from "./SystemFunctions";

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

    // ******** constants
    private readonly MAX_SOURCE_LENGTH: number;
    private readonly VALID_CHARS: RegExp;

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
            // Suppress logging for successful /metrics and /health requests
            if (req.url !== "/metrics" && req.url !== "/health") {
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

            if (req.url === "/metrics") {
                res.setHeader("Content-Type", register.contentType);
                res.end(await register.metrics());
            } else if (req.url === "/health") {
                const mqttStatus = this.mqttNetworking?.is_connected() ? "connected" : "disconnected";
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({
                    status: "healthy",
                    mqtt: mqttStatus,
                    timestamp: new Date().toISOString()
                }));
            } else if (req.url === "/about") {
                this.handleAbout(req, res);
            } else if (req.url === "/endpoints") {
                this.handleEndpoints(req, res);
            } else if (req.url === "/read-config") {
                await this.handleReadConfig(req, res);
            } else if (req.url === "/write-config") {
                await this.handleWriteConfig(req, res);
            } else if (req.url === "/reload-config") {
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

    // ******** public methods for config management

    /** Get current config */
    getConfig(): z.infer<typeof configSchema> {
        return { ...this.config };
    }

    /** Set config source path */
    setConfigSource(source: string): void {
        this.configSource = source;
    }

    /** Set MQTT networking reference for health checks */
    setMqttNetworking(networking: IMqttNetworking): void {
        this.mqttNetworking = networking;
    }

    /** Set callback to invoke when config is updated via /write-config */
    setConfigChangeCallback(callback: (newConfig: z.infer<typeof configSchema>) => void): void {
        this.configChangeCallback = callback;
    }

    // ******** private methods for HTTP handlers

    private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(statusCode);
        res.end(JSON.stringify(data));
    }

    private handleAbout(_req: http.IncomingMessage, res: http.ServerResponse): void {
        const mqttStatus = this.mqttNetworking?.is_connected() ? "connected" : "disconnected";
        const aboutInfo = {
            about: {
                name: "Sensor Telemetry Services",
                version: version ?? "unknown",
                author: "Randy Dodson (dodsonsoftware@gmail.com)",
                description: "**Sensor Telemetry Service** is the telemetry ingestion service for the SensorNET platform. Built with Node.js and TypeScript, it connects to MQTT-enabled IoT sensors, processes environmental and system telemetry, and exposes the collected data as Prometheus metrics for monitoring and visualization.\n\n**Sensor Telemetry Service** subscribes to MQTT telemetry and log topics, automatically reconnects when connectivity is interrupted, and supports both V1 and V2 telemetry message formats. Incoming messages are parsed, validated, and converted into standardized Prometheus gauges with normalized source labels. Supported telemetry includes air and water temperature, humidity, pressure, wind speed and gusts, rainfall, UV index, light intensity, lightning strikes, CPU temperature, memory usage, Wi-Fi signal strength, and sensor health metrics. Unit conversions and derived values, including heat index, are calculated automatically.\n\n**Sensor Telemetry Service** exposes Prometheus metrics alongside HTTP endpoints for health monitoring, service information, runtime configuration management, and configuration reloading. Sensor log messages are forwarded using Loki-compatible structured labels, while sensitive configuration values are automatically redacted from application logs.\n\nProduction-focused features—including runtime configuration updates, source label sanitization to control Prometheus cardinality, graceful shutdown, resilient MQTT reconnection, secret redaction, and structured logging—help ensure reliable telemetry collection across the SensorNET environment.",
                copyright: "Copyright (c) 2026 dodson Software ( dodson labs )",
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
                requestBody: "JSON object with keys: logLevel (string), alwaysLogErrors (boolean), apiPort (positive integer), intervalSecs (positive integer), devices (array of objects with source, ipAddress, deviceType)",
                responseBody: "{ success: boolean, message: string, config: object }",
                description: "Updates the configuration and reloads it."
            },
            {
                name: "Reload Config",
                route: "/reload-config",
                verb: "GET",
                requestBody: "None",
                responseBody: "{ success: true, message: \"Configuration reloaded successfully\", config: object }",
                description: "Reloads the configuration from disk without changing the payload."
            }
        ];
        this.sendJson(res, 200, { endpoints });
    }

    private async handleReadConfig(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const result = read_file_yaml<z.infer<typeof configSchema>>(this.configSource);
            if (result.data !== null) {
                const validatedConfig = validateConfig(result.data);
                this.config = { ...validatedConfig };
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
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
            try {
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
                if (oldLogLevel !== newLogLevel && this.logger.setLogLevel) {
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
                this.config = { ...validatedConfig };

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
     * Sanitize source name for Prometheus gauge labels.
     * - Normalizes Unicode dashes to ASCII hyphens (preserves canonical source identity)
     * - Strips invalid characters (keeps only configured valid chars)
     * - Truncates to MAX_SOURCE_LENGTH
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
        if (this.server) {
            this.server.close(() => {
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
    }

    /**
     * Get a numeric value from an object using V2 snake_case field names.
     * Returns undefined if not found or not a valid finite number.
     */
    private getNumericField(obj: any, ...fieldNames: string[]): number | undefined {
        for (const fieldName of fieldNames) {
            const value = obj[fieldName];
            if (value !== undefined && value !== null) {
                const numValue = Number(value);
                if (Number.isFinite(numValue)) {
                    return numValue;
                }
            }
        }
        return undefined;
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
      (this.getNumericField(air, "temperature_c") ?? NaN) * 9 / 5 + 32;
        if (!Number.isFinite(temp_f)) {
            this.logger.write_warn(
                "prometheus/publishAirInvalidTemp",
                `Source: ${sanitized}, invalid temperature_c, skipping Air_Temperature gauge`,
                {
                    event: "telemetry_invalid_value",
                    logType: "sensor",
                    source: sanitized,
                    field: "temperature_c",
                    value: air["temperature_c"],
                }
            );
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

        const humidity = this.getNumericField(air, "humidity_percent");
        const pressure = this.pascalToInHg(this.getNumericField(air, "pressure_pascal") ?? NaN);

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
        if (pressure !== undefined) {
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

        this.logger.write_debug(
            "prometheus/publishAirComplete",
            `Published all air metrics for source: ${sanitized}`,
            {
                event: "metrics_published",
                logType: "sensor",
                source: sanitized,
                metricsCount: 3, // temp, humidity, pressure
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
        const uvIndex = this.getNumericField(light, "uv_index");
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

        const lux = this.getNumericField(light, "lux");
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
        const inches = this.getNumericField(rain, "in_h2o");
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
        const speed = this.cmPerSecToMph(this.getNumericField(wind, "wind_speed_cm_sec") ?? NaN);
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

        const gusts = this.cmPerSecToMph(this.getNumericField(wind, "gusts_cm_sec") ?? NaN);
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
        const temp_f = (this.getNumericField(water, "temperature_c") ?? NaN) * 9 / 5 + 32;
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
        const count = this.getNumericField(lightning, "lightning_count");
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

        // ******** system info

        this.prometheus_Gauge_CpuTemp = new Gauge({
            name: "cpu_temperature",
            help: "CPU temperature in Celsius.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_HeapFreeBytes = new Gauge({
            name: "heap_free_bytes",
            help: "Free heap memory in bytes.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_HeapUsedPercent = new Gauge({
            name: "heap_used_percent",
            help: "Percentage of heap memory used.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_SensorReadFailures = new Gauge({
            name: "sensor_read_failures_total",
            help: "Total number of sensor read failures.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_SensorReadCounter = new Gauge({
            name: "sensor_read_counter_total",
            help: "Total number of successful sensor reads.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_WifiRssiDbm = new Gauge({
            name: "wifi_rssi_dbm",
            help: "WiFi signal strength in dBm.",
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
}
