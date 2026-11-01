import { spawnSync } from "node:child_process";
import path from "node:path";
import { disposableValidationUrl, safeValidationTarget } from "./current-context-disposable-validation-target.mjs";

if (process.env.INTENTCHORD_CURRENT_CONTEXT_CONCURRENCY_PG_TEST !== "1") {
  console.error("CURRENT_CONTEXT_CONCURRENCY_PG_TEST_BLOCKED: set INTENTCHORD_CURRENT_CONTEXT_CONCURRENCY_PG_TEST=1 explicitly.");
  process.exit(2);
}
let target;
try {
  disposableValidationUrl();
  target = safeValidationTarget();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
console.log(`CURRENT_CONTEXT_DISPOSABLE_PG_TARGET database=${target.database} user=${target.user} host=${target.host} port=${target.port} schema=${target.schema}`);
const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [
  vitestEntry,
  "run",
  "--testTimeout=45000",
  "--hookTimeout=60000",
  "--bail=1",
  "src/server/current-context-forward-authority-validation-harness.test.ts",
  "src/server/current-context-forward-authority-concurrency.postgres.integration.test.ts",
], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "test" },
  stdio: "inherit",
});
if (result.error) {
  console.error(`CURRENT_CONTEXT_CONCURRENCY_PG_TEST_LAUNCH_ERROR: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
