import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceAnalysisWorkbench } from "@/components/workspace-analysis-workbench";

const source = readFileSync("src/components/workspace-analysis-workbench.tsx", "utf8");

describe("WorkspaceAnalysisWorkbench governed functional connection", () => {
  it("preserves the four-stage Gemini journey and optional Project association", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench />);
    expect(html).toContain("Workspace Selection");
    expect(html).toContain("Index Generation");
    expect(html).toContain("Context Analysis");
    expect(html).toContain("Human Review");
    expect(html).toContain("Independent Workspace");
    expect(html).toContain("Workspace linked to a Project");
    expect(html).toContain("(Optional)");
    expect(html).not.toMatch(/<div class="[^"]*stepMeta[^"]*">[^<]*Workspace 1/i);
  });

  it("keeps Technical Details and Advanced Diagnostics collapsed natively", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench />);
    expect(html).toContain("<details");
    expect(html).toContain("Advanced Diagnostics &amp; Raw Canonical Index JSON");
    expect(html).not.toMatch(/<details[^>]*open/i);
  });

  it("keeps provider and model selection out of Workspace Analysis", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench />);
    expect(html).not.toContain("SambaNova");
    expect(html).not.toContain("gpt-4");
    expect(html).not.toContain("claude-3");
    expect(html).not.toMatch(/<select[^>]*aria-label="[^"]*(?:Model|الموديل)/i);
  });

  it("connects Stage 2 to the independent Snapshot action", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench initialStage={2} />);
    expect(html).toContain("Generate Index from Registered Workspace");
    expect(html).not.toContain("Functional Integration Notice");
    expect(source).toContain('ownerFetch("/api/workspace-index-snapshots"');
    expect(source).toContain('sourceMode: "REGISTERED_WORKSPACE"');
  });

  it("connects Stage 3 to Mapping by persisted snapshotId only", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench initialStage={3} />);
    expect(html).toContain("Persisted Snapshot Required");
    expect(source).toContain("workspaceIndexSnapshotId: indexSnapshot.id");
    expect(source).not.toContain("body: JSON.stringify({ workspaceIndex })");
  });

  it("preserves Advanced Diagnostics while routing it through diagnostic Snapshot persistence", () => {
    expect(source).toContain('sourceMode: "ADVANCED_DIAGNOSTIC"');
    expect(source).toContain("Validate and Persist Diagnostic Snapshot");
    expect(source).toContain("createDiagnosticSnapshot");
  });

  it("shows no mock Catalog and supports explicit context-level Owner decisions", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench initialStage={4} />);
    expect(html).toContain("Awaiting Validated Server Proposal");
    expect(html).not.toContain("Default Mock Catalog");
    expect(html).not.toContain("Fake Proposal Success");
    expect(source).toContain("Accept Context");
    expect(source).toContain("Reject Context");
    expect(source).toContain("Accept Reviewed Subset");
    expect(source).toContain("Reject Entire Proposal");
  });

  it("does not use localStorage or mutate Project facts", () => {
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("/facts/");
    expect(source).not.toContain("project-facts");
  });

  it("projects Backend-governed Source Revision and Canonical Index Artifact state without inventing client authority", () => {
    expect(source).toContain("workspaceRevisionId");
    expect(source).toContain("canonicalIndexArtifactId");
    expect(source).toContain("observationResult");
    expect(source).toContain("indexConfigurationSha256");
    expect(source).toContain("/api/workspace-index-snapshots?workspaceRegistrationId=");
    expect(source).toContain("Current source state");
    expect(source).toContain("حالة المصدر الحالية");
  });

  it("distinguishes unchanged, changed, restored, and index-refreshed observations in the Workspace projection", () => {
    for (const value of ["FIRST_INDEXED", "SOURCE_UNCHANGED", "SOURCE_CHANGED", "KNOWN_STATE_RESTORED", "SOURCE_UNCHANGED_INDEX_REFRESHED"]) {
      expect(source).toContain(value);
    }
    expect(source).toContain("Known source state restored");
    expect(source).toContain("Source unchanged · index refreshed");
  });

  it("renders unique Source History separately from repeatable Observation History", () => {
    expect(source).toContain("workspaceHistory.revisions.map");
    expect(source).toContain("workspaceHistory.observations].reverse().map");
    expect(source).toContain("Source history");
    expect(source).toContain("Observation history");
    expect(source).toContain("observationCount");
  });

  it("keeps technical revisions, artifact IDs, hashes, and paths isolated LTR inside Arabic RTL", () => {
    expect(source).toContain('className={styles.technicalId} dir="ltr"');
    expect(source).toContain("normalizedReference");
    expect(source).toContain("workspaceRevisionId");
    expect(source).toContain("canonicalIndexArtifactId");
  });

  it("does not reintroduce browser directory enumeration or a full repository tree", () => {
    expect(source).not.toContain("webkitdirectory");
    expect(source).not.toContain("FileSystemDirectoryHandle");
    expect(source).not.toContain("full folder tree");
    expect(source).not.toContain("repositoryInventory");
  });

  it("projects proven Source Revision separately from a failed semantic Index Attempt without inventing an Artifact", () => {
    expect(source).toContain("SOURCE_PROVEN_INDEX_FAILED");
    expect(source).toContain("indexAttemptStatus");
    expect(source).toContain("Source state proven; semantic indexing attempt failed");
    expect(source).toContain("canonicalIndexArtifactId?: string");
  });

  it("keeps Backend rejection authoritative instead of optimistic Workspace-state promotion", () => {
    expect(source).toContain("if (!response.ok) throw new Error");
    expect(source).toContain("setIndexSnapshot(snapshot)");
    expect(source).toContain("await refreshWorkspaceHistory(selectedWorkspaceId)");
    expect(source).not.toContain("setWorkspaceHistory({");
  });


  it("makes the governed Workspace and current Source State the B1 hero", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench />);
    expect(html).toContain("Current source state");
    expect(source).toContain("currentRevisionId");
    expect(source).toContain("currentArtifactId");
    expect(source).toContain("Latest Observation");
    expect(source).toContain("Backend evidence determines every available stage");
  });

  it("projects backend readiness into stage availability instead of clickable future authority", () => {
    const html = renderToStaticMarkup(<WorkspaceAnalysisWorkbench />);
    expect(source).toContain("const stageAvailable");
    expect(source).toContain('disabled={!stageAvailable[targetStage]}');
    expect(source).toContain('aria-current={stage === targetStage ? "step" : undefined}');
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("makes Owner review prominent and keeps histories under progressive disclosure", () => {
    expect(source).toContain("ownerReviewCallout");
    expect(source).toContain('role="region"');
    expect(source).toContain("Source & Observation History");
    expect(source).toContain("historyDisclosure");
  });

  it("preserves accessibility and RTL/LTR technical isolation in the lighter stage rail", () => {
    expect(source).toContain('aria-label={text("Governed analysis stages"');
    expect(source).toContain('className={styles.technicalId} dir="ltr"');
    expect(source).toContain("aria-disabled");
  });

});
