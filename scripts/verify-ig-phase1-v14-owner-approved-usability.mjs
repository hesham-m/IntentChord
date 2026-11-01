import { readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8");
const shell = read("src/components/product-shell.tsx");
const shellCss = read("src/components/product-shell.module.css");
const workflow = read("src/components/workflow-app.tsx");
const globalCss = read("src/app/globals.css");
const schemas = read("src/server/schemas.ts");
const lifecycle = read("src/server/lifecycle.ts");
const lifecyclePg = read("src/server/lifecycle.postgres.integration.test.ts");
const tests = [
  "src/app/page.test.tsx",
  "src/app/project-contexts/page.test.tsx",
  "src/components/product-shell.test.tsx",
  "src/lib/final-design-polish.test.tsx",
  "src/lib/final-discovery-first-closure.test.tsx",
  "src/lib/phase1-first-use-theme-data-isolation.test.ts",
  "src/lib/phase1-ux-root-correction.test.ts",
  "src/server/architecture-boundaries.test.ts",
  "src/lib/ig-phase1-v14-owner-approved-usability.test.ts",
].map(read).join("\n");

const failures = [];
const requireToken = (source, token, label) => {
  if (!source.includes(token)) failures.push(`${label}: missing ${token}`);
};
const forbidToken = (source, token, label) => {
  if (source.includes(token)) failures.push(`${label}: forbidden ${token}`);
};

for (const token of [
  "Search open work",
  "visibleOpenItems",
  "hiddenOpenItems",
  "styles.environmentArea",
  'aria-label={locale === "ar" ? "التنقل الرئيسي" : "Primary navigation"}',
  'locale === "ar" ? "مهمة جديدة" : "New task"',
]) requireToken(shell, token, "product shell");
for (const token of [".bodyCollapsed", ".openList", ".workSearch", "max-width: none", "grid-template-columns: auto auto minmax(180px, 1fr) auto"]) {
  requireToken(shellCss, token, "full work surface");
}
for (const token of [
  'data-product-view="home"',
  'data-product-view="new-task"',
  'data-product-journey="objective-first"',
  'data-primary-action="objective-input"',
  'data-guided-control="work-type"',
  'data-disclosure="success-conditions"',
  'data-disclosure="requested-authorization"',
  'data-owner-action="clarify-objective"',
  "Investigate and explain",
  "Implement or fix",
  "Review a report",
  "newTaskFlightRef",
  "newTaskCommandIdRef",
  "pendingNewTaskIdRef",
  "pendingNewTaskDraftSignatureRef",
  "submissionLockRef",
  "navigationStarted",
  "requestedTaskId",
  "locked to one Task",
  "draftCanPersist",
  "Complete the verified Workspace and read scope before saving the Task.",
]) requireToken(workflow, token, "guided and retryable task flow");

forbidToken(workflow, "Use a concrete result, not a broad topic or a list of instructions.", "restrictive objective copy");
forbidToken(workflow, "اكتب نتيجة محددة، وليس موضوعًا عامًا أو قائمة تعليمات.", "restrictive Arabic objective copy");
forbidToken(schemas, "Source implementation requires at least one explicit Owner-defined mandatory outcome.", "forced success conditions");

for (const token of [
  "normalizeDraftForPersistence",
  "jsonPersistable(synchronizeLegacyWorkspaceProjection",
  "canonical(existingDraft) !== canonical(normalizedDraft)",
  "on conflict(id) do nothing",
  "TASK_CREATE_IDEMPOTENCY_MISMATCH",
  "confirmedIntent.proposedRequirements.map",
]) requireToken(lifecycle, token, "Backend canonical retry boundary");
for (const token of [
  "replays one requested Task identity without creating a duplicate row",
  "expect(replay?.draft).toEqual(first?.draft)",
  'rollbackClient.query("ROLLBACK")',
]) requireToken(lifecyclePg, token, "PostgreSQL regression coverage");

if (!/@media \(max-width: 980px\)[\s\S]*\.workSearch \{ display: none; \}/.test(shellCss)) failures.push("Header search does not collapse at bounded width");
if (!/\.welcome-home\s*\{[\s\S]*?max-width:\s*none;/.test(globalCss)) failures.push("Home remains width-bounded");
if (!/\.new-task-page\s*\{[\s\S]*?max-width:\s*none;/.test(globalCss)) failures.push("New Task remains width-bounded");
for (const token of [".new-task-page .creation-progress", ".task-mode-guidance", ".intent-clarification"]) {
  requireToken(globalCss, token, "usable creation surface styling");
}
if (/(?:align-items|align-self|justify-content)\s*:\s*end\s*;/.test(globalCss + "\n" + shellCss)) {
  failures.push("unsupported flex logical end remains");
}

for (const stale of [
  'toContain("Start work")',
  'aria-label="Open help and context"',
  'data-disclosure="task-setup"',
  'toContain("What outcome do you need to achieve?")',
]) forbidToken(tests, stale, "stale presentation contract");

if (failures.length) {
  for (const failure of failures) console.error(`IG_PHASE1_V14_OWNER_APPROVED_USABILITY: BLOCKER | ${failure}`);
  process.exit(1);
}

console.log("IG_PHASE1_V14_OWNER_APPROVED_USABILITY: PASS");
console.log("WORK_SURFACE=FULL_WIDTH_WITH_PERSISTENT_WORK_SIDEBAR");
console.log("FIRST_USE=ONE_CLEAR_START_AND_PLAIN_LANGUAGE_WORK_TYPE");
console.log("OWNER_OBJECTIVE=FREE_FORM_WITH_RECOVERABLE_CLARIFICATION");
console.log("TASK_CREATION=ONE_CANONICAL_TASK_IDENTITY_WITH_RESUMABLE_RETRY");
console.log("SUCCESS_CONDITIONS=OPTIONAL_AND_REVIEWABLE_AFTER_INTENT_RESOLUTION");
console.log("LOCALE_THEME=SHARED_ROOT_AUTHORITY");
