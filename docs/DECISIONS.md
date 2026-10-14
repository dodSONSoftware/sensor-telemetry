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
