import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDirectory = path.join(root, "src", "core", "workspace-index");
const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");

if (!existsSync(vitestEntry)) {
  console.error(`WORKSPACE_INDEX_VITEST_ENTRY_MISSING: ${vitestEntry}`);
  process.exit(1);
}

const testFiles = (await readdir(testDirectory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && /\.test\.(?:c|m)?[jt]sx?$/.test(entry.name))
  .map(entry => path.posix.join("src/core/workspace-index", entry.name))
  .sort((left, right) => left.localeCompare(right));

if (testFiles.length === 0) {
  console.error("WORKSPACE_INDEX_TEST_DISCOVERY_EMPTY");
  process.exit(1);
}

console.log(`WORKSPACE_INDEX_TEST_FILES_DISCOVERED=${testFiles.length}`);
for (const testFile of testFiles) console.log(`WORKSPACE_INDEX_TEST_FILE=${testFile}`);

const result = spawnSync(process.execPath, [vitestEntry, "run", ...testFiles], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`WORKSPACE_INDEX_TEST_LAUNCH_ERROR: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
