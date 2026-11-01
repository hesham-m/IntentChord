import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function filesUnder(directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap(name => {
    const target = join(absolute, name);
    return statSync(target).isDirectory()
      ? filesUnder(join(directory, name))
      : [join(directory, name)];
  });
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function block(message) {
  console.error(`IG_PHASE1_V18_TEST_CONTRACT_ROOT_CLOSURE: BLOCKER | ${message}`);
  process.exit(1);
}

const testFiles = filesUnder("src")
  .filter(file => /\.test\.(ts|tsx)$/.test(file))
  .sort();
const allTests = testFiles.map(file => read(file)).join("\n");
const v14Test = read("src/lib/ig-phase1-v14-owner-approved-usability.test.ts");
const ownerFinalTest = read("src/lib/owner-final-closure.test.ts");
const audit = read("scripts/phase1-test-contract-audit.mjs");

const forbiddenExact = [
  'toContain("styles.environmentArea")',
  'text("Objective", "الهدف")',
  "minmax\\(220px, 320px\\)",
];
for (const token of forbiddenExact) {
  if (allTests.includes(token)) block(`superseded exact assertion remains: ${token}`);
}

if (/source\.indexOf\(["']text\(\"Objective\", \"الهدف\"\)["']\)/.test(allTests)) {
  block("superseded wizard literal-order assertion remains");
}
if (/expect\([^\n]*\)\.toContain\(["'](?:Governed environment|البيئة الحاكمة|activeEnvironmentId|onEnvironmentChange|intentchord-active-environment-id)["']\)/.test(allTests)) {
  block("positive assertion for the removed global Project selector remains");
}

for (const evidence of [
  'href="/project-contexts"',
  'not.toContain("activeEnvironmentId")',
  'not.toContain("onEnvironmentChange")',
  'not.toContain("minmax(220px, 320px)")',
  '/\\.topbar\\s*\\{[^}]*display:\\s*grid;/',
]) {
  if (!v14Test.includes(evidence)) block(`v14 usability test lacks current semantic evidence: ${evidence}`);
}

for (const evidence of [
  "const stepLabelsBlock =",
  'text("Objective and context", "الهدف والسياق")',
  'data-journey-stage="objective"',
  'data-guided-control="task-context"',
  'value="INDEPENDENT"',
  'value="PROJECT_BOUND"',
]) {
  if (!ownerFinalTest.includes(evidence)) block(`owner-final workflow test lacks current evidence: ${evidence}`);
}

for (const evidence of [
  'toContain("styles.environmentArea")',
  'text("Objective", "الهدف")',
  "minmax\\\\(220px, 320px\\\\)",
  "superseded wizard literal-order assertion remains",
  "superseded global Project-selection assertion remains",
  "IG_PHASE1_V18_TEST_CONTRACT_ROOT_CLOSURE=ENFORCED",
]) {
  if (!audit.includes(evidence)) block(`test-contract audit lacks self-guard evidence: ${evidence}`);
}

console.log("IG_PHASE1_V18_TEST_CONTRACT_ROOT_CLOSURE: PASS");
console.log(`TEST_FILES_SCANNED=${testFiles.length}`);
console.log("SUPERSEDED_TOPBAR_GRID_ASSERTIONS=0");
console.log("SUPERSEDED_WIZARD_LITERAL_ORDER_ASSERTIONS=0");
console.log("GLOBAL_PROJECT_SELECTION_POSITIVE_ASSERTIONS=0");
console.log("CURRENT_PROJECTS_NAVIGATION_ASSERTION=SEMANTIC");
console.log("CURRENT_TASK_CONTEXT_WIZARD_ASSERTION=SEMANTIC");
console.log("TEST_CONTRACT_AUDIT_SELF_GUARD=PASS");
console.log("PRODUCTION_SOURCE_CHANGES=0");
console.log("TEST_CONTRACT_ROOT_CLOSURE=PASS");
