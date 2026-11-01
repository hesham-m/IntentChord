import { readFileSync, readdirSync } from "node:fs";
const read=p=>readFileSync(p,"utf8");
const head=read("src/server/context-head-authority.ts");
const closure=read("src/server/context-closure-service.ts");
const lifecycle=read("src/server/lifecycle.ts");
const snapshot=read("src/server/task-experience-authority-snapshot.ts");
const projection=read("src/server/task-experience-projection-service.ts");
const workbench=read("src/components/unified-task-workbench.tsx");
const migration=read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const correction=read("src/core/tasks/correction-authority.ts");
const attempt=read("src/core/tasks/context-analysis-attempt.ts");
const checks=[
["TS_SOURCE_SET_ID_FP_ORDER",head.includes("taskSourceSetAuthoritySha256V1")],
["DB_SOURCE_SET_ORDER",migration.includes("tws.ordering IS DISTINCT FROM cas.ordering")],
["DB_LATEST_ACTUAL_DRAFT",migration.includes("ORDER BY revision DESC")&&migration.includes("v_draft_revision_id")],
["PRESELECTION_CONTEXT_CHECK",snapshot.includes("?? contextClosure?.revisionId")],
["PRESELECTION_STALE_REBUILD",projection.includes("CURRENT_CONTEXT_REBUILD_REQUIRED")],
["ANALYZE_ATTEMPT_ID",workbench.includes("const analysisAttemptId = crypto.randomUUID()")&&attempt.includes("analysisAttemptId")],
["CONSUMPTION_TABLE",migration.includes("context_forward_authority_consumptions")],
["RUN_CONSUMPTION_SAME_TX",lifecycle.includes("await persistSourceMutatingContextConsumption(client")],
["READ_ONLY_NOT_CONSUMED",lifecycle.includes("!input.contract.authorization.modifySource) return")],
["CONSUMED_UNPROVEN",head.includes("forwardAuthorityConsumed")&&migration.includes("RETURN 'UNPROVEN'")],
["PENDING_CORRECTION_REBUILD",projection.includes("pendingCorrectionRun && frozenContextAuthorityStale")],
["NO_POSTCOMMIT_OLD_REEVALUATION",!closure.includes("reevaluateLatestAdmittedIteration")],
["PRESENTATION_EDIT_PRESERVES_AUTHORITY",lifecycle.includes("preserveUnifiedFrozenAuthority")],
["REBASED_CORRECTION_NO_OPERATIONAL_INHERITANCE",correction.includes("if (!input.sameExactExecutionAuthority) return { completedFacts: [], inheritedCheckIds: [] }")],
["CURRENT_CONTRACT_CORRECTION",lifecycle.includes("const currentResolved = await currentContractForUpdate(client, route.rows[0].task_id)")],
["CLOSURE_PASS_DB_CURRENT_GATE",migration.includes("INTENTCHORD_CONTEXT_CLOSURE_CURRENT_EFFECTIVE_CONTEXT_REQUIRED")],
["CATALOG_DB_CURRENT_GATE",migration.includes("INTENTCHORD_CONTEXT_CATALOG_CURRENT_EFFECTIVE_CONTEXT_REQUIRED")],
["V1_PROPOSAL_GUARD_DECLARATION_VALID",(migration.match(/run_row intentchord\.context_mapping_runs%ROWTYPE;/g)||[]).length>=1],
["OBSERVATION_HEAD_FIRST",head.includes("order by o.authority_sequence desc")],
["NO_OLDER_SUCCESS_FALLBACK",head.includes("actual current Workspace Observation authority head is failed")],
["NO_MIGRATION_015",!readdirSync("migrations").some(n=>n.startsWith("015_"))],
["NO_MISTRAL",![head,closure,lifecycle,migration].join("\n").match(/internal-mistral-large-2512|mistral-large-2512/i)],
];
let fail=0;for(const [n,ok] of checks){console.log(`${n}=${ok?"PASS":"FAIL"}`);if(!ok)fail++;}
console.log(`FINAL_INTEGRATION_SOURCE_CHECKS=${checks.length}`);console.log(`FINAL_INTEGRATION_SOURCE_FAIL=${fail}`);
if(fail)process.exit(1);console.log("CURRENT_CONTEXT_FORWARD_AUTHORITY_FINAL_INTEGRATION_SOURCE_AUDIT=PASS");
