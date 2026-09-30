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

Unknown device types are dropped with a warning. V2 section-based payloads (`payload.air`, `payload.water`, ...) are still accepted and take the legacy path. V3 health messages (`iot/v3/health` or `message_type: "health"`) populate the system-info gauges plus `sensor_health_up`, `sensor_health_uptime_seconds`, and the v4 health gauges (`sensor_health_heap_min_free_bytes`, `sensor_health_devices_active`, `sensor_health_devices_configured`, `sensor_health_network_stack_ready`, `sensor_health_wifi_connected`, `sensor_health_mqtt_connected`, `sensor_health_core_1_active`, `sensor_health_outbound_queue_depth`, `sensor_health_outbound_evicted`, `sensor_health_outbound_rejected`, `sensor_health_utc_valid`, `sensor_health_utc_sync_age_sec`). A non-empty `degraded_reasons` array is logged as a `v3_health_degraded` warning (not published as a metric). All health/diagnostic metrics (including the system-info gauges `sensor_health_cpu_temperature_c`, `sensor_health_heap_free_bytes`, `sensor_health_heap_used_percent`, `sensor_health_read_failures_total`, `sensor_health_read_counter_total`, and `sensor_health_wifi_rssi_dbm`) share the `sensor_health_` prefix; physical sensor readings do not.

### Configuration

- **config.yml** (project root) — Single source of truth for runtime configuration (YAML). Copied to `dist/` by `npm run build`. At startup the service tries `CONFIG_FILE_CANDIDATES` in order: `/app/configs/config.yml` (Docker mount — the container does not ship the file in the image, see docker-compose.yml), `./dist/config.yml` (build output), then `./config.yml` (repo root). Fallback continues only past *missing* files: a candidate that exists but is unreadable, unparseable, or empty fails startup immediately (naming the offending file) instead of silently booting on a stale earlier snapshot.
- **schemas/config.ts** — Zod schema for configuration validation
- **SENSOR_TELEMETRY_CONFIG_TOKEN** (env var) — Optional shared secret protecting `/write-config` and `/reload-config`. When set, requests must carry a matching `x-config-token` header (constant-time compare); when unset the endpoints remain open and a warning is logged at startup.

## Supported Sensor Types

| Metric | Description |
|--------|-------------|
| Air_Temperature | Temperature in Fahrenheit |
| Air_Humidity | Humidity percentage |
| Air_Pressure | Air pressure in in/Hg |
| Air_Altitude | Barometric altitude in feet (bme280 only) |
| Soil_Moisture_Percent | Soil moisture percentage (0-100) |
| Soil_Moisture_Raw | Raw 16-bit soil moisture ADC reading |
| Light_UV_Index | UV Index |
| Light_LUX | Light level in LUX |
| Rain_In_H2O | Rain accumulation in inches |
| Wind_Speed | Wind speed in mph |
| Wind_Gusts | Wind gusts in mph |
| Water_Temperature | Water temperature in Fahrenheit |
| Lightning | Lightning strike count |

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
| `mqttBrokerIpAddress` | MQTT broker hostname/IP | required |
| `mqttTopicTelemetry` | MQTT topic for telemetry messages | required |
| `mqttTopicLog` | MQTT topic for log messages | - |
| `mqttTopicHealth` | MQTT topic for V3 health messages | - |
| `sensorSourceMaxLength` | Max length for source labels | 30 |
| `sensorSourceValidCharsRegex` | Valid characters for source names | a-zA-Z0-9._- |
| `forwardSensorLogs` | Forward sensor logs to main logger | true |
| `forwardSensorLogsLevel` | Log level for forwarded sensor logs (error, warn, info, debug, critical) | info |

## Prometheus Metrics Endpoint

Metrics are exposed at `/metrics` (default: `http://localhost:3301/metrics`).

Also available:
- `/health` — Liveness check endpoint. Returns 200 while the process is responsive, regardless of MQTT state, so the Docker healthcheck does not restart the container on a transient broker outage (the MQTT layer reconnects on its own)
- `/ready` — Readiness check endpoint. Returns 200 (`{ status: "ready" }`) when the MQTT client is connected and 503 (`{ status: "degraded" }`) otherwise. For readiness-sensitive orchestration (Kubernetes, load balancing); `/health` remains the liveness signal
- `/metrics` — Prometheus metrics

## Source Label Sanitization

Source names from MQTT payloads are sanitized before being used as Prometheus labels:
1. Invalid characters are removed (based on `sensor-source-valid-chars-regex`)
2. Names longer than `sensor-source-max-length` are truncated
3. Sources that sanitize to an empty string fall back to the `unknown` label so distinct sources never collide on `source=""`; `sensorSourceValidCharsRegex` must be non-empty (the schema rejects `""`, which would otherwise defeat the `??` default and blank every label)

## Graceful Shutdown

The service handles SIGTERM and SIGINT signals gracefully:
1. Stops accepting new MQTT messages
2. Closes MQTT connection with configurable timeout
3. Shuts down Prometheus server
4. Logs uptime statistics

Shutdown is idempotent: a repeated signal during an in-flight close is ignored (the MQTT close promise and HTTP server close are cached), and fatal errors (`uncaughtException`/`unhandledRejection`) exit with code 1 so orchestrators can distinguish a crash from a clean stop.

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
