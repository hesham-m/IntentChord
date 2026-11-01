import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("CANONICAL_JSON_NON_FINITE_NUMBER");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`CANONICAL_JSON_UNSUPPORTED_TYPE:${typeof value}`);
}
const sha = value => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const fileSha = bytes => createHash("sha256").update(bytes).digest("hex");
const samplePath = resolve("reports/architecture-validation/samples/canonical-workspace-index-v1.sample.json");
const sidecarPath = `${samplePath}.sha256`;
const bytes = readFileSync(samplePath);
const sample = JSON.parse(bytes.toString("utf8"));
const files = [...sample.snapshot.files].map(file => ({
  relative_path: file.relative_path.replaceAll("\\", "/").replace(/^\.\//, ""),
  size_bytes: file.size_bytes,
  content_hash: file.content_hash,
})).sort((a,b) => a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : a.content_hash < b.content_hash ? -1 : a.content_hash > b.content_hash ? 1 : 0);
const expectedTree = `sha256:${sha({ schema: "intentchord.workspace-source-state-fingerprint/v2", files })}`;
const expectedPayload = `sha256:${sha({
  contract_type: sample.contract_type,
  contract_version: sample.contract_version,
  contract_id: sample.contract_id,
  contract_status: sample.contract_status,
  workspace: sample.workspace,
  source_binding: sample.source_binding,
  generation: sample.generation,
  snapshot: sample.snapshot,
  delta: sample.delta,
  coverage: sample.coverage,
  failures: sample.failures,
  integrity: {
    workspace_tree_fingerprint: expectedTree,
    file_count: sample.snapshot.files.length,
    fact_count: sample.snapshot.facts.length,
    relation_count: sample.snapshot.relations.length,
    content_reference_count: sample.snapshot.content_references.length,
  },
})}`;
if (sample.integrity.workspace_tree_fingerprint !== expectedTree) throw new Error(`SAMPLE_WORKSPACE_TREE_FINGERPRINT_DRIFT:${sample.integrity.workspace_tree_fingerprint}:${expectedTree}`);
if (sample.integrity.canonical_payload_hash !== expectedPayload) throw new Error(`SAMPLE_CANONICAL_PAYLOAD_HASH_DRIFT:${sample.integrity.canonical_payload_hash}:${expectedPayload}`);
const sidecar = readFileSync(sidecarPath, "utf8").trim().split(/\s+/);
const actualFileSha = fileSha(bytes);
if (sidecar[0]?.toLowerCase() !== actualFileSha) throw new Error(`SAMPLE_FILE_SHA256_DRIFT:${sidecar[0]}:${actualFileSha}`);
if (sidecar[1] !== basename(samplePath)) throw new Error("SAMPLE_SHA256_SIDECAR_FILENAME_MISMATCH");
console.log(`CANONICAL_SAMPLE=${basename(samplePath)}`);
console.log(`WORKSPACE_TREE_FINGERPRINT=${expectedTree}`);
console.log(`CANONICAL_PAYLOAD_HASH=${expectedPayload}`);
console.log(`SAMPLE_FILE_SHA256=${actualFileSha}`);
console.log("CANONICAL_WORKSPACE_INDEX_SAMPLE_VERIFY=PASS");
