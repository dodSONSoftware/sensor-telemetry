# Sensor Telemetry Services — Changelog

All notable changes to the Sensor Telemetry Services are documented in this file.
Versions are listed newest first.


## [4.4.7] — Bronze Falcon (2026-10-13)

- The physical bounds for air/water temperature, humidity, pressure, altitude, lux/uv, and soil readings are no longer hardcoded independently in the MQTT routing layer and the Prometheus publishers — both now read one shared `TELEMETRY_FIELD_RANGES` table through `withinTelemetryRange`, so a one-sided range edit can no longer make the layers silently disagree (a message counted accepted and stamped fresh, then skipped by the publisher). All range values are unchanged; each layer keeps its own enforcement (routing rejects the message, the publisher skips the gauge), and new unit tests pin the table's values and the inclusive/open-bound semantics

## [4.4.6] — Bronze Falcon (2026-10-13)

- The first-occurrence / re-warn / `suppressedCount` warn-throttle state machine that was implemented three times (the MQTT rejection warns, the HTTP audit warns, and the Loki push-failure reports, with cross-file comments as the only consistency mechanism) is now a single shared `stepThrottle` helper in SystemFunctions; each site keeps its own dispatch (level, logger vs direct console, Loki's recovery latch) and its per-instance state. No behavior change — event names, levels, messages, and metadata shapes are unchanged, the three existing throttle suites pass unmodified, and new unit tests pin the four `stepThrottle` outcomes (first-fire, in-window suppression, re-warn carrying the suppressed count, re-warn with nothing suppressed)

## [4.4.5] — Bronze Falcon (2026-10-12)

- Sensor log messages suppressed by the `forwardSensorLogs` gate (on either the V3 log topic or the `type: "log"` dispatch) or below the `forwardSensorLogsLevel` threshold are no longer an undiagnosable dead zone: each is now counted as a pipeline drop (`mqtt_messages_dropped_total{reason="forwarded_log_disabled"}` / `{reason="forwarded_log_below_threshold"}` — two new `MqttMessageDropReason` values) and logged once per event through the existing per-event throttling, at **debug** level since suppression is a configuration outcome, not a fault. Previously, disabling forwarding or raising the threshold was indistinguishable from a silent sensor
- The per-request HTTP audit warns (route-not-found probes, pre-parse protocol errors, `x-config-token` rejections, CORS origin rejections) are now throttled per event with the same first-occurrence / re-warn / `suppressedCount` semantics as the MQTT rejection warns: those routes are reachable unauthenticated, so a single client could previously own the log channel; per-request truth stays in `http_requests_total{path,status}`
- The Loki transport's remaining loss modes are no longer silent: a one-shot info on the first push success after any failure ("Loki is back" is now distinguishable from "nothing to push"), a one-shot warn when entries arrive after `close()` (the console transport still gets them), a `log()` buffering exception routed through the same throttled direct-console failure report instead of a silent catch, and a one-shot error when `close()`'s drain outlives its budget, reporting the undelivered count (queued + in flight) — shutdown is exactly when the interesting lines are
- The stale-source sweep is fault-tolerant: a throwing sweep pass is now logged as a `stale_source_sweep_error` ERROR and the sweep continues, instead of escaping to `uncaughtException` and taking the whole service down over a maintenance pass
- The fingerprint-collision fallback branches (the effectively unreachable 8-hex SHA-256 collisions at the disambiguated-label level) now log as well as count: the source branch logs an ERROR per rejection episode, the firmware branch once per process — two real identities merging into one label are now visible in the log, not only in the `sensor_*_rejected_total` counters
- The `/about` and `/endpoints` route descriptions are clarified (what `/about` returns, what `/metrics` exposes, and that `/reload-config` applies the runtime-effective settings without modifying the file on disk)
- Regression tests pin: suppressed-forwarded-log drop counting + debug logging + per-event throttling (both gate paths and the threshold gate), HTTP audit-warn throttling for 404 and token-rejection probes, sweep-pass survival, the Loki recovery / after-close / close-timeout reports, and both fingerprint-collision error lines

## [4.4.4] — Bronze Falcon (2026-10-12)

- Forwarded sensor-log bodies no longer leak `message_schema_version`: the V3 rename of `schema_version` was extracted and carried as the `schema_version` metadata field, but only the old spelling was removed from the log data — a log message without a `message`/`msg` field forwards the whole log data as its body, so the key (and its value) survived into the forwarded log text. It is now removed alongside its sibling service-managed fields (`schema_version`, `runtime_id`, `firmware_version`, `uptime_ms`); the value still reaches Loki via the `schema_version` metadata label
- A regression test forwards a log document carrying top-level `message_schema_version` with no `message`/`msg` field and pins that the key is absent from the forwarded body while `schema_version` and `runtime_id` remain in the metadata; it fails against the pre-fix handler

## [4.4.3] — Bronze Falcon (2026-10-12)

- Repeated SUBACK denials are now tiered like connection failures: because the service re-subscribes on every (re)connect, a persistently denying broker previously re-logged a full `mqtt_subscription_failed` ERROR for every topic on every reconnect (every 5 s during a reconnect storm). Only the first denial of the current denial state is now a full ERROR (with the error object); repeats are a WARN carrying the attempt count, and any granted subscription resets the tier so the next denial starts fresh at its full ERROR. The `mqtt_subscription_failed` event name and the `subscription_active` / `mqtt_subscription_active` reporting are unchanged
- A SUBACK regression test drives repeated denials and a grant, pinning the tier (ERROR at attempt 1, WARN at attempts 2–3, reset to a fresh ERROR after a grant); it fails against the pre-tiering handler

## [4.4.2] — Bronze Falcon (2026-10-12)

- The Loki log push is now bounded by a 5 s per-request timeout (`AbortSignal.timeout` on the push fetch): Node's fetch has no app-level timeout by default, so a black-holed Loki endpoint (SYN-accepted, never answered) previously held the in-flight push for undici's implicit ~300 s headersTimeout and could spend `close()`'s entire shutdown budget waiting on it. An aborted push takes the existing failure path — throttled warn, batch dropped, no retry loop, never unhandled
- A transport regression test hangs a fetch until its passed signal aborts (and fails loudly if no signal is passed at all) and pins the bound: the push aborts at the timeout, the batch is reported dropped, and nothing rejects unhandled

## [4.4.1] — Bronze Falcon (2026-10-12)

- V3 telemetry device routing now resolves the category with an own-property check instead of indexing the category table directly with the untrusted `device` value: a `device: "__proto__"` (or `"constructor"`) payload previously resolved to an inherited `Object.prototype` property instead of `undefined`, slipped past the unknown-device guard, and reached the category switch with a value matching no case — a silent drop that was neither logged nor counted in `mqtt_messages_dropped_total`. Such payloads now take the same path as any other unrecognized device: a throttled warning, a counted drop (`unknown_device`), and no publish
- A routing regression test drives a `__proto__` device message and pins that path (warning event, counted drop, no publish, no source-freshness stamp); it fails against the pre-fix lookup

## [4.4.0] — Bronze Falcon (2026-10-12)

- The `/metrics` endpoint now exposes the prom-client standard `process_*` / `nodejs_*` runtime families (heap, GC, CPU, version info, event-loop lag histogram — the exact set the installed prom-client ships) alongside the service's own metrics: they are registered into the same global registry the endpoint reads, exactly once, by an idempotent initializer, so a re-constructed writer cannot double-register while a genuinely colliding metric name still fails loudly at construction
- `process_resident_memory_bytes` is now served by the library's standard collector instead of the hand-rolled gauge added in 4.3.0 (same name and unit; a second registration of that name would have thrown), and the hand-rolled `process_event_loop_lag_ms` (milliseconds, mean since the previous scrape) is retained alongside the default `nodejs_eventloop_lag_{mean,stddev}_seconds` family — until the first observation the exposition can carry a `Nan` value for those default gauges, which is prom-client's spelling and is accepted by Prometheus
- The checked-in `config.yml` now forwards sensor logs at `debug` instead of `info` (`forwardSensorLogsLevel`), so sensor debug lines reach the application log in a fresh checkout
- A new real-writer test suite pins the single-registry contract: every metric family declared exactly once, no duplicate samples, a syntactically valid exposition with the registry's content type, idempotent default-metrics initialization, a stable family set across scrapes, and duplicate registrations throwing rather than being silently ignored

## [4.3.0] — Tin Falcon (2026-10-12)

- The service now exposes its own health to Prometheus alongside the sensor metrics it serves: a pull-model `mqtt_client_connected` gauge (1/0 from the live broker connection, 0 while the client is absent), `mqtt_connection_errors_total{kind}` (`client` for errors on a live connection, `connection` for connect failures), and `mqtt_reconnects_total` (counted only for a reconnect after a failure — never the initial connect)
- The MQTT message funnel is now countable: `mqtt_messages_received_total` increments once per delivery (including messages later dropped), and `mqtt_messages_dropped_total{reason}` buckets every drop point across the routing pipeline under a fixed 13-value reason set (`payload_too_large`, `parse_error`, `not_object`, missing/unknown `message_type` or `device`, missing/invalid payloads, `telemetry_field_missing`, `telemetry_out_of_range`, `handling_error`) — the counters increment per occurrence even while the matching warning is log-throttled, so a hostile or misconfigured publisher's impact stays observable without flooding the log
- The process is self-instrumented with hand-rolled gauges (no default prom-client collector set): `process_uptime_seconds`, `process_heap_used_bytes`, `process_heap_total_bytes`, `process_resident_memory_bytes`, and `process_event_loop_lag_ms` (a 20 ms-resolution event-loop delay monitor, read at scrape time as the mean since the previous scrape and then reset — 0 until the first observation, so the exposition never carries a `Nan` value)
- The HTTP API counts itself: `http_requests_total{path, status}` fires once per completed response on every path — 200s, 4xx/5xx, CORS preflights, and the oversized-request reject — with `path` restricted to the eight known routes and everything else folded into a fixed `"unknown"` bucket, so an untrusted request line can never mint a label value

## [4.2.1] — Aluminum Falcon (2026-10-12)

- The 4.2.0 `lokiUrl` push actually delivers now: the transport was sending each batch as a bare `{ stream, values }` object, which the Loki push API rejects with a 422 ("at least one valid stream is required for ingestion") — so every batch shipped since 4.2.0 was silently dropped. The payload is now the API's real `{ streams: [{ stream, values }] }` form, and the ISO-8601 entry timestamps are converted to the int64 nanosecond epochs the API requires (sending them raw is a second, 400-class failure); the tests now pin the actual wire contract, which the old mocks had codified incorrectly

## [4.2.0] — Aluminum Falcon (2026-10-12)

- The service can now ship its own logs to Loki: a new optional `lokiUrl` config key (the instance's base URL, e.g. `http://loki:3100`) makes the Logger batch (5 s interval / 256 entries / 64 KiB, whichever first) and push the same secret-redacted single-line JSON lines it prints to the console to `<lokiUrl>/loki/api/v1/push`, with all lines of one process sharing a single stream labeled `service`, `environment`, `version`; omitting the key keeps logging console-only
- Loki shipping is best-effort: a failed push drops its batch and logs a warning directly to the console, throttled (first failure logged, repeats suppressed for 60 s, the re-warn carries the suppressed count) — a down Loki degrades to console-only logging and never crashes the process, retries unboundedly, or grows memory
- On shutdown the pending Loki batch is flushed (bounded, ~2 s) after the networking close, so the shutdown log lines are not lost; `lokiUrl` is restart-required — `/write-config` and `/reload-config` persist it and warn that it takes effect on the next restart
- The repository now ships the MIT LICENSE file

## [4.1.39] — Zinc Falcon (2026-10-12)

- The config endpoints are now fully auditable at the HTTP layer: successful `/write-config` and `/reload-config` commits log `config_write_committed` / `config_reload_completed` (info) with the directly observed `remoteAddress`, the commit `path`, and the changed keys — key names only, never values, so the broker address cannot become a second read channel through the log and a key written at its running default reports no change; the previously-silent validation rejections log `config_write_rejected` (400) and `config_reload_failed` / `config_read_failed` (500) with a bounded error message; and a successful `/read-config` logs `config_read_completed` (info, `remoteAddress` only) — closing the gap where every config rejection was audited but successful operations left no trace (the `configuration_updated` event only fires when networking is constructed and carries none of these fields)
- The six per-message rejection warnings (`mqtt_message_missing_type`, `mqtt_unknown_message_type`, `mqtt_unknown_v3_device`, `mqtt_health_invalid_payload`, `telemetry_field_missing`, `telemetry_out_of_range`) are throttled per event: the first occurrence is always logged at its original level, repeats are suppressed, and one re-warn per 60 s carries a `suppressedCount` — a hostile or misconfigured publisher can no longer flood the log at message rate, and the throttle state is keyed by event name (a fixed ≤ 6-entry set) rather than by the raw, attacker-mintable source
- The initial MQTT connect since process start now logs `mqtt_connected` at INFO (previously debug), so the startup connection that opens the `/ready` readiness window is visible at the default log level; a reconnect after a failure logs `mqtt_reconnected` only (no duplicate pair), and a no-error reconnect is announced by the preceding `mqtt_disconnected` warning plus the SUBACK path
- HTTP protocol errors before request parsing (malformed request lines, oversized headers) now reproduce the default 400 + close while logging an `http_client_error` audit warning (error code, `remoteAddress`, bounded error message) — unauthenticated probes that break the HTTP parser were previously invisible in the log

## [4.1.38] — Zinc Falcon (2026-10-11)

- Trim five redundant patterns from the logger's secret-redaction list — `/wifi-password/i`, `/wifiPassword/i`, `/accessToken/i`, `/refreshToken/i`, and `/clientSecret/i` were each a strict subset of `/password/i`, `/token/i`, or `/secret/i`, so redaction behavior is identical; a regression test now pins the subsumed keys redacting through their base patterns, so a future loosening of a base pattern fails the suite instead of silently widening what reaches the log

## [4.1.37] — Zinc Falcon (2026-10-11)

- The 8-hex fingerprint-collision fallbacks in source and firmware label disambiguation (an effectively-unreachable SHA-256 collision at the disambiguated-label level, documented as such) are now instrumented instead of silent: a colliding source increments `sensor_sources_rejected_total` once per rejection episode and a colliding firmware version increments `sensor_firmware_versions_rejected_total` per occurrence, so the approximation is observable in Prometheus if it ever fires

## [4.1.36] — Zinc Falcon (2026-10-11)

- `/read-config` now requires the `x-config-token` header when `SENSOR_TELEMETRY_CONFIG_TOKEN` is set, matching `/write-config` and `/reload-config` — a deployment that locks down config mutation also locks down the config read, so an operator who sets the token is never left with a token-protected write path beside a world-readable one; with the token unset the endpoint remains open as before

## [4.1.35] — Zinc Falcon (2026-10-11)

- Fatal process handlers (`uncaughtException` / `unhandledRejection`) are now registered before the MQTT networking / Prometheus writer construction, so a synchronous throw during that construction (a failure mode the config schema does not validate away) is routed through the structured fatal path — structured critical log and exit-code ownership — instead of escaping as a raw Node unhandled-rejection crash; `shutdown()` skips an unconstructed networking rather than hitting a TDZ reference, and a source-order regression test pins the invariant

## [4.1.34] — Zinc Falcon (2026-10-11)

- Log metadata now sources the `version` field from `src/version.ts` — the app version's single source of truth, the same value `/about` reports — instead of a second, runtime-loaded copy of `package.json`, so the two can no longer drift apart

## [4.1.33] — Zinc Falcon (2026-10-11)

- Remove a redundant second sanitization pass from per-message source-label resolution: the blank-source check now re-checks the sanitization core only when the sanitized form is ambiguous (equals the reserved `unknown` fallback), so a real source literally named `unknown` is still disambiguated rather than merged onto the blank-source fallback

## [4.1.32] — Zinc Falcon (2026-10-11)

- Consolidate the log-level string-to-enum mapping onto the single `SystemFunctions.convert_from_log_level_string_to_enum` helper and delete the Logger's private duplicate — the two mappings were identical, and one source of truth keeps them from drifting

## [4.1.31] — Zinc Falcon (2026-10-11)

- `/write-config` and `/reload-config` no longer warn that `sensorSourceMaxLength` / `sensorSourceValidCharsRegex` / `sensorSourceCardinalityCap` "changed but take effect on the next restart" when the written value equals the default the service already runs with (whether the startup config omitted the key or spelled the default out); genuine changes to those keys still warn

## [4.1.30] — Zinc Falcon (2026-10-11)

- Config read failures on `/read-config` and `/reload-config` (missing or unparseable `config.yml`) are now reported through the service's structured logger instead of a raw `console.error`: the configured log level and winston transports/formats apply, matching the config write path

## [4.1.29] — Zinc Falcon (2026-10-11)

- Introduce CHANGELOG.md as the per-version release history: every past release is back-filled from the git history (111 versions, newest first, pre-3.x releases named with the deterministic codename scheme)
- Add `src/version.ts` as the app version's source of truth: `APP_VERSION` (reported by `/about` via `serviceMetadata`) and `APP_NAME` (the release codename); `package.json` is kept in sync with it and a regression test pins the sync
- Port the `/git-commit` workflow to the full analyze-and-commit pipeline: version and codename are kept in lockstep across `package.json`/`version.ts`, every commit gets a CHANGELOG entry, and a drifted version aborts before any change is made

## [4.1.28] — Zinc Falcon (2026-10-09)

- fix: align API port with the documented 32002

## [4.1.27] — Zinc Falcon (2026-10-09)

- build: run container as the node user and harden deployment tooling

## [4.1.26] — Zinc Falcon (2026-10-03)

- fix: bound optional air altitude at the routing boundary and stop announcing the MQTT subscription at startup

## [4.1.25] — Zinc Falcon (2026-10-02)

- fix: bound untrusted HTTP/telemetry values at the boundary and drop inert code

## [4.1.24] — Zinc Falcon (2026-10-02)

- fix: reject fractional discrete health counters and disambiguate firmware label collisions

## [4.1.23] — Zinc Falcon (2026-10-02)

- refactor: consolidate service identity metadata into a single source of truth

## [4.1.22] — Zinc Falcon (2026-10-02)

- fix: report immediate Prometheus listen failures instead of waiting out the startup timeout

## [4.1.21] — Zinc Falcon (2026-10-02)

- fix: bound forwarded log body before serialization and dedupe collision warnings for cap-rejected sources

## [4.1.20] — Zinc Falcon (2026-10-02)

- refactor: remove dead MqttNetworking.configuration state

## [4.1.19] — Zinc Falcon (2026-10-02)

- fix: report rejected uptime values in seconds in the invalid-uptime warning

## [4.1.18] — Zinc Falcon (2026-10-02)

- fix: bound untrusted HTTP url and Origin fields in request logs

## [4.1.17] — Zinc Falcon (2026-10-02)

- fix: enforce sensorSourceMaxLength >= 9 in the config schema

## [4.1.16] — Zinc Falcon (2026-10-02)

- fix: warn only once per process for blank/all-invalid sources

## [4.1.15] — Zinc Falcon (2026-10-02)

- fix: keep shared fallback sources out of concrete source admission accounting

## [4.1.14] — Zinc Falcon (2026-10-02)

- fix: keep the shutdown exit reachable if the initial shutdown log throws

## [4.1.13] — Zinc Falcon (2026-10-02)

- fix: destroy the /write-config request stream after a 413

## [4.1.12] — Zinc Falcon (2026-10-02)

- fix: stop connected MQTT client errors from consuming the first-failure ERROR slot

## [4.1.11] — Zinc Falcon (2026-10-02)

- fix: count cardinality rejections once per distinct rejected source

## [4.1.10] — Zinc Falcon (2026-10-02)

- fix: disambiguate colliding source labels so distinct sensors never merge

## [4.1.9] — Zinc Falcon (2026-10-02)

- fix: include required physical-value validation in telemetry acceptance

## [4.1.8] — Zinc Falcon (2026-10-02)

- fix: defer firmware admission past validation, correct restart-only warning, and bound untrusted log values

## [4.1.7] — Zinc Falcon (2026-10-02)

- refactor: make telemetry message handling synchronous

## [4.1.6] — Zinc Falcon (2026-10-02)

- docs: document MQTT subscription guard and apiPort port constraint

## [4.1.5] — Zinc Falcon (2026-10-02)

- fix: evict sensor_last_seen_timestamp_seconds with stale sources

## [4.1.4] — Zinc Falcon (2026-10-02)

- chore: add remote client address to security-relevant HTTP audit logs

## [4.1.3] — Zinc Falcon (2026-10-02)

- docs: correct /endpoints documentation for staleSourceRemovalSecs

## [4.1.2] — Zinc Falcon (2026-10-02)

- fix: invalidate MQTT subscription state on connection close

## [4.1.1] — Zinc Falcon (2026-10-02)

- fix: bound deeply nested values in truncateForLog

## [4.1.0] — Zinc Falcon (2026-10-02)

- feat: remove stale sensor data via staleSourceRemovalSecs

## [4.0.22] — Iron Falcon (2026-10-01)

- fix: reduce MQTT reconnect error log noise

## [4.0.21] — Iron Falcon (2026-10-01)

- docs: document apiPort coupling to the Docker deployment

## [4.0.20] — Iron Falcon (2026-10-01)

- chore: source the config token from .env in docker-compose

## [4.0.19] — Iron Falcon (2026-10-01)

- build: use npm ci for reproducible Docker image builds

## [4.0.18] — Iron Falcon (2026-10-01)

- test: P2-1 scalar boundary and error-classification regression tests

## [4.0.17] — Iron Falcon (2026-10-01)

- fix: separate parse errors from handling errors in on_message

## [4.0.16] — Iron Falcon (2026-10-01)

- fix: bound raw invalid-value metadata in telemetry publishers

## [4.0.15] — Iron Falcon (2026-10-01)

- fix: bound Logger secret-redaction recursion depth

## [4.0.14] — Iron Falcon (2026-10-01)

- fix: normalize health status before any health gauge is mutated

## [4.0.13] — Iron Falcon (2026-10-01)

- fix: prove MQTT protocol scalar fields scalar at the boundary

## [4.0.12] — Iron Falcon (2026-10-01)

- fix: serialize /write-config transactions so disk and runtime config cannot diverge

## [4.0.11] — Iron Falcon (2026-10-01)

- test: make the shutdown deadline test deterministic

## [4.0.10] — Iron Falcon (2026-10-01)

- chore: sync lockfile version fields
- docs: note /read-config constraint for future secret-bearing fields

## [4.0.9] — Iron Falcon (2026-10-01)

- cleanup: remove unused memory development-state directory

## [4.0.8] — Iron Falcon (2026-10-01)

- test(config-api): cover oversize, abort, and concurrent /write-config writes

## [4.0.7] — Iron Falcon (2026-10-01)

- cleanup: normalize x-request-id header instead of unsafe assertion

## [4.0.6] — Iron Falcon (2026-10-01)

- chore(deps): remove redundant @types/mqtt

## [4.0.5] — Iron Falcon (2026-10-01)

- docs: correct forwardSensorLogsLevel default

## [4.0.4] — Iron Falcon (2026-10-01)

- fix(config): reject MQTT wildcard topic filters

## [4.0.3] — Iron Falcon (2026-10-01)

- cleanup(metrics): remove orphaned V2 health metrics

## [4.0.2] — Iron Falcon (2026-10-01)

- fix(mqtt): reject oversized MQTT payloads before parsing

## [4.0.1] — Iron Falcon (2026-10-01)

- fix(logger): preserve metadata for messages containing printf tokens

## [4.0.0] — Iron Falcon (2026-10-01)

- refactor!: remove the V2 section-based telemetry protocol

## [3.0.15] — Iron Badger (2026-10-01)

- fix: make the startup readiness wait shutdown-aware

## [3.0.14] — Iron Badger (2026-10-01)

- fix: make write_file_yaml temp files unique per call

## [3.0.13] — Iron Badger (2026-10-01)

- fix: bound structured metadata in forwarded sensor logs

## [3.0.12] — Iron Badger (2026-09-30)

- fix: register signal handlers before the Prometheus readiness wait

## [3.0.11] — Iron Badger (2026-09-30)

- fix: return explicit 400 when a /write-config request errors or aborts

## [3.0.10] — Iron Badger (2026-09-30)

- refactor: drop misleading async/await around handleWriteConfig

## [3.0.9] — Iron Badger (2026-09-30)

- docs: document trusted-LAN configuration API security model

## [3.0.8] — Iron Badger (2026-09-30)

- fix: contain /metrics collection failures

## [3.0.7] — Iron Badger (2026-09-30)

- docs: correct write_file_yaml durability contract

## [3.0.6] — Iron Badger (2026-09-30)

- fix: bound untrusted MQTT payload values before logging

## [3.0.5] — Iron Badger (2026-09-30)

- fix: prefer current working directory config over stale dist/ build copy

## [3.0.4] — Iron Badger (2026-09-30)

- refactor: replace all type-level any with the JsonObject contract

## [3.0.3] — Iron Badger (2026-09-30)

- fix: eliminate duplicate MQTT resubscribe and enforce humidity range

## [3.0.2] — Iron Badger (2026-09-30)

- fix: reconcile API self-description and documentation with implementation

## [3.0.1] — Iron Badger (2026-09-30)

- fix: bound the entire shutdown path with a single close deadline and reject case-shadowing MQTT topics

## [3.0.0] — Iron Badger (2026-09-30)

- fix: rename device-owned cumulative metrics from _total to _count

## [2.8.2] — Steel Hawk (2026-09-30)

- fix: reject sensorSourceValidCharsRegex values that cannot build a character class

## [2.8.1] — Steel Hawk (2026-09-30)

- fix: reject unknown configuration keys

## [2.8.0] — Steel Hawk (2026-09-30)

- feat: expose sensor_last_seen_timestamp_seconds freshness metric

## [2.7.7] — Nickel Hawk (2026-09-30)

- fix: enforce GET on read-only HTTP endpoints

## [2.7.6] — Nickel Hawk (2026-09-30)

- fix: await Prometheus HTTP drain on shutdown; keep Z in stamped timestamps

## [2.7.5] — Nickel Hawk (2026-09-30)

- fix: reject non-numeric types in get_numeric_field

## [2.7.4] — Nickel Hawk (2026-09-30)

- fix: survive missing system_info and validate MQTT broker address at config load

## [2.7.3] — Nickel Hawk (2026-09-30)

- fix: escalate exit code when fatal error lands during in-flight shutdown

## [2.7.2] — Nickel Hawk (2026-09-30)

- fix: coerce non-string source values before Prometheus label sanitization

## [2.7.1] — Nickel Hawk (2026-09-30)

- fix: atomic config writes and observable MQTT subscription failures

## [2.7.0] — Nickel Hawk (2026-09-30)

- feat: cap Prometheus source and firmware label cardinality

## [2.6.5] — Copper Hawk (2026-09-30)

- docs: require documentation sync in /git-commit workflow

## [2.6.4] — Copper Hawk (2026-09-30)

- fix: centralized browser CORS with configurable origin allowlist

## [2.6.3] — Copper Hawk (2026-09-30)

- test: fix stale config key in SystemFunctions test fixture

## [2.6.2] — Copper Hawk (2026-09-30)

- test: expand coverage for token auth, label sanitization, V3 routing, health mapping, and reload failure paths

## [2.6.1] — Copper Hawk (2026-09-29)

- fix: persist /write-config before committing in-memory state

## [2.6.0] — Copper Hawk (2026-09-29)

- feat: add /ready readiness endpoint

## [2.5.7] — Brass Hawk (2026-09-29)

- fix: enforce HTTP methods on config endpoints

## [2.5.6] — Brass Hawk (2026-09-29)

- docs: correct forwardSensorLogs default in CLAUDE.md

## [2.5.5] — Brass Hawk (2026-09-29)

- refactor: consolidate duplicate getNumericField implementations into SystemFunctions

## [2.5.4] — Brass Hawk (2026-09-29)

- fix: fail fast on corrupt config candidates instead of falling back to stale copies

## [2.5.3] — Brass Hawk (2026-09-29)

- fix: reject empty source char regex and fall back to "unknown" label

## [2.5.2] — Brass Hawk (2026-09-29)

- fix: bound apiPort to the valid TCP port range

## [2.5.1] — Brass Hawk (2026-09-29)

- fix: apply logLevel on /reload-config and route requests with query strings

## [2.5.0] — Brass Hawk (2026-09-29)

- feat: config endpoint authentication, config file fallback, and Jest test suite

## [2.4.0] — Bronze Hawk (2026-09-28)

- refactor: unify health and diagnostic metrics under sensor_health_ prefix

## [2.3.0] — Tin Hawk (2026-09-27)

- feat: add SHT35 and soil sensors, BME280 altitude, and V4 health gauges

## [2.2.0] — Aluminum Hawk (2026-09-20)

- feat: process V3 per-device telemetry and health messages

## [2.1.4] — Zinc Hawk (2026-08-01)

- chore: replace (c) with © in copyright strings

## [2.1.3] — Zinc Hawk (2026-08-01)

- chore: add MQTT status to /about endpoint

## [2.1.2] — Zinc Hawk (2026-07-31)

- chore: update documentation and add CORS header

## [2.1.1] — Zinc Hawk (2026-07-26)

- fix: ensure time-related fields are truncated to integers

## [2.1.0] — Zinc Hawk (2026-07-26)

- feat: add system info metrics and update to v2 telemetry topic

## [2.0.0] — Iron Hawk (2026-07-26)

- refactor: convert all Prometheus metric names to lowercase

## [1.4.0] — Bronze Fox (2026-07-26)

- feat: enhance V2 metadata handling with Loki-compatible labels

## [1.3.1] — Tin Fox (2026-07-26)

- feat: add V2 snake_case field name support and improve topic routing
- chore: inject version from package.json at module load time

## [1.3.0] — Tin Fox (2026-07-20)

- feat: refactor logging with structured metadata and enhanced log types

## [1.2.2] — Aluminum Fox (2026-07-14)

- chore: refactor git-commit workflow and improve documentation

## [1.2.1] — Aluminum Fox (2026-07-13)

- fix: resolve race condition in config change propagation and improve endpoint caching

## [1.2.0] — Aluminum Fox (2026-07-12)

- feat: add runtime log level reconfiguration support

## [1.1.0] — Zinc Fox (2026-07-12)

- feat: migrate config to camelCase and add runtime config management endpoints

## [1.0.1] — Iron Fox (2026-07-11)

- chore: remove MQTT command features and simplify architecture

## [1.0.0] — Iron Fox (2026-07-11)

- feat: add sensor-telemetry MQTT-to-Prometheus bridge
