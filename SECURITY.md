# IntentChord — Security Policy

IntentChord is experimental, owner-operated source and has **not** been certified for production use. On 2026-11-01, npm audit reported zero known dependency advisories in both full and production-only scopes after pinning minimatch 11.0.1 and adding a guarded legacy ESLint import compatibility bridge in postinstall. This does not constitute a security certification, an assertion that new advisories cannot arise, or full production database acceptance.

## Reporting a security problem

**Do not disclose secrets, credentials, private customer data or exploit steps in public issues or Pull Requests.**

When the GitHub repository enables private vulnerability reporting, use its **Security → Report a vulnerability** entry. If that option is not enabled, do not disclose sensitive findings publicly; request a private reporting channel from the repository maintainer without posting exploit details.

No bounty, response time, support SLA or guaranteed security remediation is promised.

## Safe local evaluation

Use a separate PostgreSQL development database, test-only credentials and an isolated environment. Never run the project's migrations or scripts against a production system without independent authorization. Keep private .env.local files, tokens, database exports, local logs, customer evidence and machine-specific artifacts out of Pull Requests.

The documented development setup does not establish a security certification or approval for commercial production deployment.
