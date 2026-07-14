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

    private readonly originator: string = "PrometheusWriter";
    private readonly logger: ILogger;
    private readonly prometheus_port: number;
    private server: http.Server | undefined;
    private _ready: boolean = false;
    // ----
    private prometheus_Gauge_AirTemp: Gauge | undefined;
    private prometheus_Gauge_AirHumidity: Gauge | undefined;
    private prometheus_Gauge_AirPressure: Gauge | undefined;
    private prometheus_Gauge_LightUVIndex: Gauge | undefined;
    private prometheus_Gauge_LightLux: Gauge | undefined;
    private prometheus_Gauge_RainInches: Gauge | undefined;
    private prometheus_Gauge_WindSpeed: Gauge | undefined;
    private prometheus_Gauge_WindGusts: Gauge | undefined;
    private prometheus_Gauge_WaterTemp: Gauge | undefined;
    private prometheus_Gauge_Lightning: Gauge | undefined;
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
        this.VALID_CHARS = new RegExp(`[^${escapedValidChars}]+`);

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
        this.prometheus_counter_telemetry_messages = new Counter({
            name: "telemetry_messages_total",
            help: "Total number of telemetry messages received, labeled by sensor type.",
            labelNames: ["source_type"] as const,
        });

        // --------------------------------
        // setup http server
        const server = http.createServer(async (req, res) => {
            // Log endpoint access
            this.logger.write_debug(
                this.originator + ".http",
                `HTTP ${req.method || "UNKNOWN"} ${req.url || "/"}`

            );

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
            }
        });

        // starting the http server
        this.server = server.listen(this.prometheus_port, () => {
            this._ready = true;

            // log-it
            this.logger.write_info(
                this.originator + ".ctor",
                `HTTP Server, for Prometheus, is running at http://localhost:${this.prometheus_port}`
            );
            this.logger.write_info(
                this.originator + ".ctor",
                `Prometheus metrics can be found at http://localhost:${this.prometheus_port}/metrics`
            );
        });

        // handle listen errors (e.g., port already in use)
        this.server.on("error", (err: NodeJS.ErrnoException) => {
            this.logger.write_error(
                this.originator + ".ctor",
                `Prometheus server listen error: ${err.message}`
            );
        });

        // log-it
        const msg = "PrometheusWriter class initialized.";
        logger.write_info(this.originator + ".ctor", msg);
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
        res.writeHead(statusCode);
        res.end(JSON.stringify(data));
    }

    private handleAbout(_req: http.IncomingMessage, res: http.ServerResponse): void {
        const aboutInfo = {
            about: {
                name: "Sensor Telemetry Service",
                version: version ?? "unknown",
                author: "Randy Dodson (dodsonsoftware@gmail.com)",
                description: "MQTT-to-Prometheus bridge for IoT sensor telemetry.",
                copyright: "Copyright (c) 2026 dodson Software ( dodson labs )",
                license: "MIT License"
            },
            system: {
                startDate: this.startDate
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
                        this.originator + ".handleWriteConfig",
                        `Log level changing from "${oldLogLevel}" to "${newLogLevel}"`
                    );
                    this.logger.setLogLevel(newLogLevel);
                    this.logger.write_info(
                        this.originator + ".handleWriteConfig",
                        `New log level is now: ${this.logger.global_log_level_string()}`
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
     * - Strips invalid characters (keeps only configured valid chars)
     * - Truncates to MAX_SOURCE_LENGTH
     * - Logs warning if sanitization changed the source
     */
    private sanitizeSource(source: string): string {
        if (!source) {
            return "unknown";
        }

        // Strip invalid characters, keeping only valid ones
        let sanitized = source.replace(this.VALID_CHARS, "");

        // Truncate if too long
        if (sanitized.length > this.MAX_SOURCE_LENGTH) {
            sanitized = sanitized.substring(0, this.MAX_SOURCE_LENGTH);
        }

        // Log if sanitization changed the source
        if (sanitized !== source) {
            this.logger.write_debug(
                this.originator + ".sanitizeSource",
                `Sanitized source '${source}' -> '${sanitized}'`
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
                this.logger.write_info(this.originator + ".close", "Prometheus metrics server closed.");
            });
        }
    }

    publish_air(payload: any, source: string) {
        const sanitized = this.sanitizeSource(source);
        const air = payload?.["air"];
        if (!air) {
            this.logger.write_warn(
                this.originator + ".publish_air",
                `Source: ${sanitized}, missing 'air', skipping`
            );
            return;
        }

        const temp_f =
      (Number(air["temperature-c"]) * 9) / 5 + 32;
        if (!Number.isFinite(temp_f)) {
            this.logger.write_warn(
                this.originator + ".publish_air",
                `Source: ${sanitized}, invalid temperature-c (${air["temperature-c"]}), skipping Air_Temperature gauge`
            );
        } else if (temp_f < -100 || temp_f > 200) {
            this.logger.write_warn(
                this.originator + ".publish_air",
                `Source: ${sanitized}, temperature-c out of physical range (${air["temperature-c"]}C = ${temp_f}F), skipping Air_Temperature gauge`
            );
        } else {
            this.prometheus_Gauge_AirTemp!.set({ source: sanitized }, temp_f);
        }

        const humidity = Number(air["humidity-percent"]);
        const pressure = this.pascalToInHg(
            Number(air["pressure-pascal"])
        );

        this.logger.write_debug(
            this.originator + ".publish_air",
            `Source: ${sanitized}, Temperature: ${temp_f}, Humidity: ${humidity}, Pressure: ${pressure}`
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "air" });

        // air telemetry
        if (Number.isFinite(humidity)) {
            this.prometheus_Gauge_AirHumidity!.set({ source: sanitized }, humidity);
        }
        if (Number.isFinite(pressure)) {
            this.prometheus_Gauge_AirPressure!.set({ source: sanitized }, pressure);
        }
    }

    publish_light(payload: any, source: string) {
        const sanitized = this.sanitizeSource(source);
        const light = payload?.["light"];
        if (!light) {
            this.logger.write_warn(
                this.originator + ".publish_light",
                `Source: ${sanitized}, missing 'light', skipping`
            );
            return;
        }

        const uvIndex = Number(light["uv-index"]);
        if (!Number.isFinite(uvIndex)) {
            this.logger.write_warn(
                this.originator + ".publish_light",
                `Source: ${sanitized}, invalid uv-index (${light["uv-index"]}), skipping Light_UV_Index gauge`
            );
        } else {
            this.prometheus_Gauge_LightUVIndex!.set({ source: sanitized }, uvIndex);
        }

        const lux = Number(light["lux"]);
        if (!Number.isFinite(lux)) {
            this.logger.write_warn(
                this.originator + ".publish_light",
                `Source: ${sanitized}, invalid lux (${light["lux"]}), skipping Light_LUX gauge`
            );
        } else {
            this.prometheus_Gauge_LightLux!.set({ source: sanitized }, lux);
        }

        this.logger.write_debug(
            this.originator + ".publish_light",
            `Source: ${sanitized}, uvIndex: ${uvIndex}, lux: ${lux}`
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "light" });
    }

    publish_rain(payload: any, source: string) {
        const sanitized = this.sanitizeSource(source);
        const rain = payload?.["rain"];
        if (!rain) {
            this.logger.write_warn(
                this.originator + ".publish_rain",
                `Source: ${sanitized}, missing 'rain', skipping`
            );
            return;
        }

        const inches = Number(rain["in-h2o"]);
        if (!Number.isFinite(inches)) {
            this.logger.write_warn(
                this.originator + ".publish_rain",
                `Source: ${sanitized}, invalid in-h2o (${rain["in-h2o"]}), skipping Rain_In_H2O gauge`
            );
        } else {
            this.prometheus_Gauge_RainInches!.set({ source: sanitized }, inches);
        }

        this.logger.write_debug(
            this.originator + ".publish_rain",
            `Source: ${sanitized}, in-h2o: ${inches}`
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "rain" });
    }

    publish_wind(payload: any, source: string) {
        const sanitized = this.sanitizeSource(source);
        const wind = payload?.["wind"];
        if (!wind) {
            this.logger.write_warn(
                this.originator + ".publish_wind",
                `Source: ${sanitized}, missing 'wind', skipping`
            );
            return;
        }

        const speed = this.cmPerSecToMph(
            Number(wind["wind-speed-cm-sec"])
        );
        if (!Number.isFinite(speed)) {
            this.logger.write_warn(
                this.originator + ".publish_wind",
                `Source: ${sanitized}, invalid wind-speed-cm-sec (${wind["wind-speed-cm-sec"]}), skipping Wind_Speed gauge`
            );
        } else {
            this.prometheus_Gauge_WindSpeed!.set({ source: sanitized }, speed);
        }

        const gusts = this.cmPerSecToMph(
            Number(wind["gusts-cm-sec"])
        );
        if (!Number.isFinite(gusts)) {
            this.logger.write_warn(
                this.originator + ".publish_wind",
                `Source: ${sanitized}, invalid gusts-cm-sec (${wind["gusts-cm-sec"]}), skipping Wind_Gusts gauge`
            );
        } else {
            this.prometheus_Gauge_WindGusts!.set({ source: sanitized }, gusts);
        }

        this.logger.write_debug(
            this.originator + ".publish_wind",
            `Source: ${sanitized}, speed: ${speed}, gusts: ${gusts}`
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "wind" });
    }

    publish_water(payload: any, source: string) {
        const sanitized = this.sanitizeSource(source);
        const water = payload?.["water"];
        if (!water) {
            this.logger.write_warn(
                this.originator + ".publish_water",
                `Source: ${sanitized}, missing 'water', skipping`
            );
            return;
        }

        const temp_f =
      (Number(water["temperature-c"]) * 9) / 5 + 32;
        if (!Number.isFinite(temp_f)) {
            this.logger.write_warn(
                this.originator + ".publish_water",
                `Source: ${sanitized}, invalid temperature-c (${water["temperature-c"]}), skipping Water_Temperature gauge`
            );
        } else if (temp_f < -50 || temp_f > 212) {
            this.logger.write_warn(
                this.originator + ".publish_water",
                `Source: ${sanitized}, temperature-c out of physical range (${water["temperature-c"]}C = ${temp_f}F), skipping Water_Temperature gauge`
            );
        } else {
            this.prometheus_Gauge_WaterTemp!.set({ source: sanitized }, temp_f);
        }

        this.logger.write_debug(
            this.originator + ".publish_water",
            `Source: ${sanitized}, Temperature: ${temp_f}`
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "water" });
    }

    publish_lightning(payload: any, source: string) {
        const sanitized = this.sanitizeSource(source);
        const lightning = payload?.["lightning"];
        if (!lightning) {
            this.logger.write_warn(
                this.originator + ".publish_lightning",
                `Source: ${sanitized}, missing 'lightning', skipping`
            );
            return;
        }

        const count = Number(lightning["lightning-count"]);
        if (!Number.isFinite(count)) {
            this.logger.write_warn(
                this.originator + ".publish_lightning",
                `Source: ${sanitized}, invalid lightning-count (${lightning["lightning-count"]}), skipping Lightning gauge`
            );
        } else {
            this.prometheus_Gauge_Lightning!.set({ source: sanitized }, count);
        }

        this.logger.write_debug(
            this.originator + ".publish_lightning",
            `Source: ${sanitized}, Strikes: ${count}`
        );
        this.prometheus_counter_telemetry_messages?.inc({ source_type: "lightning" });
    }

    // ******** private methods

    private create_prometheus_gauges() {
        // ******** air

        this.prometheus_Gauge_AirTemp = new Gauge({
            name: "Air_Temperature",
            help: "This indicator shows the temperature in fahrenheit.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_AirHumidity = new Gauge({
            name: "Air_Humidity",
            help: "This indicator shows the humidity percentage.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_AirPressure = new Gauge({
            name: "Air_Pressure",
            help: "This indicator shows the air pressure in in/Hg.",
            labelNames: ["source"],
        });

        // ******** light

        this.prometheus_Gauge_LightUVIndex = new Gauge({
            name: "Light_UV_Index",
            help: "This indicator shows the UV Index.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_LightLux = new Gauge({
            name: "Light_LUX",
            help: "This indicator shows the Light LUX value.",
            labelNames: ["source"],
        });

        // ******** rain

        this.prometheus_Gauge_RainInches = new Gauge({
            name: "Rain_In_H2O",
            help: "This indicator shows the accumulated Rain inches.",
            labelNames: ["source"],
        });

        // ******** wind

        this.prometheus_Gauge_WindSpeed = new Gauge({
            name: "Wind_Speed",
            help: "This indicator shows the Wind Speed in mph.",
            labelNames: ["source"],
        });

        this.prometheus_Gauge_WindGusts = new Gauge({
            name: "Wind_Gusts",
            help: "This indicator shows the Wind Gusts in mph.",
            labelNames: ["source"],
        });

        // ******** water

        this.prometheus_Gauge_WaterTemp = new Gauge({
            name: "Water_Temperature",
            help: "This indicator shows the temperature in fahrenheit.",
            labelNames: ["source"],
        });

        // ******** lightning

        this.prometheus_Gauge_Lightning = new Gauge({
            name: "Lightning",
            help: "This indicator shows the number of lightning strikes.",
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
