import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { disposableValidationUrl, safeValidationTarget } from "./current-context-disposable-validation-target.mjs";

const EXPECTED_NODE = "25.2.1";
const EXPECTED_NPM = "11.6.2";
const EXPECTED_014 = "8ED111969E4D92CF2DFC613A0AC7573D1E1E2FF01ADA012A8EEABA90561947EB";
const EXPECTED_LOCK = "DDAA83B333CCBF7D61890914E769CA2666F8F779B842709DE8FAFF7496019D3F";
const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex").toUpperCase();

function npmCliCandidates() {
  const nodeDirectory = path.dirname(process.execPath);
  return [
    process.env.INTENTCHORD_NPM_CLI_PATH,
    process.env.npm_execpath,
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate, index, all) =>
    Boolean(candidate) && all.indexOf(candidate) === index,
  );
}

function resolveNpmCliPath() {
  for (const candidate of npmCliCandidates()) {
    if (!existsSync(candidate)) continue;
    if (path.basename(candidate).toLowerCase() !== "npm-cli.js") continue;
    return candidate;
  }
  throw new Error("NPM_CLI_PATH_UNAVAILABLE: no deterministic existing npm-cli.js candidate");
}

function launchErrorDetails(error) {
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
  const name = typeof error?.name === "string" ? error.name : "Error";
  const message = typeof error?.message === "string" ? error.message : String(error);
  return `name=${name} code=${code} message=${message}`;
}

const npmCliPath = resolveNpmCliPath();

function run(label, args, env = process.env) {
  console.log(`=== ${label} ===`);
  const result = spawnSync(process.execPath, [npmCliPath, ...args], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw new Error(`${label}_LAUNCH_ERROR ${launchErrorDetails(result.error)}`);
  }
  if (result.status === null) {
    throw new Error(`${label}_CHILD_TERMINATED_WITHOUT_EXIT signal=${result.signal ?? "UNKNOWN"}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}_NONZERO_CHILD_EXIT status=${result.status}`);
  }
}

const node = process.versions.node;
if (node !== EXPECTED_NODE) throw new Error(`NODE_VERSION_MISMATCH expected=${EXPECTED_NODE} actual=${node}`);

const npmVersionResult = spawnSync(process.execPath, [npmCliPath, "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});
if (npmVersionResult.error) {
  throw new Error(`NPM_VERSION_PROBE_LAUNCH_ERROR ${launchErrorDetails(npmVersionResult.error)}`);
}
if (npmVersionResult.status === null) {
  throw new Error(`NPM_VERSION_PROBE_TERMINATED_WITHOUT_EXIT signal=${npmVersionResult.signal ?? "UNKNOWN"}`);
}
if (npmVersionResult.status !== 0) {
  const stderr = npmVersionResult.stderr?.trim() || "<empty>";
  throw new Error(`NPM_VERSION_PROBE_NONZERO_CHILD_EXIT status=${npmVersionResult.status} stderr=${stderr}`);
}
const npm = npmVersionResult.stdout?.trim();
if (!npm) throw new Error("NPM_VERSION_PROBE_STDOUT_MISSING");
if (npm !== EXPECTED_NPM) throw new Error(`NPM_VERSION_MISMATCH expected=${EXPECTED_NPM} actual=${npm}`);

if (sha("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql") !== EXPECTED_014) throw new Error("MIGRATION_014_SOURCE_HASH_MISMATCH");
if (sha("package-lock.json") !== EXPECTED_LOCK) throw new Error("PACKAGE_LOCK_IDENTITY_MISMATCH");
const disposableUrl = disposableValidationUrl();
const disposableTarget = safeValidationTarget(disposableUrl);
console.log(`DISPOSABLE_VALIDATION_TARGET database=${disposableTarget.database} user=${disposableTarget.user} host=${disposableTarget.host} port=${disposableTarget.port} schema=${disposableTarget.schema}`);
run("GOVERNED_NPM_CI", ["ci"]);
run("AUTHORITATIVE_TYPESCRIPT", ["run", "typecheck"]);
run("OFFICIAL_VITEST_VALIDATION_HARNESS", ["run", "test:current-context:validation-harness"]);
run("OFFICIAL_VITEST_SEMANTIC_LOCK", ["run", "test:current-context:semantic-lock"]);
console.log("OWNER_DB_MIGRATION_014_QUALIFY_ROLLBACK_ONLY: BEGIN");
run("OWNER_DB_MIGRATION_014_PREFLIGHT", ["run", "migration:014:preflight"]);
run("OWNER_DB_MIGRATION_014_QUALIFY_ROLLBACK_ONLY", ["run", "migration:014:qualify"]);
console.log("OWNER_DB_MIGRATION_014_PERSISTENT_APPLY=NO");
console.log("DISPOSABLE_VALIDATION_STAGE: BEGIN");
run("DISPOSABLE_DB_BOOTSTRAP", ["run", "validation:current-context:disposable:bootstrap"]);
run("OFFICIAL_VITEST_DISPOSABLE_PG", ["run", "test:current-context:pg-concurrency"], { ...process.env, INTENTCHORD_CURRENT_CONTEXT_CONCURRENCY_PG_TEST: "1" });
run("PRODUCTION_BUILD", ["run", "build"]);
console.log("OWNER_DB_MIGRATION_014_PERSISTENT_APPLY=NO");
console.log("OWNER_AUTHORITATIVE_PREAPPLY_VALIDATION_SEQUENCE=PASS");
