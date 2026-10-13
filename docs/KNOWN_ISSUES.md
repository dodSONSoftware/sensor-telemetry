# Sensor Telemetry Services — Known Issues

This document tracks known defects, limitations, and unresolved problems affecting the Sensor Telemetry Services.
Each issue documents its impact, current status, and any available workaround until it is resolved.

---

No additional unverified defects are asserted here. The following are **confirmed implementation/deployment limitations**, not necessarily bugs.

| ID | Status | Limitation / impact | Workaround or improvement |
| --- | --- | --- | --- |
| KI-01 | Open — deployment constraint | Changing `apiPort` in YAML alone leaves Compose port forwarding and image healthcheck on 32002. | Update `config.yml`, Compose ports and Dockerfile healthcheck/EXPOSE together; later derive all from one runtime setting. |
| KI-02 | Open — deployment constraint | A file bind mount or unwritable `/app/configs` directory blocks atomic `/write-config` replacement. | Mount the containing directory read-write, owned by uid/gid 1000. |
| KI-03 | Open — security configuration | If `SENSOR_TELEMETRY_CONFIG_TOKEN` is absent, read/write/reload routes accept unauthenticated requests. Permissive CORS does not protect them. | Set token and restrict network exposure; consider requiring auth by default. |
| KI-04 | Open — functional behavior | MQTT broker/topic, HTTP port, label limits and `lokiUrl` changes are not hot-reloaded. | Restart the process after persisting restart-only keys. |
| KI-05 | Open — observability tradeoff | Loki transport is best effort: failed batches are dropped; logs cannot be replayed after transport recovery. | Keep console logs/collector; monitor throttled transport errors; evaluate durable buffering only if needed. |
| KI-06 | Open — metric lifecycle | Without `staleSourceRemovalSecs`, source series persist until restart. With eviction, removal occurs on a periodic sweep, not exactly at the threshold. | Enable a comfortably long expiry (above publisher interval) or alert using last-seen time in Prometheus. |
| KI-07 | Open — payload scope | MQTT wildcard subscription filters are intentionally unsupported and unknown V3 device categories are rejected. | Configure exact topics; add supported devices via explicit routing and tests. |

## Maintenance protocol

When a limitation is fixed, mark it **Resolved**, cite the relevant code/test and release version, or remove it after moving the resolution to `CHANGELOG.md`. Do not describe unverified suspicions as confirmed production defects.
