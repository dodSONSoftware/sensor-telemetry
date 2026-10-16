# Sensor Telemetry Services — Configuration

This document describes the configuration settings, defaults, constraints, and validation rules for the Sensor Telemetry Services.
It serves as the authoritative reference for configuring and maintaining consistent system behavior.

---

## Sources and validation

Startup checks `/app/configs/config.yml`, `./config.yml`, then `./dist/config.yml` in order (`CONFIG_FILE_CANDIDATES`); the relative candidates resolve against the working directory, so run the service from `code/` in development. An existing but unreadable or malformed higher-priority file fails startup; it is not silently bypassed. Startup, `POST /write-config`, and `GET /reload-config` share the strict Zod `configSchema` (`code/src/schemas/config.ts`): missing required keys, unknown keys, wrong types and invalid bounds are errors. `code/config.yml` in this repository is an example of deployment-specific values, **not** a collection of universal defaults.

## YAML keys

| Key | Requirement / default | Constraints / behavior |
| --- | --- | --- |
| `logLevel` | Required | `error`, `warn`, `info`, `debug`, `critical`. |
| `apiPort` | Required | Integer 1–65535; deployment manifests hardcode 32002. |
| `mqttBrokerIpAddress` | Required | Host/IP, optional `:port`; IPv6 bracketed; no `mqtt://` scheme. |
| `mqttTopicTelemetry` | Required | Exact topic, no `+` or `#` wildcards. |
| `mqttTopicLog`, `mqttTopicHealth` | Optional | Exact topics. All supplied topics unique case-insensitively. |
| `sensorSourceMaxLength` | Optional; 30 | Integer ≥9; collision suffix requires nine characters. |
| `sensorSourceValidCharsRegex` | Optional; `a-zA-Z0-9._-` | Must construct a valid regex character class. |
| `sensorSourceCardinalityCap` | Optional; 1024 | Positive integer; limits distinct source/firmware label identities. |
| `staleSourceRemovalSecs` | Optional; disabled (0) | Integer 0–31536000; positive values enable source eviction after inactivity. |
| `forwardSensorLogs` | Optional; true | Boolean. |
| `forwardSensorLogsLevel` | Optional; debug | Same level enum as `logLevel`. |
| `lokiUrl` | Optional; console-only | Absolute HTTP(S) base URL; application appends `/loki/api/v1/push`. |

Defaults listed above reflect code paths in `PrometheusWriter.ts` and routing, not automatically inserted keys by Zod. A stale-source sweep runs at roughly half the inactivity threshold, clamped to 10–60 s; eviction is consequently not instantaneous.

## Runtime versus restart

**Applied immediately:** `logLevel`, `forwardSensorLogs`, `forwardSensorLogsLevel`, `staleSourceRemovalSecs`.

**Requires restart:** `mqttBrokerIpAddress`, `mqttTopicTelemetry`, `mqttTopicLog`, `mqttTopicHealth`, `apiPort`, `sensorSourceMaxLength`, `sensorSourceValidCharsRegex`, `sensorSourceCardinalityCap`, `lokiUrl`. Writes persist these keys but do not reconstruct existing clients, metric registry or Loki transport. Restart-only comparisons coalesce optional label settings with their effective defaults to avoid false positives.

## HTTP configuration API and security

`GET /read-config`, `POST /write-config`, `GET /reload-config` share token protection when `SENSOR_TELEMETRY_CONFIG_TOKEN` is set: send it in `x-config-token`; compare in constant time. If unset, these routes are exposed without authentication and startup warns. `SENSOR_TELEMETRY_CORS_ORIGINS` is a comma-separated allowlist of exact origins; unset or `*` permits all origins. **CORS is not authentication.** The write endpoint validates and atomically persists YAML via temporary file + rename; reload validates disk configuration without writing it. Audits record key names and bounded client attributes, not secrets or bodies.

## Restart endpoint (`POST /restart-service`)

The endpoint is **strict opt-in**: active only when `SENSOR_TELEMETRY_RESTART_ENABLED` is exactly `true` **and** `SENSOR_TELEMETRY_RESTART_TOKEN` is non-empty. The flag parses strictly — `yes`, `1`, `TRUE` all read as disabled — so a typo can only disable the feature, never enable it. Unlike the config token, enabled-without-token does **not** fail open: the service **refuses to start** (exit 1) rather than expose an unauthenticated process-restart endpoint, and the restart token is a distinct secret — `SENSOR_TELEMETRY_CONFIG_TOKEN` is never accepted for it.

An authenticated POST with an empty body answers `202` (`{"success":true,"status":"restart_scheduled","message":"Service restart requested"}`); **after** the response is delivered, the service runs the existing graceful SIGTERM shutdown (MQTT disconnect, HTTP drain, Loki flush, clean exit 0), and the Compose `restart: unless-stopped` policy starts the same container again with its persisted configuration. The `202` means *scheduled*, not *completed*, and the response is best-effort — verify the new process with `/health` and `/ready`. Other outcomes: `401` missing/invalid `x-restart-token`, `405` wrong method (`Allow: POST`), `409` a restart is already pending, `500` no restart mechanism available, `503` feature disabled. The endpoint takes no body (any body is `400`).

It does not rebuild the image, update deployment files, or reconcile a changed `apiPort` (see KI-01), and it is not a replacement for operator control: a container the operator `docker stop`ped stays stopped. Both variables are environment-only — never in `config.yml`, which `/read-config` would expose — sourced from the git-ignored `code/.env` (see `code/.env.example`) and injected by `code/docker-compose.yml` with the flag defaulting to `false`. Rationale: [DECISIONS.md](DECISIONS.md) D-10.

## Docker operational requirements

Mount a **directory**, not an individual config file, read-write at `/app/configs`; ensure host directory owner is uid/gid 1000 so atomic rename works. The supplied port value 32002 appears in `config.yml`, Docker `EXPOSE`, Docker `HEALTHCHECK` and Compose port mapping; update the active config and deployment together if changing it. The example Compose file expects a local `.env` for the config token and the optional restart credentials (`.env` is git-ignored; `code/.env.example` lists both); `docker compose` resolves it from the compose project directory, so it belongs at `code/.env` beside `code/docker-compose.yml`. See `code/docker-refresh.sh` and `README.md` for deployment procedures.
