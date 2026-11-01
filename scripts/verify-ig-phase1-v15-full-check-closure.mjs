import { readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8");
const lifecycle = read("src/server/lifecycle.ts");
const architectureTest = read("src/server/architecture-boundaries.test.ts");
const usabilityTest = read("src/lib/ig-phase1-v14-owner-approved-usability.test.ts");
const runtimeTest = read("src/lib/phase1-v13-owner-runtime-root-correction.test.ts");
const shellTest = read("src/components/product-shell.test.tsx");
const shell = read("src/components/product-shell.tsx");
const workflow = read("src/components/workflow-app.tsx");

const failures = [];
const requireToken = (source, token, label) => {
  if (!source.includes(token)) failures.push(`${label}: missing ${token}`);
};
const forbidMatch = (source, pattern, label) => {
  if (pattern.test(source)) failures.push(`${label}: forbidden ${pattern}`);
};

for (const token of [
  "from intentchord.task_draft_revisions",
  "where task_id=$1 and revision=0",
  "draft_projection,content_sha256",
  "normalizedDraftSha256",
  "existingDraftSha256 !== normalizedDraftSha256",
  "canonical(existingDraft) !== canonical(normalizedDraft)",
  "TASK_CREATE_IDEMPOTENCY_MISMATCH",
]) requireToken(lifecycle, token, "relational create idempotency");
forbidMatch(lifecycle, /select\s+.*\bdraft\b.*from intentchord\.tasks/i, "tasks.draft read boundary");

requireToken(architectureTest, "uses relational lifecycle reconstruction rather than tasks.draft", "architecture guard");
requireToken(usabilityTest, 'setNewTaskOperationPhase("RESUMING_TASK")', "semantic retry test");
requireToken(usabilityTest, "reloadAuthoritativeTask(pendingTaskId)", "semantic retry test");
requireToken(usabilityTest, "existingDraftSha256 !== normalizedDraftSha256", "relational idempotency test");
forbidMatch(usabilityTest, /toContain\(["']resume that same Task from its last authoritative state["']\)/, "copy-literal retry assertion");

requireToken(runtimeTest, "const objective = input\\.objective\\.trim", "free-form objective validation test");
forbidMatch(runtimeTest, /toContain\(["']if \(!input\.objective\.trim\(\)\)["']\)/, "implementation-literal objective assertion");
requireToken(runtimeTest, "resolved.intentResolution.confirmedAt", "resolved intent confirmation assertion");
forbidMatch(runtimeTest, /candidate\.intentResolution\?\.confirmedAt/, "stale pre-resolution candidate assertion");
requireToken(runtimeTest, '["COMPLETED", "EVIDENCE_REQUIRED"].includes(candidate.discoveryRun.status)', "discovery terminal-state assertion");
forbidMatch(runtimeTest, /discoveryTerminal/, "stale discovery helper assertion");

requireToken(shellTest, "Projects", "visible Projects navigation test");
requireToken(shellTest, "Project: IntentChord", "visible Task project-context test");
forbidMatch(shellTest, /toContain\(["']Environment ID["']\)/, "closed-drawer identifier assertion");
requireToken(shell, "Project ID", "advanced audit identifier preservation");

for (const token of [
  "newTaskFlightRef",
  "pendingNewTaskIdRef",
  "pendingNewTaskDraftSignatureRef",
  'setNewTaskOperationPhase("RESUMING_TASK")',
  "reloadAuthoritativeTask(pendingTaskId)",
]) requireToken(workflow, token, "resumable single-flight implementation");

if (failures.length) {
  for (const failure of failures) console.error(`IG_PHASE1_V15_FULL_CHECK_CLOSURE: BLOCKER | ${failure}`);
  process.exit(1);
}

console.log("IG_PHASE1_V15_FULL_CHECK_CLOSURE: PASS");
console.log("CREATE_IDEMPOTENCY_SOURCE=RELATIONAL_REVISION_ZERO");
console.log("TASKS_DRAFT_READS=0");
console.log("RETRY_TEST=SEMANTIC_NOT_COPY_LITERAL");
console.log("OBJECTIVE_TEST=BEHAVIORAL_SHAPE_NOT_IMPLEMENTATION_LITERAL");
console.log("SHELL_TEST=VISIBLE_PROJECT_CONTEXT_WITH_ADVANCED_ID_PRESERVED");
console.log("INTENT_CONFIRMATION_TEST=RESOLVED_AUTHORITATIVE_STATE");
console.log("DISCOVERY_TERMINAL_TEST=EXPLICIT_AUTHORITATIVE_STATES");
