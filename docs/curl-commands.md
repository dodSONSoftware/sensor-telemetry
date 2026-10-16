# curl Commands

Copy-paste examples for the HTTP API. The examples reference the tokens as shell variables — export them from the `.env` file beside `docker-compose.yml` first (e.g. `export $(grep -v '^#' .env | xargs)`). The two secrets are **distinct**; never send the config token to `/restart-service` or vice versa.

Token semantics (see [Configuration API Security Model](../README.md#configuration-api-security-model) and [Service Restart](../README.md#service-restart-post-restart-service) in the README). Both tokens share one validity rule: **at least 32 alphanumeric characters (A–Z, a–z, 0–9)** — `openssl rand -hex 32` produces a valid token. In every example below the token is valid:

- `SENSOR_TELEMETRY_CONFIG_TOKEN` — sent as the `x-config-token` header. When no valid token is configured (unset, empty, or invalid), the config endpoints below are **disabled**: every request gets `503 { "success": false, "message": "Configuration API is disabled." }` (even one carrying a well-formed header), and the service warns at startup but runs normally. With a valid token, a missing or mismatched header is rejected with `401`.
- `RESTART_SERVICE_TOKEN` — sent as `Authorization: Bearer`. Unset, empty, or invalid: `/restart-service` is **disabled** (`503`); the service warns at startup and runs normally — a set-but-invalid value never refuses startup.

## Configuration (protected by `SENSOR_TELEMETRY_CONFIG_TOKEN`)

### Read config

```bash
curl --fail-with-body -i \
  -H "x-config-token: ${SENSOR_TELEMETRY_CONFIG_TOKEN}" \
  http://HOST:32002/read-config
```

### Write config

`POST` the full JSON configuration; only `logLevel`, `forwardSensorLogs`, `forwardSensorLogsLevel`, and `staleSourceRemovalSecs` apply immediately — the rest take effect on the next restart. The schema is strict: unknown keys and missing required keys are rejected, so the easiest starting point is the output of `/read-config` with the changed values.

```bash
curl --fail-with-body -i -X POST -H "Content-Type: application/json" \
  -H "x-config-token: ${SENSOR_TELEMETRY_CONFIG_TOKEN}" \
  -d '{"logLevel": "info", "apiPort": 32002, "mqttBrokerIpAddress": "127.0.0.1", "mqttTopicTelemetry": "telemetry/sensors"}' \
  http://HOST:32002/write-config
```

### Reload config

Re-reads the persisted `config.yml` from disk and applies the runtime-effective keys; the file itself is not modified.

```bash
curl --fail-with-body -i \
  -H "x-config-token: ${SENSOR_TELEMETRY_CONFIG_TOKEN}" \
  http://HOST:32002/reload-config
```

## Restart service (protected by `RESTART_SERVICE_TOKEN`)

Schedules a graceful restart — it does not complete one. The Compose `restart: unless-stopped` policy then starts the same container again with its persisted configuration. The request body is ignored, and every response carries `Cache-Control: no-store`.

```bash
curl --fail-with-body -i -X POST \
  -H "Authorization: Bearer ${RESTART_SERVICE_TOKEN}" \
  http://HOST:32002/restart-service
```

```
HTTP/1.1 202 Accepted
{ "success": true, "status": "restart_scheduled", "message": "Service restart requested" }
```

`202` means **scheduled**, not completed — and the response is best-effort (the process may exit before you finish reading it). Verify the new process with `GET /health` and `GET /ready`, and check the container's `RestartCount`/`StartedAt` with `docker inspect sensor-telemetry`.

Other outcomes: `401` missing/invalid `Authorization` header (with `WWW-Authenticate: Bearer`), `405` wrong method, `409` a restart is already in progress, `503` endpoint disabled.
