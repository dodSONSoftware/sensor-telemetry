# Sensor Telemetry Services — Testing

This document defines the testing strategy, procedures, and validation requirements for the Sensor Telemetry Services.
It establishes how functionality, reliability, and correctness are verified before changes are accepted.

---

## Quality gate

All commands run from `code/`:

```bash
cd code
npm ci
npm run build
npm run lint
npm test -- --runInBand
npm run test:coverage -- --runInBand
```

`npm run build` invokes `tsc` and copies `config.yml` into `dist/`. `npm test` invokes Jest through `ts-jest`, with `tsconfig.jest.json` and `jest.setup.ts`; test suites live under `tests/__tests__/`. Running a focused suite (from `code/`): `npx jest tests/__tests__/dodsonlabs/PrometheusWriterDefaultMetrics.test.ts --runInBand`. Use `/blt` in Claude Code to run its build/lint/test workflow; it does not commit.

## Suite map

| Area | Existing suites / concerns |
| --- | --- |
| Startup and shutdown | `StartupEvents`, `StartupFatalHandlers`, `dodsonlabs/StartupWait` — readiness, handler timing and fatal paths. |
| MQTT | `MqttNetworking`, `MqttNetworkingRouting`, `MqttNetworkingRejectionThrottle` — subscription and routing, invalid payload handling, throttling, counters. |
| Metrics / HTTP | `PrometheusWriter` and specialized `PrometheusWriter*` suites — source/firmware identity, collision handling, cardinality, stale eviction, default/service metrics, token/auth audit, rejected messages, listen failures. `PrometheusWriterRestart` (+ `RestartDisabled` / `RestartCallbackFailure` / `RestartNoCallback`) cover `/restart-service`: Bearer auth (shape, duplicate/comma-joined header rejection, constant-time compare), method/CORS rejections, single-flight 409, response-before-shutdown ordering, client disconnect, the byte-identical 503 for each missing half, fail-fast startup on a weak token, and callback failure recovery. Each writer suite constructs exactly one real writer (prom-client global registry is per-Jest-file). |
| Logging | `Logger`, `LokiTransport` — redaction, buffering, delivery failures and shutdown. |
| Shared/config | `common/global`, `SystemFunctions`, `schemas/config` — helpers, startup schema and validation. |

## Important test isolation

`PrometheusWriter` constructor starts a **real HTTP server**. MQTT unit tests mock it; assert calls on the constructed instance, with configured return values on the mock prototype and state restored after each test. For HTTP, metric and stale-series integration behavior, use a real writer on an available port, scrape `/metrics`, and close it in cleanup. Global prom-client registry state must be isolated/reset between tests as appropriate; verify `collectDefaultMetrics()` is registered at most once. Tests exercising failures should assert accounting independently of throttled log output.

## Change-specific checks

- **Config/schema:** unknown key rejection, port and broker validation, invalid topics, min source-label length, optional defaults, live versus restart-only diff, atomic write and reload.
- **MQTT/device:** malformed JSON, oversized payload, non-object JSON, unsupported device, non-finite numbers, missing optional fields, range conversion, rejected reason counters, subscription failures.
- **Metrics:** no family-name collision, source/firmware sanitization collision, capped identity and overflow counters, stale-series cleanup, bounded `path` labels, readiness transition.
- **Security/logging:** token presence/absence, constant-time check behavior, CORS exact-origin filtering, audit secrecy, recursive secret redaction and input-log bounding. Restart endpoint: the three `RESTART_SERVICE_TOKEN` states (unset/empty, valid ≥32 bytes, weak → startup failure), Bearer-shape and duplicate-header rejection, restart-token rejection (never the config token), audit secrecy, fail-fast construction.
- **Lifecycle:** synchronous construction failure, repeated shutdown signals, shutdown deadline, MQTT cleanup, Loki failures and final flush ordering. Restart dispatch reuses the SIGTERM path (source-pinned in `StartupFatalHandlers`); a throwing callback must release the single-flight guard rather than escalate to the fatal handlers.

## Acceptance

For documentation-only changes, run build/lint/tests to establish that the packaged source remains intact; also check relative links and filenames. For behavior changes, add/extend regression coverage alongside implementation. Do not claim a test passed without recording its actual result. See [INVARIANTS.md](INVARIANTS.md) for contracts to preserve.
