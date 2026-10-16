# Sensor Telemetry Services — Architecture

This document describes the architecture, components, interfaces, and data flows of the Sensor Telemetry Services.
It serves as the authoritative reference for the system's structure, dependencies, and design boundaries.

---

## System overview

Node.js 22 / TypeScript service: MQTT V3 sensor messages → validation and routing → Prometheus metric families; sensor logs → Winston console and optional Loki transport. An HTTP server exposes metrics, liveness/readiness, service metadata and configuration operations. See `README.md` for operator-facing payload examples and metrics lists.

```text
MQTT broker (telemetry / health / log exact topics)
  → MqttNetworking (JSON validation, routing, rejection accounting)
      → PrometheusWriter (gauges, counters, label identity, stale eviction)
          → HTTP /metrics, /health, /ready, /about, /endpoints,
                 /read-config, /write-config, /reload-config,
                 /restart-service (opt-in; requests a shutdown, never owns it)
      → Logger (redacted structured logs)
          → console; optional LokiTransport → Loki push API
config.yml → Zod schema → startup; write/reload → runtime config update
env (SENSOR_TELEMETRY_RESTART_*) → index.ts restart callback → SIGTERM
```

## Source ownership

| File | Responsibility |
| --- | --- |
| `code/src/index.ts` | Configuration/bootstrap, fatal handlers, startup readiness wait, ordered shutdown; owns the `/restart-service` lifecycle callback (self-SIGTERM). |
| `code/src/dodsonlabs/MqttNetworking.ts` | MQTT connect/reconnect/SUBACK tracking, V3 message routing, payload rejection, runtime configuration coordination; threads the restart callback to the writer. |
| `code/src/dodsonlabs/PrometheusWriter.ts` | Metrics registry and gauge updates, bounded labels, stale-series removal, HTTP endpoints and configuration API, `/restart-service` (enablement, token, single-flight, response-before-shutdown). Constructor starts HTTP server. |
| `code/src/dodsonlabs/SystemFunctions.ts` | Typed field reads, telemetry range table, bounded log serialization, throttling, YAML I/O and source-label regex helpers. |
| `code/src/dodsonlabs/Interfaces.ts` | Cross-module contracts including untrusted `JsonObject` and fixed MQTT drop reasons. |
| `code/src/dodsonlabs/Logger.ts` | Winston logging, metadata redaction, optional Loki transport lifecycle. |
| `code/src/dodsonlabs/LokiTransport.ts` | Buffered Loki JSON push, backpressure bounds, direct-console failure reporting and shutdown drain. |
| `code/src/schemas/config.ts` | Strict Zod config validation shared by startup/write/reload. |
| `code/src/common/global.ts`, `code/src/version.ts` | Service identity, logger construction, release metadata. |

## Message pipeline

Messages larger than 64 KiB are rejected before JSON parsing; payload roots must be JSON objects. Topics are compared case-insensitively against distinct, exact configured topics, prioritizing log, then health, then the telemetry route. V3 telemetry uses the `device` discriminator: `bme280`/`sht35` → air; `ds18b20` → water; `ltr390` → light; `yl69_fc28`/`plantmate_soil` → soil. Unknown devices are rejected rather than guessed. Physical readings are validated against `TELEMETRY_FIELD_RANGES` and converted as specified by their consumers.

Accepted sensor traffic updates readings/health and last-seen communication timestamps. The service also exposes MQTT connection/reconnection, pipeline acceptance/drop, HTTP request, process and standard Node.js runtime metrics. Drop counters count each event independently of log throttling. Metric types, names and implementation live in `PrometheusWriter.ts`.

## Identity and lifecycle

`PrometheusWriter` normalizes source and firmware-version label values, disambiguates lossy collisions with an eight-hex-character SHA-256 suffix, and caps cardinality with reserved fallback labels and rejection counters. If `staleSourceRemovalSecs > 0`, a timer removes idle source series and releases admission slots; fallback series are never evicted. When unset or zero, historical series remain until process restart.

`/health` means the HTTP process responds; `/ready` requires both MQTT connectivity and acknowledged subscriptions. `code/src/index.ts` registers signal and fatal handlers before constructing networking, performs a bounded graceful shutdown, closes networking/HTTP before flushing the logger's Loki transport, and preserves fatal exit status.

`/restart-service` inverts that direction deliberately: the HTTP layer *requests* a restart through a one-shot callback injected from `index.ts` (via `MqttNetworking`), and `index.ts` — the process owner — self-signals SIGTERM so the restart reuses the identical graceful path as an operator `docker stop`. The writer answers `202` only after the response is flushed (with a bounded fallback when the client disconnects first), fires the callback at most once per process, and fails startup when enabled without a token.

## Deployment boundaries

`code/Dockerfile` runs the service as uid 1000 and does not bake deployment configuration into the runtime image; the directory mounted at `/app/configs` must be writable for atomic config replacement. `code/docker-compose.yml` exposes 32002. Configuration validation is in `code/src/schemas/config.ts`; deployment and environment behavior are documented in [CONFIGURATION.md](CONFIGURATION.md).
