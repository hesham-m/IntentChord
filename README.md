# IntentChord

**Keep humans in control of AI-assisted software development.**

IntentChord is a local-first, owner-governed development workflow that connects a task to its authorized source context, confirmed scope, agent-specific execution instructions, evidence, and a final human decision.

AI coding agents can propose changes and report success. IntentChord is designed to help answer the harder questions: **What was the agent authorized to do? What source was it working from? What evidence supports its result? Who decides whether the work is accepted?**

IntentChord is **not merely a prompt generator**: it connects agent-specific instructions to explicit source authority, evidence review, and human approval.

**This is a public, collaborative development repository.** You are welcome to inspect the code, raise issues, discuss improvements, and propose pull requests. The source is available under **PolyForm Noncommercial 1.0.0**, not an OSI-approved open-source license; please read [License and contributions](#license-and-contributions).

## What IntentChord does

- **Owner-defined tasks and authority.** Capture the intended outcome, working mode, workspace boundaries, and explicit permissions instead of treating an AI prompt as authorization.
- **Workspace and source context.** Bind work to local source; the codebase includes Windows-native filesystem discovery, indexing, identity/revision evidence, and continuity mechanisms.
- **Project Context and AI Context Mapping.** Build governed source context for AI-assisted work, with backend-managed context and engine configuration foundations.
- **Confirmed scope and execution contracts.** Establish the boundary for an authorized Run and produce provider-aware instructions for the selected execution channel.
- **Evidence-based review.** Keep agent claims separate from source evidence, reports, contract compliance, and deterministic verdict logic.
- **Human decision.** An agent's report is not the final approval. The owner reviews the result and decides what happens next.

These are the components and workflows represented in this repository. Their existence in source does **not** mean every path has completed end-to-end production acceptance.

## The workflow

1. **Define the task.** The owner chooses an objective and an appropriate mode: Controlled Audit, Source Implementation, or Report Review.
2. **Establish source authority.** Select and verify workspace/source context; use discovery and indexing evidence where applicable.
3. **Confirm the scope.** Review the allowed work and boundaries before authorizing execution. **Scope means authority, not relevance proof**: selected files are not automatically sufficient to answer the task. Source changes may require a new confirmation rather than silently extending authority.
4. **Prepare the agent-specific contract.** The governed instructions bind an execution Run to the approved task and its constraints.
5. **Review evidence and reports.** Compare what the agent claims against the contract, supplied evidence, and relevant source state.
6. **Record the human decision.** The owner decides whether the work is accepted, needs more evidence, or requires correction.

For example, if an agent says that a change is complete but provides insufficient evidence, **a confident completion message is not treated as proof**. Similarly, a change outside confirmed scope is not automatically authorized by an otherwise successful result.

### Execution channels

The current source registry defines execution channels for:

| Provider | Execution channel |
| --- | --- |
| OpenAI | Codex |
| Anthropic | Claude Code |
| Google | Gemini CLI |

These entries describe supported **contract/routing profiles** in the source. They do not imply that every external agent is automatically installed, controlled, or fully integrated end to end.

## Architecture at a glance

IntentChord separates four concerns:

- **Owner authority:** the task, source boundaries, scope confirmation, and final decision belong to the human owner.
- **Backend authority:** governed source/context state, execution lifecycle, evidence records, and verdict logic are not established by a frontend display alone.
- **Agent execution:** instructions are tailored to the execution channel, but agent self-reporting is not independent proof.
- **Traceability:** workspace revisions, reports, decisions, and evidence preserve the context needed to review a Run.

The codebase includes a Next.js / React / TypeScript interface, PostgreSQL-backed server workflows, Windows-native C# integration helpers, migrations, and tests.

## Explore the code

| Location | What's there |
| --- | --- |
| [src/core/](src/core/) | Task modes, contracts, provider profiles, policy, source-context, and verdict building blocks |
| [src/server/](src/server/) | Backend services, database-backed workflows, authority and evidence handling |
| [src/app/](src/app/) and [src/components/](src/components/) | Application routes and UI |
| [migrations/](migrations/) | PostgreSQL schema evolution |
| [scripts/](scripts/) | Guarded setup, checks, and development utilities |
| [docs/DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) | Environment setup, validation commands, and known boundaries |
| [TESTING_NATIVE_USN.md](TESTING_NATIVE_USN.md) | Requirements for Windows-native USN integration tests |
| [reports/architecture-validation/samples/](reports/architecture-validation/samples/) | Synthetic samples, not customer or private workspace data |

## Get started as a developer

This source snapshot uses **Node.js 25.2.1**, **npm 11.6.2**, and a separate **PostgreSQL development database**. Windows and a compatible .NET SDK are required for the Windows-native filesystem authority portions.

1. Read [Developer Setup](docs/DEVELOPER_SETUP.md) and review [.env.example](.env.example).
2. Configure a private `.env.local` with **development-only** credentials. Never commit it.
3. From the repository root, run:

```powershell
npm run toolchain:check
npm ci
npm run typecheck
npm run lint
npm run build
npm run dev
```

Some tests require an isolated PostgreSQL instance or an authorized Windows native service. **Do not run migrations or privileged scripts against production or customer machines.** Use the [documented test and setup guidance](docs/DEVELOPER_SETUP.md), not assumptions about a local environment.

## Help develop IntentChord

**The goal of making this source public is to develop IntentChord with other developers.** Bug reports, architecture discussions, tests, documentation improvements, and well-scoped code contributions are welcome.

- [Open an issue](https://github.com/hesham-m/IntentChord/issues) to describe a problem, ask a development question, or propose an improvement.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes, including the rules for source authority, tests, third-party material, and evidence.
- Submit a pull request with a clear scope, explanation, and relevant validation results. The project maintainer reviews and decides whether it is merged.
- The [Contributor License Agreement](CLA.md) requires **explicit, verifiable acceptance before an external contribution is merged into the official project**. It is **not required** merely to read, clone, discuss, or test the released code.

Do not put secrets, local logs, customer evidence, or confidential material in public issues or pull requests. Follow [SECURITY.md](SECURITY.md) for sensitive security findings.

## Project maturity and validation

IntentChord is an **experimental, source-available development project**, not a certified production service. The prepared public source passed clean dependency installation, TypeScript checks, ESLint, Next.js production build, and a native .NET build in the recorded Windows validation environment.

The source handoff also records targeted passing test groups (104 non-native, 11 PostgreSQL R4, and 153 Windows-native USN tests); these results have specific environments and scopes. They are **not** a claim that every historical test, end-to-end workflow, or production recovery scenario has passed. See [Developer Setup](docs/DEVELOPER_SETUP.md) for relevant test requirements.

## License and contributions

**Original creator and architect:** Hisham Mansy.

The covered original IntentChord source is released under the [PolyForm Noncommercial License 1.0.0](LICENSE), with its [required notice](NOTICE). It is **source-available**, not OSI-approved open source. Read the license for its actual permitted uses; public availability alone is not permission for unrestricted commercial reuse.

- [COMMERCIAL.md](COMMERCIAL.md): separate commercial licensing and non-confidential inquiries.
- [COPYRIGHT.md](COPYRIGHT.md): ownership and attribution.
- [BRAND_POLICY.md](BRAND_POLICY.md): project name and original branding.
- [CLA.md](CLA.md): rights for accepted external contributions.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): independent third-party licenses and the [asset/dependency inventory](docs/PUBLIC_ASSET_AND_DEPENDENCY_RIGHTS_INVENTORY.md).

Third-party software and assets retain their own licenses. No warranty, production certification, or support SLA is implied.
