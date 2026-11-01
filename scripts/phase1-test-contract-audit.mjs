import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

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

function fail(message) {
  console.error(`PHASE1_TEST_CONTRACT_AUDIT: BLOCKER | ${message}`);
  process.exitCode = 1;
}

const testFiles = filesUnder("src")
  .filter(file => /\.test\.(ts|tsx)$/.test(file))
  .sort();
const allTests = testFiles.map(file => read(file)).join("\n");

const supersededAssertions = [
  'class="nav-link active"',
  "home-shell",
  "brand-lockup",
  "width: min(96vw, 1760px)",
  ".topbar .primary-nav",
  'toContain("New Task")',
  'toContain("Add Workspace")',
  'toContain("Decisions")',
  'expect(shell).toContain("هدف واضح • تنفيذ منضبط • نتائج قابلة للتحقق")',
  'toContain("generated-task-title")',
  'toContain("task-definition-layout")',
  'toContain("candidate.intentResolution?.confirmedAt")',
  'toContain("discoveryTerminal")',
  'toContain("styles.environmentArea")',
  'text("Objective", "الهدف")',
  "minmax\\(220px, 320px\\)",
];

for (const token of supersededAssertions) {
  if (allTests.includes(token)) fail(`superseded presentation assertion remains: ${token}`);
}
if (/home-section-heading[\s\S]{0,120}align-items/.test(allTests)) {
  fail("superseded selector-specific home alignment assertion remains");
}
if (/expect\(newTask\)\.toContain\(["']Define the objective["']\)/.test(allTests)) {
  fail("superseded New Task copy-literal assertion remains");
}
if (/source\.indexOf\(["']text\(\"Objective\", \"الهدف\"\)["']\)/.test(allTests)) {
  fail("superseded wizard literal-order assertion remains");
}
if (/expect\([^\n]*\)\.toContain\(["'](?:Governed environment|البيئة الحاكمة|activeEnvironmentId|onEnvironmentChange|intentchord-active-environment-id)["']\)/.test(allTests)) {
  fail("superseded global Project-selection assertion remains");
}

const requiredFiles = [
  "src/components/product-shell.tsx",
  "src/components/product-shell.module.css",
  "src/components/product-shell.test.tsx",
  "src/lib/phase1-ux-root-correction.test.ts",
  "src/lib/product-preferences.ts",
  "scripts/integration-data-maintenance.mjs",
  "scripts/backup-intentchord-database.mjs",
  "scripts/verify-v9-failure-regressions.mjs",
  "scripts/verify-v11-test-contract-reconciliation.mjs",
  "scripts/verify-ig-phase1-v15-full-check-closure.mjs",
  "scripts/verify-ig-phase1-v17-runtime-gate1-task-project-context.mjs",
  "scripts/verify-ig-phase1-v18-test-contract-root-closure.mjs",
];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) fail(`required Phase 1 contract file missing: ${file}`);
}

const shell = read("src/components/product-shell.tsx");
const shellCss = read("src/components/product-shell.module.css");
const workflow = read("src/components/workflow-app.tsx");
const preferences = read("src/lib/product-preferences.ts");
const v9Regression = read("scripts/verify-v9-failure-regressions.mjs");
const v11Regression = read("scripts/verify-v11-test-contract-reconciliation.mjs");
const v15Regression = read("scripts/verify-ig-phase1-v15-full-check-closure.mjs");
const v17Regression = read("scripts/verify-ig-phase1-v17-runtime-gate1-task-project-context.mjs");
const v18Regression = read("scripts/verify-ig-phase1-v18-test-contract-root-closure.mjs");
const v14UsabilityTest = read("src/lib/ig-phase1-v14-owner-approved-usability.test.ts");
const ownerFinalTest = read("src/lib/owner-final-closure.test.ts");

const requiredShellEvidence = [
  [shell, 'aria-current={child.active ? "page" : undefined}', "active task-stage accessibility"],
  [shell, 'href="/project-contexts"', "Projects navigation"],
  [shell, '"المشاريع"', "Arabic Projects navigation"],
  [shell, "Switch to English", "English language control"],
  [shell, "التبديل إلى العربية", "Arabic language control"],
  [shell, "translations[locale].runs", "canonical Run History ledger label"],
  [shell, "visibleOpenItems", "persistent open-work sidebar"],
  [shellCss, ".bodyCollapsed", "desktop task-stage rail"],
  [shellCss, ".openList", "open-work sidebar list"],
  [shellCss, ".workSearch", "open-work search"],
  [shellCss, "max-width: none", "unconstrained workbench canvas"],
  [workflow, "newTaskFlightRef", "single-flight task creation"],
  [workflow, "newTaskCommandIdRef", "stable request identity before Task creation"],
  [workflow, "requestedTaskId", "Backend-bound create idempotency key"],
  [workflow, "pendingNewTaskIdRef", "created task reuse after downstream interruption"],
  [workflow, "submissionLockRef", "single-flight UI action lock"],
  [workflow, "pendingNewTaskDraftSignatureRef", "same-task draft revision recovery"],
  [workflow, 'data-owner-action="clarify-objective"', "clarification recovery surface"],
  [shellCss, "--chrome: #0b1624", "dark theme chrome token"],
  [preferences, 'taskProjectContextPersistence = "POSTGRESQL_TASK_REVISION_ONLY"', "Task revision project-context authority"],
  [preferences, 'globalProjectAutoSelection = "FORBIDDEN"', "global Project auto-selection prohibition"],
  [workflow, "availableRegisteredWorkspaces", "Project-linked Workspace filtering"],
  [workflow, 'value="INDEPENDENT"', "independent Task choice"],
  [workflow, 'value="PROJECT_BOUND"', "Project-bound Task choice"],
  [workflow, 'data-product-view="home"', "practical Home surface"],
  [workflow, 'data-journey-stage="objective"', "shared objective journey stage"],
  [workflow, 'data-product-view="new-task"', "New Task product surface"],
  [workflow, 'data-product-journey="objective-first"', "objective-first New Task structure"],
  [workflow, 'data-primary-action="objective-input"', "objective as first meaningful action"],
  [workflow, 'data-task-title-source="objective"', "generated title bound to objective"],
  [workflow, 'data-guided-control="work-type"', "plain-language work type guidance"],
  [workflow, 'data-disclosure="success-conditions"', "optional success conditions"],
  [workflow, 'data-disclosure="requested-authorization"', "authorization progressively disclosed"],
  [v9Regression, "resolved_assertions=3", "v9 failed-assertion regression harness"],
  [v9Regression, "TOPBAR_TAGLINE=ABSENT_BY_COMPACT_ASSET_ROLE", "compact Topbar branding boundary"],
  [v11Regression, "resolved_failures=4", "v11 failed-test regression count"],
  [v11Regression, "latent_failures=1", "v11 latent-test regression count"],
  [v15Regression, "CREATE_IDEMPOTENCY_SOURCE=RELATIONAL_REVISION_ZERO", "v15 relational idempotency closure"],
  [v15Regression, "TASKS_DRAFT_READS=0", "v15 tasks.draft read prohibition"],
  [v17Regression, "GLOBAL_PROJECT_SELECTION=REMOVED", "v17 global Project selection removal"],
  [v17Regression, "TASK_CONTEXT=INDEPENDENT_OR_PROJECT_BOUND", "v17 explicit Task context"],
  [v18Regression, "TEST_CONTRACT_ROOT_CLOSURE=PASS", "v18 test-contract root closure"],
  [v14UsabilityTest, 'href="/project-contexts"', "v14 Projects-navigation semantic assertion"],
  [v14UsabilityTest, 'not.toContain("activeEnvironmentId")', "v14 global Project-selection absence assertion"],
  [ownerFinalTest, "const stepLabelsBlock =", "current wizard-order semantic block"],
  [ownerFinalTest, 'data-guided-control="task-context"', "explicit Task-context wizard assertion"],
];
for (const [source, evidence, label] of requiredShellEvidence) {
  if (!source.includes(evidence)) fail(`missing ${label}: ${evidence}`);
}

if (/locale\s*===\s*["']ar["']\s*\?\s*["']قرارات["']\s*:\s*["']Decisions["']/.test(shell)) {
  fail("ProductShell still hardcodes the superseded Decisions / قرارات ledger label");
}
if (shell.includes("هدف واضح • تنفيذ منضبط • نتائج قابلة للتحقق")) {
  fail("ProductShell reintroduced the approved tagline into the compact Topbar shell");
}
if (workflow.includes("title={copy.newTaskTitle}")) {
  fail("New Task still exposes technical Contract language before the objective");
}
if (!workflow.includes("title={copy.newTask}")) {
  fail("New Task practical title contract is missing");
}

const directLifecycleStorage = [...workflow.matchAll(/localStorage\.(?:getItem|setItem)\(([^)]+)\)/g)]
  .map(match => match[1])
  .filter(argument => !/localeStorageKey|intentchord-theme/.test(argument));
if (directLifecycleStorage.length) {
  fail(`WorkflowApp directly persists non-presentation state: ${directLifecycleStorage.join(", ")}`);
}

const productionFiles = filesUnder("src")
  .filter(file => /\.(ts|tsx)$/.test(file))
  .filter(file => !/\.test\.(ts|tsx)$/.test(file))
  .filter(file => !file.split(sep).includes("test"));
const production = productionFiles.map(file => read(file)).join("\n");
if (production.includes('from "@/test/fixtures')) {
  fail("Production source imports test fixtures");
}
if (workflow.includes("owner-row-audit")) fail("Advanced Audit remains repeated inside owner work rows");

const db = read("src/server/db.ts");
const lifecyclePg = read("src/server/lifecycle.postgres.integration.test.ts");
for (const evidence of ["bindRollbackOnlyTestClient", "SAVEPOINT", "ROLLBACK_ONLY_TEST_CLIENT_BLOCKED"]) {
  if (!db.includes(evidence)) fail(`rollback-only database boundary missing: ${evidence}`);
}
for (const evidence of ['rollbackClient.query("BEGIN")', 'rollbackClient.query("ROLLBACK")', 'import type { PoolClient } from "pg";', 'let rollbackClient: PoolClient | undefined;', 'rollbackClient?.release()']) {
  if (!lifecyclePg.includes(evidence)) fail(`PostgreSQL integration rollback contract missing: ${evidence}`);
}
if (lifecyclePg.includes('Awaited<ReturnType<ReturnType<typeof databasePool>["connect"]>>')) {
  fail("PostgreSQL rollback client uses the overloaded Pool.connect ReturnType trap");
}

if (!process.exitCode) {
  console.log("============================================================");
  console.log(" IntentChord Phase 1 Test-Contract Audit");
  console.log("============================================================");
  console.log(`TEST_FILES_SCANNED=${testFiles.length}`);
  console.log(`PRODUCTION_TS_TSX_FILES_SCANNED=${productionFiles.length}`);
  console.log("SUPERSEDED_PRESENTATION_ASSERTIONS=0");
  console.log("RUN_LEDGER_LABEL=RUN_HISTORY_CANONICAL");
  console.log("GLOBAL_PROJECT_SELECTION=REMOVED");
  console.log("TASK_CONTEXT=AUTHORITATIVE_TASK_REVISION");
  console.log("ACTIVE_TASK_STAGE_ACCESSIBILITY=PASS");
  console.log("HOME_CLARITY_THEME_AND_ROLLBACK_CONTRACT=PASS");
  console.log("POSTGRES_ROLLBACK_CLIENT_TYPING=EXPLICIT_POOL_CLIENT");
  console.log("V9_FAILED_ASSERTIONS_REGRESSION=ENFORCED");
  console.log("V11_TEST_CONTRACT_RECONCILIATION=ENFORCED");
  console.log("IG_PHASE1_V14_OWNER_APPROVED_USABILITY=ENFORCED");
  console.log("IG_PHASE1_V15_FULL_CHECK_CLOSURE=ENFORCED");
  console.log("IG_PHASE1_V17_RUNTIME_GATE1_TASK_PROJECT_CONTEXT=ENFORCED");
  console.log("IG_PHASE1_V18_TEST_CONTRACT_ROOT_CLOSURE=ENFORCED");
  console.log("INTENT_CONFIRMATION_ASSERTION=RESOLVED_STATE_SEMANTIC");
  console.log("PHASE1_TEST_CONTRACT_AUDIT=PASS");
}
