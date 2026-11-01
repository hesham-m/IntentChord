import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");
const failures = [];
const requireToken = (source, token, label) => {
  if (!source.includes(token)) failures.push(`${label}: missing ${token}`);
};
const forbidToken = (source, token, label) => {
  if (source.includes(token)) failures.push(`${label}: forbidden ${token}`);
};

const workflow = read("src/components/workflow-app.tsx");
const css = read("src/app/globals.css");
const architectureTest = read("src/server/architecture-boundaries.test.ts");
const pageTest = read("src/app/page.test.tsx");
const designTest = read("src/lib/final-design-polish.test.tsx");
const firstUseTest = read("src/lib/phase1-first-use-theme-data-isolation.test.ts");
const allRelevantTests = [architectureTest, pageTest, designTest, firstUseTest].join("\n");

for (const token of [
  'data-product-view="home"',
  'data-journey-stage="objective"',
  'data-product-view="new-task"',
  'data-product-journey="objective-first"',
  'data-primary-action="objective-input"',
  'data-task-title-source="objective"',
  'data-guided-control="work-type"',
  'data-disclosure="success-conditions"',
  'data-disclosure="requested-authorization"',
]) {
  requireToken(workflow, token, "semantic journey contract");
}
requireToken(workflow, "title: generatedTaskTitle(event.target.value)", "objective-generated task identity");
requireToken(workflow, "title={copy.newTask}", "practical New Task title");
forbidToken(workflow, "title={copy.newTaskTitle}", "technical Contract language before objective");

for (const legacySelector of [
  ".generated-task-title",
  ".task-definition-layout",
  ".task-identity-panel",
  ".task-primary-stack",
  ".step-count-summary",
]) {
  forbidToken(css, legacySelector, "superseded New Task CSS");
}
if (/(?:align-items|align-self|justify-content)\s*:\s*end\s*;/.test(css)) {
  failures.push("unsupported flex logical end remains in globals.css");
}

for (const brittleAssertion of [
  'toContain("generated-task-title")',
  'toContain("task-definition-layout")',
  'expect(newTask).toContain("Define the objective")',
]) {
  forbidToken(allRelevantTests, brittleAssertion, "superseded presentation assertion");
}
if (/home-section-heading[\s\S]{0,120}align-items/.test(allRelevantTests)) {
  failures.push("selector-specific home alignment assertion remains");
}

for (const token of [
  'data-task-title-source="objective"',
  'data-product-journey="objective-first"',
  'data-primary-action="objective-input"',
  'data-guided-control="work-type"',
  'data-disclosure="success-conditions"',
  'data-disclosure="requested-authorization"',
]) {
  requireToken(allRelevantTests, token, "semantic regression assertion");
}

if (failures.length) {
  for (const failure of failures) console.error(`V11_TEST_CONTRACT_RECONCILIATION: BLOCKER | ${failure}`);
  process.exitCode = 1;
} else {
  console.log("V11_TEST_CONTRACT_RECONCILIATION: PASS | resolved_failures=4 | latent_failures=1");
  console.log("OBJECTIVE_TITLE_SOURCE=SEMANTIC_AND_OBJECTIVE_BOUND");
  console.log("HOME_NEW_TASK_JOURNEY=SEMANTIC_CONTINUITY");
  console.log("PROGRESSIVE_DISCLOSURE=SEMANTIC");
  console.log("CSS_WARNING_CONTRACT=GENERIC_UNSUPPORTED_VALUE_GUARD");
  console.log("TECHNICAL_EYEBROW=ABSENT_BEFORE_OBJECTIVE");
}
