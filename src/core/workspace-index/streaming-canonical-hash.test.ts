import { describe, expect, it } from "vitest";
import {
  StreamingCanonicalHashWriter,
  type StreamingHeaderMaterial,
} from "@/core/workspace-index/streaming-canonical-hash";
import {
  canonicalWorkspaceIndexHash,
  finalizeWorkspaceIndexContract,
  normalizedWorkspaceIndexSnapshot,
} from "@/core/workspace-index/canonical";
import type {
  CanonicalWorkspaceIndexContract,
  WorkspaceFactRecord,
  WorkspaceFileRecord,
  WorkspaceRelationRecord,
  ContentReferenceRecord,
} from "@/core/workspace-index/types";

// ---------------------------------------------------------------------------
// Deterministic fixture construction (bounded metadata + streamed families).
// ---------------------------------------------------------------------------

function fileRecord(i: number): WorkspaceFileRecord {
  const suffix = i.toString(36).padStart(3, "0");
  return {
    workspace_file_id: `wfi_${suffix}`,
    file_revision_id: `fir_${suffix}`,
    relative_path: `src/mod_${suffix}.ts`,
    file_name: `mod_${suffix}.ts`,
    file_kind: "SOURCE_CODE",
    language: "typescript",
    size_bytes: 100 + i,
    content_hash: `sha256:${(i + 1).toString(16).padStart(4, "0")}${"a".repeat(60)}`,
    metadata_hash: `sha256:${(i + 2).toString(16).padStart(4, "0")}${"b".repeat(60)}`,
    encoding: "UTF8",
    parse_status: "PARSED",
    sensitivity_state: "NORMAL",
    coverage_stage: "RELATIONS_RESOLVED",
    coverage_state: "COMPLETE",
    content_ref_id: `wcr_${suffix}`,
    lineage_state: "CONTINUED",
  };
}

function factRecord(i: number): WorkspaceFactRecord {
  const suffix = i.toString(36).padStart(3, "0");
  return {
    workspace_fact_id: `wfa_${suffix}`,
    fact_revision_id: `far_${suffix}`,
    fact_type: "SYMBOL",
    qualified_name: `sym_${suffix}`,
    display_name: `sym ${suffix}`,
    attributes: { ordinal: i },
    source_file_revision_id: `fir_${suffix}`,
    source_location: { line_range: { start: i + 1, end: i + 1 } },
    extraction_method: "PARSER_EXACT",
    extractor_id: "ts_symbols_v1",
    extractor_version: "1.0.0",
    certainty: "EXACT",
    evidence_role: "CANONICAL_EVIDENCE",
    provenance: {
      workspace_revision_id: "wsr_x",
      file_revision_id: `fir_${suffix}`,
      file_content_hash: `sha256:${"c".repeat(64)}`,
      source_location: { line_range: { start: i + 1, end: i + 1 } },
      extractor_id: "ts_symbols_v1",
      extractor_version: "1.0.0",
      extraction_method: "PARSER_EXACT",
      evidence_hash: `sha256:${"d".repeat(64)}`,
    },
  };
}

function relationRecord(i: number): WorkspaceRelationRecord {
  return {
    workspace_relation_id: `wre_${i.toString(36).padStart(3, "0")}`,
    relation_revision_id: `rer_${i.toString(36).padStart(3, "0")}`,
    relation_type: "DECLARES",
    source: { entity_type: "FILE", entity_revision_id: `fir_${i.toString(36).padStart(3, "0")}` },
    target: { entity_type: "FACT", entity_revision_id: `far_${i.toString(36).padStart(3, "0")}` },
    direction: "DIRECTED",
    attributes: {},
    evidence_refs: [
      {
        file_revision_id: `fir_${i.toString(36).padStart(3, "0")}`,
        source_location: {},
        evidence_hash: `sha256:${"e".repeat(64)}`,
        extractor_id: "ts_symbols_v1",
        extractor_version: "1.0.0",
      },
    ],
    extraction_method: "PARSER_EXACT",
    extractor_id: "ts_symbols_v1",
    extractor_version: "1.0.0",
    certainty: "EXACT",
    evidence_role: "CANONICAL_EVIDENCE",
  };
}

function contentReferenceRecord(i: number): ContentReferenceRecord {
  const suffix = i.toString(36).padStart(3, "0");
  return {
    content_ref_id: `wcr_${suffix}`,
    file_revision_id: `fir_${suffix}`,
    content_hash: `sha256:${"f".repeat(64)}`,
    content_kind: "SOURCE_CODE",
    media_type: "text/plain",
    encoding: "UTF8",
    size_bytes: 100 + i,
    retrieval_ref: `workspace://ws/mod_${suffix}.ts`,
    sensitivity_class: "NORMAL",
    availability_state: "AVAILABLE",
    scope_type: "FULL_FILE",
  };
}

const HEADER: Omit<StreamingHeaderMaterial, "integrity"> & {
  integrity?: StreamingHeaderMaterial["integrity"];
} = {
  contract_id: "cwi_pf_contract",
  contract_status: "COMPLETE",
  contract_type: "canonical_workspace_index",
  contract_version: "1.0.0",
  coverage: { total_discovered_files: 0 },
  delta: null,
  failures: [],
  generation: {
    indexing_session_id: "wis_pf",
    indexer_name: "intentchord-workspace-indexer",
    indexer_version: "1.4.0",
    parser_registry_version: "workspace-parser-registry/v2",
    relation_registry_version: "workspace-relation-registry/v1",
    started_at: "2026-08-26T00:00:00.000Z",
    completed_at: "2026-08-26T00:01:00.000Z",
  },
  source_binding: {
    source_binding_id: "sbi_pf",
    binding_type: "LOCAL_FILESYSTEM",
    normalized_reference: "C:\\pf\\ws",
    device_name: "PF-HOST",
    platform: "win32",
    metadata: { read_only: true },
  },
  workspace: {
    workspace_instance_id: "ws_pf",
    workspace_revision_id: "wsr_pf",
    previous_revision_id: null,
    source_binding_id: "sbi_pf",
  },
};

function buildContract(counts: { files: number; facts: number; relations: number; refs: number }) {
  const files = Array.from({ length: counts.files }, (_, i) => fileRecord(i));
  const facts = Array.from({ length: counts.facts }, (_, i) => factRecord(i));
  const relations = Array.from({ length: counts.relations }, (_, i) => relationRecord(i));
  const content_references = Array.from({ length: counts.refs }, (_, i) => contentReferenceRecord(i));
  const snapshot = normalizedWorkspaceIndexSnapshot({ files, facts, relations, content_references });
  const base = {
    contract_type: "canonical_workspace_index" as const,
    contract_version: "1.0.0" as const,
    contract_id: HEADER.contract_id,
    contract_status: HEADER.contract_status as CanonicalWorkspaceIndexContract["contract_status"],
    workspace: HEADER.workspace,
    source_binding: HEADER.source_binding,
    generation: HEADER.generation,
    snapshot,
    delta: null,
    coverage: HEADER.coverage,
    failures: HEADER.failures,
  } as unknown as Omit<CanonicalWorkspaceIndexContract, "integrity">;
  return finalizeWorkspaceIndexContract(base);
}

function streamingDigestFor(contract: CanonicalWorkspaceIndexContract, captureBytes = false) {
  const writer = new StreamingCanonicalHashWriter(
    {
      contract_id: contract.contract_id,
      contract_status: contract.contract_status,
      contract_type: contract.contract_type,
      contract_version: contract.contract_version,
      coverage: contract.coverage,
      delta: contract.delta,
      failures: contract.failures,
      generation: contract.generation,
      integrity: {
        content_reference_count: contract.integrity.content_reference_count,
        fact_count: contract.integrity.fact_count,
        relation_count: contract.integrity.relation_count,
        file_count: contract.integrity.file_count,
        workspace_tree_fingerprint: contract.integrity.workspace_tree_fingerprint,
      },
      source_binding: contract.source_binding,
      workspace: contract.workspace,
    },
    { captureBytes },
  );
  void (HEADER satisfies unknown);
  writer.beginFamily("content_references");
  for (const record of contract.snapshot.content_references) writer.writeRecord(record);
  writer.endFamily();
  writer.beginFamily("facts");
  for (const record of contract.snapshot.facts) writer.writeRecord(record);
  writer.endFamily();
  writer.beginFamily("files");
  for (const record of contract.snapshot.files) writer.writeRecord(record);
  writer.endFamily();
  writer.beginFamily("relations");
  for (const record of contract.snapshot.relations) writer.writeRecord(record);
  writer.endFamily();
  return writer.finish();
}

describe("streaming canonical hash — CANONICAL SHA SEMANTICS PARITY (G1)", () => {
  it("matches legacy whole-form hash on the empty workspace", () => {
    const contract = buildContract({ files: 0, facts: 0, relations: 0, refs: 0 });
    expect(streamingDigestFor(contract).digest).toBe(canonicalWorkspaceIndexHash(contract));
  });

  it("matches legacy whole-form hash on a mixed non-empty fixture", () => {
    const contract = buildContract({ files: 5, facts: 7, relations: 6, refs: 5 });
    const result = streamingDigestFor(contract, true);
    expect(result.digest).toBe(canonicalWorkspaceIndexHash(contract));
    // byte-level identity proof (debug capture only)
    expect(result.canonicalBytes).toBeDefined();
  });

  it("supports unicode and nested attribute payloads without drift", () => {
    const contract = buildContract({ files: 2, facts: 3, relations: 2, refs: 2 });
    (contract.snapshot.facts[0] as WorkspaceFactRecord).qualified_name = "رمز_α_✓";
    const refreshed = finalizeWorkspaceIndexContract({
      ...(contract as unknown as Omit<CanonicalWorkspaceIndexContract, "integrity">),
    });
    expect(streamingDigestFor(refreshed).digest).toBe(canonicalWorkspaceIndexHash(refreshed));
  });
});

// ---------------------------------------------------------------------------
// Randomized property parity (seeded; deterministic across runs).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("randomized parity/property suite", () => {
  it("holds across 200 seeded randomized workspaces", () => {
    const rng = mulberry32(0x494e5443); // 'INTC'
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const counts = {
        files: Math.floor(rng() * 8),
        facts: Math.floor(rng() * 10),
        relations: Math.floor(rng() * 8),
        refs: Math.floor(rng() * 8),
      };
      const contract = buildContract(counts);
      // perturb one scalar deterministically
      if (iteration % 3 === 0 && contract.snapshot.files.length > 0) {
        contract.snapshot.files[0] = {
          ...contract.snapshot.files[0],
          size_bytes: 4096 + iteration,
        } as WorkspaceFileRecord;
      }
      const streamed = streamingDigestFor(contract).digest;
      const legacy = canonicalWorkspaceIndexHash(contract);
      if (streamed !== legacy) {
        throw new Error(`PARITY_FAILURE at iteration ${iteration}: ${streamed} !== ${legacy}`);
      }
      expect(streamed).toBe(legacy);
    }
  });

  it("is deterministic: identical input yields identical digest across independent runs", () => {
    const a = streamingDigestFor(buildContract({ files: 3, facts: 3, relations: 3, refs: 3 })).digest;
    const b = streamingDigestFor(buildContract({ files: 3, facts: 3, relations: 3, refs: 3 })).digest;
    expect(a).toBe(b);
  });
});
