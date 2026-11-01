import { spawnSync } from "node:child_process";
import path from "node:path";

const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestEntry, "run", "--testTimeout=180000", "--bail=1", "src/server/lifecycle.postgres.integration.test.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, INTENTCHORD_ROLLBACK_ONLY_PG_TEST: "1" },
  stdio: "inherit",
});
if (result.error) {
  console.error(`LIFECYCLE_POSTGRES_TEST_LAUNCH_ERROR: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
