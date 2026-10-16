# Sensor Telemetry Services — Engineering Decisions

This document records significant architectural and engineering decisions made during the development of the Sensor Telemetry Services.
Each decision documents its context, rationale, and consequences to preserve design intent and prevent unnecessary reconsideration.

---

These are decisions inferred from the current implementation and tests, not separately dated historical ADR approvals. Consult `CHANGELOG.md` for version history.

## D-01 — Validate configuration at every entry point

**Decision:** A strict Zod schema validates startup, write and reload inputs. Topics are exact and case-fold-unique. **Why:** Prevent silent fallback and routing collisions. **Consequence:** Unknown legacy keys and unsupported wildcard topic filters fail fast (`code/src/schemas/config.ts`).

## D-02 — Separate runtime changes from construction-time settings

**Decision:** Only log controls and stale eviction update live; broker, subscriptions, port, label identity limits and Loki destination require restart. **Why:** These parameters are bound into constructed transports or metric families. **Consequence:** Persisted configuration may differ from running behavior until restart; report changed restart-only keys (`MqttNetworking.updateConfig`).

## D-03 — Treat MQTT and HTTP input as adversarial

**Decision:** Cap MQTT payloads at 64 KiB, narrow parsed objects, validate fields, bound logged values, and throttle event-specific warnings. **Why:** Protect correctness and observability from hostile/malformed publishers and probes. **Consequence:** Invalid messages are dropped with reason counters even if repeated warnings are suppressed (`MqttNetworking.ts`, `SystemFunctions.ts`, `PrometheusWriter.ts`).

## D-04 — Bound Prometheus cardinality without silent label merging

**Decision:** Sanitize labels, hash-disambiguate lossy collisions, reserve overflow labels, count rejections, and optionally evict stale series. **Why:** Unbounded or colliding source labels damage metric reliability. **Consequence:** Some inputs map to fallbacks; source admission slots can be reclaimed by stale eviction (`PrometheusWriter.ts`).

## D-05 — Separate liveness from readiness

**Decision:** `/health` only checks process responsiveness; `/ready` also requires broker connection and acknowledged subscriptions. **Why:** A running HTTP process may be unable to ingest telemetry. **Consequence:** Operators must use readiness for ingestion-sensitive checks (`PrometheusWriter.ts`).

## D-06 — Isolate Loki transport failures

**Decision:** Console logging remains available; Loki batches have bounded sizes and time, failures drop batches and report directly to `console.error`, never recurse through Winston. **Why:** Log delivery must not destabilize telemetry ingestion. **Consequence:** Loki is best effort; observability should monitor transport errors (`LokiTransport.ts`).

## D-07 — Atomic config replacement and unprivileged Docker

**Decision:** Write YAML using temporary file plus rename and run as uid 1000. **Why:** Avoid partial config files and unnecessary root privileges. **Consequence:** Bind mount must be a writable directory, not a single config file (`SystemFunctions.ts`, `code/Dockerfile`).

## D-08 — Single shared Prometheus registry

**Decision:** Use an idempotent `initializeDefaultMetrics()` to register `collectDefaultMetrics()` once into the same registry as custom metrics; avoid duplicate `process_*` families. **Why:** Duplicate metric names throw and break collection. **Consequence:** When adding custom runtime gauges, check standard names first (`PrometheusWriter.ts`).

## D-09 — Throttle persistent degraded-health reports per (source, reasons)

**Decision:** The `v3_health_degraded` warn fires on first occurrence per bounded (source, reasons-signature) key; repeats re-warn at most every 5 minutes carrying a `suppressedCount`, and the throttle map is capped (a never-tracked key at the cap logs unthrottled). **Why:** A permanently degraded sensor is a persistent state whose live value is the `sensor_health_up` gauge — warn-per-report would flood the log channel (~2,880 warns/day per sensor at a 30 s cadence) — while including the reasons in the key keeps reason changes first-occurrence-visible. **Consequence:** Steady-state degraded-warn volume is bounded; the key content is attacker-controllable payload text (unlike the rejection throttle's closed event-name set), so the map is size-capped instead of closed-set (`MqttNetworking.ts`).

## D-10 — `/restart-service` is self-SIGTERM plus the Docker restart policy, not Docker control

**Decision:** The token-authenticated `POST /restart-service` schedules a restart by having `index.ts` — the process owner — self-signal SIGTERM through a callback the HTTP layer may only *request*; the existing graceful shutdown then runs once and the Compose `restart: unless-stopped` policy starts the same container. There is no separate enable flag: a validated `RESTART_SERVICE_TOKEN` (the shared validity rule of D-11) is the switch — unset, empty, or set-but-invalid disables the endpoint with a startup warning (the service always boots; a dummy value can disable it, but only in the safe direction), and only a valid token arms it. The endpoint is fail-closed on two halves (validated secret AND injected shutdown hook) and answers the same byte-identical 503 when either half is missing, so the response cannot probe a deployment's configuration. Authentication is `Authorization: Bearer` with strict header-shape validation (duplicated headers rejected before any comparison) and constant-time comparison; the token is a distinct secret — `SENSOR_TELEMETRY_CONFIG_TOKEN` is never accepted for it. The `202` is fully delivered before shutdown starts (bounded fallback when the client disconnects first), and a single-flight guard latches for the process lifetime (released only if the callback itself throws). **Why:** No Docker socket, CLI, or SDK in the container and no root user, one tested code path shared with `docker stop`, and fail-closed enablement on every configuration state that would otherwise be an under-protected denial-of-service — while the two-half 503 closes the config-probing channel a distinct "missing callback" status would open. **Consequence:** The `202` is best-effort (the process may exit before the client finishes reading); a restart does not rebuild the image, update deployment files, or reconcile a changed `apiPort` mapping; a manually stopped container stays stopped; and a leaked token permits repeated-restart DoS, so exposure stays LAN-only with a strong token (`PrometheusWriter.ts`, `index.ts`).

## D-11 — Service tokens: one strict validity rule, disabled-not-open, and the constructor never fails on token state

**Decision:** Both service tokens (`SENSOR_TELEMETRY_CONFIG_TOKEN` and `RESTART_SERVICE_TOKEN`) are validated exactly once at startup against one shared rule — at least 32 alphanumeric characters (A–Z, a–z, 0–9), i.e. `openssl rand -hex 32` output — and an ability is enabled only when its token is valid. Unset, empty, or set-but-invalid values log a startup warning, disable the related ability, and the service always boots: the config API answers `503 {"success":false,"message":"Configuration API is disabled."}` on all three routes (resolving KI-03 — the endpoints are no longer open when the token is absent), and a request header can never grant enablement. This replaced two older behaviors: the config API's open-when-unset default and the restart endpoint's refuse-to-start on a weak token. **Why:** One rule is easier to operate and audit than two; "disabled, not open" removes the unauthenticated config surface from every unset-token deployment (KI-03) instead of papering over it with a LAN-trust assumption; and a startup refusal on a weak token was a self-inflicted crash-loop — a misconfigured environment made the *entire service* unavailable when only one endpoint was misconfigured. The strict charset also keeps validity checkable with a single ASCII regex (character count == byte count, no multibyte edge cases). **Consequence:** Breaking for 4.x deployments: unset-token deployments lose the (formerly open) config API and must set a valid token to restore it, and previously-valid weak restart tokens (e.g. 31 bytes, or base64 output with `+`/`=`) now disable the endpoint with a warning instead of failing startup (`PrometheusWriter.ts`; `PrometheusWriterConfigDisabled` and `PrometheusWriterTokenInvalid` suites).
