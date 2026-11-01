import {
  canonicalJson,
  canonicalWorkspaceIndexHash,
  finalizeWorkspaceIndexContract,
  normalizedWorkspaceIndexSnapshot,
  workspaceTreeFingerprint,
} from "@/core/workspace-index/canonical";
import { validateWorkspaceIndexDelta } from "@/core/workspace-index/delta";
import { canonicalWorkspaceIndexContractSchema } from "@/core/workspace-index/schema";
import type {
  CanonicalWorkspaceIndexContract,
  TechnicalValidationDiagnostic,
  TechnicalValidationResult,
  WorkspaceCoverageSummary,
  WorkspaceIndexSnapshot,
} from "@/core/workspace-index/types";

function diagnostic(code: string, severity: "ERROR" | "WARNING", message: string, path?: string): TechnicalValidationDiagnostic {
  return { code, severity, message, ...(path ? { path } : {}) };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function deriveCoverageSummary(snapshot: WorkspaceIndexSnapshot): WorkspaceCoverageSummary {
  const factCount: Record<string, number> = {};
  for (const fact of snapshot.facts) factCount[fact.fact_type] = (factCount[fact.fact_type] ?? 0) + 1;
  const relationCount: Record<string, number> = {};
  for (const relation of snapshot.relations) relationCount[relation.relation_type] = (relationCount[relation.relation_type] ?? 0) + 1;
  const languageCoverage: WorkspaceCoverageSummary["parser_coverage_by_language"] = {};
  for (const file of snapshot.files) {
    const language = file.language ?? file.file_kind.toLowerCase();
    const entry = languageCoverage[language] ?? { discovered_files: 0, parsed_files: 0, partial_files: 0, unsupported_files: 0 };
    entry.discovered_files += 1;
    if (file.coverage_state === "COMPLETE") entry.parsed_files += 1;
    if (file.coverage_state === "PARTIAL" || file.coverage_state === "METADATA_ONLY" || file.coverage_state === "RESTRICTED") entry.partial_files += 1;
    if (file.coverage_state === "UNSUPPORTED") entry.unsupported_files += 1;
    languageCoverage[language] = entry;
  }
  return {
    total_discovered_files: snapshot.files.length,
    metadata_indexed_files: snapshot.files.filter(file => file.coverage_stage !== "DISCOVERED").length,
    fully_parsed_files: snapshot.files.filter(file => file.coverage_state === "COMPLETE").length,
    partially_parsed_files: snapshot.files.filter(file => file.coverage_state === "PARTIAL").length,
    metadata_only_files: snapshot.files.filter(file => file.coverage_state === "METADATA_ONLY").length,
    restricted_files: snapshot.files.filter(file => file.coverage_state === "RESTRICTED").length,
    unsupported_files: snapshot.files.filter(file => file.coverage_state === "UNSUPPORTED").length,
    failed_files: snapshot.files.filter(file => file.coverage_state === "FAILED").length,
    fact_count_by_type: factCount,
    relation_count_by_type: relationCount,
    parser_coverage_by_language: languageCoverage,
  };
}

function validateUniqueIds(contract: CanonicalWorkspaceIndexContract, diagnostics: TechnicalValidationDiagnostic[]) {
  const groups: Array<[string, string[]]> = [
    ["workspace_file_id", contract.snapshot.files.map(item => item.workspace_file_id)],
    ["file_revision_id", contract.snapshot.files.map(item => item.file_revision_id)],
    ["workspace_fact_id", contract.snapshot.facts.map(item => item.workspace_fact_id)],
    ["fact_revision_id", contract.snapshot.facts.map(item => item.fact_revision_id)],
    ["workspace_relation_id", contract.snapshot.relations.map(item => item.workspace_relation_id)],
    ["relation_revision_id", contract.snapshot.relations.map(item => item.relation_revision_id)],
    ["content_ref_id", contract.snapshot.content_references.map(item => item.content_ref_id)],
    ["failure_id", contract.failures.map(item => item.failure_id)],
  ];
  for (const [name, values] of groups) {
    for (const duplicate of duplicateValues(values)) diagnostics.push(diagnostic("DUPLICATE_ID", "ERROR", `Duplicate ${name}: ${duplicate}.`, `snapshot.${name}`));
  }
}

function validateReferences(contract: CanonicalWorkspaceIndexContract, diagnostics: TechnicalValidationDiagnostic[]) {
  const filesByRevision = new Map(contract.snapshot.files.map(file => [file.file_revision_id, file]));
  const factsByRevision = new Map(contract.snapshot.facts.map(fact => [fact.fact_revision_id, fact]));
  const refsById = new Map(contract.snapshot.content_references.map(ref => [ref.content_ref_id, ref]));
  for (const file of contract.snapshot.files) {
    if (file.content_ref_id && !refsById.has(file.content_ref_id)) diagnostics.push(diagnostic("BROKEN_CONTENT_REFERENCE", "ERROR", `File ${file.file_revision_id} references missing ${file.content_ref_id}.`));
  }
  for (const ref of contract.snapshot.content_references) {
    const file = filesByRevision.get(ref.file_revision_id);
    if (!file) diagnostics.push(diagnostic("BROKEN_CONTENT_FILE_REFERENCE", "ERROR", `Content reference ${ref.content_ref_id} points to a missing file revision.`));
    else if (file.content_hash !== ref.content_hash) diagnostics.push(diagnostic("CONTENT_REFERENCE_HASH_MISMATCH", "ERROR", `Content reference ${ref.content_ref_id} does not match its file hash.`));
  }
  for (const fact of contract.snapshot.facts) {
    const file = filesByRevision.get(fact.source_file_revision_id);
    if (!file) diagnostics.push(diagnostic("BROKEN_FACT_SOURCE_REFERENCE", "ERROR", `Fact ${fact.fact_revision_id} points to a missing source file revision.`));
    if (fact.parent_fact_revision_id && !factsByRevision.has(fact.parent_fact_revision_id)) diagnostics.push(diagnostic("BROKEN_PARENT_FACT_REFERENCE", "ERROR", `Fact ${fact.fact_revision_id} points to a missing parent fact.`));
    if (fact.provenance.workspace_revision_id !== contract.workspace.workspace_revision_id) diagnostics.push(diagnostic("FACT_PROVENANCE_WORKSPACE_MISMATCH", "ERROR", `Fact ${fact.fact_revision_id} provenance names another Workspace revision.`));
    if (fact.provenance.file_revision_id !== fact.source_file_revision_id) diagnostics.push(diagnostic("FACT_PROVENANCE_FILE_MISMATCH", "ERROR", `Fact ${fact.fact_revision_id} provenance names another file revision.`));
    if (file && fact.provenance.file_content_hash !== file.content_hash) diagnostics.push(diagnostic("FACT_PROVENANCE_HASH_MISMATCH", "ERROR", `Fact ${fact.fact_revision_id} provenance hash differs from the source file.`));
    const nonGoverning = ["TEXT_PATTERN", "HEURISTIC", "DOCUMENTED_CLAIM"].includes(fact.extraction_method) || ["HEURISTIC", "UNRESOLVED"].includes(fact.certainty);
    if (nonGoverning && fact.evidence_role === "CANONICAL_EVIDENCE") diagnostics.push(diagnostic("NON_GOVERNING_FACT_PROMOTED", "ERROR", `Fact ${fact.fact_revision_id} uses a non-governing extraction method but is marked canonical evidence.`));
  }
  const endpointExists = (type: "FILE" | "FACT", id: string) => type === "FILE" ? filesByRevision.has(id) : factsByRevision.has(id);
  for (const relation of contract.snapshot.relations) {
    if (!endpointExists(relation.source.entity_type, relation.source.entity_revision_id)) diagnostics.push(diagnostic("BROKEN_RELATION_SOURCE", "ERROR", `Relation ${relation.relation_revision_id} source endpoint does not exist.`));
    if (!endpointExists(relation.target.entity_type, relation.target.entity_revision_id)) diagnostics.push(diagnostic("BROKEN_RELATION_TARGET", "ERROR", `Relation ${relation.relation_revision_id} target endpoint does not exist.`));
    for (const evidence of relation.evidence_refs) {
      if (!filesByRevision.has(evidence.file_revision_id)) diagnostics.push(diagnostic("BROKEN_RELATION_EVIDENCE", "ERROR", `Relation ${relation.relation_revision_id} evidence points to a missing file.`));
    }
    const nonGoverning = ["TEXT_PATTERN", "HEURISTIC", "DOCUMENTED_CLAIM"].includes(relation.extraction_method) || ["HEURISTIC", "UNRESOLVED"].includes(relation.certainty);
    if (nonGoverning && relation.evidence_role === "CANONICAL_EVIDENCE") diagnostics.push(diagnostic("NON_GOVERNING_RELATION_PROMOTED", "ERROR", `Relation ${relation.relation_revision_id} is non-governing but marked canonical evidence.`));
  }
}

function validateIntegrity(contract: CanonicalWorkspaceIndexContract, diagnostics: TechnicalValidationDiagnostic[]) {
  const expectedCounts = {
    file_count: contract.snapshot.files.length,
    fact_count: contract.snapshot.facts.length,
    relation_count: contract.snapshot.relations.length,
    content_reference_count: contract.snapshot.content_references.length,
  };
  for (const [field, expected] of Object.entries(expectedCounts)) {
    if (contract.integrity[field as keyof typeof expectedCounts] !== expected) diagnostics.push(diagnostic("COUNT_MISMATCH", "ERROR", `${field} must equal ${expected}.`, `integrity.${field}`));
  }
  const expectedTree = workspaceTreeFingerprint(contract.snapshot);
  if (contract.integrity.workspace_tree_fingerprint !== expectedTree) diagnostics.push(diagnostic("WORKSPACE_TREE_FINGERPRINT_MISMATCH", "ERROR", "Workspace tree fingerprint does not match the full snapshot."));
  const expectedHash = canonicalWorkspaceIndexHash(contract);
  if (contract.integrity.canonical_payload_hash !== expectedHash) diagnostics.push(diagnostic("CANONICAL_PAYLOAD_HASH_MISMATCH", "ERROR", "Canonical payload hash does not match the contract payload."));
  const expectedCoverage = deriveCoverageSummary(contract.snapshot);
  if (canonicalJson(expectedCoverage) !== canonicalJson(contract.coverage)) diagnostics.push(diagnostic("COVERAGE_SUMMARY_MISMATCH", "ERROR", "Coverage summary must be derived from actual file records."));
}

export function validateCanonicalWorkspaceIndexContract(raw: unknown, options: { base_contract?: CanonicalWorkspaceIndexContract; reject_invalid_delta_only?: boolean } = {}): TechnicalValidationResult {
  const parsed = canonicalWorkspaceIndexContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "REJECTED",
      diagnostics: parsed.error.issues.map((issue: { message: string; path: Array<string | number> }) => diagnostic("SCHEMA_INVALID", "ERROR", issue.message, issue.path.join("."))),
      delta_status: "NOT_PRESENT",
    };
  }
  let contract = { ...parsed.data, snapshot: normalizedWorkspaceIndexSnapshot(parsed.data.snapshot) };
  const diagnostics: TechnicalValidationDiagnostic[] = [];
  validateUniqueIds(contract, diagnostics);
  validateReferences(contract, diagnostics);
  validateIntegrity(contract, diagnostics);
  if (contract.failures.some((failure: CanonicalWorkspaceIndexContract["failures"][number]) => failure.impact === "CONTRACT_BLOCKING")) diagnostics.push(diagnostic("CONTRACT_BLOCKING_FAILURE_PRESENT", "ERROR", "A candidate with a contract-blocking failure cannot become canonical."));

  let deltaStatus: TechnicalValidationResult["delta_status"] = contract.delta ? "ACCEPTED" : "NOT_PRESENT";
  if (contract.delta) {
    const deltaResult = validateWorkspaceIndexDelta({ base: options.base_contract, target: contract, delta: contract.delta });
    if (!deltaResult.accepted) {
      deltaStatus = "REJECTED";
      diagnostics.push(...deltaResult.diagnostics.map(code => diagnostic(code, options.reject_invalid_delta_only === false ? "ERROR" : "WARNING", "Derived Delta was rejected; the target full snapshot remains authoritative.")));
      if (options.reject_invalid_delta_only !== false) {
        const { integrity: _integrity, ...withoutIntegrity } = contract;
        contract = finalizeWorkspaceIndexContract({ ...withoutIntegrity, delta: null });
      }
    }
  }

  if (diagnostics.some(item => item.severity === "ERROR")) return { status: "REJECTED", diagnostics, delta_status: deltaStatus };
  const expectedStatus = contract.failures.length > 0 || contract.snapshot.files.some((file: CanonicalWorkspaceIndexContract["snapshot"]["files"][number]) => file.coverage_state !== "COMPLETE") ? "COMPLETE_WITH_GAPS" : "COMPLETE";
  if (contract.contract_status !== expectedStatus) diagnostics.push(diagnostic("CONTRACT_STATUS_NORMALIZED", "WARNING", `Contract status was normalized to ${expectedStatus}.`));
  if (contract.contract_status !== expectedStatus) {
    const { integrity: _integrity, ...withoutIntegrity } = contract;
    contract = finalizeWorkspaceIndexContract({ ...withoutIntegrity, contract_status: expectedStatus });
  }
  return { status: expectedStatus, contract, diagnostics, delta_status: deltaStatus };
}
