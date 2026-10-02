/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import http from "http";
import { timingSafeEqual } from "crypto";
import { register, Gauge, Counter } from "prom-client";
import { createRequire } from "module";
import { isJsonObject } from "./Interfaces";
import type { ILogger, IMqttNetworking, JsonObject } from "./Interfaces";
import type { configSchema } from "../schemas/config";
import type { z } from "zod";
import { validateConfig } from "../schemas/config";
import { boundForLog, buildSourceValidCharsRegex, ensureError, get_numeric_field, read_file_yaml, truncateForLog, write_file_yaml } from "./SystemFunctions";

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
    private prometheus_Gauge_WaterTemp: Gauge | undefined;
    // ---- System info gauges
    private prometheus_Gauge_CpuTemp: Gauge | undefined;
    private prometheus_Gauge_HeapFreeBytes: Gauge | undefined;
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
    // ---- sensor freshness (last accepted telemetry or health message)
    private prometheus_Gauge_SensorLastSeenTimestamp: Gauge | undefined;

    // ******** service diagnostics (this service's own MQTT subscriptions)

    private prometheus_Gauge_MqttSubscriptionActive: Gauge | undefined;
    // ----
    private prometheus_counter_telemetry_messages: Counter | undefined;
    // Cardinality-overflow counters: incremented each time a label value
    // falls outside the distinct-value cap and is mapped to its fallback
    // label, so the condition is visible in Prometheus itself.
    private prometheus_counter_sources_rejected: Counter | undefined;
    private prometheus_counter_firmware_versions_rejected: Counter | undefined;
    // ---- config storage for read/write/reload endpoints
    private config: z.infer<typeof configSchema>;
    private configSource: string;
    // ---- serialized /write-config transactions. Each write appends its
    // full transaction (validate -> persist -> this.config -> callback) to
    // this chain and the next write starts only after it completes: the
    // atomic temp-file + rename covers the file, not the commit steps, so
    // without serialization two in-flight writes could interleave persist
    // and commit and leave the file at one config while this.config — and
    // the runtime, updated through the callback — holds the other's.
    private configWriteChain: Promise<void> = Promise.resolve();
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
    // ---- browser CORS policy, parsed once at construction from
    // SENSOR_TELEMETRY_CORS_ORIGINS (see parseCorsOrigins). Unset, empty, or
    // "*" keeps the previous permissive behavior; otherwise only exact
    // allowlisted Origin values receive Access-Control-Allow-Origin.
    private readonly corsAllowAllOrigins: boolean;
    private readonly corsAllowedOrigins: ReadonlySet<string>;

    // ******** constants
    private readonly MAX_SOURCE_LENGTH: number;
    private readonly VALID_CHARS: RegExp;
    // Distinct-label cardinality cap (config: sensorSourceCardinalityCap,
    // default 1024). Sanitization bounds each label VALUE (length, charset);
    // this bounds how many distinct values are admitted per label name.
    // Values beyond the cap map to a fixed fallback label, so an MQTT
    // publisher minting fresh random source or firmware_version values
    // cannot grow the Prometheus series set without bound.
    private readonly sourceCardinalityCap: number;
    private readonly admittedSources = new Set<string>();
    private readonly admittedFirmwareVersions = new Set<string>();
    // Warn-once latches: a rejected value is counted on every occurrence,
    // but the warning fires once per cap so a sustained flood stays a
    // single warn line (the counters carry the ongoing signal).
    private sourceCapExceededWarned = false;
    private firmwareCapExceededWarned = false;

    // ---- stale-source removal (config: staleSourceRemovalSecs; 0 = disabled)
    // Last accepted-telemetry/health time (epoch ms) per admitted, non-fallback
    // source, keyed by sanitized label. Mirrors
    // sensor_last_seen_timestamp_seconds, which is deliberately retained after
    // eviction as the staleness signal. Bounded by sourceCardinalityCap:
    // entries are added in mark_source_seen and deleted in evictStaleSource.
    // Known limitation: admittedFirmwareVersions slots are NOT freed on
    // eviction — no source→firmware map is tracked, so a permanently-gone
    // source's firmware label keeps its cap slot for the process lifetime.
    private sourceLastSeenTimes = new Map<string, number>();
    private staleSourceRemovalSecs = 0;
    // The stale sweep interval; undefined while disabled. Cleared in close().
    private staleSweepTimer: NodeJS.Timeout | undefined;
    // Fallback labels shared by overflow/blank sources: evicting one would
    // wipe another source's data, so they are excluded from the map in
    // mark_source_seen and can never reach evictStaleSource.
    private static readonly NON_EVICTABLE_SOURCES: ReadonlySet<string> = new Set(["unknown", "unknown_source"]);
    // The 26 per-source data gauges (9 readings + 17 sensor_health_*).
    // Eviction calls .remove({source}) on exactly these — never on
    // sensor_last_seen_timestamp_seconds, the topic-labeled
    // mqtt_subscription_active gauge, or any counter.
    private prometheus_SourceDataGauges: Gauge[] = [];
    // Cap for /write-config request bodies. A valid config is < 2 KiB, so
    // anything larger is a misbehaving or hostile client, not a config.
    private static readonly MAX_CONFIG_BODY_BYTES = 64 * 1024;
    // CORS preflight contract for browser clients: the methods and headers
    // cross-origin requests may use, and how long a browser may cache the
    // preflight answer (bounds how long a stale policy can persist).
    private static readonly CORS_ALLOW_METHODS = "GET, POST, OPTIONS";
    private static readonly CORS_ALLOW_HEADERS = "Content-Type, X-Config-Token";
    private static readonly CORS_MAX_AGE_SECONDS = 600;

    // ******** ctor

    /**
     * Configure Prometheus label sanitization and cardinality.
     * - sensor-source-max-length: Maximum length for source labels (default: 30)
     * - sensor-source-valid-chars-regex: Character whitelist for source names (default: a-zA-Z0-9._-)
     * - sensor-source-cardinality-cap: Maximum distinct source / firmware_version
     *   label values admitted (default: 1024)
     *
     * Sanitization bounds each label's length and character set — it does NOT
     * bound how many distinct values appear. The cardinality cap does that:
     * once the cap is reached, each new distinct value maps to a fixed
     * fallback label (unknown_source / unknown_firmware) and increments
     * sensor_sources_rejected_total / sensor_firmware_versions_rejected_total
     * so the overflow is visible in Prometheus itself.
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
        // Shared with the schema's constructibility check: a value the
        // schema admitted cannot throw here, and the escape rule lives in
        // exactly one place (SystemFunctions.buildSourceValidCharsRegex).
        // Global flag: replaces ALL invalid characters, not just the first.
        this.VALID_CHARS = buildSourceValidCharsRegex(validChars);
        this.sourceCardinalityCap = config.sensorSourceCardinalityCap ?? 1024;

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

        // Browser CORS policy: parsed once at startup, not per request.
        const corsOrigins = PrometheusWriter.parseCorsOrigins(process.env.SENSOR_TELEMETRY_CORS_ORIGINS);
        this.corsAllowAllOrigins = corsOrigins.allowAllOrigins;
        this.corsAllowedOrigins = corsOrigins.allowedOrigins;

        // create prometheus gauges
        this.create_prometheus_gauges();

        // Arm the stale-source sweep if configured (no-op when 0/absent;
        // also applies at every config commit — see applyStaleSourceRemoval).
        this.applyStaleSourceRemoval();

        // create telemetry messages counter
        // Note: firmware_version added to reduce cardinality compared to runtime_id
        this.prometheus_counter_telemetry_messages = new Counter({
            name: "telemetry_messages_total",
            help: "Total number of telemetry messages received, labeled by sensor type and firmware version.",
            labelNames: ["source_type", "firmware_version"] as const,
        });

        // Cardinality-overflow counters (see admitSource / admitFirmwareVersion)
        this.prometheus_counter_sources_rejected = new Counter({
            name: "sensor_sources_rejected_total",
            help: "Source label values mapped to the 'unknown_source' fallback label because the source cardinality cap was reached.",
        });
        this.prometheus_counter_firmware_versions_rejected = new Counter({
            name: "sensor_firmware_versions_rejected_total",
            help: "Firmware version label values mapped to the 'unknown_firmware' fallback label because the firmware version cardinality cap was reached.",
        });

        // --------------------------------
        // setup http server
        const server = http.createServer(async (req, res) => {
            // Route on the path only: req.url includes any query string
            // (e.g. /health?probe=20260929), and exact-string matching
            // against it 404s well-formed requests. The full req.url is
            // still logged where it matters for diagnostics.
            const path = (req.url ?? "/").split("?")[0];

            // CORS is handled at the server boundary, not in sendJson():
            // /health, /metrics, and 404 responses never pass through
            // sendJson, and a browser must be able to read API error
            // responses (401/405/500) for an allowed origin instead of
            // seeing an opaque CORS failure. Preflight (OPTIONS) is
            // answered before method checks and authentication: a browser
            // preflight names x-config-token in
            // Access-Control-Request-Headers but never carries the value.
            if (this.handleCorsPreflight(req, res)) {
                return;
            }
            if (!this.applyCorsHeaders(req, res)) {
                this.appendVaryOrigin(res);
                res.setHeader("Cache-Control", "no-store");
                this.logCorsOriginRejected(req);
                this.sendJson(res, 403, { success: false, message: "origin not allowed" });
                return;
            }

            // Suppress logging for successful /metrics, /health, and /ready
            // requests (all are polled by orchestrators at high frequency)
            if (path !== "/metrics" && path !== "/health" && path !== "/ready") {
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

            // The read-only routes enforce the same GET-only contract that
            // /endpoints advertises: an unsupported verb gets 405 with an
            // Allow header instead of silently serving a normal response.
            // (OPTIONS never reaches here — the preflight is answered
            // above.)
            if (path === "/metrics") {
                if (!this.requireMethod(req, res, "GET")) {
                    return;
                }
                // A collector that throws would otherwise reject this async
                // callback, whose returned promise the http server never
                // awaits — surfacing as an unhandledRejection, which index.ts
                // treats as fatal (exit 1). Contain it here: log, answer 500,
                // and let the service keep serving.
                try {
                    const metrics = await register.metrics();
                    if (!res.writableEnded) {
                        res.setHeader("Content-Type", register.contentType);
                        res.end(metrics);
                    }
                } catch (error) {
                    this.logger.write_error(
                        "prometheus/metricsCollectionFailed",
                        "Failed to collect Prometheus metrics",
                        {
                            event: "prometheus_metrics_collection_failed",
                            logType: "service",
                            error: ensureError(error),
                        }
                    );
                    // Empty body on purpose: the Prometheus endpoint returns
                    // text format, and internal error details must never be
                    // echoed to the scraper.
                    if (!res.headersSent) {
                        res.statusCode = 500;
                    }
                    if (!res.writableEnded) {
                        res.end();
                    }
                }
            } else if (path === "/health") {
                if (!this.requireMethod(req, res, "GET")) {
                    return;
                }
                // Liveness only: stays 200 while the process is responsive so
                // the Docker healthcheck does not restart the container on a
                // transient broker outage (the MQTT layer reconnects on its
                // own). Orchestration layers that need a readiness signal
                // should probe /ready instead.
                const mqttStatus = this.mqttNetworking?.is_connected() ? "connected" : "disconnected";
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({
                    status: "healthy",
                    mqtt: mqttStatus,
                    timestamp: new Date().toISOString()
                }));
            } else if (path === "/ready") {
                if (!this.requireMethod(req, res, "GET")) {
                    return;
                }
                // Readiness: can the service actually ingest telemetry right
                // now? The client must be connected AND the broker must have
                // acknowledged the configured subscriptions — a broker can
                // grant CONNECT while denying SUBSCRIBE (ACL, rejected topic
                // filter), keeping the client "connected" while ingesting
                // nothing, so connection state alone is not enough. Report
                // 503 to readiness-sensitive orchestrators while /health
                // keeps reporting liveness independently.
                const connected = this.mqttNetworking?.is_connected() === true;
                const subscriptionsActive = this.mqttNetworking?.subscriptions_active() === true;
                const mqttReady = connected && subscriptionsActive;
                res.setHeader("Content-Type", "application/json");
                res.writeHead(mqttReady ? 200 : 503);
                res.end(JSON.stringify({
                    status: mqttReady ? "ready" : "degraded",
                    mqtt: connected ? "connected" : "disconnected",
                    subscriptions: subscriptionsActive ? "active" : "degraded",
                    timestamp: new Date().toISOString()
                }));
            } else if (path === "/about") {
                if (!this.requireMethod(req, res, "GET")) {
                    return;
                }
                this.handleAbout(req, res);
            } else if (path === "/endpoints") {
                if (!this.requireMethod(req, res, "GET")) {
                    return;
                }
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
                this.handleWriteConfig(req, res);
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

                // Header values are typed string | string[] | undefined by
                // Node; a duplicated x-request-id is protocol-violating, so
                // normalize to the first value explicitly rather than
                // casting away the array case.
                const requestIdHeader = req.headers["x-request-id"];
                const requestId = Array.isArray(requestIdHeader)
                    ? requestIdHeader[0]
                    : requestIdHeader;
                this.logger.write_warn(
                    "prometheus/routeNotFound",
                    "HTTP route not found",
                    {
                        event: "route_not_found",
                        logType: "service",
                        requestId,
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

    // CORS headers are applied centrally in the request callback (see
    // applyCorsHeaders), not here: every route must answer browsers
    // consistently, including the ones that bypass sendJson.
    private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
        res.setHeader("Content-Type", "application/json");
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

    // ******** private methods for CORS

    /**
     * Parse the SENSOR_TELEMETRY_CORS_ORIGINS environment variable.
     * Called once at construction — not per request. Unset, empty, or "*"
     * preserves the previous permissive behavior; anything else is a
     * comma-separated exact-match allowlist (entries are trimmed of
     * whitespace, empty entries are dropped). An origin is the full
     * scheme://host:port tuple, so there is no prefix, wildcard-domain, or
     * regex matching: http://host:3000 and http://host:3301 are distinct.
     */
    private static parseCorsOrigins(raw: string | undefined): {
        allowAllOrigins: boolean;
        allowedOrigins: ReadonlySet<string>;
    } {
        const configured = raw?.trim();
        if (!configured || configured === "*") {
            return { allowAllOrigins: true, allowedOrigins: new Set() };
        }
        return {
            allowAllOrigins: false,
            allowedOrigins: new Set(
                configured
                    .split(",")
                    .map((origin) => origin.trim())
                    .filter((origin) => origin.length > 0)
            ),
        };
    }

    /**
     * Decide which Access-Control-Allow-Origin value a request may receive,
     * or null when the response must carry no CORS headers at all:
     * - no Origin header (Prometheus, curl, containers, healthchecks) → null
     * - wildcard mode → "*"
     * - allowlist mode → the request's own origin, only on an exact match
     * A disallowed origin returns null too; the caller distinguishes it
     * from "no Origin" by checking the request header.
     */
    private static resolveCorsOrigin(
        origin: string | undefined,
        allowAllOrigins: boolean,
        allowedOrigins: ReadonlySet<string>
    ): string | null {
        if (origin === undefined) {
            return null;
        }
        if (allowAllOrigins) {
            return "*";
        }
        return allowedOrigins.has(origin) ? origin : null;
    }

    /**
     * Apply CORS response headers for a normal (non-preflight) request.
     * Returns true when the request may continue — either headers were
     * applied for an allowed browser origin, or the request had no Origin
     * header and needs no CORS headers at all. Returns false for a browser
     * origin that is not allowlisted; the caller must answer 403 with no
     * Access-Control-Allow-Origin header.
     *
     * Vary: Origin is added whenever the response is origin-dependent — both
     * when echoing a specific allowed origin and (in the rejection paths,
     * which call appendVaryOrigin themselves) when answering a rejected
     * origin 403 — so an HTTP cache never serves one origin's response to a
     * different one. Access-Control-Allow-Credentials is intentionally never
     * set: this API authenticates with x-config-token, not browser HTTP
     * credentials.
     */
    private applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        const rawOrigin = req.headers.origin;
        // Duplicate Origin headers are protocol-violating; take the first.
        const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
        const allowed = PrometheusWriter.resolveCorsOrigin(origin, this.corsAllowAllOrigins, this.corsAllowedOrigins);
        if (allowed === null) {
            // No header at all when the request had no Origin, so
            // non-browser clients see exactly the responses they always did.
            return origin === undefined;
        }
        res.setHeader("Access-Control-Allow-Origin", allowed);
        if (allowed !== "*") {
            this.appendVaryOrigin(res);
        }
        return true;
    }

    /**
     * Add "Origin" to the response Vary header without clobbering values an
     * earlier layer may have set (setHeader would replace them).
     */
    private appendVaryOrigin(res: http.ServerResponse): void {
        const existing = res.getHeader("Vary");
        if (existing === undefined) {
            res.setHeader("Vary", "Origin");
            return;
        }
        const values = (Array.isArray(existing) ? existing : [String(existing)])
            .join(", ")
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (!values.includes("Origin")) {
            values.push("Origin");
            res.setHeader("Vary", values.join(", "));
        }
    }

    /**
     * Answer a CORS preflight request and report that the response is
     * complete (true), or return false for non-OPTIONS requests so the
     * caller continues with normal routing. Runs before method checks and
     * authentication: a browser preflight never carries the actual
     * x-config-token value, only the intent to send it. Never reads the
     * request body, never invokes an endpoint handler.
     */
    private handleCorsPreflight(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        if (req.method !== "OPTIONS") {
            return false;
        }
        if (!this.applyCorsHeaders(req, res)) {
            this.appendVaryOrigin(res);
            res.setHeader("Cache-Control", "no-store");
            this.logCorsOriginRejected(req);
            res.writeHead(403);
            res.end();
            return true;
        }
        res.setHeader("Access-Control-Allow-Methods", PrometheusWriter.CORS_ALLOW_METHODS);
        res.setHeader("Access-Control-Allow-Headers", PrometheusWriter.CORS_ALLOW_HEADERS);
        res.setHeader("Access-Control-Max-Age", PrometheusWriter.CORS_MAX_AGE_SECONDS.toString());
        res.writeHead(204);
        res.end();
        return true;
    }

    /**
     * Audit a rejected browser origin. Deliberately excludes request headers
     * and secrets — the token lives in x-config-token and never belongs in
     * a log line.
     */
    private logCorsOriginRejected(req: http.IncomingMessage): void {
        const rawOrigin = req.headers.origin;
        const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
        this.logger.write_warn(
            "prometheus/corsOriginRejected",
            "Rejected browser request from an origin not on the CORS allowlist",
            {
                event: "cors_origin_rejected",
                logType: "audit",
                method: req.method || "UNKNOWN",
                url: req.url || "/",
                origin: origin ?? "UNKNOWN",
                statusCode: 403,
            }
        );
    }

    private handleAbout(_req: http.IncomingMessage, res: http.ServerResponse): void {
        const mqttStatus = this.mqttNetworking?.is_connected() ? "connected" : "disconnected";
        const aboutInfo = {
            about: {
                name: "Sensor Telemetry Services",
                version: version ?? "unknown",
                author: "Randy Dodson (dodsonsoftware@gmail.com)",
                description: "**Sensor Telemetry Service** is the telemetry ingestion service for the SensorNET platform. Built with Node.js and TypeScript, it connects to MQTT-enabled IoT sensors, processes environmental and system telemetry, and exposes the collected data as Prometheus metrics for monitoring and visualization.\n\n**Sensor Telemetry Service** subscribes to MQTT telemetry and log topics, automatically reconnects when connectivity is interrupted, and supports V3 (per-device) telemetry message formats. Incoming messages are parsed, validated, and converted into standardized Prometheus gauges with normalized source labels. Supported telemetry includes air and water temperature, humidity, pressure, soil moisture, UV index, light intensity, CPU temperature, memory usage, Wi-Fi signal strength, and sensor health metrics. Unit conversions and derived values are calculated automatically.\n\n**Sensor Telemetry Service** exposes Prometheus metrics alongside HTTP endpoints for health monitoring, service information, runtime configuration management, and configuration reloading. Sensor log messages are forwarded using Loki-compatible structured labels, while sensitive configuration values are automatically redacted from application logs.\n\nProduction-focused features—including runtime configuration updates, source label sanitization to control Prometheus cardinality, graceful shutdown, resilient MQTT reconnection, secret redaction, and structured logging—help ensure reliable telemetry collection across the SensorNET environment.",
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
                { route: "/health", description: "Liveness check endpoint (always 200 while the process is responsive)." },
                { route: "/ready", description: "Readiness check endpoint (503 when the MQTT client is not connected or a subscription is not active)." },
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
                description: "Liveness check endpoint for container healthchecks: returns 200 while the process is responsive, regardless of MQTT state."
            },
            {
                name: "Readiness",
                route: "/ready",
                verb: "GET",
                requestBody: "None",
                responseBody: "{ status: \"ready|degraded\", mqtt: \"connected|disconnected\", subscriptions: \"active|degraded\", timestamp: \"ISO-date-string\" }",
                description: "Readiness check endpoint: returns 200 when the MQTT client is connected and the broker has acknowledged the configured subscriptions, 503 (degraded) otherwise. A denied subscription (SUBACK failure) keeps the client connected while ingesting nothing, so both signals are required. Use for readiness-sensitive orchestration; /health remains the liveness signal."
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
                requestBody: "JSON object with keys: logLevel (error|warn|info|debug|critical), apiPort (positive integer), mqttBrokerIpAddress (string), mqttTopicTelemetry (string), mqttTopicLog (string, optional), mqttTopicHealth (string, optional), sensorSourceMaxLength (positive integer, optional), sensorSourceValidCharsRegex (string, optional), sensorSourceCardinalityCap (positive integer, optional), staleSourceRemovalSecs (non-negative integer, 0 = disabled, optional), forwardSensorLogs (boolean, optional), forwardSensorLogsLevel (error|warn|info|debug|critical, optional). Requires the x-config-token header when SENSOR_TELEMETRY_CONFIG_TOKEN is set.",
                responseBody: "{ success: boolean, message: string }",
                description: "Validates the new configuration, persists it to disk, and applies the runtime-effective keys (logLevel, forwardSensorLogs, forwardSensorLogsLevel, staleSourceRemovalSecs). Changes to mqttBrokerIpAddress, the MQTT topics, apiPort, sensorSourceMaxLength, sensorSourceValidCharsRegex, or sensorSourceCardinalityCap take effect on the next restart. When running in Docker, an apiPort change additionally requires updating the deployment configuration: the image healthcheck probes localhost:3301 and the compose port mapping is 3301:3301."
            },
            {
                name: "Reload Config",
                route: "/reload-config",
                verb: "GET",
                requestBody: "None. Requires the x-config-token header when SENSOR_TELEMETRY_CONFIG_TOKEN is set.",
                responseBody: "{ success: true, message: \"Configuration reloaded successfully\" }",
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

    private handleWriteConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
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
        req.on("end", () => {
            if (rejected) return;
            // The body is bounded by the 'data' handler's size cap above,
            // so this concatenation/decode is bounded. The write
            // transaction itself is appended to the config write chain
            // (queueConfigWrite) so concurrent requests run it one at a
            // time, each to completion.
            const body = Buffer.concat(chunks).toString("utf8");
            this.queueConfigWrite(() => this.performConfigWrite(body, res));
        });

        // A client that vanishes mid-body (aborted fetch, dropped TCP) makes
        // the request stream emit 'error' (e.g. ECONNRESET) or 'aborted'
        // instead of 'end'. With no handler attached, an unhandled 'error'
        // event on the request stream throws ERR_UNHANDLED_ERROR and takes the
        // process down. Both paths are made explicit here: mark the request
        // rejected so the 'end' handler never parses a partial body, log an
        // audit warning, and end the response if it is still open — with an
        // explicit 400 first (matching the malformed-body path below) so a
        // response that can still reach the client does not default to 200.
        // (Not reproducible on the pinned Node runtime, but defensive against
        // a runtime that does surface the error.)
        const endWithFailure = () => {
            if (!res.headersSent) {
                res.statusCode = 400;
            }
            if (!res.writableEnded) {
                res.end();
            }
        };
        req.on("error", (err: Error) => {
            if (rejected) return;
            rejected = true;
            this.logger.write_warn(
                "prometheus/writeConfigRequestError",
                `/write-config request errored before completion: ${err.message}`,
                {
                    event: "config_request_error",
                    logType: "audit",
                    error: err.message,
                }
            );
            endWithFailure();
        });
        req.on("aborted", () => {
            if (rejected) return;
            rejected = true;
            this.logger.write_warn(
                "prometheus/writeConfigRequestAborted",
                "/write-config request aborted before completion",
                {
                    event: "config_request_aborted",
                    logType: "audit",
                }
            );
            endWithFailure();
        });
    }

    /**
     * Append a configuration write transaction to the serialization
     * chain. Each transaction runs to completion before the next one
     * starts, so one /write-config's persist/commit/callback steps can
     * never interleave with another's.
     *
     * The chain itself never rejects: a failed transaction is already
     * reported to its own HTTP response inside performConfigWrite, and
     * swallowing any rejection here keeps a single failed write from
     * permanently poisoning the queue — a rejected chain would silently
     * skip every later write's transaction while each still answered
     * nothing.
     */
    private queueConfigWrite(transaction: () => Promise<void> | void): void {
        this.configWriteChain = this.configWriteChain.then(async () => {
            try {
                await transaction();
            } catch {
                // See the note above: the rejection is handled by the
                // transaction's own response path, so nothing to do here
                // beyond keeping the chain alive for the next write.
            }
        });
    }

    /**
     * Complete configuration write transaction: validate -> persist ->
     * commit the in-memory config -> apply the runtime-effective keys ->
     * notify the config change callback. Runs serialized on the config
     * write chain (queueConfigWrite), preserving the persist-before-
     * commit order: a failed persistence leaves this.config and the
     * runtime untouched, and on success all three representations of the
     * configuration (disk, in-memory, runtime) end up on the same config
     * before the response goes out.
     */
    private async performConfigWrite(body: string, res: http.ServerResponse): Promise<void> {
        try {
            const newConfigRaw = JSON.parse(body);
            const validatedConfig = validateConfig(newConfigRaw);

            // Extract old and new log levels
            const oldLogLevel = this.config.logLevel;
            const newLogLevel = validatedConfig.logLevel;

            // Persist before committing: the on-disk file is the
            // authoritative config (/read-config and /reload-config both
            // read it), so a failed write must leave every in-memory
            // copy untouched. Committing this.config first would split
            // the process (new memory, stale disk) even though the
            // response reports 500.
            const writeSuccess = write_file_yaml(this.configSource, validatedConfig, this.logger);
            if (!writeSuccess) {
                this.sendJson(res, 500, {
                    success: false,
                    message: "Failed to persist configuration; no changes were applied"
                });
                return;
            }

            // Disk write succeeded — commit the runtime state.
            this.config = { ...validatedConfig };

            // Apply log level change if it differs
            this.applyLogLevelChange(oldLogLevel, newLogLevel);

            // Apply stale-source-removal change if it differs
            this.applyStaleSourceRemoval();

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

                // Apply stale-source-removal change, matching /write-config.
                this.applyStaleSourceRemoval();

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
     * Arm or disengage the stale-source sweep from the committed
     * staleSourceRemovalSecs value (0 = disabled). Called from the
     * constructor and from both config commit paths (/write-config,
     * /reload-config) after this.config is committed, so the key is
     * runtime-effective like logLevel. No-op when the value is unchanged,
     * which covers the constructor's 0 → 0 and commits that omit the key.
     * The sweep interval is threshold/2 clamped to [10s, 60s]: eviction can
     * therefore lag the threshold by up to one interval.
     */
    private applyStaleSourceRemoval(): void {
        const newThreshold = this.config.staleSourceRemovalSecs ?? 0;
        if (newThreshold === this.staleSourceRemovalSecs) {
            return;
        }
        this.staleSourceRemovalSecs = newThreshold;
        this.clearStaleSweepTimer();
        if (newThreshold <= 0) {
            this.logger.write_info(
                "prometheus/staleSourceRemoval",
                "Stale source removal disabled — per-source series live until process restart",
                {
                    event: "stale_source_removal",
                    logType: "audit",
                    enabled: false,
                    thresholdSeconds: newThreshold,
                }
            );
            return;
        }
        const intervalMs = Math.min(60_000, Math.max(10_000, (newThreshold / 2) * 1000));
        this.staleSweepTimer = setInterval(() => this.sweepStaleSources(), intervalMs);
        this.logger.write_info(
            "prometheus/staleSourceRemoval",
            `Stale source removal enabled — sources idle for more than ${newThreshold}s have their data gauges removed`,
            {
                event: "stale_source_removal",
                logType: "audit",
                enabled: true,
                thresholdSeconds: newThreshold,
                intervalMs,
            }
        );
        if (newThreshold < 300) {
            this.logger.write_warn(
                "prometheus/staleSourceRemoval",
                "staleSourceRemovalSecs is below 300s — sources reporting less often than the threshold will flap (series removed, then recreated on each message)",
                {
                    event: "stale_source_removal_threshold_low",
                    logType: "audit",
                    thresholdSeconds: newThreshold,
                }
            );
        }
    }

    /**
     * Clear the stale sweep interval. Idempotent: no-op while undefined,
     * which is what makes repeated close() calls safe.
     */
    private clearStaleSweepTimer(): void {
        if (this.staleSweepTimer === undefined) {
            return;
        }
        clearInterval(this.staleSweepTimer);
        this.staleSweepTimer = undefined;
    }

    /**
     * One sweep pass: evict every source whose last accepted message is
     * strictly older than the threshold. Iterates a snapshot because
     * evictStaleSource mutates the map (and admittedSources) in place.
     * Fallback labels are absent from the map by construction (see
     * mark_source_seen), so no per-source exemption check is needed here.
     */
    private sweepStaleSources(): void {
        if (this.staleSourceRemovalSecs <= 0) {
            return;
        }
        const now = Date.now();
        const thresholdMs = this.staleSourceRemovalSecs * 1000;
        for (const [source, lastSeenMs] of Array.from(this.sourceLastSeenTimes)) {
            const ageMs = now - lastSeenMs;
            if (ageMs <= thresholdMs) {
                continue;
            }
            this.evictStaleSource(source, Math.floor(ageMs / 1000));
        }
    }

    /**
     * Remove a stale source's per-source data gauge series and free its
     * admitted-source slot so a returning sensor is re-admitted normally.
     * sensor_last_seen_timestamp_seconds{source} is deliberately retained
     * as the staleness signal; the fallback-labeled gauges, the
     * topic-labeled subscription gauge, and all counters are untouched.
     * gauge.remove() is a no-op for a label set the source never set (e.g.
     * a soil-only source has no air gauges), so the fixed list is safe for
     * partial reporters.
     */
    private evictStaleSource(source: string, ageSeconds: number): void {
        for (const gauge of this.prometheus_SourceDataGauges) {
            gauge.remove({ source });
        }
        this.sourceLastSeenTimes.delete(source);
        this.admittedSources.delete(source);
        this.logger.write_warn(
            "prometheus/staleSourceRemoved",
            `Removing data gauges for source idle for ${ageSeconds}s (threshold ${this.staleSourceRemovalSecs}s); sensor_last_seen_timestamp_seconds is retained`,
            {
                event: "stale_source_removed",
                logType: "audit",
                source: truncateForLog(source),
                ageSeconds,
                thresholdSeconds: this.staleSourceRemovalSecs,
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
                `Source '${truncateForLog(normalized)}' contains no valid characters — using 'unknown' label`,
                {
                    event: "sensor_source_sanitized",
                    logType: "sensor",
                    originalSource: truncateForLog(normalized),
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
                `Sanitized source '${truncateForLog(normalized)}' -> '${sanitized}'`,
                {
                    event: "sensor_source_sanitized",
                    logType: "sensor",
                    originalSource: truncateForLog(normalized),
                    sanitizedSource: sanitized,
                }
            );
        }

        return sanitized;
    }

    /**
     * Admit a source as a Prometheus label value.
     * sanitizeSource() bounds each value's length and charset but not the
     * number of distinct values, so this additionally caps distinct admitted
     * values at sourceCardinalityCap. A sanitized source that would exceed
     * the cap maps to the fixed "unknown_source" fallback label and is
     * counted in sensor_sources_rejected_total instead of minting a new
     * series. The warning fires once per cap; each rejection is counted.
     */
    private admitSource(source: string): string {
        const sanitized = this.sanitizeSource(source);
        if (this.admittedSources.has(sanitized)) {
            return sanitized;
        }
        if (this.admittedSources.size < this.sourceCardinalityCap) {
            this.admittedSources.add(sanitized);
            return sanitized;
        }
        this.prometheus_counter_sources_rejected?.inc();
        if (!this.sourceCapExceededWarned) {
            this.sourceCapExceededWarned = true;
            this.logger.write_warn(
                "prometheus/sourceCapExceeded",
                `Source cardinality cap (${this.sourceCardinalityCap}) reached — new distinct sources map to 'unknown_source'`,
                {
                    event: "sensor_source_cap_exceeded",
                    logType: "audit",
                    source: sanitized,
                    cap: this.sourceCardinalityCap,
                }
            );
        }
        this.logger.write_debug(
            "prometheus/sourceRejected",
            `Source '${sanitized}' rejected by cardinality cap, using 'unknown_source' label`,
            {
                event: "sensor_source_rejected",
                logType: "sensor",
                source: sanitized,
            }
        );
        return "unknown_source";
    }

    /**
     * Admit a firmware version as a telemetry_messages_total label value.
     * firmware_version comes straight from MQTT payloads, so apply the same
     * bounds as source labels — invalid-character strip, truncation to
     * MAX_SOURCE_LENGTH — plus the same distinct-value cap: values beyond
     * the cap map to the fixed "unknown_firmware" label and increment
     * sensor_firmware_versions_rejected_total.
     */
    public admitFirmwareVersion(firmwareVersion: string): string {
        // No Unicode dash normalization: firmware identity is not
        // cross-referenced with source identity, so plain strip/truncate
        // is sufficient to bound the label value.
        let sanitized = firmwareVersion.replace(this.VALID_CHARS, "");
        if (sanitized.length > this.MAX_SOURCE_LENGTH) {
            sanitized = sanitized.substring(0, this.MAX_SOURCE_LENGTH);
        }
        // A firmware version made entirely of invalid characters collapses
        // to "" — reuse the "unknown" label the missing-field path uses.
        if (sanitized === "") {
            sanitized = "unknown";
        }
        if (this.admittedFirmwareVersions.has(sanitized)) {
            return sanitized;
        }
        if (this.admittedFirmwareVersions.size < this.sourceCardinalityCap) {
            this.admittedFirmwareVersions.add(sanitized);
            return sanitized;
        }
        this.prometheus_counter_firmware_versions_rejected?.inc();
        if (!this.firmwareCapExceededWarned) {
            this.firmwareCapExceededWarned = true;
            this.logger.write_warn(
                "prometheus/firmwareCapExceeded",
                `Firmware version cardinality cap (${this.sourceCardinalityCap}) reached — new firmware versions map to 'unknown_firmware'`,
                {
                    event: "sensor_firmware_cap_exceeded",
                    logType: "audit",
                    firmwareVersion: sanitized,
                    cap: this.sourceCardinalityCap,
                }
            );
        }
        this.logger.write_debug(
            "prometheus/firmwareRejected",
            `Firmware version '${sanitized}' rejected by cardinality cap, using 'unknown_firmware' label`,
            {
                event: "sensor_firmware_rejected",
                logType: "sensor",
                firmwareVersion: sanitized,
            }
        );
        return "unknown_firmware";
    }

    // ******** public methods

    is_ready(): boolean {
        return this._ready;
    }

    close(): Promise<void> {
        this._ready = false;
        // Before the !this.server early return so a second close (and a
        // close of a writer whose listen failed) still stops the sweep.
        this.clearStaleSweepTimer();
        if (!this.server) {
            // close() must be idempotent: a second shutdown signal while the
            // first is still in flight would otherwise call server.close()
            // on a server that is already closing and throw
            // ERR_SERVER_NOT_RUNNING.
            return Promise.resolve();
        }
        const server = this.server;
        this.server = undefined;
        // server.close() is asynchronous: it stops accepting new connections
        // but only fires its callback once existing connections have drained,
        // so the promise must resolve in the callback — the shutdown path in
        // MqttNetworking awaits it before process.exit() runs.
        return new Promise<void>((resolve) => {
            server.close(() => {
                this.logger.write_info(
                    "prometheus/serverClosed",
                    "Prometheus metrics server closed.",
                    {
                        event: "prometheus_server_closed",
                        logType: "service",
                    }
                );
                resolve();
            });
        });
    }

    publish_air(payload: JsonObject, source: string, firmwareVersion: string) {
        const sanitized = this.admitSource(source);
        const airRaw = payload?.["air"];
        if (!airRaw) {
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

        // Non-object sections read as empty rather than indexing a primitive.
        const air: JsonObject = isJsonObject(airRaw) ? airRaw : {};

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
                    value: boundForLog(air["temperature_c"]),
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
                    value: boundForLog(air["temperature_c"]),
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
            if (humidity < 0 || humidity > 100) {
                this.logger.write_warn(
                    "prometheus/publishAirHumidityOutOfRange",
                    `Source: ${sanitized}, humidity_percent out of physical range (${humidity}%), skipping Air_Humidity gauge`,
                    {
                        event: "telemetry_out_of_range",
                        logType: "sensor",
                        source: sanitized,
                        field: "humidity_percent",
                        value: humidity,
                        minRange: 0,
                        maxRange: 100,
                    }
                );
            } else {
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
            `Processed air telemetry for source: ${sanitized}`,
            {
                event: "metrics_published",
                logType: "sensor",
                source: sanitized,
            }
        );
    }

    publish_light(payload: JsonObject, source: string, firmwareVersion: string) {
        const sanitized = this.admitSource(source);
        const lightRaw = payload?.["light"];
        if (!lightRaw) {
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

        // Non-object sections read as empty rather than indexing a primitive.
        const light: JsonObject = isJsonObject(lightRaw) ? lightRaw : {};

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
                    value: boundForLog(light["uv_index"]),
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
                    value: boundForLog(light["lux"]),
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

    publish_water(payload: JsonObject, source: string, firmwareVersion: string) {
        const sanitized = this.admitSource(source);
        const waterRaw = payload?.["water"];
        if (!waterRaw) {
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

        // Non-object sections read as empty rather than indexing a primitive.
        const water: JsonObject = isJsonObject(waterRaw) ? waterRaw : {};

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
                    value: boundForLog(water["temperature_c"]),
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
                    value: boundForLog(water["temperature_c"]),
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

    publish_soil(payload: JsonObject, source: string, firmwareVersion: string) {
        const sanitized = this.admitSource(source);
        const soilRaw = payload?.["soil"];
        if (!soilRaw) {
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

        // Non-object sections read as empty rather than indexing a primitive.
        const soil: JsonObject = isJsonObject(soilRaw) ? soilRaw : {};

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
                    value: boundForLog(soil["relative_moisture_percent"]),
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
                        value: boundForLog(raw),
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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

    set_wifi_rssi_dbm(source: string, rssi: number): void {
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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
        const sanitized = this.admitSource(source);
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

    // ******** public methods for sensor freshness

    /**
     * Record that the sensor source accepted a telemetry or health message.
     *
     * The value is "last accepted message time", NOT "last time an
     * individual gauge changed": a source that keeps reporting the same
     * reading stays fresh, and a malformed message that MqttNetworking
     * drops does not count as activity. MqttNetworking calls this exactly
     * once per accepted message — a single health message sets 10+ gauges
     * but must stamp the timestamp only once.
     *
     * The source is admitted through admitSource() like every other sensor
     * metric, so this label obeys the same sanitization and cardinality
     * rules (cap overflow maps to 'unknown_source') rather than keeping a
     * second, independent source-label policy.
     */
    public mark_source_seen(source: string): void {
        const sanitized = this.admitSource(source);
        // Track freshness for the stale sweep, mirroring the gauge stamp in
        // the same call so the two cannot diverge. Fallback labels are
        // shared by overflow/blank sources and are never tracked —
        // evicting them would wipe another source's data.
        if (!PrometheusWriter.NON_EVICTABLE_SOURCES.has(sanitized)) {
            this.sourceLastSeenTimes.set(sanitized, Date.now());
        }
        this.prometheus_Gauge_SensorLastSeenTimestamp!.setToCurrentTime({ source: sanitized });
        this.logger.write_debug(
            "prometheus/markSourceSeen",
            `Source: ${sanitized} marked seen`,
            {
                event: "sensor_marked_seen",
                logType: "sensor",
                source: sanitized,
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

        // ******** water

        this.prometheus_Gauge_WaterTemp = new Gauge({
            name: "water_temperature",
            help: "This indicator shows the temperature in fahrenheit.",
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

        // ******** sensor freshness

        // Unix timestamp of the most recent ACCEPTED telemetry or health
        // message per source, updated by mark_source_seen() once per
        // accepted message (never per gauge). Consumers compute sensor age
        // as time() - sensor_last_seen_timestamp_seconds. By default the
        // series live forever — staleness thresholds belong in
        // Prometheus/Grafana. When staleSourceRemovalSecs > 0, the stale
        // sweep (see evictStaleSource) removes the 26 per-source data
        // gauges for sources idle past the threshold while retaining this
        // series as the staleness signal; fallback labels (unknown,
        // unknown_source) are never evicted.
        this.prometheus_Gauge_SensorLastSeenTimestamp = new Gauge({
            name: "sensor_last_seen_timestamp_seconds",
            help: "Unix timestamp in seconds of the most recent accepted telemetry or health message from the sensor source.",
            labelNames: ["source"],
        });

        // ******** service diagnostics (this service's own MQTT subscriptions)

        // Pulled from MqttNetworking at scrape time rather than pushed on
        // each SUBACK: the value is always current and no callback coupling
        // is needed. Absent (no series) when no networking is attached, as
        // in unit tests that use a bare writer.
        this.prometheus_Gauge_MqttSubscriptionActive = new Gauge({
            name: "mqtt_subscription_active",
            help: "Per-topic MQTT subscription state for this service (1 = broker acknowledged the subscription, 0 = pending, denied, or lost).",
            labelNames: ["topic"],
            collect: () => {
                const states = this.mqttNetworking?.get_subscription_states();
                if (!states) return;
                for (const { topic, active } of states) {
                    this.prometheus_Gauge_MqttSubscriptionActive!.set(
                        { topic },
                        active ? 1 : 0
                    );
                }
            },
        });

        // The eviction target list: exactly the 26 per-source data gauges
        // (9 readings + 17 sensor_health_*). Deliberately excludes
        // SensorLastSeenTimestamp (retained as the staleness signal) and
        // MqttSubscriptionActive (topic-labeled service diagnostic).
        this.prometheus_SourceDataGauges = [
            this.prometheus_Gauge_AirTemp,
            this.prometheus_Gauge_AirHumidity,
            this.prometheus_Gauge_AirPressure,
            this.prometheus_Gauge_AirAltitude,
            this.prometheus_Gauge_LightUvIndex,
            this.prometheus_Gauge_LightLux,
            this.prometheus_Gauge_WaterTemp,
            this.prometheus_Gauge_SoilMoisturePercent,
            this.prometheus_Gauge_SoilMoistureRaw,
            this.prometheus_Gauge_CpuTemp,
            this.prometheus_Gauge_HeapFreeBytes,
            this.prometheus_Gauge_WifiRssiDbm,
            this.prometheus_Gauge_SensorHealthUp,
            this.prometheus_Gauge_SensorUptime,
            this.prometheus_Gauge_MinHeapFreeBytes,
            this.prometheus_Gauge_DevicesActive,
            this.prometheus_Gauge_DevicesConfigured,
            this.prometheus_Gauge_NetworkStackReady,
            this.prometheus_Gauge_WifiConnected,
            this.prometheus_Gauge_MqttConnected,
            this.prometheus_Gauge_Core1Active,
            this.prometheus_Gauge_OutboundQueueDepth,
            this.prometheus_Gauge_OutboundEvicted,
            this.prometheus_Gauge_OutboundRejected,
            this.prometheus_Gauge_UtcValid,
            this.prometheus_Gauge_UtcSyncAgeSec,
        ];
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
