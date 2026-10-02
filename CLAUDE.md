# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Overview

A Node.js service that listens on MQTT channels for sensor telemetry data and publishes it to Prometheus metrics.

## Architecture

### Key Components

- **MqttNetworking** (`src/dodsonlabs/MqttNetworking.ts`) — MQTT client and Prometheus writer integration
- **PrometheusWriter** (`src/dodsonlabs/PrometheusWriter.ts`) — Prometheus metric registration and HTTP server
- **Logger** (`src/dodsonlabs/Logger.ts`) — Winston-based logging abstraction
- **SystemFunctions** (`src/dodsonlabs/SystemFunctions.ts`) — File I/O, error handling, formatting utilities, scalar field validation (`getStringField` / `getStringOrFiniteNumberField` prove MQTT protocol scalars are scalar at the boundary), and log-value bounding (`truncateForLog` / `truncateForLogList` cap untrusted MQTT values before they reach the log)
- **Interfaces** (`src/dodsonlabs/Interfaces.ts`) — Type definitions for the service, including `JsonObject` (the untrusted-MQTT-JSON contract: `Record<string, unknown>`) and the `isJsonObject` type guard

### Entry Point

- **index.ts** (`src/index.ts`) — Main entry point with config loading, shutdown handling, and signal trapping

### V3 Message Format (per-device telemetry)

Payloads above the 64 KiB application cap (`MAX_MQTT_PAYLOAD_BYTES`, checked at the top of `MqttNetworking.on_message` before `toString()` and `JSON.parse`) are dropped with an `mqtt_payload_too_large` warning that logs only the topic and lengths, never the contents. The guard bounds string conversion and parsing, not the MQTT client's receipt of the packet itself — the broker should enforce its own packet-size limit as well.

Every incoming body is narrowed once at the parse site: valid JSON that is not an object is dropped with a `mqtt_message_not_object` warning before routing, and all handlers receive a `JsonObject` whose fields are read through the `SystemFunctions`/`MqttNetworking` field helpers (no handler indexes an untrusted value directly; present-but-non-object payloads/sections read as empty).

Scalar protocol fields are proven scalar at the MQTT boundary before entering internal processing — never through blanket `String()` coercion, whose array-to-string conversion recurses on nested structures (a deeply nested hostile value throws `RangeError: Maximum call stack size exceeded`) and silently coerces booleans/objects into garbage strings: `getStringField` accepts only actual strings (`message_type`/`message-type`, log `level`, health `status`, forwarded-log label fields — non-string values are treated as missing), and `getStringOrFiniteNumberField` additionally accepts finite numbers as their string form for the identifier fields legacy firmware may emit numerically (`source`, `device`, `firmware_version`; `NaN`/`±Infinity` are rejected).

V3 telemetry messages are per-device rather than per-section: each carries a top-level `device` field and a `payload` with only that device's readings. `MqttNetworking` maps known device types to the metric category they feed:

| V3 device | Metric category | Payload fields |
|-----------|-----------------|----------------|
| `bme280` | air | `temperature_c`, `humidity_percent`, `pressure_pa`, `altitude_m` (nullable — null when adjusted pressure is non-positive) |
| `sht35` | air | `temperature_c`, `humidity_percent` (no pressure sensor — pressure gauge is left untouched) |
| `ds18b20` | water | `temperature_c` |
| `ltr390` | light | `lux`, `uv_index` (+ `als_raw`, `uv_raw`, not published) |
| `yl69_fc28` | soil | `relative_moisture_percent`, `raw` (+ `digital_state`, nullable, not published) |
| `plantmate_soil` | soil | `relative_moisture_percent`, `raw` |

Unknown device types are dropped with a warning. Telemetry messages must carry a usable `device` field (missing, null, or blank values are dropped with an `mqtt_telemetry_missing_device` warning) — the legacy V2 section-based path (`payload.air`, `payload.water`, ...) was removed and no longer accepted; `getFirmwareVersion` follows the V3 contract (top-level `firmware_version` only, `"unknown"` when absent). V3 health messages (`iot/v3/health` or `message_type: "health"`) populate the system-info gauges plus `sensor_health_up`, `sensor_health_uptime_seconds`, and the v4 health gauges (`sensor_health_heap_min_free_bytes`, `sensor_health_devices_active`, `sensor_health_devices_configured`, `sensor_health_network_stack_ready`, `sensor_health_wifi_connected`, `sensor_health_mqtt_connected`, `sensor_health_core_1_active`, `sensor_health_outbound_queue_depth`, `sensor_health_outbound_evicted`, `sensor_health_outbound_rejected`, `sensor_health_utc_valid`, `sensor_health_utc_sync_age_sec`). A non-empty `degraded_reasons` array is logged as a `v3_health_degraded` warning (not published as a metric). All health/diagnostic metrics (including the system-info gauges `sensor_health_cpu_temperature_c`, `sensor_health_heap_free_bytes`, and `sensor_health_wifi_rssi_dbm`) share the `sensor_health_` prefix; physical sensor readings do not.

### Configuration

- **config.yml** (project root) — Single source of truth for runtime configuration (YAML). Copied to `dist/` by `npm run build`. At startup the service tries `CONFIG_FILE_CANDIDATES` in order: `/app/configs/config.yml` (Docker mount — the container does not ship the file in the image, see docker-compose.yml), `./config.yml` (current working directory), then `./dist/config.yml` (build-output fallback when running from repo root). The root config deliberately beats the generated `dist/` copy, so editing the root config after a build takes effect without rebuilding. Fallback continues only past *missing* files: a candidate that exists but is unreadable, unparseable, or empty fails startup immediately (naming the offending file) instead of silently booting on a stale earlier snapshot.
- **schemas/config.ts** — Zod schema for configuration validation. The schema is strict: unknown keys (e.g. a misspelled optional key like `forwardSensorLog`) fail validation with an `Unrecognized key` error instead of being silently discarded — the same schema is used at startup, `/write-config`, and `/reload-config`, so all three enforce the identical shape. It also enforces that the three MQTT topics (`mqttTopicTelemetry`, `mqttTopicLog`, `mqttTopicHealth`) are unique when compared case-insensitively: `MqttNetworking.on_message` routes topics case-insensitively (log before health, both before the telemetry fallback), while MQTT itself is case-sensitive, so two configured topics that collapse under case folding (including exact duplicates) are distinct to the broker but identical to the router, and one would silently shadow the other
- **SENSOR_TELEMETRY_CONFIG_TOKEN** (env var) — Optional shared secret protecting `/write-config` and `/reload-config`. When set, requests must carry a matching `x-config-token` header (constant-time compare); when unset the endpoints remain open and a warning is logged at startup. The security-relevant HTTP rejection events (`config_token_rejected`, `cors_origin_rejected`, `config_body_too_large`) include the directly observed `remoteAddress` for operational forensics — never the token value, request headers, or body, and no proxy-header (X-Forwarded-For) trust or reverse DNS. A `/write-config` body over 64 KiB is rejected with `413` (`config_body_too_large`) and the request stream is then destroyed — the 413 is delivered first, but a misbehaving client cannot keep the socket open pumping data past the cap.
- **SENSOR_TELEMETRY_CORS_ORIGINS** (env var) — Comma-separated exact-match allowlist of browser origins for the HTTP API (an origin is the full `scheme://host:port` tuple; no prefix/wildcard/regex matching). Parsed once at construction. Unset/empty/`*` allows all origins (permissive default, `Access-Control-Allow-Origin: *`); otherwise only an exact allowlisted `Origin` is echoed back, with `Vary: Origin`. `OPTIONS` preflights are answered `204` (methods `GET, POST, OPTIONS`, headers `Content-Type, X-Config-Token`, `Access-Control-Max-Age: 600`) before route handling, method checks, and authentication — a preflight never carries the token value. Disallowed browser origins get `403` with no `Access-Control-Allow-Origin` header and a `cors_origin_rejected` audit warning. Requests with no `Origin` header (Prometheus, curl, containers) are unaffected. CORS is a browser policy and does not replace `SENSOR_TELEMETRY_CONFIG_TOKEN`.

## Supported Sensor Types

| Metric | Description |
|--------|-------------|
| air_temperature | Temperature in Fahrenheit |
| air_humidity | Humidity percentage |
| air_pressure | Air pressure in in/Hg |
| air_altitude_ft | Barometric altitude in feet (bme280 only) |
| soil_moisture_percent | Soil moisture percentage (0-100) |
| soil_moisture_raw | Raw 16-bit soil moisture ADC reading |
| light_uv_index | UV Index |
| light_lux | Light level in LUX |
| water_temperature | Water temperature in Fahrenheit |

## Commands

```bash
npm run build     # Compile TypeScript + copy config.yml to dist/
npm start         # Run production service
npm run dev       # Development mode with ts-node
npm run lint      # Run ESLint
npm test          # Run Jest test suite
npm run test:watch # Watch mode for tests
npm run test:coverage # Run tests with coverage report
```

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `logLevel` | Logging verbosity (error, warn, info, debug, critical — critical filters at winston error level) | info |
| `apiPort` | Port for Prometheus metrics endpoint. The supplied Docker deployment hardcodes 3301 in three places — the Dockerfile `EXPOSE 3301` and HEALTHCHECK probe (`localhost:3301/health`), and the docker-compose port mapping (`3301:3301`) — so changing `apiPort` in a container deployment requires updating those deployment files to match, or the healthcheck fails and the host port never reaches the service. This is an **intentional, documented constraint — not a defect**: a true single source of truth (an env var read by the app as well as the healthcheck/compose) would require the application to take an env override of `config.yml`'s `apiPort`, which was deliberately declined to avoid complicating the app for a rarely-changed, Prometheus-pinned port. Do not re-flag the `3301` hardcoding as a bug | required |
| `mqttBrokerIpAddress` | MQTT broker address — host, IP, or bracketed IPv6 literal, each with an optional `:port` (1-65535); no scheme (`mqtt://`) — the value is appended to `mqtt://` in `MqttNetworking`. Validated at config load because an unparseable value (e.g. out-of-range port) would otherwise throw synchronously from `mqtt.connect` inside the `MqttNetworking` constructor, which runs before index.ts's structured startup try | required |
| `mqttTopicTelemetry` | MQTT topic for telemetry messages | required |
| `mqttTopicLog` | MQTT topic for log messages | - |
| `mqttTopicHealth` | MQTT topic for V3 health messages | - |
| `sensorSourceMaxLength` | Max length for source labels (integer, minimum 9 — collision disambiguation appends `-` plus 8 hex characters, so below 9 the configured maximum could not hold; enforced by the schema at startup and in `/write-config`/`/reload-config`) | 30 |
| `sensorSourceValidCharsRegex` | Valid characters for source names. The value is escaped into a negated character class (`[^...]`) at construction, so it must form a valid character class: `-` is the range separator (ranges like `a-z` work), but an out-of-order range (e.g. `z-a`) throws in the `PrometheusWriter` constructor, which runs before index.ts's structured startup try — the schema rejects it via the same `buildSourceValidCharsRegex` helper the writer uses, so `/write-config` cannot persist a value that crash-loops the next restart | a-zA-Z0-9._- |
| `sensorSourceCardinalityCap` | Max distinct source / firmware_version label values admitted as Prometheus labels; overflow maps to a fallback label | 1024 |
| `staleSourceRemovalSecs` | Inactivity threshold (integer seconds, 0 = disabled, max 31536000): when a source has sent no accepted telemetry/health for longer, a sweep timer removes all of its per-source series (readings + `sensor_health_*` + `sensor_last_seen_timestamp_seconds{source}`). Runtime-updatable via `/write-config` and `/reload-config` — the config commit is whole-config, so omitting the key re-disables it. The sweep interval is threshold/2 clamped to 10-60s, so removal lags the threshold by up to one interval. Set it well above the longest expected sensor reporting interval or slow reporters will flap | disabled (0/absent) |
| `forwardSensorLogs` | Forward sensor logs to main logger | true |
| `forwardSensorLogsLevel` | Log level for forwarded sensor logs (error, warn, info, debug, critical) | debug |

## Prometheus Metrics Endpoint

Metrics are exposed at `/metrics` (default: `http://localhost:3301/metrics`).

Also available:
- `/health` — Liveness check endpoint. Returns 200 while the process is responsive, regardless of MQTT state, so the Docker healthcheck does not restart the container on a transient broker outage (the MQTT layer reconnects on its own)
- `/ready` — Readiness check endpoint. Returns 200 (`{ status: "ready" }`) when the MQTT client is connected **and** the broker has acknowledged the configured subscriptions, 503 (`{ status: "degraded" }`) otherwise. Connection alone is not readiness: a broker can grant CONNECT while denying SUBSCRIBE (ACL denial, rejected topic filter), keeping the client "connected" while ingesting nothing — SUBACK failures are logged as `mqtt_subscription_failed` (with the topic) and the response body reports `subscriptions: "active|degraded"` alongside `mqtt: "connected|disconnected"`. For readiness-sensitive orchestration (Kubernetes, load balancing); `/health` remains the liveness signal
- `/metrics` — Prometheus metrics. Includes `mqtt_subscription_active` — a per-topic gauge (label `topic`, 1 = broker acknowledged the subscription, 0 = pending/denied/lost) that is pulled from the MQTT client state at scrape time, so it reflects the same state `/ready` decides on. Metric collection is wrapped in a local try/catch: if a collector throws, the scrape returns `500` (empty body, no internal details) and the service stays up — the rejection is contained rather than escaping to the fatal `unhandledRejection` handler

### Sensor freshness

`sensor_last_seen_timestamp_seconds{source}` — Unix timestamp in seconds of the most recent **accepted** telemetry or health message from the sensor source. "Accepted" means communication, not measurement: a source reporting the same reading repeatedly stays fresh, while a dropped/malformed message does not advance the timestamp. `MqttNetworking` stamps it once per accepted message (never per gauge — a single health message sets 10+ gauges but stamps once); V3 telemetry is stamped only when the device type is recognized and its required fields pass validation — present, finite, **and within the physical range the publisher enforces** (air/water temperature in the supported Fahrenheit range after C→F conversion, humidity and soil moisture 0-100, bme280 pressure present under `pressure_pa`/`pressure_pascal` and non-negative, lux/uv_index non-negative; an out-of-range required reading rejects the whole message with a `telemetry_out_of_range` warning and is treated exactly like a dropped field — no publish, no stamp, no firmware admission). The optional soil `raw` ADC field stays independently skippable; telemetry without a usable `device` is dropped before any stamping; a V3 health message is stamped only when its payload is present and is a JSON object (a non-object payload is rejected with an `mqtt_health_invalid_payload` warning and does not advance the timestamp — the empty object `{}` is still accepted, since the V3 contract defines every health field as optional). The label goes through the same `admitSource()` sanitization/cardinality pipeline as every other sensor metric.

Prometheus/Grafana compute sensor age with:

```promql
time() - sensor_last_seen_timestamp_seconds
```

By default staleness thresholds belong in Prometheus/Grafana alerting, not in this service: the exporter reports the fact (last observed at X) and does **not** expire or remove series from sources that stop reporting — a source that disappears keeps its last values indefinitely. Opt in to in-service removal with `staleSourceRemovalSecs > 0`: a sweep timer (interval = threshold/2, clamped to 10-60s) then removes all 27 per-source series (9 readings + 17 `sensor_health_*` + `sensor_last_seen_timestamp_seconds`) for any source idle strictly past the threshold. On eviction the writer also frees the source's `admittedSources` slot and its label-ownership entry (so a returning sensor is re-admitted normally, long-gone sensors stop consuming `sensorSourceCardinalityCap` slots, and a freed label can be re-claimed by a future source rather than forcing fresh disambiguations), and logs a `stale_source_removed` warning with the source and age. The last-seen series is removed **with** the data gauges rather than retained: eviction frees the source's cardinality slot, so retaining one source-labeled series per evicted source would let source churn accumulate `sensor_last_seen_timestamp_seconds` series without bound and defeat the cap — the staleness signal stays useful until the threshold says the source should go. The fallback labels `unknown` / `unknown_source` are never evicted (evicting a shared label would wipe another source's data), and all counters are untouched. A known limitation: `admittedFirmwareVersions` slots are not freed on eviction — no source→firmware map is tracked, so a permanently-gone source's firmware label keeps its cap slot for the process lifetime.

Every route enforces the verb advertised at `/endpoints`: the read-only routes (`/metrics`, `/health`, `/ready`, `/about`, `/endpoints`) answer only `GET`, and the config routes enforce `GET` (`/read-config`, `/reload-config`) or `POST` (`/write-config`). Unsupported verbs get a `405` with an `Allow` header; `OPTIONS` preflights are answered `204` before method checks.

## Source Label Sanitization

Source names from MQTT payloads are sanitized before being used as Prometheus labels:
0. Non-string values (e.g. a numeric `source` from firmware) are coerced to their string form at extraction in `MqttNetworking` (matching `device` and `firmware_version`), so `123` becomes the usable label `"123"` instead of throwing in `sanitizeSource` and dropping the message
1. Invalid characters are removed (based on `sensor-source-valid-chars-regex`)
2. Names longer than `sensor-source-max-length` are truncated
3. Sources that sanitize to an empty string fall back to the `unknown` label so distinct sources never collide on `source=""`; the first blank/all-invalid source observed is warned once per process (`sensor_source_sanitized`, naming the first raw source seen) — a warn-once latch, because every metric setter resolves the label independently (one health message, 17+ times) and a sustained condition from one misconfigured publisher would otherwise flood the WARN channel; `sensorSourceValidCharsRegex` must be non-empty (the schema rejects `""`, which would otherwise defeat the `??` default and blank every label) and must be constructible via `SystemFunctions.buildSourceValidCharsRegex` (the schema's refine and the `PrometheusWriter` constructor share that one helper, so the escape rule cannot drift between validation and use)
4. Sanitization is lossy, so two *distinct* raw sources can collapse to the same sanitized form (e.g. `soil@1` and `soil#1` → `soil1`, or two names that differ only beyond `sensorSourceMaxLength` after truncation). A label-ownership map (final label → raw source) held in `PrometheusWriter` detects this at admission: the first admitted raw source keeps the plain label, and a *different* raw source that sanitizes to the same form is deterministically disambiguated to `<sanitized>-<suffix>`, where the suffix is the first 8 hex characters of the SHA-256 of the **original** source — stable for the process lifetime, distinct per raw source, and the result still obeys `sensorSourceMaxLength`. Each collision is logged once (on first sighting) as a `sensor_source_collision` warning carrying `originalSource`, `sanitizedSource`, and `finalLabel`. Ownership entries are held in lockstep with `admittedSources` slots and freed by the stale-source sweep, so an evicted source's label can be re-claimed instead of forcing fresh disambiguations. The reserved fallback labels `unknown` / `unknown_source` are never claimed: a real source literally named that way is given a disambiguated label, and only blank (all-invalid) sources share the bare `unknown` fallback

Sanitization bounds each label *value* but not how many distinct values appear, so a distinct-value cap (`sensorSourceCardinalityCap`) bounds cardinality: once the cap is reached, each new distinct source maps to the fixed `unknown_source` fallback label and increments `sensor_sources_rejected_total`, and each new distinct firmware version (admitted in `MqttNetworking.getFirmwareVersion`, which also strips invalid characters and truncates to the source length limit; admission runs only **after** the telemetry's required fields validate, so a rejected/malformed message never consumes a firmware slot) maps to `unknown_firmware` and increments `sensor_firmware_versions_rejected_total`. The source rejection counter counts a stable logical event — one increment per distinct rejected source per rejection episode (a single health message resolves its label 17+ times but counts once), tracked in a bounded dedup set keyed by the resolved label that is cleared at 4× the cap; admission ends an episode, so a source rejected again after cap churn counts again — and the warning fires once per cap. The cap is captured at construction, so changing it requires a restart (it is a `restartOnly` key in `updateConfig`). It limits **concurrently admitted** concrete sources: the shared fallback labels `unknown` / `unknown_source` are not admitted source identities, and firmware-version cardinality is managed independently. When `staleSourceRemovalSecs > 0`, eviction removes the source's entire per-source state (see Sensor freshness) and frees its slot, so source churn cannot accumulate series past the cap.

### Log Value Bounding

The logging path is bounded the same way the label path is. Untrusted, free-form MQTT payload values are length-capped before being written to the log, in **both** the human-readable message text and the structured log metadata, so a malformed or hostile publisher cannot produce disproportionately large log entries. Bounded via `SystemFunctions.truncateForLog` (256 chars; a `…` marks a truncation; short values unchanged; string values pass through as-is and non-string scalars keep their `String()` form, but array values are first structurally bounded by `boundForLog` — depth, item count, per-string length — and JSON-serialized, because plain `String()` on a deeply nested array recurses and throws `RangeError`) and `SystemFunctions.truncateForLogList` (10 elements × 256 chars): `source`, `device`, `message_type`, `degraded_reasons`, and the forwarded sensor-log `message` body, raw `firmware_version`, and every forwarded-log metadata field (`event`, `module`, `function`, `level`, `runtime_id`, `schema_version`, `command_id`, `target`, `targeted`, `response_topic`, `device_ip`, `device_source`). The V3 forwarded-log `data` object is bounded as a *structure* by `SystemFunctions.boundForLog`, which preserves its shape for Loki indexing while capping string values **and object keys** at 256 chars, arrays at 10 elements, objects at 10 properties, and replacing any subtree nested deeper than 8 levels with a `[truncated: max depth]` marker — the depth cap exists because the Logger's redaction pass recurses through the metadata, so an arbitrarily deep payload would otherwise exhaust the call stack per log line. The bounds apply to log output only — metric processing is unchanged and payload objects are not mutated (the bounded values are new strings/objects/arrays, and `degraded_reasons` is re-derived for the log rather than rewritten in place). The same bound is applied to the untrusted **MQTT topic** before it is logged from `on_message` (size-guard, not-object/parse, routing-debug, and handling-error logs); the raw topic stays intact for the case-folded routing comparisons. The unmatched-route `route_not_found` audit log bounds `req.url` the same way, so an unauthenticated 404 probe with an arbitrarily long path cannot bloat the log line.

## Graceful Shutdown

The service handles SIGTERM and SIGINT signals gracefully. The handlers are registered in `index.ts` **before** the startup wait for the Prometheus server to become ready, so a stop signal arriving during that startup window (up to 5 s) is routed through the graceful close path rather than the platform's default immediate termination; `networking` and the logger are already constructed by that point, so no nullable lifecycle state is needed. The readiness wait is shutdown-aware: it bails out the instant a shutdown is in flight (an operator stop signal or a fatal error) and defers to the close path, which owns the exit — so a stop landing in that window is never misreported as a `prometheus_startup_failed` startup crash (exit 1) that would mask a clean stop (exit 0). `MqttNetworking.close(timeout)` applies a **single deadline to the entire close path**, not per phase: the Prometheus HTTP drain and the MQTT disconnect share one budget, so `close(5000)` settles within roughly 5 seconds of the shutdown signal. This matters because `server.close` resolves only once existing connections have finished (idle keep-alive sockets are reaped by Node's `keepAliveTimeout`) — an incomplete in-flight request (e.g. a stuck `/write-config` body) would otherwise hold the drain open indefinitely, making the configured timeout mean "unbounded HTTP drain + 5 s of MQTT shutdown" and letting orchestrators escalate to SIGKILL:
1. Shuts down the Prometheus server (stop accepting new connections, drain existing ones), bounded by the shared deadline — if the drain outlives it, the wait is abandoned (the process is about to exit anyway; the drain finishes in the background) and a `prometheus_server_close_timeout` error is logged
2. Closes the MQTT connection with whatever time the drain left on the deadline — if the deadline is already exhausted, a forced `end(true)` DISCONNECT is sent best-effort without waiting (`mqtt_close_forced_deadline_exhausted`)
3. Logs uptime statistics

The `shutdown_initiated` log is written **inside** the shutdown's try, so a logging failure there cannot skip the `finally` that owns `process.exit` — a stop always terminates. Shutdown is idempotent: a repeated signal during an in-flight close is ignored (the networking close promise is cached, and the Prometheus writer's close is idempotent — a second call resolves immediately). The service tracks the worst exit code seen, so a fatal error (`uncaughtException`/`unhandledRejection`) — whether it starts the shutdown or lands during an in-flight one — exits with code 1 and is never masked as a clean 0, letting orchestrators distinguish a crash from an operator-initiated stop.

The MQTT disconnect is classified by intent: `perform_close` sets a `closing` flag before initiating shutdown (so it cannot race the async `close` event), and `on_disconnect` logs an **intentional** stop (SIGTERM/SIGINT, a deploy restart, a container stop) at INFO as `mqtt_disconnected` rather than a WARN that would read as an outage in the logs; only an **unexpected** transport close logs the WARN. Both paths run the same subscription-state reset.

MQTT client `error` events are classified by the actual connection state: an error while the client is **connected** (a failed publish, a mid-stream protocol error) is logged as an `mqtt_client_error` ERROR and is NOT counted as a connection failure — it cannot consume the first-failure ERROR slot of the next real outage (which would otherwise re-enter as a mere "attempt 2" WARN). Errors while **not connected** tier as connection failures: the first failure of an outage is a full `mqtt_connection_error` ERROR carrying the error object, each subsequent mqtt.js retry is a `mqtt_reconnect_failed` WARN with the attempt count, and a successful connect logs an `mqtt_reconnected` INFO and resets the counter.

## Building & Deployment

### Local Build

```bash
npm run build
cd dist
node index.js
```

### Docker

```bash
docker build -t sensor-telemetry .
docker run -p 3301:3301 sensor-telemetry
```

### Docker Compose

See `docker-compose.yml` for the production deployment configuration.

## Project Structure

```
src/
├── common/
│   └── global.ts          # Global state, logger singleton, about info
├── dodsonlabs/            # Core service modules
│   ├── Interfaces.ts      # Type definitions
│   ├── Logger.ts          # Winston wrapper
│   ├── MqttNetworking.ts  # MQTT + Prometheus integration
│   ├── PrometheusWriter.ts # Prometheus metric management
│   └── SystemFunctions.ts # Utilities
└── schemas/
    └── config.ts          # Zod config validation

tests/
└── __tests__/             # Jest suites (ts-jest, CommonJS via tsconfig.jest.json)
    ├── dodsonlabs/        # MqttNetworking, PrometheusWriter, Logger, SystemFunctions
    └── schemas/           # config schema validation
```

## Dependencies

- **mqtt** (^5.14.1) — MQTT client library
- **prom-client** (^15.1.3) — Prometheus metrics collection
- **js-yaml** (^4.2.0) — YAML parsing
- **zod** (^4.4.3) — Schema validation
- **winston** (^3.17.0) — Logging framework

## License

MIT License with Patent Grant.
