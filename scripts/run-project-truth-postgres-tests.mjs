import { spawnSync } from "node:child_process";
import path from "node:path";

const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitestEntry, "run", "src/server/project-truth.postgres.integration.test.ts"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      INTENTCHORD_ENABLE_PROJECT_TRUTH_PG: "1",
    },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`PROJECT_TRUTH_POSTGRES_TEST_LAUNCH_ERROR: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
