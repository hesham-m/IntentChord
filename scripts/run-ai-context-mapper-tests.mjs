import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const testFiles = readdirSync("src/core/ai-context-mapper")
  .filter(name => name.endsWith(".test.ts"))
  .map(name => path.posix.join("src/core/ai-context-mapper", name));
const serverTests = readdirSync("src/server")
  .filter(name => /^ai-context-mapper.*\.test\.ts$/.test(name) && !name.includes("postgres.integration"))
  .map(name => path.posix.join("src/server", name));
testFiles.push(...serverTests);
const internalRuntimeTest = path.posix.join("src/server", "internal-ai-engine-runtime.test.ts");
testFiles.push(internalRuntimeTest);
if (!testFiles.length) throw new Error("AI_CONTEXT_MAPPER_TEST_FILES_NOT_FOUND");
for (const file of testFiles) console.log(`AI_CONTEXT_MAPPER_TEST_FILE=${file}`);
const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestEntry, "run", ...testFiles], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
if (result.error) { console.error(`AI_CONTEXT_MAPPER_TEST_LAUNCH_ERROR: ${result.error.message}`); process.exit(1); }
process.exit(result.status ?? 1);
