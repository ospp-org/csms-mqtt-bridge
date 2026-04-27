# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-28

Initial scaffold per AUDIT v2 §0.2 (Phase 0 work item: Repo bootstrap).
No business logic yet — Phase 0.3-0.5 will add config loader, MQTT client
wrapper, and Redis bridge on top of this foundation.

### Added

- `package.json` with strict dependency set: `mqtt@^5`, `ioredis@^5`,
  `pino@^9`, `prom-client@^15` (runtime); `typescript@^5`, `vitest@^2`,
  `eslint@^9`, `typescript-eslint@^8`, `prettier@^3`, `tsx@^4` (dev).
- `tsconfig.json` — TypeScript strict mode (all strict flags), ES2022 target,
  NodeNext module resolution, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`.
- `eslint.config.js` — ESLint 9 flat config with `typescript-eslint` strict
  type-checked + stylistic rules; explicit `no-floating-promises`,
  `require-await`, `prefer-nullish-coalescing`, `prefer-optional-chain`.
- `prettier.config.js` — 2-space, single quotes, trailing commas all,
  100-char width.
- `Dockerfile` — multi-stage (deps / builder / runtime) on `node:22-alpine`,
  `tini` as PID 1, runs as `node` user. Final image targets <100 MB.
- `.dockerignore`, `.editorconfig`, `.github/workflows/ci.yml`.
- GitHub Actions CI runs lint + typecheck + test + build on push and PR.
- `src/index.ts` — minimal placeholder with `pino` logger and SIGTERM/SIGINT
  graceful shutdown hooks. Replaced in Phase 0.3.
- `README.md` — architecture diagram (ASCII), env-var placeholder table,
  build/run instructions, OSPP spec reference.

### Notes

- Phase 0.1 POC validated `mqtt@5` + Node 22+ against the UAT EMQX broker
  via mTLS. Round-trip latency was ~469ms, no compatibility issues observed.
- Server certificate convention `csms-<env>-server-<N>` (e.g.
  `csms-uat-server-1`) — provisioning happens out-of-band via the
  `ospp:generate-server-cert` artisan command in csms-server (Phase 0.6).

[Unreleased]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ospp-org/csms-mqtt-bridge/releases/tag/v0.1.0
