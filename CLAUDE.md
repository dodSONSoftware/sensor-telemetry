# CLAUDE.md

Guidance for Claude Code working in Sensor Telemetry Services (Node.js 22 / TypeScript MQTT → Prometheus bridge).

## Workflow

- Read the relevant document(s) below **before modifying behavior**. Code and tests win over stale prose; update affected documentation with each change.
- Prefer minimal, targeted changes; preserve public metric names, config compatibility where possible, API behavior and telemetry validation. Add regression tests for changed contracts.
- Run `npm run build && npm run lint && npm test -- --runInBand` **from `code/`** before completion; report any failures. `/blt` performs the build/lint/test gate without committing.
- Never log secrets or unsanitized MQTT input. Never alter deployment secrets or commit `.env`.
- When releasing, `/git-commit` updates version files, CHANGELOG and README; `code/src/version.ts` `APP_VERSION`/`APP_NAME` assignments intentionally have **no trailing semicolons** for its scripts.

## Documentation map

| Reference | Read for |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Module ownership, MQTT → metrics/log pipelines, HTTP API and lifecycle. |
| [Configuration](docs/CONFIGURATION.md) | YAML keys, validation, env security, runtime/restart-only settings and Docker setup. |
| [Invariants](docs/INVARIANTS.md) | Non-negotiable input, metrics, security and shutdown contracts. |
| [Engineering Decisions](docs/DECISIONS.md) | Tradeoffs and why key design choices exist. |
| [Testing](docs/TESTING.md) | Test commands, suite mapping, mocking and quality gate. |
| [Known Issues](docs/KNOWN_ISSUES.md) | Current limitations and workarounds. |
| [Curl Commands](docs/curl-commands.md) | Copy-paste HTTP API examples for the config and restart endpoints. |
| [README](README.md) | Operator usage, API and deployment. |
| [CHANGELOG](CHANGELOG.md) | Versioned change history (newest first). |

## Layout

The repo root holds documentation only (this file, README, CHANGELOG, `docs/`); all code and code-related files — `src/`, `tests/`, `package.json`, `tsconfig*.json`, `jest.*`, `eslint.config.mjs`, `config.yml`, `Dockerfile`, `docker-compose.yml`, `docker-refresh.sh` — live in `code/`, and npm/docker commands run from there.

## Navigation

`code/src/index.ts` boots and shuts down; `code/src/dodsonlabs/MqttNetworking.ts` handles MQTT; `code/src/dodsonlabs/PrometheusWriter.ts` owns metrics and HTTP; `code/src/dodsonlabs/SystemFunctions.ts` owns typed field and logging helpers; `code/src/schemas/config.ts` validates configuration; `code/src/dodsonlabs/Logger.ts` and `LokiTransport.ts` handle redacted logs. Suites mirror `code/src` in `code/tests/__tests__/`.
