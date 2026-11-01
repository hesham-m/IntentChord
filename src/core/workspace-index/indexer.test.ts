import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeWorkspaceIndexContract } from "@/core/workspace-index/canonical";
import { indexWorkspace } from "@/core/workspace-index/indexer";
import { validateCanonicalWorkspaceIndexContract } from "@/core/workspace-index/validator";
import { createWorkspaceIndexFixture } from "@/test/workspace-index-helpers";

const requestFor = (root: string, instance: string) => ({
  workspace_instance_id: instance,
  root_path: root,
  binding_type: "FIXTURE" as const,
  indexing_session_id: `${instance}_session`,
  started_at: "2026-08-02T18:00:00.000Z",
  completed_at: "2026-08-02T18:00:01.000Z",
});

describe("Workspace Indexing Engine v1", () => {
  it("builds a full baseline without Git", async () => {
    const contract = await indexWorkspace(requestFor(await createWorkspaceIndexFixture(), "wsi_non_git"));
    expect(contract.source_binding.metadata.git_required).toBe(false);
    expect(contract.snapshot.files.length).toBeGreaterThanOrEqual(8);
    expect(contract.workspace.previous_revision_id).toBeNull();
    expect(contract.delta?.from_workspace_revision_id).toBeNull();
  });

  it("extracts manifest facts, documentation structure, and deterministic source signals", async () => {
    const contract = await indexWorkspace(requestFor(await createWorkspaceIndexFixture(), "wsi_facts"));
    const dependency = contract.snapshot.facts.find(fact => fact.fact_type === "DEPENDENCY" && fact.display_name === "zod");
    const heading = contract.snapshot.facts.find(fact => fact.fact_type === "DOCUMENTATION" && fact.display_name === "Evidence");
    const importFact = contract.snapshot.facts.find(fact => fact.fact_type === "IMPORT");
    expect(dependency?.extraction_method).toBe("MANIFEST_DECLARED");
    expect(dependency?.evidence_role).toBe("CANONICAL_EVIDENCE");
    expect(heading?.certainty).toBe("EXACT");
    expect(importFact?.evidence_role).toBe("SIGNAL_ONLY");
    expect(importFact?.certainty).toBe("DERIVED");
  });

  it("preserves mandatory provenance for every canonical Fact", async () => {
    const contract = await indexWorkspace(requestFor(await createWorkspaceIndexFixture(), "wsi_provenance"));
    for (const fact of contract.snapshot.facts) {
      expect(fact.provenance.workspace_revision_id).toBe(contract.workspace.workspace_revision_id);
      expect(fact.provenance.file_revision_id).toBe(fact.source_file_revision_id);
      expect(fact.provenance.file_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(fact.provenance.evidence_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Object.keys(fact.provenance.source_location).length).toBeGreaterThan(0);
    }
  });

  it("merges duplicate relation discoveries and retains multiple evidence references", async () => {
    const root = await createWorkspaceIndexFixture();
    await writeFile(path.join(root, "src", "index.ts"), "import { double } from './util';\nimport { double as again } from './util';\nexport const result = double(2) + again(2);\n");
    const contract = await indexWorkspace(requestFor(root, "wsi_relation_merge"));
    const importFacts = contract.snapshot.facts.filter(fact => fact.fact_type === "IMPORT");
    const sourceFile = contract.snapshot.files.find(file => file.relative_path === "src/index.ts")!;
    const targetFile = contract.snapshot.files.find(file => file.relative_path === "src/util.ts")!;
    const imports = contract.snapshot.relations.filter(relation =>
      relation.relation_type === "IMPORTS"
      && relation.source.entity_revision_id === sourceFile.file_revision_id
      && relation.target.entity_revision_id === targetFile.file_revision_id,
    );
    const unrelatedImports = contract.snapshot.relations.filter(relation =>
      relation.relation_type === "IMPORTS"
      && relation.workspace_relation_id !== imports[0]?.workspace_relation_id,
    );
    expect(new Set(importFacts.map(fact => fact.workspace_fact_id)).size).toBe(importFacts.length);
    expect(imports).toHaveLength(1);
    expect(imports[0].evidence_refs).toHaveLength(2);
    expect(imports[0].evidence_role).toBe("SIGNAL_ONLY");
    expect(unrelatedImports).toHaveLength(1);
  });

  it("keeps exact DECLARES relations governing and heuristic TESTS relations non-governing", async () => {
    const contract = await indexWorkspace(requestFor(await createWorkspaceIndexFixture(), "wsi_relations"));
    const declares = contract.snapshot.relations.find(relation => relation.relation_type === "DECLARES" && relation.evidence_role === "CANONICAL_EVIDENCE");
    const tests = contract.snapshot.relations.find(relation => relation.relation_type === "TESTS");
    expect(declares).toBeDefined();
    expect(tests?.extraction_method).toBe("HEURISTIC");
    expect(tests?.evidence_role).toBe("SIGNAL_ONLY");
  });

  it("retains restricted secrets and unsupported binaries in inventory without exposing raw content", async () => {
    const contract = await indexWorkspace(requestFor(await createWorkspaceIndexFixture(), "wsi_sensitive"));
    const secret = contract.snapshot.files.find(file => file.relative_path === ".env.fixture")!;
    const binary = contract.snapshot.files.find(file => file.relative_path === "asset.bin")!;
    const secretRef = contract.snapshot.content_references.find(ref => ref.file_revision_id === secret.file_revision_id)!;
    const binaryRef = contract.snapshot.content_references.find(ref => ref.file_revision_id === binary.file_revision_id)!;
    expect(secret.coverage_state).toBe("RESTRICTED");
    expect(secretRef.availability_state).toBe("RESTRICTED");
    expect(secretRef.content_hash).toBe(secret.content_hash);
    expect(binary.coverage_state).toBe("UNSUPPORTED");
    expect(binaryRef.availability_state).toBe("BINARY");
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toContain("DEMO_TOKEN=not-a-real-secret");
    expect(serialized).not.toContain("return value * 2");
  });

  it("records a local parser failure as COMPLETE_WITH_GAPS", async () => {
    const root = await createWorkspaceIndexFixture();
    await writeFile(path.join(root, "config", "settings.json"), "{ invalid json");
    const contract = await indexWorkspace(requestFor(root, "wsi_parse_gap"));
    expect(contract.contract_status).toBe("COMPLETE_WITH_GAPS");
    expect(contract.failures.some(failure => failure.error_code === "REGISTERED_PARSER_FAILED")).toBe(true);
    expect(contract.snapshot.files.find(file => file.relative_path === "config/settings.json")?.coverage_state).toBe("FAILED");
  });

  it("rejects a documented claim promoted to exact governing source evidence", async () => {
    const contract = await indexWorkspace(requestFor(await createWorkspaceIndexFixture(), "wsi_claim_policy"));
    const target = contract.snapshot.facts.find(fact => fact.fact_type === "DOCUMENTATION")!;
    target.extraction_method = "DOCUMENTED_CLAIM";
    target.evidence_role = "CANONICAL_EVIDENCE";
    const { integrity: _integrity, ...withoutIntegrity } = contract;
    const tampered = finalizeWorkspaceIndexContract(withoutIntegrity);
    expect(validateCanonicalWorkspaceIndexContract(tampered).diagnostics.some(item => item.code === "NON_GOVERNING_FACT_PROMOTED")).toBe(true);
  });

  it("rejects contract-blocking inventory or integrity failures", async () => {
    const contract = await indexWorkspace(requestFor(await createWorkspaceIndexFixture(), "wsi_blocking_failure"));
    const blocking = {
      failure_id: "wif_contract_blocking",
      stage: "HASHING" as const,
      failure_type: "HASHING",
      error_code: "GOVERNING_HASH_FAILED",
      sanitized_message: "A governing hash could not be produced.",
      occurred_at: "2026-08-02T18:00:01.000Z",
      recoverability: "RETRYABLE" as const,
      impact: "CONTRACT_BLOCKING" as const,
    };
    const { integrity: _integrity, ...withoutIntegrity } = contract;
    const candidate = finalizeWorkspaceIndexContract({ ...withoutIntegrity, failures: [...contract.failures, blocking] });
    expect(validateCanonicalWorkspaceIndexContract(candidate).diagnostics.some(item => item.code === "CONTRACT_BLOCKING_FAILURE_PRESENT")).toBe(true);
  });

  it("does not mutate indexed source files", async () => {
    const root = await createWorkspaceIndexFixture();
    const before = await readFile(path.join(root, "src", "util.ts"), "utf8");
    await indexWorkspace(requestFor(root, "wsi_read_only"));
    const after = await readFile(path.join(root, "src", "util.ts"), "utf8");
    expect(after).toBe(before);
  });
});

it("R1 reuses one filesystem authority for the complete index operation and closes it exactly once", async () => {
  const { createWorkspaceFilesystemObjectAuthority } = await import("@/core/workspace-index/filesystem-object-authority");
  const root = await createWorkspaceIndexFixture();
  let factories = 0;
  let closeCount = 0;
  let probeCount = 0;
  let enumerateCount = 0;
  let captureCount = 0;
  const makeAuthority = () => {
    factories += 1;
    const base = createWorkspaceFilesystemObjectAuthority();
    return {
      async probeDirectory(...args: Parameters<typeof base.probeDirectory>) { probeCount += 1; return base.probeDirectory(...args); },
      async enumerateRelativeDirectory(...args: Parameters<typeof base.enumerateRelativeDirectory>) { enumerateCount += 1; return base.enumerateRelativeDirectory(...args); },
      async captureRelativeFile(...args: Parameters<typeof base.captureRelativeFile>) { captureCount += 1; return base.captureRelativeFile(...args); },
      async close() { closeCount += 1; await base.close(); },
    };
  };

  const first = await indexWorkspace({
    ...requestFor(root, "wsi_operation_authority_1"),
    filesystem_object_authority_factory: makeAuthority,
  });
  expect(first.snapshot.files.length).toBeGreaterThan(1);
  expect(factories).toBe(1);
  expect(closeCount).toBe(1);
  expect(probeCount).toBeGreaterThanOrEqual(1);
  expect(enumerateCount).toBeGreaterThanOrEqual(1);
  expect(captureCount).toBe(first.snapshot.files.length);

  await indexWorkspace({
    ...requestFor(root, "wsi_operation_authority_2"),
    filesystem_object_authority_factory: makeAuthority,
  });
  expect(factories).toBe(2);
  expect(closeCount).toBe(2);
});

it("R2 stamps completion only after terminal validation and revalidates the exact returned projection", async () => {
  const { canonicalIndexArtifactSemanticSha256 } = await import("@/core/workspace-index/artifact-identity");
  const root = await createWorkspaceIndexFixture();
  let captureStarted = false;
  const chronology: string[] = [];
  const first = await indexWorkspace({
    workspace_instance_id: "wsi_completion_truth",
    root_path: root,
    binding_type: "FIXTURE",
    indexing_session_id: "completion_session_1",
    started_at: "2026-08-13T10:00:00.000Z",
    failure_now: () => "2026-08-13T10:00:04.000Z",
    now: () => {
      chronology.push("COMPLETION_STAMPED");
      expect(captureStarted).toBe(true);
      expect(chronology).toEqual(["TERMINAL_CANDIDATE_VALIDATED", "COMPLETION_STAMPED"]);
      return "2026-08-13T10:00:05.000Z";
    },
    terminal_validation_observer: event => chronology.push(event),
    capture_before_open: () => { captureStarted = true; },
  });
  expect(chronology).toEqual([
    "TERMINAL_CANDIDATE_VALIDATED",
    "COMPLETION_STAMPED",
    "FINAL_PROJECTION_VALIDATED",
  ]);
  expect(first.generation.started_at).toBe("2026-08-13T10:00:00.000Z");
  expect(first.generation.completed_at).toBe("2026-08-13T10:00:05.000Z");

  const second = await indexWorkspace({
    workspace_instance_id: "wsi_completion_truth",
    root_path: root,
    binding_type: "FIXTURE",
    indexing_session_id: "completion_session_2",
    started_at: "2026-08-13T11:00:00.000Z",
    completed_at: "2026-08-13T11:00:09.000Z",
  });
  expect(first.workspace.workspace_revision_id).toBe(second.workspace.workspace_revision_id);
  expect(canonicalIndexArtifactSemanticSha256(first)).toBe(canonicalIndexArtifactSemanticSha256(second));
});

it("R2 records non-blocking failure occurrence at the failure event rather than reusing operation start", async () => {
  const root = await createWorkspaceIndexFixture();
  let tick = 0;
  const failureTimes = [
    "2026-08-13T14:00:01.000Z",
    "2026-08-13T14:00:02.000Z",
    "2026-08-13T14:00:03.000Z",
    "2026-08-13T14:00:04.000Z",
    "2026-08-13T14:00:05.000Z",
    "2026-08-13T14:00:06.000Z",
    "2026-08-13T14:00:07.000Z",
    "2026-08-13T14:00:08.000Z",
  ];
  const contract = await indexWorkspace({
    workspace_instance_id: "wsi_failure_occurrence_truth",
    root_path: root,
    binding_type: "FIXTURE",
    indexing_session_id: "failure_occurrence_session",
    started_at: "2026-08-13T14:00:00.000Z",
    completed_at: "2026-08-13T14:00:09.000Z",
    failure_now: () => failureTimes[Math.min(tick++, failureTimes.length - 1)],
  });
  expect(contract.failures.length).toBeGreaterThan(1);
  expect(new Set(contract.failures.map(failure => failure.occurred_at)).size).toBeGreaterThan(1);
  for (const failure of contract.failures) {
    expect(failure.occurred_at > contract.generation.started_at).toBe(true);
    expect(failure.occurred_at <= contract.generation.completed_at).toBe(true);
  }
});

it("R4 records rolling-capture consistency as Observation provenance without changing intrinsic identity", async () => {
  const { canonicalIndexArtifactSemanticSha256 } = await import("@/core/workspace-index/artifact-identity");
  const root = await createWorkspaceIndexFixture();
  const first = await indexWorkspace({
    workspace_instance_id: "wsi_capture_consistency",
    root_path: root,
    binding_type: "FIXTURE",
    indexing_session_id: "capture_consistency_1",
    started_at: "2026-08-13T12:00:00.000Z",
    completed_at: "2026-08-13T12:00:03.000Z",
  });
  const second = await indexWorkspace({
    workspace_instance_id: "wsi_capture_consistency",
    root_path: root,
    binding_type: "FIXTURE",
    indexing_session_id: "capture_consistency_2",
    started_at: "2026-08-13T13:00:00.000Z",
    completed_at: "2026-08-13T13:00:07.000Z",
  });
  const consistency = first.source_binding.metadata.capture_consistency as Record<string, unknown>;
  expect(consistency.model).toBe("GOVERNED_ROLLING_FILE_REVISION_MANIFEST_V1");
  expect(consistency.exact_file_revision_manifest).toBe(true);
  expect(consistency.immutable_after_assembly).toBe(true);
  expect(consistency.atomic_filesystem_snapshot_claimed).toBe(false);
  expect(first.source_binding.metadata.capture_consistency).not.toEqual(second.source_binding.metadata.capture_consistency);
  expect(first.workspace.workspace_revision_id).toBe(second.workspace.workspace_revision_id);
  expect(canonicalIndexArtifactSemanticSha256(first)).toBe(canonicalIndexArtifactSemanticSha256(second));
});

it("R-EIT-V3 CASE A: object authority close failure never masks the originating index failure", async () => {
  const { createWorkspaceFilesystemObjectAuthority } = await import("@/core/workspace-index/filesystem-object-authority");
  const { vi } = await import("vitest");
  const root = await createWorkspaceIndexFixture();
  const base = createWorkspaceFilesystemObjectAuthority();
  const closeY = Object.assign(new Error("AUTHORITY_CLOSE_FAILURE_Y"), { name: "AuthorityCloseError" });
  const primaryX = Object.assign(new Error("INDEX_PRIMARY_FAILURE_X"), { name: "IndexPrimaryError" });
  const makeAuthority = () => ({
    probeDirectory: (...args: Parameters<typeof base.probeDirectory>) => base.probeDirectory(...args),
    enumerateRelativeDirectory: (...args: Parameters<typeof base.enumerateRelativeDirectory>) => base.enumerateRelativeDirectory(...args),
    captureRelativeFile: (...args: Parameters<typeof base.captureRelativeFile>) => base.captureRelativeFile(...args),
    close: async () => { throw closeY; },
  });
  const secondaryLines: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    secondaryLines.push(args.map(item => typeof item === "string" ? item : JSON.stringify(item)).join(" "));
  });
  try {
    await expect(indexWorkspace({
      ...requestFor(root, "wsi_eit_v3_close_mask_case_a"),
      filesystem_object_authority_factory: makeAuthority,
      on_duration_phase_authority: authority => {
        if (authority.governancePhase === "PROCESSING") throw primaryX;
      },
    })).rejects.toBe(primaryX);
  } finally {
    errorSpy.mockRestore();
    await base.close().catch(() => undefined);
  }
  expect(secondaryLines.some(line => line.includes("workspace-index-object-authority-close-secondary") && line.includes("AuthorityCloseError"))).toBe(true);
});

it("R-EIT-V3 CASE B: an object authority close failure after successful indexing is a real operation failure and is never silently discarded", async () => {
  const { createWorkspaceFilesystemObjectAuthority } = await import("@/core/workspace-index/filesystem-object-authority");
  const root = await createWorkspaceIndexFixture();
  const base = createWorkspaceFilesystemObjectAuthority();
  const closeY = Object.assign(new Error("AUTHORITY_CLOSE_FAILURE_AFTER_SUCCESS"), { name: "AuthorityCloseAfterSuccessError" });
  const makeAuthority = () => ({
    probeDirectory: (...args: Parameters<typeof base.probeDirectory>) => base.probeDirectory(...args),
    enumerateRelativeDirectory: (...args: Parameters<typeof base.enumerateRelativeDirectory>) => base.enumerateRelativeDirectory(...args),
    captureRelativeFile: (...args: Parameters<typeof base.captureRelativeFile>) => base.captureRelativeFile(...args),
    close: async () => { throw closeY; },
  });
  try {
    await expect(indexWorkspace({
      ...requestFor(root, "wsi_eit_v3_close_after_success"),
      filesystem_object_authority_factory: makeAuthority,
    })).rejects.toBe(closeY);
  } finally {
    await base.close().catch(() => undefined);
  }
});
