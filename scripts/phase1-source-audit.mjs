import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)));
const normalized = value => value.split(sep).join("/");
const failures = [];
const notes = [];

function fail(code, detail) {
  failures.push({ code, detail });
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function sourceFiles() {
  return walk(join(root, "src")).filter(path => /\.(?:ts|tsx)$/.test(path));
}

function productionSourceFiles() {
  return sourceFiles().filter(path => {
    const rel = normalized(relative(root, path));
    return !/\.test\.(?:ts|tsx)$/.test(rel) && !rel.startsWith("src/test/");
  });
}

const approvedTagline = "هدف واضح • تنفيذ منضبط • نتائج قابلة للتحقق";
const manifestPath = join(root, "docs", "architecture", "INTENTCHORD_APPROVED_IDENTITY_ASSET_MANIFEST_2026_07_29.json");
if (!existsSync(manifestPath)) {
  fail("IDENTITY_MANIFEST_MISSING", normalized(relative(root, manifestPath)));
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.approved_tagline !== approvedTagline) {
    fail("APPROVED_TAGLINE_MISMATCH", String(manifest.approved_tagline));
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    fail("IDENTITY_ASSET_LIST_EMPTY", "manifest.assets");
  } else {
    for (const asset of manifest.assets) {
      const assetPath = join(root, asset.path);
      if (!existsSync(assetPath)) {
        fail("IDENTITY_ASSET_MISSING", asset.path);
        continue;
      }
      const actual = sha256(assetPath);
      if (actual !== String(asset.sha256).toUpperCase()) {
        fail("IDENTITY_ASSET_HASH_MISMATCH", `${asset.path}: ${actual}`);
      }
    }
    notes.push(`IDENTITY_ASSETS_VERIFIED=${manifest.assets.length}`);
  }
}


const production = productionSourceFiles();
for (const path of production) {
  const rel = normalized(relative(root, path));
  const text = readFileSync(path, "utf8");
  if (/from\s+["'][^"']*(?:\/test\/|@\/test\/)/.test(text)) {
    fail("PRODUCTION_IMPORTS_TEST_FIXTURE", rel);
  }
}

const shellPath = join(root, "src", "components", "product-shell.tsx");
const preferencesProviderPath = join(root, "src", "components", "product-preferences-provider.tsx");
const shellCssPath = join(root, "src", "components", "product-shell.module.css");
const globalCssPath = join(root, "src", "app", "globals.css");
for (const required of [shellPath, shellCssPath, globalCssPath]) {
  if (!existsSync(required)) fail("REQUIRED_SHELL_FILE_MISSING", normalized(relative(root, required)));
}
if (!existsSync(preferencesProviderPath)) {
  fail("PRODUCT_PREFERENCES_PROVIDER_MISSING", normalized(relative(root, preferencesProviderPath)));
} else {
  const preferencesProvider = readFileSync(preferencesProviderPath, "utf8");
  for (const token of ["ProductPreferencesProvider", "useProductPreferences", "prefers-color-scheme: dark", "document.documentElement.lang", "document.documentElement.dir", "document.documentElement.dataset.theme"]) {
    if (!preferencesProvider.includes(token)) fail("PRODUCT_PREFERENCES_CAPABILITY_MISSING", token);
  }
  for (const routeSurface of ["src/components/workflow-app.tsx", "src/components/project-context-workbench.tsx"]) {
    const surface = readFileSync(join(root, routeSurface), "utf8");
    if (!surface.includes("useProductPreferences")) fail("ROUTE_PREFERENCES_AUTHORITY_SPLIT", routeSurface);
    if (/useState<Locale>\(|localStorage\.getItem\(localeStorageKey\)|localStorage\.getItem\("intentchord-theme"\)/.test(surface)) fail("ROUTE_PREFERENCES_LOCAL_STATE_REMAINS", routeSurface);
  }
  if (!readFileSync(join(root, "src/app/layout.tsx"), "utf8").includes("ProductPreferencesProvider")) fail("ROOT_PREFERENCES_PROVIDER_NOT_MOUNTED", "src/app/layout.tsx");
  notes.push("LOCALE_THEME_AUTHORITY=ROOT_PROVIDER_ONLY");
}
if (existsSync(shellPath)) {
  const shell = readFileSync(shellPath, "utf8");
  for (const token of [
    "Search open work",
    "Open work",
    "visibleOpenItems",
    "translations[locale].runs",
    "styles.bodyCollapsed",
    "Context and audit",
    "styles.environmentArea",
  ]) {
    if (!shell.includes(token)) fail("PRODUCT_SHELL_CAPABILITY_MISSING", token);
  }
  if (!/Search open work|Open work/.test(shell)) fail("GLOBAL_OPEN_WORK_SIDEBAR_MISSING", "product-shell.tsx");
  if (shell.includes(approvedTagline)) fail("COMPACT_TOPBAR_TAGLINE_REINTRODUCED", "product-shell.tsx");
  if (/locale\s*===\s*["']ar["']\s*\?\s*["']قرارات["']\s*:\s*["']Decisions["']/.test(shell)) {
    fail("SUPERSEDED_RUN_LEDGER_LABEL_PRESENT", "ProductShell hardcodes Decisions / قرارات");
  }
  notes.push("HOME_SHELL=FULL_WIDTH_WORK_SURFACE");
  notes.push("WORK_SIDEBAR=PERSISTENT_OPEN_WORK_AND_TASK_STAGES");
  notes.push("RUN_LEDGER_LABEL=RUN_HISTORY_CANONICAL");
}
if (existsSync(globalCssPath)) {
  const css = readFileSync(globalCssPath, "utf8");
  const shellCss = readFileSync(shellCssPath, "utf8");
  const rootCount = (css.match(/(^|\n)\s*:root\s*\{/g) ?? []).length;
  const globalTopbarCount = (css.match(/(^|\n)\s*\.topbar\s*\{/g) ?? []).length;
  if (rootCount !== 1) fail("GLOBAL_TOKEN_ROOT_COUNT_INVALID", String(rootCount));
  if (globalTopbarCount !== 0) fail("GLOBAL_TOPBAR_OVERRIDE_PRESENT", String(globalTopbarCount));
  for (const token of ["--chrome: #ffffff", "--chrome: #0b1624", "background: var(--canvas)", ".openList", ".workSearch", ".bodyCollapsed", "max-width: none", "grid-template-columns: auto auto minmax(180px, 1fr) auto"]) {
    if (!shellCss.includes(token)) fail("UNIFIED_THEME_CONTRACT_MISSING", token);
  }
  if (shellCss.includes("background: rgba(7, 17, 31, .98)")) fail("FIXED_DARK_CHROME_REMAINS", "product-shell.module.css");
  if (!css.includes("input,\ntextarea,\nselect { background: var(--panel); }")) fail("FORM_SURFACE_THEME_TOKEN_MISSING", "globals.css");
  if (/(?:align-items|align-self|justify-content)\s*:\s*end\s*;/.test(css)) fail("AUTOPREFIXER_UNSUPPORTED_FLEX_END_REMAINS", "globals.css");
  if (/(?:align-items|align-self|justify-content)\s*:\s*end\s*;/.test(shellCss)) fail("AUTOPREFIXER_UNSUPPORTED_FLEX_END_REMAINS", "product-shell.module.css");
  for (const legacySelector of [
    ".generated-task-title",
    ".task-definition-layout",
    ".task-identity-panel",
    ".task-primary-stack",
    ".step-count-summary",
  ]) {
    if (css.includes(legacySelector)) fail("SUPERSEDED_NEW_TASK_SELECTOR_REMAINS", legacySelector);
  }
  if (!/@media \(max-width: 980px\)[\s\S]*\.workSearch \{ display: none; \}/.test(shellCss)) fail("HEADER_RESPONSIVE_SEARCH_COLLAPSE_MISSING", "product-shell.module.css");
  if (!/\.welcome-home[\s\S]*max-width:\s*none;/.test(css)) fail("FULL_WIDTH_HOME_SURFACE_MISSING", "globals.css");
  if (!/\.new-task-page[\s\S]*max-width:\s*none;/.test(css)) fail("FULL_WIDTH_NEW_TASK_SURFACE_MISSING", "globals.css");
  notes.push("LIGHT_DARK_SURFACE_CONSISTENCY=TOKEN_GOVERNED");
  notes.push("MAIN_CANVAS=FULL_WIDTH_WITH_PERSISTENT_WORK_SIDEBAR");
}

const workflowUxPath = join(root, "src", "components", "workflow-app.tsx");
if (existsSync(workflowUxPath)) {
  const workflow = readFileSync(workflowUxPath, "utf8");
  for (const token of ["newTaskFlightRef", "newTaskCommandIdRef", "pendingNewTaskIdRef", "pendingNewTaskDraftSignatureRef", "requestedTaskId", "submissionLockRef", "navigationStarted", "runSubmission", "draftCanPersist", "locked to one Task"]) {
    if (!workflow.includes(token)) fail("NEW_TASK_SINGLE_FLIGHT_CONTRACT_MISSING", token);
  }
  if (workflow.includes("Use a concrete result, not a broad topic or a list of instructions.")) {
    fail("RESTRICTIVE_OWNER_OBJECTIVE_COPY_REMAINS", "workflow-app.tsx");
  }
  for (const token of ['value="INDEPENDENT"', 'value="PROJECT_BOUND"', "availableRegisteredWorkspaces", "effectiveTaskContext(input)"]) {
    if (!workflow.includes(token)) fail("TASK_PROJECT_CONTEXT_UI_MISSING", token);
  }
  if (/readActiveEnvironmentPreference|writeActiveEnvironmentPreference|intentchord-active-environment-id/.test(workflow)) {
    fail("GLOBAL_PROJECT_PREFERENCE_REMAINS", "workflow-app.tsx");
  }
  notes.push("OWNER_OBJECTIVE_INPUT=FREE_FORM_THEN_PLANNER_CLARIFICATION");
  notes.push("NEW_TASK_CREATION=SINGLE_FLIGHT_AND_RETRY_REUSES_CREATED_TASK");
  notes.push("TASK_CONTEXT=INDEPENDENT_OR_PROJECT_BOUND");
}
const lifecycleSourcePath = join(root, "src", "server", "lifecycle.ts");
const schemasSourcePath = join(root, "src", "server", "schemas.ts");
if (existsSync(lifecycleSourcePath) && existsSync(schemasSourcePath)) {
  const lifecycleSource = readFileSync(lifecycleSourcePath, "utf8");
  const schemasSource = readFileSync(schemasSourcePath, "utf8");
  for (const token of ["requestedTaskId", "normalizeDraftForPersistence", "jsonPersistable(synchronizeLegacyWorkspaceProjection", "from intentchord.task_draft_revisions", "where task_id=$1 and revision=0", "existingDraftSha256 !== normalizedDraftSha256", "canonical(existingDraft) !== canonical(normalizedDraft)", "on conflict(id) do nothing", "TASK_CREATE_IDEMPOTENCY_MISMATCH"]) {
    if (!`${schemasSource}
${lifecycleSource}`.includes(token)) fail("TASK_CREATE_BACKEND_IDEMPOTENCY_MISSING", token);
  }
  if (/select\s+.*\bdraft\b.*from intentchord\.tasks/i.test(lifecycleSource)) {
    fail("TASKS_DRAFT_READ_BOUNDARY_VIOLATION", "create/replay must use task_draft_revisions");
  }
  if (schemasSource.includes("Source implementation requires at least one explicit Owner-defined mandatory outcome.")) {
    fail("OWNER_SUCCESS_CONDITIONS_STILL_FORCED", "src/server/schemas.ts");
  }
  for (const token of ["normalizeTaskContextForPersistence", "from intentchord.project_contexts", "from intentchord.project_context_workspaces", "PROJECT_WORKSPACE_LINK_REQUIRED"]) {
    if (!lifecycleSource.includes(token)) fail("TASK_PROJECT_CONTEXT_BACKEND_MISSING", token);
  }
  notes.push("TASK_CREATE_BACKEND_IDEMPOTENCY=REQUEST_ID_BOUND_RELATIONAL_REVISION_ZERO_REPLAY");
  notes.push("OWNER_SUCCESS_CONDITIONS=OPTIONAL_AND_PLANNER_PROPOSED");
  notes.push("TASK_PROJECT_CONTEXT_PERSISTENCE=AUTHORITATIVE_TASK_DRAFT_REVISION");
}

const projectContextCssPath = join(root, "src", "components", "project-context-workbench.module.css");
if (!existsSync(projectContextCssPath)) {
  fail("PROJECT_CONTEXT_THEME_BOUNDARY_MISSING", normalized(relative(root, projectContextCssPath)));
} else {
  const projectContextCss = readFileSync(projectContextCssPath, "utf8");
  if (/background:\s*(?:#fff(?:fff)?|white)/i.test(projectContextCss)) {
    fail("PROJECT_CONTEXT_MIXED_THEME_SURFACE", "hardcoded light background remains");
  }
  for (const token of ["background: var(--panel)", "background: var(--surface)", "color: var(--text)"]) {
    if (!projectContextCss.includes(token)) fail("PROJECT_CONTEXT_THEME_TOKEN_MISSING", token);
  }
  const environmentWorkbench = readFileSync(join(root, "src/components/project-context-workbench.tsx"), "utf8");
  if (/useEffect\(\(\) => \{ void refresh\(\); \}, \[locale\]\)/.test(environmentWorkbench)) {
    fail("PROJECT_CONTEXT_LOCALE_REFETCH_REMAINS", "project-context-workbench.tsx");
  }
  notes.push("PROJECT_CONTEXT_THEME=TOKEN_GOVERNED");
  notes.push("PROJECT_CONTEXT_LOCALE_CHANGE=PRESENTATION_ONLY_NO_REFETCH");
  notes.push("GLOBAL_PROJECT_SELECTION=REMOVED");
}

const workbenchPath = join(root, "src", "components", "project-context-workbench.tsx");
if (!existsSync(workbenchPath)) {
  fail("GOVERNED_ENVIRONMENT_SURFACE_MISSING", normalized(relative(root, workbenchPath)));
} else {
  const workbench = readFileSync(workbenchPath, "utf8");
  if (/name=["']slug["']|setSlug\(|setWorkspaceRegistrationId\(|name=["']workspaceRegistrationId["']/.test(workbench)) {
    fail("MANUAL_INTERNAL_IDENTIFIER_CONTROL_PRESENT", "project-context-workbench.tsx");
  }
  for (const token of ["displayName", "structuredFactValue", "Advanced Audit", "OWNER_APPROVED", "snapshotVersion: \"project-truth/v1\""]) {
    if (!workbench.includes(token)) fail("GOVERNED_ENVIRONMENT_CAPABILITY_MISSING", token);
  }
  if (/JSON\.parse\(factValue|JSON\.parse\(factSourceNote/.test(workbench)) {
    fail("RAW_JSON_REQUIRED_IN_OWNER_FLOW", "project-context-workbench.tsx");
  }
}

const devSmokePath = join(root, "scripts", "next-dev-safe.mjs");
const devSmokeRegressionPath = join(root, "scripts", "test-next-dev-smoke-harness.mjs");
if (!existsSync(devSmokePath)) {
  fail("DEV_SMOKE_HARNESS_MISSING", normalized(relative(root, devSmokePath)));
} else {
  const devSmoke = readFileSync(devSmokePath, "utf8");
  for (const token of [
    "const smokeProbeTimeoutMs = 10 * 1000;",
    "timeout: smokeProbeTimeoutMs",
    'const pendingGate = smokeRootPassed ? "HTTP_TASKS" : "HTTP_ROOT";',
    "if (smokeDeadlineTimer) clearTimeout(smokeDeadlineTimer);",
  ]) {
    if (!devSmoke.includes(token)) fail("DEV_SMOKE_ROOT_CLOSURE_MISSING", token);
  }
  if (/timeout:\s*1500\b/.test(devSmoke)) {
    fail("DEV_SMOKE_PROBE_TIMEOUT_TOO_SHORT", "scripts/next-dev-safe.mjs");
  }
  notes.push("DEV_SMOKE_PROBE_TIMEOUT_MS=10000");
}
if (!existsSync(devSmokeRegressionPath)) {
  fail("DEV_SMOKE_REGRESSION_TEST_MISSING", normalized(relative(root, devSmokeRegressionPath)));
} else {
  const regression = readFileSync(devSmokeRegressionPath, "utf8");
  for (const token of ["delayedApiMs = 2200", "HTTP_TASKS: PASS", "DEV_SMOKE_HARNESS_REGRESSION: PASS"]) {
    if (!regression.includes(token)) fail("DEV_SMOKE_REGRESSION_CONTRACT_MISSING", token);
  }
  notes.push("DEV_SMOKE_DELAYED_API_REGRESSION=ENFORCED");
}

const v9RegressionPath = join(root, "scripts", "verify-v9-failure-regressions.mjs");
if (!existsSync(v9RegressionPath)) {
  fail("V9_FAILURE_REGRESSION_HARNESS_MISSING", normalized(relative(root, v9RegressionPath)));
} else {
  const regression = readFileSync(v9RegressionPath, "utf8");
  for (const token of ["resolved_assertions=3", "MAIN_CANVAS=FULL_WIDTH", "TOPBAR_TAGLINE=ABSENT_BY_COMPACT_ASSET_ROLE"]) {
    if (!regression.includes(token)) fail("V9_FAILURE_REGRESSION_CONTRACT_MISSING", token);
  }
  notes.push("V9_FAILED_ASSERTIONS_REGRESSION=ENFORCED");
}

const v11ReconciliationPath = join(root, "scripts", "verify-v11-test-contract-reconciliation.mjs");
if (!existsSync(v11ReconciliationPath)) {
  fail("V11_TEST_CONTRACT_RECONCILIATION_HARNESS_MISSING", normalized(relative(root, v11ReconciliationPath)));
} else {
  const reconciliation = readFileSync(v11ReconciliationPath, "utf8");
  for (const token of ["resolved_failures=4", "latent_failures=1", "TECHNICAL_EYEBROW=ABSENT_BEFORE_OBJECTIVE"]) {
    if (!reconciliation.includes(token)) fail("V11_TEST_CONTRACT_RECONCILIATION_MISSING", token);
  }
  notes.push("V11_TEST_CONTRACT_RECONCILIATION=ENFORCED");
}

const ownerErrorsPath = join(root, "src", "lib", "owner-errors.ts");
if (!existsSync(ownerErrorsPath)) {
  fail("OWNER_ERROR_MAPPING_MISSING", "src/lib/owner-errors.ts");
} else {
  const ownerErrors = readFileSync(ownerErrorsPath, "utf8");
  if (ownerErrors.includes("JSON.stringify(payload.details)") || ownerErrors.includes("payload.error ??")) {
    fail("RAW_BACKEND_ERROR_FALLBACK_PRESENT", "src/lib/owner-errors.ts");
  }
}

const workflowPath = join(root, "src", "components", "workflow-app.tsx");
if (!existsSync(workflowPath)) {
  fail("WORKFLOW_SURFACE_MISSING", "src/components/workflow-app.tsx");
} else {
  const workflow = readFileSync(workflowPath, "utf8");
  if (!workflow.includes("<ProductShell")) fail("WORKFLOW_NOT_USING_PRODUCT_SHELL", "workflow-app.tsx");
  for (const token of [
    "What do you want IntentChord to help you accomplish?",
    "No conclusion without evidence",
    "home-journey",
    'data-product-view="home"',
    'data-journey-stage="objective"',
  ]) {
    if (!workflow.includes(token)) fail("FIRST_USE_HOME_CONTRACT_MISSING", token);
  }
  for (const token of [
    'data-product-view="new-task"',
    'data-product-journey="objective-first"',
    'data-primary-action="objective-input"',
    'data-task-title-source="objective"',
    'data-guided-control="work-type"',
    'data-disclosure="success-conditions"',
    'data-disclosure="requested-authorization"',
    'data-owner-action="clarify-objective"',
    "Tell IntentChord what you need",
  ]) {
    if (!workflow.includes(token)) fail("NEW_TASK_PROGRESSIVE_DISCLOSURE_MISSING", token);
  }
  if (workflow.includes("title={copy.newTaskTitle}")) {
    fail("TECHNICAL_CONTRACT_LANGUAGE_PRECEDES_OBJECTIVE", "task-new eyebrow still uses copy.newTaskTitle");
  }
  if (!workflow.includes("title={copy.newTask}")) {
    fail("PRACTICAL_NEW_TASK_TITLE_MISSING", "task-new must use copy.newTask");
  }
  if (/useEffect\(\(\) => \{[\s\S]{0,900}fetch\("\/api\/tasks"[\s\S]{0,900}\}, \[locale\]\)/.test(workflow)) {
    fail("LOCALE_CHANGE_RELOADS_TASK_REGISTRY", "workflow-app.tsx");
  }
  if (!workflow.includes("tasks.some((item) => item.id === current.activeTaskId)")) {
    fail("ACTIVE_TASK_PRESERVATION_MISSING", "workflow-app.tsx");
  }
  if (workflow.includes("owner-row-audit")) fail("ROW_LEVEL_ADVANCED_AUDIT_REMAINS", "workflow-app.tsx");
  if (!workflow.includes("HISTORICAL TEST DATA · FIXTURE")) fail("HISTORICAL_FIXTURE_LABEL_MISSING", "workflow-app.tsx");
}

const dbPath = join(root, "src", "server", "db.ts");
const lifecyclePgTestPath = join(root, "src", "server", "lifecycle.postgres.integration.test.ts");
const maintenancePath = join(root, "scripts", "integration-data-maintenance.mjs");
const backupPath = join(root, "scripts", "backup-intentchord-database.mjs");
for (const required of [dbPath, lifecyclePgTestPath, maintenancePath, backupPath]) {
  if (!existsSync(required)) fail("TEST_DATA_BOUNDARY_FILE_MISSING", normalized(relative(root, required)));
}
if (existsSync(dbPath) && existsSync(lifecyclePgTestPath)) {
  const db = readFileSync(dbPath, "utf8");
  const test = readFileSync(lifecyclePgTestPath, "utf8");
  for (const token of ["bindRollbackOnlyTestClient", "ROLLBACK_ONLY_TEST_CLIENT_BLOCKED", "SAVEPOINT"]) {
    if (!db.includes(token)) fail("ROLLBACK_ONLY_DATABASE_BOUNDARY_MISSING", token);
  }
  for (const token of ['await rollbackClient.query("BEGIN")', 'await rollbackClient.query("ROLLBACK")', "bindRollbackOnlyTestClient(rollbackClient)", 'import type { PoolClient } from "pg";', "let rollbackClient: PoolClient | undefined;", "rollbackClient?.release()"] ) {
    if (!test.includes(token)) fail("POSTGRES_TEST_ROLLBACK_BOUNDARY_MISSING", token);
  }
  if (test.includes('Awaited<ReturnType<ReturnType<typeof databasePool>["connect"]>>')) {
    fail("POSTGRES_POOL_CONNECT_OVERLOAD_TYPE_TRAP", "Use explicit PoolClient; ReturnType resolves the callback overload to void.");
  }
  notes.push("POSTGRES_ROLLBACK_CLIENT_TYPING=EXPLICIT_POOL_CLIENT");
  notes.push("POSTGRES_INTEGRATION_TESTS=ROLLBACK_ONLY_NO_PERSISTENT_ROWS");
}
if (existsSync(maintenancePath)) {
  const maintenance = readFileSync(maintenancePath, "utf8");
  for (const token of ["testScenarioSuffixes", "exact lifecycle.postgres.integration.test.ts generated title plus enumerated source scenario objectives", "INTEGRATION_DATA_PLAN_STALE", "INTEGRATION_DATA_CLEANUP: PASS"]) {
    if (!maintenance.includes(token)) fail("STALE_INTEGRATION_DATA_CLEANUP_MISSING", token);
  }
  notes.push("STALE_INTEGRATION_DATA=CANDIDATE_PLAN_BACKUP_TRANSACTIONAL_DELETE");
}

notes.push(`PRODUCTION_TS_TSX_FILES_SCANNED=${production.length}`);
notes.push(`WORKFLOW_APP_LINES=${readFileSync(workflowPath, "utf8").split(/\r?\n/).length}`);
notes.push(`GLOBALS_CSS_LINES=${readFileSync(globalCssPath, "utf8").split(/\r?\n/).length}`);
notes.push(`SOURCE_AUDIT_TIMESTAMP=${new Date().toISOString()}`);

console.log("============================================================");
console.log(" IntentChord Phase 1 Source Audit");
console.log("============================================================");
for (const note of notes) console.log(note);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure.code}: ${failure.detail}`);
  console.error(`PHASE1_SOURCE_AUDIT=BLOCKER (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log("PHASE1_SOURCE_AUDIT=PASS");
}
