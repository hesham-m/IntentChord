import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "014_governed_context_assembly_and_ai_context_mapping_v2.sql";
const baselineIds = [
  "001_intentchord_vertical_slice.sql",
  "002_backend_authoritative_lifecycle.sql",
  "003_owner_decision_ledger.sql",
  "004_trust_invariants_and_authoritative_projection.sql",
  "005_semantic_trust_hardening.sql",
  "006_intelligence_and_evidence_semantics.sql",
  "007_project_context_and_truth_registry.sql",
  "008_project_truth_database_clock_authority.sql",
  "009_ai_context_mapper_v1.sql",
  "010_workspace_index_snapshots_and_context_decisions.sql",
  "011_workspace_index_runtime_governance.sql",
  "012_workspace_revision_observation_and_index_artifacts.sql",
  "013_internal_ai_engine_runtime_identity_decoupling.sql",
];
const expectedSha256 = "8ED111969E4D92CF2DFC613A0AC7573D1E1E2FF01ADA012A8EEABA90561947EB";

function fail(code, details = "") { throw new Error(`${code}${details ? `: ${details}` : ""}`); }

async function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) fail("DATABASE_URL_NOT_FOUND");
  return match[1].trim();
}

async function assertSourceHash() {
  const actual = createHash("sha256").update(await readFile(`migrations/${migrationId}`)).digest("hex").toUpperCase();
  if (actual !== expectedSha256) fail("MIGRATION_014_SOURCE_HASH_MISMATCH", `expected=${expectedSha256} actual=${actual}`);
  console.log(`MIGRATION_014_SOURCE_HASH: PASS sha256=${actual}`);
}

async function assertIdentity(client) {
  const { rows: [row] } = await client.query("select current_database() database,current_user role,current_schema() schema");
  if (row.database !== "intentchord_dev" || row.role !== "intentchord_app" || row.schema !== "intentchord") fail("DATABASE_IDENTITY_BLOCKER", JSON.stringify(row));
  console.log("DATABASE_IDENTITY: PASS database=intentchord_dev role=intentchord_app schema=intentchord");
}

async function migrationIds(client) {
  return (await client.query("select id from intentchord.schema_migrations order by id")).rows.map(row => row.id);
}
async function state(client) {
  const ids = await migrationIds(client);
  if (JSON.stringify(ids) === JSON.stringify(baselineIds)) return "NOT_APPLIED";
  if (JSON.stringify(ids) === JSON.stringify([...baselineIds, migrationId])) return "APPLIED";
  fail("MIGRATION_014_BASELINE_BLOCKER", ids.join(","));
}

async function functionDef(client, regprocedure) {
  return (await client.query("select pg_get_functiondef($1::regprocedure) definition", [regprocedure])).rows[0]?.definition ?? "";
}

async function tableCheckConstraints(client, tableName) {
  return (await client.query(
    `select c.conname,pg_get_constraintdef(c.oid,true) definition
       from pg_constraint c
      where c.connamespace='intentchord'::regnamespace
        and c.conrelid=$1::regclass
        and c.contype='c'
      order by c.conname`,
    [`intentchord.${tableName}`],
  )).rows;
}

function normalizedConstraintDefinition(definition) {
  return definition.toLowerCase().replace(/::text/g, "").replace(/\s+/g, "");
}

function sqlStringLiterals(definition) {
  return [...definition.matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1].replace(/''/g, "'"));
}

function assertExactTextDomainConstraint(constraints, { columnName, expectedValues, excludedMarkers = [], failCode }) {
  const expected = [...expectedValues].sort();
  const candidate = constraints.find(row => {
    const normalized = normalizedConstraintDefinition(row.definition);
    if (!normalized.includes(columnName.toLowerCase())) return false;
    if (excludedMarkers.some(marker => normalized.includes(marker.toLowerCase()))) return false;
    const actual = sqlStringLiterals(row.definition).sort();
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  });
  if (!candidate) fail(failCode, `${columnName}=${expectedValues.join("|")}`);
  return candidate;
}

function canonicalConstraintExpression(definition) {
  return definition
    .toLowerCase()
    .replace(/::text/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchingOuterParenthesisIndex(expression) {
  if (!expression.startsWith("(")) return -1;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'") {
      if (inString && expression[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return -1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripRedundantOuterParentheses(expression) {
  let current = expression.trim();
  while (current.startsWith("(") && matchingOuterParenthesisIndex(current) === current.length - 1) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function extractCheckExpression(definition) {
  const normalized = canonicalConstraintExpression(definition);
  if (!normalized.startsWith("check")) return null;
  const expression = stripRedundantOuterParentheses(normalized.slice("check".length).trim());
  return expression || null;
}

function isSqlIdentifierCharacter(char) {
  return Boolean(char) && /[a-z0-9_]/i.test(char);
}

function splitTopLevelBoolean(expression, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  const lower = expression.toLowerCase();
  const needle = operator.toLowerCase();

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'") {
      if (inString && expression[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth < 0) return null;
      continue;
    }
    if (depth !== 0 || lower.slice(index, index + needle.length) !== needle) continue;

    const before = lower[index - 1] ?? "";
    const after = lower[index + needle.length] ?? "";
    if (isSqlIdentifierCharacter(before) || isSqlIdentifierCharacter(after)) continue;

    const part = expression.slice(start, index).trim();
    if (!part) return null;
    parts.push(part);
    start = index + needle.length;
    index += needle.length - 1;
  }

  if (inString || depth !== 0) return null;
  if (!parts.length) return [expression.trim()];
  const finalPart = expression.slice(start).trim();
  if (!finalPart) return null;
  parts.push(finalPart);
  return parts;
}

function parseConstraintBooleanExpression(expression) {
  const current = stripRedundantOuterParentheses(expression);
  const orParts = splitTopLevelBoolean(current, "or");
  if (!orParts) return null;
  if (orParts.length > 1) {
    const children = orParts.map(parseConstraintBooleanExpression);
    return children.every(Boolean) ? { type: "or", children } : null;
  }

  const andParts = splitTopLevelBoolean(current, "and");
  if (!andParts) return null;
  if (andParts.length > 1) {
    const children = andParts.map(parseConstraintBooleanExpression);
    return children.every(Boolean) ? { type: "and", children } : null;
  }

  return { type: "atom", value: normalizeConstraintPredicate(current) };
}

function normalizeConstraintPredicate(predicate) {
  return stripRedundantOuterParentheses(predicate)
    .toLowerCase()
    .replace(/::text/g, "")
    .replace(/\s+/g, "");
}

function flattenAssociativeBoolean(node, type) {
  if (!node) return null;
  if (node.type !== type) return [node];
  const flattened = [];
  for (const child of node.children) {
    const nested = flattenAssociativeBoolean(child, type);
    if (!nested) return null;
    flattened.push(...nested);
  }
  return flattened;
}

function branchPredicateSignature(branch) {
  const terms = flattenAssociativeBoolean(branch, "and");
  if (!terms || terms.some(term => term.type !== "atom")) return null;
  return terms.map(term => term.value).sort().join("&&");
}

const SNAPSHOT_BINDING_EXPECTED_BRANCHES = [
  [
    "qualification_scope='ai_context_mapping_v1'",
    "workspace_index_snapshot_idisnull",
    "mapping_idempotency_keyisnull",
    "mapping_request_fingerprint_sha256isnull",
  ],
  [
    "qualification_scope='ai_context_mapping_v1'",
    "workspace_index_snapshot_idisnotnull",
    "mapping_idempotency_keyisnotnull",
    "btrim(mapping_idempotency_key)<>''",
    "char_length(mapping_idempotency_key)<=200",
    "mapping_request_fingerprint_sha256isnotnull",
  ],
  [
    "qualification_scope='ai_context_mapping_v2'",
    "workspace_index_snapshot_idisnull",
    "mapping_idempotency_keyisnotnull",
    "btrim(mapping_idempotency_key)<>''",
    "char_length(mapping_idempotency_key)<=200",
    "mapping_request_fingerprint_sha256isnotnull",
  ],
].map(branch => branch.map(normalizeConstraintPredicate).sort().join("&&")).sort();

function snapshotBindingStructuralProof(definition) {
  const expression = extractCheckExpression(definition);
  if (!expression) return { pass: false, reason: "CHECK_EXPRESSION_MISSING", branchSignatures: [] };
  const tree = parseConstraintBooleanExpression(expression);
  if (!tree) return { pass: false, reason: "BOOLEAN_PARSE_FAILED", branchSignatures: [] };

  const branches = flattenAssociativeBoolean(tree, "or");
  if (!branches || branches.length !== 3) {
    return { pass: false, reason: `TOP_LEVEL_OR_BRANCH_COUNT_${branches?.length ?? "INVALID"}`, branchSignatures: [] };
  }

  const branchSignatures = branches.map(branchPredicateSignature);
  if (branchSignatures.some(signature => !signature)) {
    return { pass: false, reason: "NON_AND_BRANCH_OR_NESTED_BOOLEAN_PRESENT", branchSignatures };
  }

  const actual = [...branchSignatures].sort();
  const pass = actual.length === SNAPSHOT_BINDING_EXPECTED_BRANCHES.length
    && actual.every((signature, index) => signature === SNAPSHOT_BINDING_EXPECTED_BRANCHES[index]);
  return { pass, reason: pass ? "PASS" : "BRANCH_LOCAL_PREDICATE_MISMATCH", branchSignatures: actual };
}

function assertContextMappingRunSnapshotBindingConstraint(constraints) {
  const constraint = constraints.find(row => row.conname === "context_mapping_runs_snapshot_binding_shape_ck");
  if (!constraint) fail("MIGRATION_014_MAPPING_RUN_SNAPSHOT_BINDING_CONSTRAINT_MISSING");

  const proof = snapshotBindingStructuralProof(constraint.definition);
  if (!proof.pass) {
    fail(
      "MIGRATION_014_MAPPING_RUN_SNAPSHOT_BINDING_CONSTRAINT_INVALID",
      `reason=${proof.reason} branches=${JSON.stringify(proof.branchSignatures)}`,
    );
  }
  return constraint;
}

function legacyParenthesesDestructiveSnapshotFlatten(definition) {
  return normalizedConstraintDefinition(definition)
    .replace(/btrim\(mapping_idempotency_key\)/g, "btrim_mapping_idempotency_key")
    .replace(/char_length\(mapping_idempotency_key\)/g, "char_length_mapping_idempotency_key")
    .replace(/^check/, "")
    .replaceAll("(", "")
    .replaceAll(")", "");
}

function runSnapshotBindingStructuralSelfTest() {
  const historical = [
    "qualification_scope='AI_CONTEXT_MAPPING_V1'",
    "workspace_index_snapshot_id IS NULL",
    "mapping_idempotency_key IS NULL",
    "mapping_request_fingerprint_sha256 IS NULL",
  ];
  const governed = [
    "qualification_scope='AI_CONTEXT_MAPPING_V1'",
    "workspace_index_snapshot_id IS NOT NULL",
    "mapping_idempotency_key IS NOT NULL",
    "btrim(mapping_idempotency_key) <> ''",
    "char_length(mapping_idempotency_key) <= 200",
    "mapping_request_fingerprint_sha256 IS NOT NULL",
  ];
  const v2 = [
    "qualification_scope='AI_CONTEXT_MAPPING_V2'",
    "workspace_index_snapshot_id IS NULL",
    "mapping_idempotency_key IS NOT NULL",
    "btrim(mapping_idempotency_key) <> ''",
    "char_length(mapping_idempotency_key) <= 200",
    "mapping_request_fingerprint_sha256 IS NOT NULL",
  ];
  const branch = predicates => `(${predicates.join(" AND ")})`;
  const definition = branches => `CHECK (${branches.join(" OR ")})`;
  const valid = definition([branch(historical), branch(governed), branch(v2)]);
  const pgStyleValid = `CHECK ((((${historical[0]}::text) AND (${historical[1]}) AND (${historical[2]}) AND (${historical[3]})) OR ((${governed[0]}::text) AND (${governed[1]}) AND (${governed[2]}) AND (btrim(mapping_idempotency_key) <> ''::text) AND (${governed[4]}) AND (${governed[5]})) OR ((${v2[0]}::text) AND (${v2[1]}) AND (${v2[2]}) AND (btrim(mapping_idempotency_key) <> ''::text) AND (${v2[4]}) AND (${v2[5]}))))`;

  const malformedSameFlatten = `CHECK (${historical[0]} AND (${historical.slice(1).join(" AND ")} OR ${governed[0]}) AND ${governed.slice(1).join(" AND ")} OR ${branch(v2)})`;
  const controls = [
    ["VALID_THREE_BRANCH", valid, true],
    ["PG_GET_CONSTRAINTDEF_STYLE", pgStyleValid, true],
    ["HISTORICAL_AND_GOVERNED", `CHECK (${branch(historical)} AND ${branch(governed)} OR ${branch(v2)})`, false],
    ["V2_BRANCH_MISSING", definition([branch(historical), branch(governed)]), false],
    ["V2_SNAPSHOT_NOT_NULL", definition([branch(historical), branch(governed), branch(v2.map(value => value === "workspace_index_snapshot_id IS NULL" ? "workspace_index_snapshot_id IS NOT NULL" : value))]), false],
    ["V2_IDEMPOTENCY_NULL", definition([branch(historical), branch(governed), branch(v2.map(value => value === "mapping_idempotency_key IS NOT NULL" ? "mapping_idempotency_key IS NULL" : value))]), false],
    ["V2_FINGERPRINT_NULL", definition([branch(historical), branch(governed), branch(v2.map(value => value === "mapping_request_fingerprint_sha256 IS NOT NULL" ? "mapping_request_fingerprint_sha256 IS NULL" : value))]), false],
    ["PREDICATE_MOVED_BETWEEN_BRANCHES", definition([branch([...historical, v2.at(-1)]), branch(governed), branch(v2.slice(0, -1))]), false],
    ["SAME_TOKENS_DIFFERENT_GROUPING", malformedSameFlatten, false],
  ];

  let failures = 0;
  for (const [name, candidate, expected] of controls) {
    const actual = snapshotBindingStructuralProof(candidate).pass;
    const pass = actual === expected;
    console.log(`MIGRATION_014_SNAPSHOT_BINDING_STRUCTURAL_SELF_TEST_${name}=${pass ? "PASS" : "FAIL"}`);
    if (!pass) failures += 1;
  }

  const legacyCollision = legacyParenthesesDestructiveSnapshotFlatten(valid)
    === legacyParenthesesDestructiveSnapshotFlatten(malformedSameFlatten);
  console.log(`MIGRATION_014_SNAPSHOT_BINDING_LEGACY_FLATTEN_COLLISION=${legacyCollision ? "PASS" : "FAIL"}`);
  if (!legacyCollision) failures += 1;
  if (snapshotBindingStructuralProof(malformedSameFlatten).pass) failures += 1;

  if (failures) fail("MIGRATION_014_SNAPSHOT_BINDING_STRUCTURAL_SELF_TEST_FAILED", String(failures));
  console.log(`MIGRATION_014_SNAPSHOT_BINDING_STRUCTURAL_SELF_TEST: PASS controls=${controls.length + 1}`);
}

async function assertObjects(client) {
  const requiredTables = [
    "context_assemblies","context_assembly_revisions","context_assembly_sources","context_mapping_v2_results","context_assembly_mapping_iterations",
    "context_missing_evidence_requests","context_gap_classifications","context_material_contradictions","context_resolution_requirements",
    "context_source_authorizations","context_forward_authority_consumptions","context_resolution_events","context_closure_evaluations","context_catalog_revisions",
  ];
  const tables = await client.query(
    `select table_name from information_schema.tables where table_schema='intentchord' and table_name=any($1::text[])`,
    [requiredTables],
  );
  const tableSet = new Set(tables.rows.map(row => row.table_name));
  const missingTables = requiredTables.filter(name => !tableSet.has(name));
  if (missingTables.length) fail("MIGRATION_014_TABLES_MISSING", missingTables.join(","));

  const forbiddenAssemblyColumns = ["state","closure_state","qualification_scope"];
  const assemblyColumns = await client.query(
    `select column_name from information_schema.columns where table_schema='intentchord' and table_name='context_assembly_revisions'`,
  );
  const assemblyColumnSet = new Set(assemblyColumns.rows.map(row => row.column_name));
  const forbiddenPresent = forbiddenAssemblyColumns.filter(name => assemblyColumnSet.has(name));
  if (forbiddenPresent.length) fail("MIGRATION_014_ASSEMBLY_MUTABLE_LIFECYCLE_COLUMN_PRESENT", forbiddenPresent.join(","));
  for (const required of ["context_assembly_id","revision","previous_revision_id","assembly_schema_version","assembly_sha256","created_at"]) {
    if (!assemblyColumnSet.has(required)) fail("MIGRATION_014_ASSEMBLY_EVIDENCE_COLUMN_MISSING", required);
  }

  const requiredRunColumns = [
    "qualification_scope","context_assembly_revision_id","context_assembly_sha256",
    "execution_deadline_at","deadline_policy_version","terminal_reason_code",
  ];
  const runColumns = await client.query(
    `select column_name from information_schema.columns where table_schema='intentchord' and table_name='context_mapping_runs' and column_name=any($1::text[])`,
    [requiredRunColumns],
  );
  const runColumnSet = new Set(runColumns.rows.map(row => row.column_name));
  const missingRunColumns = requiredRunColumns.filter(name => !runColumnSet.has(name));
  if (missingRunColumns.length) fail("MIGRATION_014_RUN_COLUMNS_MISSING", missingRunColumns.join(","));

  const runCheckConstraints = await tableCheckConstraints(client, "context_mapping_runs");
  assertContextMappingRunSnapshotBindingConstraint(runCheckConstraints);

  const sourceAuthorizationColumns = await client.query(
    `select column_name from information_schema.columns where table_schema='intentchord' and table_name='context_source_authorizations'`,
  );
  const sourceAuthorizationColumnSet = new Set(sourceAuthorizationColumns.rows.map(row => row.column_name));
  for (const required of ["task_id","task_revision","workspace_registration_revision","workspace_registration_fingerprint"]) {
    if (!sourceAuthorizationColumnSet.has(required)) fail("MIGRATION_014_SOURCE_AUTHORITY_RECEIPT_COLUMN_MISSING", required);
  }

  const requiredCatalogColumns = ["context_assembly_revision_id","mapping_iteration_id","closure_evaluation_id","catalog_sha256"];
  const catalogColumns = await client.query(
    `select column_name from information_schema.columns where table_schema='intentchord' and table_name='context_catalog_revisions'`,
  );
  const catalogColumnSet = new Set(catalogColumns.rows.map(row => row.column_name));
  for (const required of requiredCatalogColumns) if (!catalogColumnSet.has(required)) fail("MIGRATION_014_CATALOG_PROVENANCE_COLUMN_MISSING", required);
  if (catalogColumnSet.has("closure_evidence_id")) fail("MIGRATION_014_LEGACY_SINGLE_CLOSURE_BINDING_PRESENT");

  const closureConstraints = await client.query(
    `select conname,pg_get_constraintdef(oid) definition from pg_constraint
      where connamespace='intentchord'::regnamespace and conrelid='intentchord.context_closure_evaluations'::regclass`,
  );
  if (closureConstraints.rows.some(row => /^UNIQUE \(context_assembly_revision_id\)$/.test(row.definition))) {
    fail("MIGRATION_014_SINGLE_CLOSURE_PER_ASSEMBLY_CONSTRAINT_PRESENT");
  }

  const requiredTriggers = [
    ["context_assembly_revisions", "context_assembly_revisions_lineage_guard"],
    ["context_assembly_sources", "context_assembly_sources_insert_guard"],
    ["context_mapping_runs", "context_mapping_runs_runtime_configuration_v014"],
    ["context_mapping_v2_results", "context_mapping_v2_results_insert_guard"],
    ["context_assembly_mapping_iterations", "context_assembly_mapping_iterations_insert_guard"],
    ["context_missing_evidence_requests", "context_missing_evidence_requests_insert_guard"],
    ["context_material_contradictions", "context_material_contradictions_insert_guard"],
    ["context_resolution_requirements", "context_resolution_requirements_insert_guard"],
    ["context_resolution_events", "context_resolution_events_insert_guard"],
    ["context_source_authorizations", "context_source_authorizations_insert_guard"],
    ["context_forward_authority_consumptions", "context_forward_authority_consumptions_insert_guard"],
    ["context_closure_evaluations", "context_closure_evaluations_insert_guard"],
    ["context_catalog_revisions", "context_catalog_revisions_insert_guard"],
  ];
  for (const [table, trigger] of requiredTriggers) {
    const result = await client.query(
      `select 1 from pg_trigger where not tgisinternal and tgrelid=$1::regclass and tgname=$2`,
      [`intentchord.${table}`, trigger],
    );
    if (!result.rowCount) fail("MIGRATION_014_TRIGGER_MISSING", trigger);
  }

  const lineageGuard = await functionDef(client, "intentchord.context_assembly_revision_lineage_guard()");
  for (const marker of [
    "FIRST_REVISION_PREVIOUS_FORBIDDEN","PREVIOUS_REVISION_REQUIRED","PREVIOUS_REVISION_CROSS_ASSEMBLY","PREVIOUS_REVISION_NOT_SEQUENTIAL",
  ]) if (!lineageGuard.includes(marker)) fail("MIGRATION_014_ASSEMBLY_LINEAGE_GUARD_MISSING", marker);

  const runGuard = await functionDef(client, "intentchord.context_mapping_run_governed_update()");
  for (const marker of [
    "ORPHANED_ACTIVE_MAPPING_EXECUTION","execution_deadline_at",
    "AI_CONTEXT_MAPPING_V1","AI_CONTEXT_MAPPING_V2",
  ]) if (!runGuard.toLowerCase().includes(marker.toLowerCase())) fail("MIGRATION_014_RUN_LIVENESS_GUARD_MARKER_MISSING", marker);
  if (!/clock_timestamp\(\)\s*>\s*old\.execution_deadline_at/i.test(runGuard)) {
    fail("MIGRATION_014_RUN_LIVENESS_GUARD_MARKER_MISSING", "clock_timestamp() > old.execution_deadline_at");
  }

  const iterationGuard = await functionDef(client, "intentchord.context_mapping_iteration_insert_guard()");
  for (const marker of ["AI_CONTEXT_MAPPING_V2","deterministic_validation_evidence","PASS","context_assembly_revision_id"]) {
    if (!iterationGuard.includes(marker)) fail("MIGRATION_014_MAPPING_ITERATION_ADMISSION_GUARD_MISSING", marker);
  }

  const missingGuard = await functionDef(client, "intentchord.context_missing_evidence_insert_guard()");
  if (!missingGuard.includes("analysis_json") || !missingGuard.includes("missing_evidence_requests")) fail("MIGRATION_014_MISSING_EVIDENCE_PROVENANCE_GUARD_MISSING");
  const contradictionGuard = await functionDef(client, "intentchord.context_material_contradiction_insert_guard()");
  if (!contradictionGuard.includes("analysis_json") || !contradictionGuard.includes("material_contradictions")) fail("MIGRATION_014_CONTRADICTION_PROVENANCE_GUARD_MISSING");

  const closureGuard = await functionDef(client, "intentchord.context_closure_evaluation_insert_guard()");
  for (const marker of [
    "mapping_iteration_id","AI_CONTEXT_MAPPING_V2","evaluation_input_sha256","decision",
    "EXACT_MISSING_EVIDENCE_CLASSIFICATION_REQUIRED","unclassified_missing_evidence_count",
    "CURRENT_EFFECTIVE_CONTEXT_REQUIRED","current_effective_context_authority_status",
  ]) {
    if (!closureGuard.includes(marker)) fail("MIGRATION_014_CLOSURE_EVALUATION_GUARD_MISSING", marker);
  }
  const catalogGuard = await functionDef(client, "intentchord.context_catalog_revision_insert_guard()");
  for (const marker of [
    "closure_evaluation_id","mapping_iteration_id","PASS","catalog_json",
    "CURRENT_EFFECTIVE_CONTEXT_REQUIRED","current_effective_context_authority_status",
  ]) {
    if (!catalogGuard.includes(marker)) fail("MIGRATION_014_ACCEPTED_CATALOG_PROVENANCE_GUARD_MISSING", marker);
  }
  const requirementConstraints = await tableCheckConstraints(client, "context_resolution_requirements");
  assertExactTextDomainConstraint(requirementConstraints, {
    columnName: "requirement_type",
    expectedValues: ["MISSING_INTERNAL_EVIDENCE", "SOURCE_TRUTH_CONFLICT"],
    excludedMarkers: ["originating_missing_evidence_request_id", "originating_material_contradiction_id"],
    failCode: "MIGRATION_014_RESOLUTION_REQUIREMENT_TYPE_CONSTRAINT_MISSING",
  });
  const requirementOriginConstraint = requirementConstraints.find(row => row.conname === "context_resolution_requirement_origin_ck");
  if (!requirementOriginConstraint) fail("MIGRATION_014_RESOLUTION_REQUIREMENT_ORIGIN_CONSTRAINT_MISSING");
  const requirementOrigin = normalizedConstraintDefinition(requirementOriginConstraint.definition);
  const requirementOriginRelationship = /\(*requirement_type='missing_internal_evidence'\)*and\(*originating_missing_evidence_request_idisnotnull\)*and\(*originating_material_contradiction_idisnull\)*\)*or\(*\(*requirement_type='source_truth_conflict'\)*and\(*originating_missing_evidence_request_idisnull\)*and\(*originating_material_contradiction_idisnotnull\)*/;
  if (!requirementOriginRelationship.test(requirementOrigin)) {
    fail("MIGRATION_014_RESOLUTION_REQUIREMENT_ORIGIN_CONSTRAINT_INVALID");
  }

  const requirementGuard = await functionDef(client, "intentchord.context_resolution_requirement_insert_guard()");
  for (const marker of [
    "MISSING_INTERNAL_EVIDENCE","mapping_iteration_id","context_missing_evidence_requests","context_material_contradictions",
    "ITERATION_MISMATCH","MISSING_EVIDENCE_MISMATCH","CONTRADICTION_MISMATCH",
  ]) {
    if (!requirementGuard.includes(marker)) fail("MIGRATION_014_RESOLUTION_REQUIREMENT_GUARD_MISSING", marker);
  }
  const eventGuard = await functionDef(client, "intentchord.context_resolution_event_insert_guard()");
  for (const marker of [
    "OWNER_AUTHORIZED_SOURCE","OWNER_DENIED_SOURCE","SUPERSEDED_BY_NEW_ASSEMBLY",
    "SUCCESSOR_LINEAGE_MISMATCH",
  ]) {
    if (!eventGuard.includes(marker)) fail("MIGRATION_014_RESOLUTION_EVENT_GUARD_MISSING", marker);
  }

  const effectiveContextGuard = await functionDef(client, "intentchord.current_effective_context_authority_status(uuid,uuid)");
  for (const marker of [
    "STEP 1: establish current authority","STEP 2: current authority is proven",
    "authority_sequence DESC","SOURCE_PROVEN_INDEX_FAILED","index_attempt_status","task_workspace_snapshots",
    "context_assembly_sources","ORDER BY revision DESC","tws.ordering IS DISTINCT FROM cas.ordering",
    "workspace_observation_id","workspace_observation_authority_sequence",
    "context_forward_authority_consumptions","RETURN 'CURRENT'","RETURN 'DRIFT'","RETURN 'UNPROVEN'",
  ]) if (!effectiveContextGuard.includes(marker)) fail("MIGRATION_014_CURRENT_EFFECTIVE_CONTEXT_GUARD_MISSING", marker);

  const sourceAuthorizationGuard = await functionDef(client, "intentchord.context_source_authorization_insert_guard()");
  for (const marker of [
    "STALE_CONTEXT_HEAD","REQUIREMENT_SUPERSEDED","TASK_REVISION_STALE",
    "WORKSPACE_REGISTRATION_STALE","WORKSPACE_ALREADY_PRESENT","FOR UPDATE",
    "CURRENT_EFFECTIVE_CONTEXT_REQUIRED","current_effective_context_authority_status",
    "UNION","SELECT NEW.workspace_registration_id","ORDER BY w.id",
  ]) if (!sourceAuthorizationGuard.includes(marker)) fail("MIGRATION_014_CURRENT_HEAD_SOURCE_AUTH_GUARD_MISSING", marker);

  const consumptionConstraints = await tableCheckConstraints(client, "context_forward_authority_consumptions");
  assertExactTextDomainConstraint(consumptionConstraints, {
    columnName: "consumption_type",
    expectedValues: ["SOURCE_MUTATING_RUN_STARTED"],
    failCode: "MIGRATION_014_CONTEXT_CONSUMPTION_TYPE_CONSTRAINT_MISSING",
  });

  const consumptionGuard = await functionDef(client, "intentchord.context_forward_authority_consumption_insert_guard()");
  for (const marker of [
    "modifySource","scopeConfirmation","authorityInputSha256","candidateScopeSha256","CURRENT_EFFECTIVE_CONTEXT",
    "PERFORM 1 FROM intentchord.tasks","PERFORM 1 FROM intentchord.context_assemblies","ORDER BY w.id",
    "contract_revisions WHERE id=NEW.contract_revision_id FOR UPDATE","runs WHERE id=NEW.run_id FOR UPDATE",
    "CONTEXT_BINDING_MISMATCH","SOURCE_MUTATING_CONTRACT_REQUIRED","RUN_BINDING_MISMATCH",
    "SCOPE_AUTHORITY_MISMATCH","CURRENT_EFFECTIVE_CONTEXT_REQUIRED",
  ]) if (!consumptionGuard.includes(marker)) fail("MIGRATION_014_CONTEXT_CONSUMPTION_GUARD_MISSING", marker);

  const mappingScopeGuard = await functionDef(client, "intentchord.context_mapping_run_insert_snapshot_guard()");
  for (const marker of [
    "AI_CONTEXT_MAPPING_V1","AI_CONTEXT_MAPPING_V2","workspace_index_snapshot_id","context_assembly_revision_id",
    "CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED","CONTEXT_MAPPING_V2_ASSEMBLY_BINDING_REQUIRED",
    "CONTEXT_MAPPING_QUALIFICATION_SCOPE_UNSUPPORTED",
  ]) if (!mappingScopeGuard.includes(marker)) fail("MIGRATION_014_MAPPING_SCOPE_GUARD_MARKER_MISSING", marker);

  const runtimeGuard = await functionDef(client, "intentchord.context_mapping_run_insert_guard_v014()");
  for (const marker of [
    "intentchord.internal-ai-provider-configuration.v3","intentchord.internal-ai-engine-registry.v2",
    "selection_mode","SINGLE","qualification_scope","NEW.qualification_scope","qualification_status","QUALIFIED",
    "selected_engine_id","engine_id","selected_engine_config_revision","engine_config_revision",
    "selected_engine_configuration_sha256","engine_configuration_sha256","internal_ai_engine_configuration_sha256_v1",
    "INTENTCHORD_CONTEXT_MAPPING_RUNTIME_CONFIGURATION_EXACT_QUALIFICATION_REQUIRED",
  ]) if (!runtimeGuard.includes(marker)) fail("MIGRATION_014_RUNTIME_GUARD_MARKER_MISSING", marker);

  const v1ProposalGuard = await functionDef(client, "intentchord.context_catalog_proposal_insert_guard()");
  if (!v1ProposalGuard.includes("AI_CONTEXT_MAPPING_V1")) fail("MIGRATION_014_V1_PROPOSAL_COMPATIBILITY_GUARD_INVALID");

  console.log(`MIGRATION_014_OBJECTS: PASS tables=${requiredTables.length} governed_triggers=${requiredTriggers.length}`);
  console.log("CONTEXT_ASSEMBLY_EVIDENCE_ONLY: PASS");
  console.log("MAPPING_EXECUTION_STATE_OWNED_BY_RUN: PASS");
  console.log("CONTEXT_CLOSURE_IMMUTABLE_EVALUATIONS: PASS");
  console.log("ACCEPTED_CATALOG_EXACT_PROVENANCE: PASS");
  console.log("CURRENT_HEAD_SOURCE_AUTHORITY_GUARD: PASS");
  console.log("CURRENT_EFFECTIVE_CONTEXT_AUTHORITY_DB_GUARD: PASS");
  console.log("AI_CONTEXT_MAPPING_V1_COMPATIBILITY: PASS");
  console.log("AI_CONTEXT_MAPPING_V2_EXPLICIT_SCOPE: PASS");
  console.log("V1_QUALIFICATION_IMPLIES_V2: NO");
}

async function main() {
  if (process.env.INTENTCHORD_MIGRATION_014_STRUCTURAL_SELF_TEST === "1") {
    runSnapshotBindingStructuralSelfTest();
    return;
  }
  if (!["preflight", "qualify", "apply", "verify"].includes(action)) fail("MIGRATION_014_ACTION_INVALID", String(action));
  await assertSourceHash();
  const sql = await readFile(`migrations/${migrationId}`, "utf8");
  const client = new pg.Client({ connectionString: await databaseUrl() });
  await client.connect();
  try {
    await assertIdentity(client);
    const current = await state(client);
    console.log(`MIGRATION_014_STATE: ${current}`);
    if (action === "preflight") {
      if (current === "APPLIED") await assertObjects(client);
      console.log("MIGRATION_014_PREFLIGHT: PASS");
      return;
    }
    if (action === "qualify") {
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(sql);
        await assertObjects(client);
        await client.query("rollback");
      } catch (error) { await client.query("rollback"); throw error; }
      console.log(`MIGRATION_014_QUALIFY: PASS source_state=${current} transaction=ROLLBACK`);
      return;
    }
    if (action === "verify") {
      if (current !== "APPLIED") fail("MIGRATION_014_NOT_APPLIED");
      await assertObjects(client);
      console.log("MIGRATION_014_VERIFY: PASS");
      return;
    }
    if (current === "APPLIED") {
      await assertObjects(client);
      console.log("MIGRATION_014_APPLY: PASS already_applied=true");
      return;
    }
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into intentchord.schema_migrations(id) values($1)", [migrationId]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    await assertObjects(client);
    console.log("MIGRATION_014_APPLY: PASS already_applied=false");
  } finally { await client.end(); }
}

main().catch(error => {
  console.error(`MIGRATION_014_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
