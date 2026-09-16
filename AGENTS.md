# AGENTS.md

## Project overview
This repository is the Monitoring ARIFIN application: a Bun-based real-time monitoring system for airport/navigation equipment with a web UI, background collectors, SNMP/Modbus/TCP logic, and file-based datastore assets under `db/` and `data/`.

## Primary runtime
- Use Bun as the default runtime for scripts and app startup.
- Main app entrypoint: `src/server.ts`
- Common commands are defined in `package.json`.

## Working rules
- Prefer minimal, localized changes over broad refactors.
- Preserve the existing project structure and naming conventions.
- Keep configuration values and runtime assumptions aligned with the repo's current Bun/Elysia architecture.
- Do not hardcode credentials or secrets into source files.
- If a change affects parsing, networking, or data collection, validate it with the most targeted command or script available.

## Common tasks
- Start dev server: `npm run dev`
- Start app: `npm start`
- Start PM2 production stack: `npm run pm2:start`
- Install dependencies: `npm install`
- Run a project-specific script: use the repo's existing `*.js` or Bun entrypoints under `src/` and root-level scripts.

## Important directories
- `src/` — application, services, parsers, server code
- `db/` — JSON configuration and runtime data
- `public/` — web assets
- `simulators/` — protocol simulators for testing
- `logs/` — runtime logs

## Validation guidance
- Prefer the smallest relevant verification command that checks real behavior.
- If a task is data parsing or protocol handling, run the closest existing test or script instead of a broad suite.
- Treat the repo as a mixed runtime project: some scripts are Node-compatible, others are Bun-specific.

## Notes
This repo appears to be an operational monitoring system rather than a generic clean app. Favor compatibility with current infrastructure, logs, and config structures over introducing new frameworks or conventions.
