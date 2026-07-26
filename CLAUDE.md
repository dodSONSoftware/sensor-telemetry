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

### Configuration

- **config.yml** — Runtime configuration (YAML format)
- **schemas/config.ts** — Zod schema for configuration validation

## Supported Sensor Types

| Metric | Description |
|--------|-------------|
| Air_Temperature | Temperature in Fahrenheit |
| Air_Humidity | Humidity percentage |
| Air_Pressure | Air pressure in in/Hg |
| Light_UV_Index | UV Index |
| Light_LUX | Light level in LUX |
| Rain_In_H2O | Rain accumulation in inches |
| Wind_Speed | Wind speed in mph |
| Wind_Gusts | Wind gusts in mph |
| Water_Temperature | Water temperature in Fahrenheit |
| Lightning | Lightning strike count |

## Commands

```bash
npm run build     # Compile TypeScript
npm start         # Run production service
npm run dev       # Development mode with ts-node
npm run lint      # Run ESLint
```

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `logLevel` | Logging verbosity (error, warn, info, debug) | info |
| `prometheusPort` | Port for Prometheus metrics endpoint | 3301 |
| `mqttBrokerIpAddress` | MQTT broker hostname/IP | required |
| `mqttTopicTelemetry` | MQTT topic for telemetry messages | required |
| `sensorSourceMaxLength` | Max length for source labels | 30 |
| `sensorSourceValidCharsRegex` | Valid characters for source names | a-zA-Z0-9._- |
| `forwardSensorLogs` | Forward sensor logs to main logger | false |
| `forwardSensorLogsLevel` | Log level for forwarded sensor logs | info |

## Prometheus Metrics Endpoint

Metrics are exposed at `/metrics` (default: `http://localhost:3301/metrics`).

Also available:
- `/health` — Health check endpoint
- `/metrics` — Prometheus metrics

## Source Label Sanitization

Source names from MQTT payloads are sanitized before being used as Prometheus labels:
1. Invalid characters are removed (based on `sensor-source-valid-chars-regex`)
2. Names longer than `sensor-source-max-length` are truncated

## Graceful Shutdown

The service handles SIGTERM and SIGINT signals gracefully:
1. Stops accepting new MQTT messages
2. Closes MQTT connection with configurable timeout
3. Shuts down Prometheus server
4. Logs uptime statistics

## Building & Deployment

### Local Build

```bash
npm run build
cp src/config.yml ./dist/
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
```

## Dependencies

- **mqtt** (^5.14.1) — MQTT client library
- **prom-client** (^15.1.3) — Prometheus metrics collection
- **js-yaml** (^4.2.0) — YAML parsing
- **zod** (^4.4.3) — Schema validation
- **winston** (^3.17.0) — Logging framework

## License

MIT License with Patent Grant.
