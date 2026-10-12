# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Node.js service that listens on MQTT channels for IoT sensor telemetry and exposes it as Prometheus metrics, plus a small HTTP API for config and health.

## Commands

```bash
npm run build     # tsc + copy config.yml to dist/
npm start         # run compiled service (dist/)
npm run dev       # ts-node src/index.ts
npm run lint      # eslint .   (npm run lint:fix to autofix)
npm test          # jest (ts-jest, suites under tests/)
npx jest tests/__tests__/dodsonlabs/Logger.test.ts   # single suite
npx jest -t "test name"                               # single test
npm run test:watch / npm run test:coverage
```

- `/blt` — build → lint → test quality gate (does not commit).
- `/git-commit` — release pipeline: semver bump with `src/version.ts` kept in sync with `package.json` (the `APP_VERSION`/`APP_NAME` lines deliberately have **no trailing semicolon** — the workflow's replace-and-verify scripts match them exactly), CHANGELOG.md entry (newest first), README release line, and refresh of CLAUDE.md/README. `APP_VERSION` is the app version source of truth (reported by `/about`); the codename (`APP_NAME`) is a deterministic function of the version ("<Material> <Animal>").

## Architecture

- `src/index.ts` — entry: config loading, startup wait, shutdown. Signal + fatal handlers (SIGTERM/SIGINT/`uncaughtException`/`unhandledRejection`) register **before** `MqttNetworking` construction; `networking` stays nullable until then (`networking?.close` guards).
- `src/dodsonlabs/MqttNetworking.ts` — MQTT client + message routing. Routes topics case-insensitively (log → health → telemetry fallback); MQTT topics are case-sensitive, so the config schema rejects topic pairs that collapse under case folding. Every payload is narrowed to `JsonObject` once at parse; handlers read fields only through the field helpers. V3 telemetry is per-device: top-level `device` maps to a metric category (`bme280`/`sht35` → air, `ds18b20` → water, `ltr390` → light, `yl69_fc28`/`plantmate_soil` → soil); unknown devices are dropped with a warning. Per-message rejection warnings are throttled **per event** (first logged, repeats suppressed in a 60 s window, one re-warn with `suppressedCount`) so a hostile publisher cannot flood the log.
- `src/dodsonlabs/PrometheusWriter.ts` — prom-client metrics + the HTTP API (constructor starts the server). Source labels are sanitized (charset strip, truncation, `unknown`/`unknown_source` fallbacks) and cardinality-capped (`sensorSourceCardinalityCap`; overflow → fallback label + `sensor_*_rejected_total` counters). Lossy-sanitization collisions are disambiguated to `<label>-<8-hex sha256 of raw>`; the effectively-unreachable fingerprint-collision branch falls back to the reserved label and **counts** — never silently merges. `staleSourceRemovalSecs > 0` starts a sweep that evicts idle sources' series and frees their cap slots (fallback labels are never evicted).
- `src/dodsonlabs/SystemFunctions.ts` — field extraction + log bounding. `get_numeric_field` returns the finite number as parsed and never truncates; `get_millisecond_field` = same + `Math.trunc` (the integer-ms invariant is declared at the call site, never inferred from field spelling). `truncateForLog` (256 chars), `truncateForLogList` (10×256), and `boundForLog` (depth 8, 10 items/props) cap untrusted MQTT values before they reach the log. Also: config file candidates + YAML read/write, `buildSourceValidCharsRegex`.
- `src/dodsonlabs/Logger.ts` — winston wrapper. Recursively redacts metadata keys matching SECRET_PATTERNS (`/password|passwd|authorization|cookie|token|secret|apiKey|privateKey/i`) to `[REDACTED]`; Error objects keep name/message/stack; the pass is depth-capped (8). Do **not** add patterns that are strict substrings of an existing one — 4.1.38 trimmed five subsumed ones, and `Logger.test.ts` pins the base patterns so a loosening fails the suite. When `lokiUrl` is set the constructor also builds a `LokiTransport` (below) with static `service`/`environment`/`version` stream labels, and `close()` (concrete class, not `ILogger`) flushes the pending batch — index.ts awaits it last in `shutdown()`.
- `src/dodsonlabs/LokiTransport.ts` — winston transport that batch-pushes (5 s interval / 256 entries / 64 KiB, whichever first) the redacted single-line JSON log lines to `<lokiUrl>/loki/api/v1/push` via global `fetch`. The push body is server-contracted: `{ streams: [{ stream, values }] }` with int64 nanosecond timestamps — a bare `{ stream, values }` is a 422 and ISO-string timestamps a 400; 4.2.0 shipped the bare shape and every push failed until 4.2.1. A failed push drops the batch and warns via direct, 60 s-throttled `console.error` — never through the winston logger (recursion) and never as an unhandled rejection (fatal per index.ts).
- `src/schemas/config.ts` — strict Zod schema, shared by startup, `/write-config`, and `/reload-config` (unknown keys rejected; the three MQTT topics must be unique case-insensitively).
- `src/common/global.ts` — `serviceMetadata` (identity for `/about` + prom-client), `createLogger`.

## Key contracts

- **MQTT payloads are untrusted.** Never index them directly — scalars go through `getStringField`/`getStringOrFiniteNumberField` (a blanket `String()` is banned: nested arrays throw `RangeError`), numbers through `get_numeric_field`-family helpers. Payloads over 64 KiB are dropped before parsing. Log every untrusted value through the bounding helpers.
- **Config** is `config.yml` (YAML). Startup tries `/app/configs/config.yml` (Docker mount), `./config.yml`, `./dist/config.yml`; a candidate that exists but is unreadable/unparseable fails startup loudly (no silent fallback to a stale copy). Docker: the image ships no config — mount the **directory** read-write owned by uid 1000 (`chown 1000:1000`); `/write-config` persists via temp-file + rename, so a single-file bind mount shadows the rename and the host file stays stale. The optional `lokiUrl` (Loki instance base URL) is restart-required — it drives the Logger's Loki transport (Architecture), so `/write-config` changes to it persist and warn but never rebuild the running transport.
- **HTTP API** (all on the `apiPort`): `/metrics`, `/health` (liveness only), `/ready` (200 only when MQTT connected **and** subscriptions SUBACKed), `/about`, `/endpoints`, `/read-config` (GET), `/write-config` (POST), `/reload-config` (GET). Read-only routes answer GET only (405 + `Allow`); `OPTIONS` preflights get 204 before anything else. `SENSOR_TELEMETRY_CONFIG_TOKEN` env guards all three config routes via `x-config-token` (constant-time compare; unset = open + startup warning). `SENSOR_TELEMETRY_CORS_ORIGINS` env is an exact-match origin allowlist (unset/`*` = allow all). Security audit events log `remoteAddress` only — never token values, headers, or bodies; config commit/rejection audits carry key names, never values.
- **Metrics**: physical readings (`air_*`, `soil_*`, `light_*`, `water_*`) plus `sensor_health_*` gauges from V3 health messages, plus `sensor_last_seen_timestamp_seconds{source}` stamped once per **accepted** message (communication, not measurement). By default no series expire — staleness alerting belongs in Prometheus/Grafana unless `staleSourceRemovalSecs` is set. Application (service-level) metrics sit beside these, all in `PrometheusWriter`: `mqtt_client_connected` (pull gauge from the live connection), `mqtt_connection_errors_total{kind}` / `mqtt_reconnects_total`, the pipeline funnel `mqtt_messages_received_total` / `mqtt_messages_dropped_total{reason}` (reason is the fixed `MqttMessageDropReason` set from `Interfaces.ts`; counters increment per occurrence even when the matching log line is throttled), hand-rolled `process_*` gauges (uptime, heap used/total, event-loop lag — the lag gauge reads `mean` since last scrape then `reset()`, 0 until first observation), plus the library's standard `process_*`/`nodejs_*` runtime families added exactly once by `collectDefaultMetrics()` (idempotent `initializeDefaultMetrics()`, called in the constructor into the same global `register` the endpoint reads — `process_resident_memory_bytes` is the library's, not hand-rolled; the exposition can carry `Nan` from `nodejs_eventloop_lag_{mean,stddev}_seconds` until first observation, prom-client's spelling, which Prometheus accepts and `promtool` treats as a naming lint only), and `http_requests_total{path, status}` (fired on `res "finish"`, `path` normalized to the 8 known routes or `"unknown"` — no untrusted values in labels, same policy as the source-label cap).

## Testing notes

- Jest + ts-jest (CommonJS via `tsconfig.jest.json`), suites mirror `src/` under `tests/__tests__/`.
- In MqttNetworking tests `PrometheusWriter` is **auto-mocked** (its constructor starts a real HTTP server). Call tracking is per-instance (assert on the returned mock); return values come from the **prototype** implementation (set `mockImplementation` once at module load, restore in `finally`).
- Real-writer behavior (cardinality, collisions, stale sweep, config API) is tested with the real writer on a free port, asserting on scraped output.

## Docs

- `README.md` — user-facing documentation (config, deployment, endpoints, redaction); `CHANGELOG.md` — per-version history, newest first.
- An earlier, much more detailed CLAUDE.md (deep contract prose: rejection-throttle semantics, collision episode dedupe, shutdown deadline budgeting, Docker config-folder failure modes) is preserved in git history — `git log --oneline -- CLAUDE.md` to find it.
