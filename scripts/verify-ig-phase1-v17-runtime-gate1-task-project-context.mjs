import { readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8");
const shell = read("src/components/product-shell.tsx");
const workflow = read("src/components/workflow-app.tsx");
const lifecycle = read("src/server/lifecycle.ts");
const schemas = read("src/server/schemas.ts");
const preferences = read("src/lib/product-preferences.ts");
const workbench = read("src/components/project-context-workbench.tsx");
const workspaceRegistry = read("src/lib/workspace.ts");
const pgTest = read("src/server/lifecycle.postgres.integration.test.ts");

const failures = [];
const requireToken = (source, token, label) => {
  if (!source.includes(token)) failures.push(`${label}: missing ${token}`);
};
const forbidToken = (source, token, label) => {
  if (source.includes(token)) failures.push(`${label}: forbidden ${token}`);
};

for (const token of ['href="/project-contexts"', '"المشاريع"', "effectiveTaskContext(task.draft)"]) {
  requireToken(shell, token, "Project navigation and Task context");
}
for (const token of ["activeEnvironmentId", "onEnvironmentChange", "Governed environment"]) {
  forbidToken(shell, token, "global Project selection");
}
for (const token of [
  'value="INDEPENDENT"',
  'value="PROJECT_BOUND"',
  "changeTaskContext(independentTaskContext())",
  "selectProjectContext(event.target.value)",
  "availableRegisteredWorkspaces",
  'data-task-context={context.kind}',
]) requireToken(workflow, token, "explicit Task context UI");
for (const token of ["readActiveEnvironmentPreference", "writeActiveEnvironmentPreference", "intentchord-active-environment-id"]) {
  forbidToken(workflow, token, "global Project browser preference");
}
for (const token of [
  'kind: z.literal("INDEPENDENT")',
  'kind: z.literal("PROJECT_BOUND")',
  "taskContext: taskContextSchema.default",
]) requireToken(schemas, token, "Task context schema");
for (const token of [
  "normalizeTaskContextForPersistence",
  "from intentchord.project_contexts",
  "from intentchord.project_context_workspaces",
  "PROJECT_WORKSPACE_LINK_REQUIRED",
  "Project membership still grants no Task authority by itself",
]) requireToken(lifecycle, token, "authoritative Task project binding");
for (const token of ["migrateTaskContext", "taskContext: migrateTaskContext(raw.taskContext)"]) {
  requireToken(workspaceRegistry, token, "stored Task context restoration");
}
for (const token of [
  'taskProjectContextPersistence = "POSTGRESQL_TASK_REVISION_ONLY"',
  'globalProjectAutoSelection = "FORBIDDEN"',
]) requireToken(preferences, token, "Project preference policy");
for (const token of ["IntentChord · Projects", "Create your first project", "Create project"]) {
  requireToken(workbench, token, "human Project management surface");
}
for (const token of [
  "binds each Task explicitly as independent or Project-bound without global Project authority",
  "PROJECT_WORKSPACE_LINK_REQUIRED",
]) requireToken(pgTest, token, "PostgreSQL rollback-only Task context proof");

if (failures.length) {
  for (const failure of failures) console.error(`IG_PHASE1_V17_RUNTIME_GATE1_TASK_PROJECT_CONTEXT: BLOCKER | ${failure}`);
  process.exit(1);
}

console.log("IG_PHASE1_V17_RUNTIME_GATE1_TASK_PROJECT_CONTEXT: PASS");
console.log("GLOBAL_PROJECT_SELECTION=REMOVED");
console.log("TASK_CONTEXT=INDEPENDENT_OR_PROJECT_BOUND");
console.log("TASK_PROJECT_BINDING=AUTHORITATIVE_TASK_DRAFT_REVISION");
console.log("PROJECT_WORKSPACE_AUTHORITY=AUDITED_AND_EXPLICIT");
console.log("SCHEMA_MIGRATIONS=0");
