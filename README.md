# IntentChord

**IntentChord** is a local-first, owner-governed workflow for AI-assisted software development. It connects a human owner's intent to authorized workspace and source context, confirmed scope, an identity-bound execution Run, traceable evidence, and the owner's final review and decision.

IntentChord is **not merely a prompt generator**. Its core design distinguishes a model's output or agent report from proven execution evidence and explicit human authority.

**Original creator and architect:** Hisham Mansy.

## What is in this repository?

- Owner-driven tasks, scoped authority boundaries, execution contracts and deterministic report/verdict logic.
- Workspace verification, Windows source discovery, indexing, revision and continuity evidence.
- Foundations for Project Context and AI Context Mapping, with governed provider and engine configuration.
- Next.js/React user interface, PostgreSQL-backed backend, Windows-native C# helpers, migrations, validation scripts and unit tests.

These are source-code capabilities, **not a claim that every feature has passed an end-to-end production acceptance test**.

## Repository layout

| Location | Purpose |
| --- | --- |
| src/ | Application, backend, domain logic, tests and Windows-native source |
| migrations/ | PostgreSQL migrations; use a separate development database |
| scripts/ | Development, validation and controlled setup utilities |
| public/ and assets/ | Product UI and visual assets |
| docs/DEVELOPER_SETUP.md | Local setup and known limitations |
| reports/architecture-validation/samples/ | Synthetic sample data, not customer evidence |

## Developer setup

The preserved source expects Node.js 25.2.1 and npm 11.6.2, Windows for Windows filesystem-authority functionality, and PostgreSQL for backend workflows. Review the [developer setup guide](docs/DEVELOPER_SETUP.md) and [.env.example](.env.example) before configuring your isolated local environment.

    npm run toolchain:check
    npm ci
    npm run lint
    npm run typecheck
    npm run build
    npm run dev

**Verified source checks (2026-11-01): clean npm ci, TypeScript, ESLint, Next.js production build and native .NET build PASS. Focused suites: 104/104 non-Native tests, 11/11 PostgreSQL R4 tests, and 153/153 Windows-native USN tests PASS (268/268 targeted tests). Repository Step-B / Step-C real COMMIT and fresh-process recovery proof: 2/2 PASS on isolated PostgreSQL. The broader historical 2056-case suite and production cold-start recovery are not asserted as fully verified.**

## License and ownership

IntentChord's covered original source is available under [PolyForm Noncommercial License 1.0.0](LICENSE), subject to the [required copyright notice](NOTICE). This is **source-available**, not an OSI-approved open-source license. Certain organizational uses are expressly permitted by PolyForm; read the actual license, not a shorthand summary.

For commercial use outside the license's permissions, see [Commercial Licensing](COMMERCIAL.md). Pricing and terms are negotiated individually per agreement. Non-confidential first contact is available through the official repository Issues page; do not post private deal details publicly.

Original copyright belongs to the relevant rightsholder. Third-party dependencies retain their own licenses and contributors retain ownership of their original work. See [Copyright](COPYRIGHT.md), [Third-Party Notes](THIRD_PARTY_NOTICES.md), and [Brand Policy](BRAND_POLICY.md). The software license does not automatically authorize a fork to represent itself as the official IntentChord project.

## Contribute

Developers are welcome to study the source and propose improvements within the software license's terms. Read [Contributing](CONTRIBUTING.md) and the [Contributor License Agreement (CLA v1.0)](CLA.md).

The CLA is for accepting changes into the **official project**, not for simply reading or forking licensed code. Contributors keep ownership of original contributions while granting permission for the project to relicense contributions commercially. A documented, affirmative CLA acceptance is requested **before merging a contribution**, not before public publication. There is no automatic royalty or profit share.

## Security and maturity

This is experimental, owner-operated software, not a certified production system. With the pinned minimatch 11.0.1 and reproducible dev-tool compatibility bridge, npm audit reported zero current advisories (full and production-only) on 2026-11-01. The postinstall bridge exists solely for legacy ESLint module interoperability and is guarded by exact dependency version; review it on upgrades. Passing the listed tests and audit does not certify security or production readiness. Use only isolated evaluation credentials until independently approved.

Read [Security](SECURITY.md) for responsible reporting and [Developer Setup](docs/DEVELOPER_SETUP.md) for isolated operation. No production support agreement, warranty or SLA is implied.
