import { readFileSync } from "node:fs";

const read = p => readFileSync(p,"utf8");
const authority=read("src/server/context-head-authority.ts");
const lifecycle=read("src/server/lifecycle.ts");
const closure=read("src/server/context-closure-service.ts");
const binding=read("src/server/context-assembly-task-binding-service.ts");
const migration=read("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql");
const pg=read("src/server/current-context-forward-authority-concurrency.postgres.integration.test.ts");
const focused=read("src/server/current-context-forward-authority-semantic-lock-order.test.ts");
const matrix=read("src/server/current-context-forward-authority-semantic-parity-concurrency-matrix.test.ts");
const h=(s,m)=>s.includes(m);
const before=(s,a,b)=>{const x=s.indexOf(a),y=s.indexOf(b);return x>=0&&y>x;};
const pgCaseBlock=caseId=>{
  const marker=`caseId: "${caseId}"`;
  const markerIndex=pg.indexOf(marker);
  if(markerIndex<0)return "";
  const start=pg.lastIndexOf("\n  it(",markerIndex);
  const next=pg.indexOf("\n  it(",markerIndex);
  return pg.slice(start<0?markerIndex:start,next<0?pg.length:next);
};
const pg26=pgCaseBlock("CASE26");
const pg27=pgCaseBlock("CASE27");
const pg28=pgCaseBlock("CASE28");
const pg29=pgCaseBlock("CASE29");
const pg30=pgCaseBlock("CASE30");
const pg31=pgCaseBlock("CASE31");
const cases=[
 ["01_TYPED_CURRENT_DRIFT_UNPROVEN",()=>h(authority,'status: "DRIFT" | "UNPROVEN"')&&h(authority,'status: "CURRENT"')],
 ["02_CANONICAL_EVALUATOR",()=>h(authority,"evaluateCurrentEffectiveContextAuthority")],
 ["03_COMMAND_WRAPPER_ONLY",()=>h(authority,"assertCurrentEffectiveContextAuthority")&&h(authority,"CURRENT_SOURCE_AUTHORITY_UNPROVEN")],
 ["04_READ_ONLY_TYPED_EVALUATOR",()=>h(authority,"readFrozenContextForwardAuthorityStatus")&&h(authority,"evaluateCurrentEffectiveContextAuthority")],
 ["05_NO_HTTP_ERROR_STATUS_INFERENCE",()=>{const x=authority.indexOf("export async function readFrozenContextForwardAuthorityStatus");const z=authority.slice(x);return x>=0&&!h(z,'error.code === "CURRENT_SOURCE_AUTHORITY_UNPROVEN"')&&!h(z,"instanceof HttpCommandError");}],
 ["06_NO_EXPORTED_ALTERNATE_SOURCE_RESOLVER",()=>!h(authority,"export async function inspectFrozenContextSourceAuthority")],
 ["07_DB_STEP1_ESTABLISH",()=>h(migration,"STEP 1: establish current authority")],
 ["08_DB_STEP2_COMPARE",()=>h(migration,"STEP 2: current authority is proven")],
 ["09_DB_THREE_STATUS_ONLY",()=>h(migration,"RETURN 'CURRENT'")&&h(migration,"RETURN 'DRIFT'")&&h(migration,"RETURN 'UNPROVEN'")],
 ["10_OBSERVATION_HEAD_FIRST",()=>h(migration,"ORDER BY o.authority_sequence DESC")&&h(authority,"order by o.authority_sequence desc")],
 ["11_FROZEN_OBSERVATION_IDENTITY",()=>h(migration,"workspace_observation_id")&&h(migration,"workspace_observation_authority_sequence")],
 ["12_SOURCE_SET_ORDERING",()=>h(migration,"tws.ordering IS DISTINCT FROM cas.ordering")],
 ["13_SOURCE_SET_FINGERPRINT",()=>h(migration,"tws.fingerprint IS DISTINCT FROM cas.workspace_registration_fingerprint")],
 ["14_CONSUMPTION_UNPROVEN",()=>h(migration,"context_forward_authority_consumptions")&&h(migration,"RETURN 'UNPROVEN'")],
 ["15_APPROVAL_TASK_FIRST",()=>{const x=lifecycle.indexOf("export async function approveContractRevision");const y=lifecycle.indexOf("export async function compileContractArtifact",x);const z=lifecycle.slice(x,y);return before(z,"lockTask(client, routing.taskId)","loadContractForUpdate(client, contractRevisionId)");}],
 ["16_COMPILE_TASK_FIRST",()=>{const x=lifecycle.indexOf("export async function compileContractArtifact");const y=lifecycle.indexOf("export async function createRun",x);const z=lifecycle.slice(x,y);return before(z,"lockTask(client, routing.taskId)","loadContractForUpdate(client, contractRevisionId)");}],
 ["17_CREATE_RUN_TASK_CONTEXT_CONTRACT",()=>{const x=lifecycle.indexOf("export async function createRun");const y=lifecycle.indexOf("export async function submitRawReport",x);const z=lifecycle.slice(x,y<0?lifecycle.length:y);return before(z,"lockTask(client, taskId", "assertCurrentEffectiveContextAuthority")&&before(z,"assertCurrentEffectiveContextAuthority","currentContractForUpdate");}],
 ["18_CORRECTION_TASK_CONTEXT_CONTRACT_RUN",()=>{const s=lifecycle.slice(lifecycle.indexOf("export async function startCorrection"));return before(s,"lockTask","assertCurrentEffectiveContextAuthority")&&before(s,"assertCurrentEffectiveContextAuthority","currentContractForUpdate")&&before(s,"currentContractForUpdate","loadRunForUpdate");}],
 ["19_NONLOCKING_CONTRACT_ROUTING",()=>{const s=lifecycle.slice(lifecycle.indexOf("async function lookupContractRouting"),lifecycle.indexOf("async function readRuns"));return !/for update/i.test(s);}],
 ["20_SOURCE_AUTH_ADDITIONAL_WORKSPACE_TO_GATE",()=>h(closure,"[command.workspaceRegistrationId]")],
 ["21_SOURCE_AUTH_DB_UNION",()=>h(migration,"UNION\n     SELECT NEW.workspace_registration_id")],
 ["22_SOURCE_AUTH_GLOBAL_ORDER",()=>h(migration,"ORDER BY w.id")],
 ["23_NO_SEPARATE_TARGET_FOR_UPDATE",()=>!closure.slice(closure.indexOf("export async function authorizeTaskContextSource")).includes("from intentchord.workspaces where id=$1 for update")],
 ["24_CONTEXT_CAPTURE_CANONICAL_LOCK_HELPER",()=>h(closure,"captureLockedTaskSourceAuthority")],
 ["25_WORK_SELECTION_CANONICAL_GATE",()=>h(binding,"assertCurrentEffectiveContextAuthority")],
 ["26_SCOPE_CANONICAL_GATE",()=>h(lifecycle,"export async function confirmTaskScope")&&h(lifecycle,"assertCurrentEffectiveContextAuthority")],
 ["27_PG_CONCURRENCY_SOURCE_PRESENT",()=>h(pg,"Owner disposable PostgreSQL Current Context product concurrency")],
 ["28_PG_CONTRACT_CONCURRENCY",()=>h(pg26,"resolveContract(")&&h(pg26,"approveContractRevision(")&&h(pg26,'milestone: "TASK_LOCK"')&&h(pg27,"resolveContract(")&&h(pg27,"compileContractArtifact(")&&h(pg27,'milestone: "TASK_LOCK"')&&h(pg28,"commitTaskWorkSelection(")&&h(pg28,"approveContractRevision(")&&h(pg28,'milestone: "TASK_LOCK"')],
 ["29_PG_CROSS_WORKSPACE_CONCURRENCY",()=>h(pg29,"authorizeTaskContextSource(")&&(pg29.match(/authorizeTaskContextSource\(/g)??[]).length===2&&h(pg29,'mode: "SIMULTANEOUS_ATTEMPT"')&&h(pg29,'milestone: "WORKSPACE_LOCK"')],
 ["30_PG_SCOPE_CONCURRENCY",()=>h(pg30,"confirmTaskScope(")&&h(pg30,"resolveContract(")&&h(pg30,'milestone: "TASK_LOCK"')&&h(pg30,"candidateScopeIdentityFromScope(candidate)")],
 ["31_PG_CLOSURE_WORK_CONCURRENCY",()=>h(pg31,"runTaskContextClosure(")&&h(pg31,"commitTaskWorkSelection(")&&h(pg31,"fixture.closure31")&&h(pg31,"ACCEPTED_CONTEXT_CATALOG_SUPERSEDED")&&h(pg31,'milestone: "TASK_LOCK"')],
 ["32_PG_DRIFT_ASSERTION",()=>h(pg,'toBe("DRIFT")')],
 ["33_PG_UNPROVEN_ASSERTION",()=>h(pg,'toBe("UNPROVEN")')],
 ["34_CONSUMPTION_DB_GLOBAL_LOCK_ORDER",()=>{const x=migration.indexOf("CREATE OR REPLACE FUNCTION intentchord.context_forward_authority_consumption_insert_guard()");const y=migration.indexOf("DROP TRIGGER IF EXISTS context_forward_authority_consumptions_insert_guard",x);const z=migration.slice(x,y);return before(z,"PERFORM 1 FROM intentchord.tasks","PERFORM 1 FROM intentchord.context_assemblies")&&before(z,"PERFORM 1 FROM intentchord.context_assemblies","ORDER BY w.id")&&before(z,"ORDER BY w.id","contract_revisions WHERE id=NEW.contract_revision_id FOR UPDATE")&&before(z,"contract_revisions WHERE id=NEW.contract_revision_id FOR UPDATE","runs WHERE id=NEW.run_id FOR UPDATE");}],
 ["35_FOCUSED_TEST_PRESENT",()=>h(focused,"semantic parity and global lock order")],
 ["36_MATRIX_57_PRESENT",()=>h(matrix,"matrix cardinality is exactly 57 required cases")],
];
let pass=0;
for(const [name,fn] of cases){let ok=false;try{ok=Boolean(fn())}catch{};console.log(`${ok?"PASS":"FAIL"} ${name}`);if(ok)pass++;}
console.log(`CURRENT_CONTEXT_SEMANTIC_LOCK_ORDER_CHECKS=${cases.length}`);
console.log(`CURRENT_CONTEXT_SEMANTIC_LOCK_ORDER_PASS=${pass}`);
console.log(`CURRENT_CONTEXT_SEMANTIC_LOCK_ORDER_FAIL=${cases.length-pass}`);
console.log(`CURRENT_CONTEXT_SEMANTIC_LOCK_ORDER_SOURCE_AUDIT=${pass===cases.length?"PASS":"FAIL"}`);
process.exit(pass===cases.length?0:1);
