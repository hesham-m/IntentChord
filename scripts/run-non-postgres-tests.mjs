import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tests = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (/\.test\.(ts|tsx)$/.test(name) && !/\.postgres\.integration\.test\.(ts|tsx)$/.test(name)) tests.push(relative(root, full).replaceAll("\\", "/"));
  }
}
walk(join(root, "src"));
tests.sort();
if (!tests.length) throw new Error("NON_POSTGRES_TEST_SET_EMPTY");
const leaked = tests.filter(test => test.includes(".postgres.integration.test."));
if (leaked.length) throw new Error(`POSTGRES_TEST_LEAK_IN_NON_PG_GATE:${leaked.join(",")}`);

const timingSensitiveWindowsGovernanceTests = [
  "src/core/discovery/discovery-tools.test.ts",
  "src/core/workspace-index/filesystem-governance.test.ts",
  "src/server/workspace-source-read.test.ts",
];
for (const test of timingSensitiveWindowsGovernanceTests) {
  if (!tests.includes(test)) {
    throw new Error(`NON_POSTGRES_TIMING_SENSITIVE_TEST_MISSING:${test}`);
  }
}
const regularTests = tests.filter(test => !timingSensitiveWindowsGovernanceTests.includes(test));
const vitestEntry = join(root, "node_modules", "vitest", "vitest.mjs");

function runVitest(label, selectedTests) {
  console.log(`${label}_FILES=${selectedTests.length}`);
  const result = spawnSync(process.execPath, [vitestEntry, "run", ...selectedTests], {
    cwd: root,
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  console.log(`${label}_EXIT=${status}`);
  return status;
}

console.log(`NON_POSTGRES_TEST_FILES=${tests.length}`);
console.log(`NON_POSTGRES_TIMING_SENSITIVE_SERIAL=${timingSensitiveWindowsGovernanceTests.join(",")}`);

// T77 & T80 are real Windows timing-governance tests. Parallel execution of all files
// under high CPU contention can starve the file read helpers until deadlines expire.
// Execute timing-sensitive Windows tests without worker contention, then preserve
// normal Vitest parallelism for every other non-PostgreSQL file.
let timingSensitiveStatus = 0;
for (const timingTest of timingSensitiveWindowsGovernanceTests) {
  const status = runVitest("NON_POSTGRES_TIMING_SENSITIVE", [timingTest]);
  if (status !== 0) {
    timingSensitiveStatus = status;
    break;
  }
}
const regularStatus = runVitest("NON_POSTGRES_PARALLEL_REMAINDER", regularTests);

process.exit(timingSensitiveStatus === 0 && regularStatus === 0 ? 0 : 1);
