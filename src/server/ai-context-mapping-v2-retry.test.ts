import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositorySource = readFileSync("src/server/ai-context-mapping-v2-repository.ts", "utf8");
const closureSource = readFileSync("src/server/context-closure-service.ts", "utf8");
const migration014 = readFileSync("migrations/014_governed_context_assembly_and_ai_context_mapping_v2.sql", "utf8");

describe("AI Context Mapping V2 run-owned retry/orphan contract", () => {
  it("keeps active Mapping distinct from terminal failed/rejected Mapping", () => {
    expect(repositorySource).toContain("ACTIVE_V2_MAPPING_RUN_STATUSES");
    expect(repositorySource).toContain("RETRYABLE_V2_MAPPING_TERMINAL_STATUSES");
    expect(repositorySource).toContain("CONTEXT_ASSEMBLY_MAPPING_ALREADY_ACTIVE");
  });

  it("owns execution liveness on the Mapping Run rather than the Assembly", () => {
    expect(repositorySource).toContain("execution_deadline_at");
    expect(repositorySource).toContain("deadline_policy_version");
    expect(repositorySource).toContain("ORPHANED_ACTIVE_MAPPING_EXECUTION");
    expect(migration014).not.toMatch(/context_assembly_revisions[\s\S]{0,500}\bstate\b/i);
    expect(migration014).not.toMatch(/context_assembly_revisions[\s\S]{0,500}\bclosure_state\b/i);
  });

  it("reconciles expired non-terminal V2 runs while preserving the immutable Assembly Revision", () => {
    expect(repositorySource).toContain("reconcileExpiredActiveRunsWith");
    expect(repositorySource).toContain("MAPPER_ORPHANED_ACTIVE_EXECUTION");
    const reconcile = repositorySource.slice(repositorySource.indexOf("async function reconcileExpiredActiveRunsWith"), repositorySource.indexOf("export const aiContextMappingV2Repository"));
    expect(reconcile).toContain("context_mapping_runs");
    expect(reconcile).not.toContain("update intentchord.context_assembly_revisions");
  });

  it("derives retry product status from terminal Run facts rather than persisted Assembly lifecycle", () => {
    expect(closureSource).toContain('state="MAPPING_RETRYABLE"');
    expect(closureSource).toContain("latestMappingRun");
    expect(closureSource).not.toContain("set state='MAPPING_RETRYABLE'");
  });

  it("never creates Migration 015", () => {
    expect(readdirSync(resolve(process.cwd(), "migrations")).some(name => name.startsWith("015_"))).toBe(false);
  });
});
