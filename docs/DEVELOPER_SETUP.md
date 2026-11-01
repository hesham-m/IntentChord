# Developer Setup — IntentChord

This guide reproduces the preserved IntentChord source in an **isolated development environment**. It does not imply production readiness.

## Prerequisites

- Node.js 25.2.1 and npm 11.6.2 as required by the preserved toolchain.
- Windows for Windows-native workspace and filesystem authority; .NET SDK for relevant C# helpers.
- A dedicated PostgreSQL development database for backend functionality. Never connect development scripts to production or customer systems.
- Copy [.env.example](../.env.example) to a private .env.local and supply development-only credentials. Do not commit .env.local.

## Commands

    npm run toolchain:check
    npm ci
    npm run lint
    npm run typecheck
    npm run build
    npm run dev

**Verified source baseline (2026-11-01):** clean npm ci, TypeScript, ESLint, Next.js production build and .NET native build passed on Windows. Focused validation: 104/104 non-Native tests, 11/11 R4 PostgreSQL tests and 153/153 isolated Windows-native USN tests PASS (268/268). The wider end-to-end and full PostgreSQL suites, as well as automatic cold-start crash recovery, remain outside these claims. Do not run migrations against production or disable database identity guards.

## Pinned ESLint/minimatch compatibility

The complete development dependency audit currently resolves minimatch 11.0.1. A narrowly scoped, exact-version-guarded postinstall bridge restores the legacy callable CommonJS and default ESM exports consumed by existing ESLint plugins. Run standard npm ci with scripts enabled; npm ci --ignore-scripts does not prepare the required dev-tool compatibility exports. Any upgrade to the relevant plugins or minimatch must revalidate this bridge and remove it when unnecessary. This changes no application algorithm or runtime database/authority policy.

## Focused tests

    npx vitest run src/core/ai-context-mapper/validator.test.ts src/core/ai-context-mapper/security.test.ts src/core/contracts/resolver.test.ts src/core/workspace-index/canonical.test.ts --maxWorkers=2

These four focused test commands were an earlier baseline. The latest isolated validation covers the 104-case non-Native group and all 11 R4 PostgreSQL linking checks; the 153/153 PASS Windows Native USN suite requires a real authenticated LocalSystem service. See [native USN testing](../TESTING_NATIVE_USN.md). The /login smoke check does not prove a production authentication workflow.

## Product workflow

The intended flow is: Owner intent → source/authority binding → governed analysis and context → scope confirmation → authorized Run with evidence/report → deterministic verdict → human final decision.

Never publish credentials, machine-local artifacts, logs, private owner reports, live databases or original Git working-tree metadata.
