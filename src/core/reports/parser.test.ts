import { describe, expect, it } from "vitest";
import { baseContract } from "@/test/fixtures/scenarios";
import { parseAuthoritativeReport } from "@/core/reports/parser";
import { validateReportSemantics } from "@/core/reports/semantics";
import { authoritativeMarkdown, makeAuthoritativeReport } from "@/test/authoritative-report";

describe("authoritative report parser and semantic trust boundary", () => {
  it("accepts one exact governed header set and one exact canonical section set", () => {
    const report = makeAuthoritativeReport(baseContract, {
      runId: "run-parser-valid-001",
      bindingMarker: "IC-RUN-PARSER-VALID-001",
    });
    const parsed = parseAuthoritativeReport(authoritativeMarkdown(report), "text/markdown");
    expect("report" in parsed).toBe(true);
    if ("report" in parsed) {
      expect(parsed.verifiedSections).toHaveLength(8);
      expect(validateReportSemantics(baseContract, parsed.report)).toEqual([]);
    }
  });

  it("rejects duplicate governed headers instead of accepting the last claim", () => {
    const report = makeAuthoritativeReport(baseContract, {
      runId: "run-parser-duplicate-header",
      bindingMarker: "IC-RUN-PARSER-DUPLICATE-HEADER",
    });
    const markdown = `${authoritativeMarkdown(report)}\nIntentChord Run: forged-run-id`;
    const parsed = parseAuthoritativeReport(markdown, "text/markdown");
    expect("issues" in parsed).toBe(true);
    if ("issues" in parsed) expect(parsed.issues.join(" ")).toContain("must appear exactly once");
  });

  it("rejects duplicate and unknown canonical sections", () => {
    const report = makeAuthoritativeReport(baseContract, {
      runId: "run-parser-duplicate-section",
      bindingMarker: "IC-RUN-PARSER-DUPLICATE-SECTION",
    });
    const markdown = `${authoritativeMarkdown(report)}\n\n## [IC-SECTION:executive-summary] Duplicate\nDuplicate content.\n\n## [IC-SECTION:invented-section] Unknown\nUnknown content.`;
    const parsed = parseAuthoritativeReport(markdown, "text/markdown");
    expect("issues" in parsed).toBe(true);
    if ("issues" in parsed) {
      expect(parsed.issues.join(" ")).toContain("appears more than once");
      expect(parsed.issues.join(" ")).toContain("Unknown canonical report section");
    }
  });

  it("rejects a PROVEN finding that cites only an inspected path", () => {
    const report = makeAuthoritativeReport(baseContract, {
      runId: "run-parser-path-only-finding",
      bindingMarker: "IC-RUN-PARSER-PATH-ONLY",
    });
    report.findings = report.findings.map(finding => ({
      ...finding,
      status: "PROVEN" as const,
      evidenceRefs: [{
        kind: "INSPECTED_PATH" as const,
        workspaceId: baseContract.scope.workspaces[0].id,
        path: baseContract.scope.workspaces[0].allowedPaths[0],
      }],
    }));
    expect(validateReportSemantics(baseContract, report).join(" ")).toContain(
      "must reference its own exact source, artifact, validation, runtime, or trusted trace evidence",
    );
  });

  it("does not accept a JSON completed-section claim without the actual canonical section bodies", () => {
    const report = makeAuthoritativeReport(baseContract, {
      runId: "run-parser-json-section-spoof",
      bindingMarker: "IC-RUN-PARSER-JSON-SECTION-SPOOF",
    });
    const spoofed = {
      ...report,
      completedReportSections: [
        "executive-summary",
        "sources-inspected",
        "evidence-matrix",
        "unsupported-claims",
        "evidence-gaps",
        "validation-results",
        "executor-classification",
        "exact-next-action",
      ],
    } as Record<string, unknown>;
    delete spoofed.reportSections;
    const parsed = parseAuthoritativeReport(JSON.stringify(spoofed), "application/json");
    expect("issues" in parsed).toBe(true);
    if ("issues" in parsed) expect(parsed.issues.join(" ")).toContain("reportSections");
  });

  it("accepts compact canonical PASS classification content as substantive", () => {
    const report = makeAuthoritativeReport(baseContract, {
      executorClassification: "PASS",
      reportSections: {
        ...makeAuthoritativeReport(baseContract).reportSections,
        "executor-classification": "PASS",
      },
    });
    expect(validateReportSemantics(baseContract, report)).not.toContain(
      "Canonical report section executor-classification contains placeholder or non-substantive content.",
    );
  });
});
