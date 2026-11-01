import { spawnSync } from "node:child_process";
import path from "node:path";

const suites = [
  ["Project Truth PostgreSQL", "scripts/run-project-truth-postgres-tests.mjs"],
  ["AI Context Mapper PostgreSQL", "scripts/run-ai-context-mapper-postgres-tests.mjs"],
  ["Workspace Analysis PostgreSQL", "scripts/run-workspace-analysis-postgres-tests.mjs"],
  ["Lifecycle PostgreSQL", "scripts/run-lifecycle-postgres-tests.mjs"],
];

for (const [label, runner] of suites) {
  const runnerPath = path.join(process.cwd(), runner);
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: process.cwd(),
    env: { ...process.env, INTENTCHORD_ROLLBACK_ONLY_PG_TEST: "1" },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`POST_MIGRATION_POSTGRES_LAUNCH_ERROR [${label}]: ${result.error.message}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    console.error(`POST_MIGRATION_POSTGRES_SUITE_FAILED [${label}] exit=${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
}
console.log("POST_MIGRATION_POSTGRES_ROLLBACK_ONLY=PASS");
