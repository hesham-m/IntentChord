import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
  WORKSPACE_DURATION_POLICY_ID,
  deriveWorkspaceProcessingDurationBudget,
  workspaceAbsoluteOperationDeadlineAt,
  workspacePhaseDeadlineAt,
  type WorkspaceDurationGovernance,
} from "@/core/workspace-index/duration-governance";
import { indexWorkspace, WorkspaceIndexingError } from "@/core/workspace-index/indexer";
import { isTechnicalExcludedDirectory, WorkspaceIndexBoundedError } from "@/core/workspace-index/adapters/filesystem";
import { workspaceIndexConfigurationDescriptor, workspaceIndexConfigurationSha256 } from "@/core/workspace-index/artifact-identity";

function policy(overrides: Partial<WorkspaceDurationGovernance>): WorkspaceDurationGovernance {
  return { ...DEFAULT_WORKSPACE_DURATION_GOVERNANCE, ...overrides };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "intentchord-duration-governance-"));
  await writeFile(path.join(root, "a.txt"), "governed duration evidence");
  return root;
}

async function expectTimeout(
  durationGovernance: WorkspaceDurationGovernance,
  expectedGovernancePhase: "DISCOVERY" | "PROCESSING" | "FINALIZATION",
): Promise<WorkspaceIndexingError> {
  const root = await fixture();
  try {
    let error: unknown;
    try {
      await indexWorkspace({ workspace_instance_id: `duration-${expectedGovernancePhase.toLowerCase()}`, root_path: root, duration_policy: durationGovernance });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceIndexingError);
    const governed = error as WorkspaceIndexingError;
    expect(governed.code).toBe("WORKSPACE_INDEX_TIMEOUT");
    expect(governed.evidence.currentGovernancePhase).toBe(expectedGovernancePhase);
    expect(governed.evidence.detailedProgressPhase).toBeDefined();
    expect(governed.evidence.elapsedAttemptDurationMs).toEqual(expect.any(Number));
    expect(governed.evidence.phaseElapsedDurationMs).toEqual(expect.any(Number));
    expect(governed.evidence.phaseBudgetMs).toEqual(expect.any(Number));
    expect(governed.evidence.absoluteElapsedDurationMs).toEqual(expect.any(Number));
    return governed;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Workspace duration governance v3", () => {
  it("derives the processing minimum for a small Workspace", () => {
    const result = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 1024, discoveredFiles: 1 });
    expect(result.durationPolicyId).toBe(WORKSPACE_DURATION_POLICY_ID);
    expect(result.derivedProcessingBudgetMs).toBe(120_000);
  });

  it("derives the exact V3 byte + file formula and the current real EIT Processing cap", () => {
    const result = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 7_599_775_318, discoveredFiles: 21_881 });
    expect(result.durationPolicyId).toBe("intentchord.workspace-duration-governance/v3");
    expect(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.processingPerFileMs).toBe(40);
    expect(result.byteAllowanceMs).toBe(603_976);
    expect(result.fileAllowanceMs).toBe(875_240);
    expect(result.rawProcessingBudgetMs).toBe(1_509_216);
    expect(result.derivedProcessingBudgetMs).toBe(1_500_000);
  });

  it("keeps smaller workloads deterministically workload-derived below the Processing max", () => {
    const result = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 512 * 1024 * 1024, discoveredFiles: 2_500 });
    expect(result.rawProcessingBudgetMs).toBeGreaterThan(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.processingMinMs);
    expect(result.rawProcessingBudgetMs).toBeLessThan(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.processingMaxMs);
    expect(result.derivedProcessingBudgetMs).toBe(result.rawProcessingBudgetMs);
  });

  it("is workload-deterministic rather than measured-throughput-derived", () => {
    const workload = { discoveredBytes: 512 * 1024 * 1024, discoveredFiles: 2500 };
    const measuredMachineA = { captureMiBPerSec: 3.5 };
    const measuredMachineB = { captureMiBPerSec: 95.0 };
    const a = deriveWorkspaceProcessingDurationBudget(workload);
    const b = deriveWorkspaceProcessingDurationBudget(workload);
    expect(measuredMachineA.captureMiBPerSec).not.toBe(measuredMachineB.captureMiBPerSec);
    expect(a).toEqual(b);
    expect(JSON.stringify(DEFAULT_WORKSPACE_DURATION_GOVERNANCE)).not.toContain("captureMiBPerSec");
    expect(JSON.stringify(DEFAULT_WORKSPACE_DURATION_GOVERNANCE)).not.toContain("throughput");
  });

  it("responds independently to file-count and byte-size workload identity", () => {
    const sameBytesLowFiles = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 2 * 1024 * 1024 * 1024, discoveredFiles: 1000 });
    const sameBytesHighFiles = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 2 * 1024 * 1024 * 1024, discoveredFiles: 20_000 });
    expect(sameBytesHighFiles.fileAllowanceMs).toBeGreaterThan(sameBytesLowFiles.fileAllowanceMs);
    expect(sameBytesHighFiles.rawProcessingBudgetMs).toBeGreaterThan(sameBytesLowFiles.rawProcessingBudgetMs);

    const sameFilesLowBytes = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 256 * 1024 * 1024, discoveredFiles: 2000 });
    const sameFilesHighBytes = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 4 * 1024 * 1024 * 1024, discoveredFiles: 2000 });
    expect(sameFilesHighBytes.byteAllowanceMs).toBeGreaterThan(sameFilesLowBytes.byteAllowanceMs);
    expect(sameFilesHighBytes.rawProcessingBudgetMs).toBeGreaterThan(sameFilesLowBytes.rawProcessingBudgetMs);
  });

  it("clamps processing authority at PROCESSING_MAX_MS", () => {
    const result = deriveWorkspaceProcessingDurationBudget({ discoveredBytes: 20 * 1024 * 1024 * 1024, discoveredFiles: 50_000 });
    expect(result.rawProcessingBudgetMs).toBeGreaterThan(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.processingMaxMs);
    expect(result.derivedProcessingBudgetMs).toBe(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.processingMaxMs);
  });

  it("never lets phase transitions bypass the absolute operation ceiling", () => {
    const attemptStartedAtMs = 1_000_000;
    const absolute = workspaceAbsoluteOperationDeadlineAt(attemptStartedAtMs);
    const latePhaseStart = absolute - 10_000;
    expect(workspacePhaseDeadlineAt({ phaseStartedAtMs: latePhaseStart, phaseBudgetMs: 120_000, absoluteOperationDeadlineAt: absolute })).toBe(absolute);
    expect(workspacePhaseDeadlineAt({ phaseStartedAtMs: absolute - 1, phaseBudgetMs: 1_500_000, absoluteOperationDeadlineAt: absolute })).toBe(absolute);
    expect(absolute - attemptStartedAtMs).toBe(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs);
  });

  it("fails closed independently for Discovery, Processing, and Finalization duration limits", async () => {
    await expectTimeout(policy({ discoveryMaxMs: 0 }), "DISCOVERY");
    await expectTimeout(policy({ processingMinMs: 0, processingMaxMs: 0 }), "PROCESSING");
    await expectTimeout(policy({ finalizationMaxMs: 0 }), "FINALIZATION");
  });

  it("classifies a generic capture/helper failure at the PROCESSING deadline edge as WORKSPACE_INDEX_TIMEOUT", async () => {
    const root = await fixture();
    const baseEpochMs = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseEpochMs);
    try {
      await expect(indexWorkspace({
        workspace_instance_id: "duration-capture-deadline-edge",
        root_path: root,
        duration_policy: policy({ processingMinMs: 100, processingMaxMs: 100 }),
        capture_stream_factory: () => new Readable({
          read() {
            now.mockReturnValue(baseEpochMs + 100);
            this.destroy(new Error("SIMULATED_WINDOWS_HELPER_PIPE_CLOSED"));
          },
        }),
      })).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: {
          durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
          currentGovernancePhase: "PROCESSING",
          detailedProgressPhase: "HASHING",
          discoveredFiles: 1,
          hashedFiles: 0,
          hashedBytes: 0,
          parsedFiles: 0,
          remainingFilesAtTimeout: 1,
          remainingBytesAtTimeout: 26,
          aggregateRetainedTextBytes: 0,
          csvSampledBytes: 0,
          currentProcessingRelativePath: "a.txt",
          derivedProcessingBudgetMs: 100,
        },
      });
    } finally {
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves exact current Processing progress and remaining work at a checkpoint timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "intentchord-duration-progress-"));
    const a = Buffer.from("export const a = 1;\n");
    const b = Buffer.from("export const b = 2;\n");
    await writeFile(path.join(root, "a.ts"), a);
    await writeFile(path.join(root, "b.ts"), b);
    const baseEpochMs = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseEpochMs);
    try {
      await expect(indexWorkspace({
        workspace_instance_id: "duration-progress-checkpoint",
        root_path: root,
        duration_policy: policy({ processingMinMs: 100, processingMaxMs: 100 }),
        capture_stream_factory: absolutePath => Readable.from([path.basename(absolutePath) === "a.ts" ? a : b]),
        on_progress: current => {
          if (current.hashedFiles === 1 && current.parsedFiles === 1) now.mockReturnValue(baseEpochMs + 100);
        },
      })).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: {
          durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
          currentGovernancePhase: "PROCESSING",
          detailedProgressPhase: "HASHING",
          discoveredFiles: 2,
          discoveredBytes: a.length + b.length,
          hashedFiles: 1,
          hashedBytes: a.length,
          parsedFiles: 1,
          remainingFilesAtTimeout: 1,
          remainingBytesAtTimeout: b.length,
          aggregateRetainedTextBytes: a.length,
          csvSampledBytes: 0,
          currentProcessingRelativePath: "b.ts",
        },
      });
    } finally {
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds currentProcessingRelativePath as diagnostic evidence without affecting timeout authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "intentchord-duration-path-bound-"));
    const first = "a".repeat(180);
    const second = "b".repeat(180);
    const third = "c".repeat(180);
    const directory = path.join(root, first, second, third);
    await mkdir(directory, { recursive: true });
    const payload = Buffer.from("bounded path evidence");
    await writeFile(path.join(directory, "evidence.ts"), payload);
    const baseEpochMs = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseEpochMs);
    try {
      let failure: WorkspaceIndexingError | undefined;
      try {
        await indexWorkspace({
          workspace_instance_id: "duration-path-bound",
          root_path: root,
          duration_policy: policy({ processingMinMs: 100, processingMaxMs: 100 }),
          capture_stream_factory: () => new Readable({
            read() {
              now.mockReturnValue(baseEpochMs + 100);
              this.destroy(new Error("SIMULATED_PATH_BOUND_HELPER_FAILURE"));
            },
          }),
        });
      } catch (error) {
        failure = error as WorkspaceIndexingError;
      }
      expect(failure).toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      const currentPath = String(failure?.evidence.currentProcessingRelativePath ?? "");
      expect(Array.from(currentPath).length).toBe(512);
      expect(currentPath).not.toContain(root);
      expect(failure?.evidence.phaseBudgetMs).toBe(100);
    } finally {
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a genuine generic capture/helper failure before the deadline fail-closed as Source State", async () => {
    const root = await fixture();
    try {
      let failure: WorkspaceIndexingError | undefined;
      try {
        await indexWorkspace({
          workspace_instance_id: "duration-capture-predeadline-failure",
          root_path: root,
          capture_stream_factory: () => new Readable({
            read() { this.destroy(new Error("SIMULATED_WINDOWS_HELPER_PROTOCOL_FAILURE")); },
          }),
        });
      } catch (error) {
        failure = error as WorkspaceIndexingError;
      }
      expect(failure).toMatchObject({ code: "WORKSPACE_SOURCE_STATE_INCOMPLETE" });
      expect(failure?.diagnostics).toContain("FILE_CAPTURE_FAILED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit proof-grade Source Object identity violation before deadline as Source State", async () => {
    const root = await fixture();
    try {
      let failure: WorkspaceIndexingError | undefined;
      try {
        await indexWorkspace({
          workspace_instance_id: "duration-source-identity-predeadline",
          root_path: root,
          capture_stream_factory: () => new Readable({
            read() {
              this.destroy(new WorkspaceIndexBoundedError(
                "WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED",
                { phase: "SOURCE_AUTHORITY" },
              ));
            },
          }),
        });
      } catch (error) {
        failure = error as WorkspaceIndexingError;
      }
      expect(failure).toMatchObject({ code: "WORKSPACE_SOURCE_STATE_INCOMPLETE" });
      expect(failure?.diagnostics).toEqual(expect.arrayContaining([
        "SOURCE_CAPTURE_FAILED",
        "WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps AbortSignal terminal over simultaneous deadline/source capture classification", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const baseEpochMs = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseEpochMs);
    try {
      await expect(indexWorkspace({
        workspace_instance_id: "duration-abort-precedence",
        root_path: root,
        signal: controller.signal,
        duration_policy: policy({ processingMinMs: 100, processingMaxMs: 100 }),
        capture_stream_factory: () => new Readable({
          read() {
            now.mockReturnValue(baseEpochMs + 100);
            controller.abort();
            this.destroy(new WorkspaceIndexBoundedError(
              "WORKSPACE_SOURCE_OBJECT_IDENTITY_CHANGED",
              { phase: "SOURCE_AUTHORITY" },
            ));
          },
        }),
      })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
    } finally {
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps abort terminal across Discovery, Processing, and Finalization transitions", async () => {
    for (const target of ["DISCOVERY", "PROCESSING", "FINALIZATION"] as const) {
      const root = await fixture();
      const controller = new AbortController();
      try {
        if (target === "DISCOVERY") controller.abort();
        await expect(indexWorkspace({
          workspace_instance_id: `abort-${target.toLowerCase()}`,
          root_path: root,
          signal: controller.signal,
          on_progress: progress => {
            if (progress.governancePhase === target) controller.abort();
          },
        })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("preserves full-file SHA-256 authority and does not create workload-driven path exclusions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "intentchord-duration-scope-"));
    try {
      const directories = ["reports", "artifacts", "snapshots", "generated outputs", "archives"];
      for (const directory of directories) {
        await mkdir(path.join(root, directory), { recursive: true });
        await writeFile(path.join(root, directory, "evidence.bin"), Buffer.from(`${directory}-full-file-evidence`));
        expect(isTechnicalExcludedDirectory(directory)).toBe(false);
      }
      const contract = await indexWorkspace({ workspace_instance_id: "duration-scope", root_path: root });
      expect(contract.snapshot.files).toHaveLength(directories.length);
      for (const directory of directories) {
        const payload = Buffer.from(`${directory}-full-file-evidence`);
        const expected = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
        expect(contract.snapshot.files.find(file => file.relative_path === `${directory}/evidence.bin`)?.content_hash).toBe(expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds duration policy version and parameters into canonical configuration identity", () => {
    const baseDescriptor = workspaceIndexConfigurationDescriptor();
    const baseSha = workspaceIndexConfigurationSha256(baseDescriptor);
    expect(baseDescriptor.duration_governance.duration_policy_id).toBe(WORKSPACE_DURATION_POLICY_ID);
    expect(baseDescriptor.duration_governance.processing_governed_bytes_per_second).toBe(12 * 1024 * 1024);
    expect(baseDescriptor.duration_governance).not.toHaveProperty("measured_throughput");

    expect(baseDescriptor.duration_governance.processing_per_file_ms).toBe(40);
    const v2Descriptor = workspaceIndexConfigurationDescriptor({
      durationGovernance: policy({
        durationPolicyId: "intentchord.workspace-duration-governance/v2",
        processingPerFileMs: 32,
      }),
    });
    const parameterChanged = workspaceIndexConfigurationDescriptor({ durationGovernance: policy({ processingPerFileMs: 39 }) });
    expect(workspaceIndexConfigurationSha256(v2Descriptor)).not.toBe(baseSha);
    expect(workspaceIndexConfigurationSha256(parameterChanged)).not.toBe(baseSha);
  });
});
