import { spawnSync } from "node:child_process";
import path from "node:path";

const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const suites = [
  "src/server/workspace-analysis.postgres.integration.test.ts",
  "src/server/workspace-index-duration-governance.postgres.integration.test.ts",
];

for (const suite of suites) {
  const result = spawnSync(process.execPath, [
    vitestEntry,
    "run",
    suite,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      INTENTCHORD_ENABLE_WORKSPACE_ANALYSIS_PG: "1",
      INTENTCHORD_ROLLBACK_ONLY_PG_TEST: "1",
    },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`WORKSPACE_ANALYSIS_POSTGRES_TEST_LAUNCH_ERROR:${suite}:${result.error.message}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
