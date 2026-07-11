# Sensor Telemetry Service

A lightweight Node.js service that listens on MQTT channels for sensor telemetry data and publishes it to Prometheus metrics.

## Overview

This service:
- Connects to an MQTT broker to receive sensor telemetry messages
- Parses telemetry payloads (air, light, rain, wind, water, lightning)
- Exposes Prometheus-compatible metrics on HTTP `/metrics` endpoint
- Runs standalone or in Docker containers

## Prerequisites

- Node.js 22.x
- MQTT broker (e.g., Mosquitto, EMQX)
- Prometheus server for scraping metrics

## Configuration

Create a `config.yml` file:

```yaml
log-level: debug
prometheus-port: 3301
mqtt-broker-ip-address: "10.10.10.64"
mqtt-topic-telemetry: "iot/telemetry"
sensor-source-max-length: 30
sensor-source-valid-chars-regex: "a-zA-Z0-9._-"
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `log-level` | Logging verbosity (error, warn, info, debug) | info |
| `prometheus-port` | Port for Prometheus metrics endpoint | 3301 |
| `mqtt-broker-ip-address` | MQTT broker hostname/IP | required |
| `mqtt-topic-telemetry` | MQTT topic for telemetry messages | required |
| `mqtt-topic-command` | MQTT topic for command responses | iot/v2/command |
| `mqtt-topic-command-response` | MQTT topic for command responses | iot/v2/command-response |
| `sensor-source-max-length` | Max length for source labels | 30 |
| `sensor-source-valid-chars-regex` | Valid characters for source names | a-zA-Z0-9._- |

## Building

```bash
npm install
npm run build
```

## Running Locally

```bash
cp src/config.yml ./dist/
cd dist
node index.js
```

## Docker Deployment

### Build Image

```bash
docker build -t sensor-telemetry .
```

### Run Container

```bash
docker run -d \
  --name sensor-telemetry \
  -p 3301:3301 \
  -v /mnt/sensor-telemetry/config.yml:/app/configs/config.yml:ro \
  sensor-telemetry
```

### With docker-compose

```yaml
version: "3.8"

services:
  sensor-telemetry:
    image: sensor-telemetry:latest
    container_name: sensor-telemetry
    ports:
      - "3301:3301"
    volumes:
      - /mnt/sensor-telemetry/config.yml:/app/configs/config.yml:ro
    restart: unless-stopped
```

## Prometheus Metrics

Metrics are exposed at `http://localhost:3301/metrics`:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `Air_Temperature` | Gauge | source | Temperature in Fahrenheit |
| `Air_Humidity` | Gauge | source | Humidity percentage |
| `Air_Pressure` | Gauge | source | Air pressure in in/Hg |
| `Light_UV_Index` | Gauge | source | UV Index |
| `Light_LUX` | Gauge | source | Light level in LUX |
| `Rain_In_H2O` | Gauge | source | Rain accumulation in inches |
| `Wind_Speed` | Gauge | source | Wind speed in mph |
| `Wind_Gusts` | Gauge | source | Wind gusts in mph |
| `Water_Temperature` | Gauge | source | Water temperature in Fahrenheit |
| `Lightning` | Gauge | source | Lightning strike count |
| `telemetry_messages_total` | Counter | source_type | Total telemetry messages by type |

## Source Label Sanitization

Source names are sanitized before being used as Prometheus labels:
1. Invalid characters are removed (based on `sensor-source-valid-chars-regex`)
2. Names longer than `sensor-source-max-length` are truncated

## Graceful Shutdown

The service handles SIGTERM and SIGINT signals gracefully:
1. Stops accepting new MQTT messages
2. Closes MQTT connection with timeout
3. Shuts down Prometheus server
4. Logs uptime statistics

## License

MIT License with Patent Grant.
