# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Overview

A Node.js service that listens on MQTT channels for sensor telemetry data and publishes it to Prometheus metrics.

## Architecture

### Key Components

- **MqttNetworking** (`src/dodsonlabs/MqttNetworking.ts`) — MQTT client and Prometheus writer integration
- **PrometheusWriter** (`src/dodsonlabs/PrometheusWriter.ts`) — Prometheus metric registration and HTTP server
- **Logger** (`src/dodsonlabs/Logger.ts`) — Winston-based logging abstraction
- **SystemFunctions** (`src/dodsonlabs/SystemFunctions.ts`) — File I/O, error handling, formatting utilities
- **Interfaces** (`src/dodsonlabs/Interfaces.ts`) — Type definitions for the service

### Entry Point

- **index.ts** (`src/index.ts`) — Main entry point with config loading, shutdown handling, and signal trapping

### V3 Message Format (per-device telemetry)

V3 telemetry messages are per-device rather than per-section: each carries a top-level `device` field and a `payload` with only that device's readings. `MqttNetworking` maps known device types to the metric category they feed:

| V3 device | Metric category | Payload fields |
|-----------|-----------------|----------------|
| `bme280` | air | `temperature_c`, `humidity_percent`, `pressure_pa`, `altitude_m` (nullable — null when adjusted pressure is non-positive) |
| `sht35` | air | `temperature_c`, `humidity_percent` (no pressure sensor — pressure gauge is left untouched) |
| `ds18b20` | water | `temperature_c` |
| `ltr390` | light | `lux`, `uv_index` (+ `als_raw`, `uv_raw`, not published) |
| `yl69_fc28` | soil | `relative_moisture_percent`, `raw` (+ `digital_state`, nullable, not published) |
| `plantmate_soil` | soil | `relative_moisture_percent`, `raw` |

Unknown device types are dropped with a warning. V2 section-based payloads (`payload.air`, `payload.water`, ...) are still accepted and take the legacy path. V3 health messages (`iot/v3/health` or `message_type: "health"`) populate the system-info gauges plus `sensor_health_up`, `sensor_health_uptime_seconds`, and the v4 health gauges (`sensor_health_heap_min_free_bytes`, `sensor_health_devices_active`, `sensor_health_devices_configured`, `sensor_health_network_stack_ready`, `sensor_health_wifi_connected`, `sensor_health_mqtt_connected`, `sensor_health_core_1_active`, `sensor_health_outbound_queue_depth`, `sensor_health_outbound_evicted`, `sensor_health_outbound_rejected`, `sensor_health_utc_valid`, `sensor_health_utc_sync_age_sec`). A non-empty `degraded_reasons` array is logged as a `v3_health_degraded` warning (not published as a metric). All health/diagnostic metrics (including the system-info gauges `sensor_health_cpu_temperature_c`, `sensor_health_heap_free_bytes`, `sensor_health_heap_used_percent`, `sensor_health_read_failure_count`, `sensor_health_read_count`, and `sensor_health_wifi_rssi_dbm`) share the `sensor_health_` prefix; physical sensor readings do not.

### Configuration

- **config.yml** (project root) — Single source of truth for runtime configuration (YAML). Copied to `dist/` by `npm run build`. At startup the service tries `CONFIG_FILE_CANDIDATES` in order: `/app/configs/config.yml` (Docker mount — the container does not ship the file in the image, see docker-compose.yml), `./dist/config.yml` (build output), then `./config.yml` (repo root). Fallback continues only past *missing* files: a candidate that exists but is unreadable, unparseable, or empty fails startup immediately (naming the offending file) instead of silently booting on a stale earlier snapshot.
- **schemas/config.ts** — Zod schema for configuration validation. The schema is strict: unknown keys (e.g. a misspelled optional key like `forwardSensorLog`) fail validation with an `Unrecognized key` error instead of being silently discarded — the same schema is used at startup, `/write-config`, and `/reload-config`, so all three enforce the identical shape. It also enforces that the three MQTT topics (`mqttTopicTelemetry`, `mqttTopicLog`, `mqttTopicHealth`) are unique when compared case-insensitively: `MqttNetworking.on_message` routes topics case-insensitively (log before health, both before the telemetry fallback), while MQTT itself is case-sensitive, so two configured topics that collapse under case folding (including exact duplicates) are distinct to the broker but identical to the router, and one would silently shadow the other
- **SENSOR_TELEMETRY_CONFIG_TOKEN** (env var) — Optional shared secret protecting `/write-config` and `/reload-config`. When set, requests must carry a matching `x-config-token` header (constant-time compare); when unset the endpoints remain open and a warning is logged at startup.
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
| rain_in_h2o | Rain accumulation in inches |
| wind_speed | Wind speed in mph |
| wind_gusts | Wind gusts in mph |
| water_temperature | Water temperature in Fahrenheit |
| lightning_strike_count | Lightning strike count |

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
| `apiPort` | Port for Prometheus metrics endpoint | required |
| `mqttBrokerIpAddress` | MQTT broker address — host, IP, or bracketed IPv6 literal, each with an optional `:port` (1-65535); no scheme (`mqtt://`) — the value is appended to `mqtt://` in `MqttNetworking`. Validated at config load because an unparseable value (e.g. out-of-range port) would otherwise throw synchronously from `mqtt.connect` inside the `MqttNetworking` constructor, which runs before index.ts's structured startup try | required |
| `mqttTopicTelemetry` | MQTT topic for telemetry messages | required |
| `mqttTopicLog` | MQTT topic for log messages | - |
| `mqttTopicHealth` | MQTT topic for V3 health messages | - |
| `sensorSourceMaxLength` | Max length for source labels | 30 |
| `sensorSourceValidCharsRegex` | Valid characters for source names. The value is escaped into a negated character class (`[^...]`) at construction, so it must form a valid character class: `-` is the range separator (ranges like `a-z` work), but an out-of-order range (e.g. `z-a`) throws in the `PrometheusWriter` constructor, which runs before index.ts's structured startup try — the schema rejects it via the same `buildSourceValidCharsRegex` helper the writer uses, so `/write-config` cannot persist a value that crash-loops the next restart | a-zA-Z0-9._- |
| `sensorSourceCardinalityCap` | Max distinct source / firmware_version label values admitted as Prometheus labels; overflow maps to a fallback label | 1024 |
| `forwardSensorLogs` | Forward sensor logs to main logger | true |
| `forwardSensorLogsLevel` | Log level for forwarded sensor logs (error, warn, info, debug, critical) | info |

## Prometheus Metrics Endpoint

Metrics are exposed at `/metrics` (default: `http://localhost:3301/metrics`).

Also available:
- `/health` — Liveness check endpoint. Returns 200 while the process is responsive, regardless of MQTT state, so the Docker healthcheck does not restart the container on a transient broker outage (the MQTT layer reconnects on its own)
- `/ready` — Readiness check endpoint. Returns 200 (`{ status: "ready" }`) when the MQTT client is connected **and** the broker has acknowledged the configured subscriptions, 503 (`{ status: "degraded" }`) otherwise. Connection alone is not readiness: a broker can grant CONNECT while denying SUBSCRIBE (ACL denial, rejected topic filter), keeping the client "connected" while ingesting nothing — SUBACK failures are logged as `mqtt_subscription_failed` (with the topic) and the response body reports `subscriptions: "active|degraded"` alongside `mqtt: "connected|disconnected"`. For readiness-sensitive orchestration (Kubernetes, load balancing); `/health` remains the liveness signal
- `/metrics` — Prometheus metrics. Includes `mqtt_subscription_active` — a per-topic gauge (label `topic`, 1 = broker acknowledged the subscription, 0 = pending/denied/lost) that is pulled from the MQTT client state at scrape time, so it reflects the same state `/ready` decides on

### Sensor freshness

`sensor_last_seen_timestamp_seconds{source}` — Unix timestamp in seconds of the most recent **accepted** telemetry or health message from the sensor source. "Accepted" means communication, not measurement: a source reporting the same reading repeatedly stays fresh, while a dropped/malformed message does not advance the timestamp. `MqttNetworking` stamps it once per accepted message (never per gauge — a single health message sets 10+ gauges but stamps once); V3 telemetry is stamped only when the device type is recognized and its required fields pass validation, and V2 telemetry when the message carries at least one recognized section. The label goes through the same `admitSource()` sanitization/cardinality pipeline as every other sensor metric.

Prometheus/Grafana compute sensor age with:

```promql
time() - sensor_last_seen_timestamp_seconds
```

Staleness thresholds belong in Prometheus/Grafana alerting, not in this service: the exporter reports the fact (last observed at X) and deliberately does **not** expire or remove series from sources that stop reporting — a source that disappears keeps its last values indefinitely.

Every route enforces the verb advertised at `/endpoints`: the read-only routes (`/metrics`, `/health`, `/ready`, `/about`, `/endpoints`) answer only `GET`, and the config routes enforce `GET` (`/read-config`, `/reload-config`) or `POST` (`/write-config`). Unsupported verbs get a `405` with an `Allow` header; `OPTIONS` preflights are answered `204` before method checks.

## Source Label Sanitization

Source names from MQTT payloads are sanitized before being used as Prometheus labels:
0. Non-string values (e.g. a numeric `source` from firmware) are coerced to their string form at extraction in `MqttNetworking` (matching `device` and `firmware_version`), so `123` becomes the usable label `"123"` instead of throwing in `sanitizeSource` and dropping the message
1. Invalid characters are removed (based on `sensor-source-valid-chars-regex`)
2. Names longer than `sensor-source-max-length` are truncated
3. Sources that sanitize to an empty string fall back to the `unknown` label so distinct sources never collide on `source=""`; `sensorSourceValidCharsRegex` must be non-empty (the schema rejects `""`, which would otherwise defeat the `??` default and blank every label) and must be constructible via `SystemFunctions.buildSourceValidCharsRegex` (the schema's refine and the `PrometheusWriter` constructor share that one helper, so the escape rule cannot drift between validation and use)

Sanitization bounds each label *value* but not how many distinct values appear, so a distinct-value cap (`sensorSourceCardinalityCap`) bounds cardinality: once the cap is reached, each new distinct source maps to the fixed `unknown_source` fallback label and increments `sensor_sources_rejected_total`, and each new distinct firmware version (admitted in `MqttNetworking.getFirmwareVersion`, which also strips invalid characters and truncates to the source length limit) maps to `unknown_firmware` and increments `sensor_firmware_versions_rejected_total`. Each rejection is counted; the warning fires once per cap. The cap is captured at construction, so changing it requires a restart (it is a `restartOnly` key in `updateConfig`).

## Graceful Shutdown

The service handles SIGTERM and SIGINT signals gracefully. `MqttNetworking.close(timeout)` applies a **single deadline to the entire close path**, not per phase: the Prometheus HTTP drain and the MQTT disconnect share one budget, so `close(5000)` settles within roughly 5 seconds of the shutdown signal. This matters because `server.close` resolves only once existing connections have finished (idle keep-alive sockets are reaped by Node's `keepAliveTimeout`) — an incomplete in-flight request (e.g. a stuck `/write-config` body) would otherwise hold the drain open indefinitely, making the configured timeout mean "unbounded HTTP drain + 5 s of MQTT shutdown" and letting orchestrators escalate to SIGKILL:
1. Shuts down the Prometheus server (stop accepting new connections, drain existing ones), bounded by the shared deadline — if the drain outlives it, the wait is abandoned (the process is about to exit anyway; the drain finishes in the background) and a `prometheus_server_close_timeout` error is logged
2. Closes the MQTT connection with whatever time the drain left on the deadline — if the deadline is already exhausted, a forced `end(true)` DISCONNECT is sent best-effort without waiting (`mqtt_close_forced_deadline_exhausted`)
3. Logs uptime statistics

Shutdown is idempotent: a repeated signal during an in-flight close is ignored (the networking close promise is cached, and the Prometheus writer's close is idempotent — a second call resolves immediately). The service tracks the worst exit code seen, so a fatal error (`uncaughtException`/`unhandledRejection`) — whether it starts the shutdown or lands during an in-flight one — exits with code 1 and is never masked as a clean 0, letting orchestrators distinguish a crash from an operator-initiated stop.

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
