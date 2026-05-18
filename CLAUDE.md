# ProtoScan — Automated Figma Prototype QA

## What is this
CLI tool + library that scans Figma files and detects prototype navigation issues: dead-end screens, orphan screens, broken back-navigation, small touch targets, overlapping hotspots, missing scroll, and overlay traps. Optional AI vision layer for UX analysis.

## Architecture
- **Monorepo:** npm workspaces
- **packages/core** (MIT) — Graph analysis + spatial checks + reporters
- **packages/simulator** (MIT) — Embed Kit 2.0 prototype walker (Phase 4)
- **packages/vision** (Proprietary) — AI vision screen analysis (Phase 5)
- **apps/cli** (MIT) — CLI entry point (`protoscan scan <file-key>`)

## Tech Stack
- TypeScript (strict mode)
- Node 20+ (uses native fetch)
- Vitest for testing
- tsup for building
- Commander for CLI
- Figma REST API (interactions field, since Sep 2024)

## Key API Details
- `GET /v1/files/:key` returns `interactions[]` on every node (triggers + actions + destinations)
- `flowStartingPoints[]` on CANVAS nodes define prototype entry points
- `absoluteBoundingBox` on nodes for spatial analysis
- `overflowDirection` for scroll detection
- Rate limit: 10-20 req/min depending on plan

## Code Rules
- All source in `src/`, built to `dist/`
- ESM only (`"type": "module"`)
- No external graph libraries — BFS/DFS is simple enough inline
- No axios/got — use native `fetch` (Node 20+)
- Tests colocated: `foo.test.ts` next to `foo.ts`
- Types in `types.ts`, shared across packages

## Development Methodology
- **BMAD** for product lifecycle (brief → PRD → architecture → sprints)
- **Product Architect** for business decisions (pricing, GTM, open source strategy)
- Docs in `docs/` following BMAD templates

## Open Source Model
- MIT: `@protoscan/core`, `@protoscan/cli`, `@protoscan/simulator`
- Proprietary: `@protoscan/vision`, dashboard, CI/CD integration
- Boundary: anything using Figma REST API only = MIT. Anything needing AI API keys or server state = proprietary.
