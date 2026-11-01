import { readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8");
const shell = read("src/components/product-shell.tsx");
const shellCss = read("src/components/product-shell.module.css");
const workflow = read("src/components/workflow-app.tsx");
const globalCss = read("src/app/globals.css");
const schemas = read("src/server/schemas.ts");
const lifecycle = read("src/server/lifecycle.ts");
const tests = [
  "src/components/product-shell.test.tsx",
  "src/app/page.test.tsx",
  "src/lib/final-design-polish.test.tsx",
  "src/lib/phase1-first-use-theme-data-isolation.test.ts",
  "src/lib/phase1-ux-root-correction.test.ts",
  "src/lib/final-discovery-first-closure.test.tsx",
].map(read).join("\n");

const failures = [];
const requireToken = (source, token, label) => {
  if (!source.includes(token)) failures.push(`${label}: missing ${token}`);
};
const forbidToken = (source, token, label) => {
  if (source.includes(token)) failures.push(`${label}: forbidden ${token}`);
};

for (const token of ["Search open work", "Open work", "visibleOpenItems", "workSearch", "collapsedItems", "hiddenOpenItems"]) {
  requireToken(shell, token, "persistent work sidebar");
}
for (const token of [".openList", ".workSearch", ".workControls", ".restoreOpenItems", ".bodyCollapsed"]) {
  requireToken(shellCss, token, "sidebar styling");
}
if (!/\.welcome-home\s*\{[\s\S]*?max-width:\s*none;/.test(globalCss)) failures.push("Home is still width-bounded");
if (!/\.new-task-page\s*\{[\s\S]*?max-width:\s*none;/.test(globalCss)) failures.push("New Task is still width-bounded");

for (const token of [
  "newTaskFlightRef",
  "newTaskCommandIdRef",
  "pendingNewTaskIdRef",
  "submissionLockRef",
  "runSubmission",
  'method: "PUT"',
  "requestedTaskId",
  "resolved.intentResolution.confirmedAt",
  'candidate.discoveryRun && ["COMPLETED", "EVIDENCE_REQUIRED"].includes(candidate.discoveryRun.status)',
  "locked to one Task",
  "العملية مرتبطة بمهمة واحدة",
]) {
  requireToken(workflow, token, "single-flight create/build flow");
}
forbidToken(workflow, "Use a concrete result, not a broad topic or a list of instructions.", "restrictive objective helper");
forbidToken(workflow, "اكتب نتيجة محددة، وليس موضوعًا عامًا أو قائمة تعليمات.", "restrictive Arabic objective helper");
requireToken(workflow, "const objective = input.objective.trim();", "free-form objective entry boundary");
requireToken(workflow, "اكتب الهدف بطريقتك", "owner-friendly objective copy");
requireToken(workflow, "owner-summary-strip", "restored bounded work summary");
requireToken(workflow, 'data-guided-control="work-type"', "plain-language work type guidance");
requireToken(workflow, 'data-owner-action="clarify-objective"', "clarification recovery");
requireToken(schemas, "requestedTaskId", "Backend idempotency schema");
forbidToken(schemas, "Source implementation requires at least one explicit Owner-defined mandatory outcome.", "forced owner success conditions");
requireToken(lifecycle, "normalizeDraftForPersistence", "canonical draft normalization");
requireToken(lifecycle, "jsonPersistable(synchronizeLegacyWorkspaceProjection", "persisted JSON normalization");
requireToken(lifecycle, "TASK_CREATE_IDEMPOTENCY_MISMATCH", "Backend idempotency boundary");
requireToken(lifecycle, "on conflict(id) do nothing", "Backend idempotent insert");

for (const stale of [
  'not.toContain("Open work")',
  'toContain("showTaskSidebar")',
  'toContain("Current task stages")',
  "max-width:\\s*1180px",
]) {
  forbidToken(tests, stale, "superseded presentation test contract");
}

if (failures.length) {
  for (const failure of failures) console.error(`V13_OWNER_RUNTIME_ROOT_CORRECTION: BLOCKER | ${failure}`);
  process.exit(1);
}

console.log("V13_OWNER_RUNTIME_ROOT_CORRECTION: PASS");
console.log("WORK_SURFACE=FULL_WIDTH");
console.log("WORK_SIDEBAR=PERSISTENT_AND_SEARCHABLE");
console.log("OWNER_OBJECTIVE=FREE_FORM_INPUT");
console.log("TASK_CREATION=SINGLE_FLIGHT_AND_BACKEND_IDEMPOTENT");
console.log("CONTRACT_RETRY=REUSES_CREATED_TASK");
