import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectWorkbench = readFileSync("src/components/project-context-workbench.tsx", "utf8");
const workspaceWorkbench = readFileSync("src/components/workspace-analysis-workbench.tsx", "utf8");
const typesSource = readFileSync("src/core/ai-context-mapper/types.ts", "utf8");
const workbench = `${projectWorkbench}\n${workspaceWorkbench}`;
const routeFiles = {
  create: "src/app/api/ai-context-mappings/route.ts",
  read: "src/app/api/ai-context-mappings/[runId]/route.ts",
  attempts: "src/app/api/ai-context-mappings/[runId]/attempts/route.ts",
  verdict: "src/app/api/ai-context-mappings/[runId]/owner-verdict/route.ts",
} as const;
const routeSources = Object.fromEntries(
  Object.entries(routeFiles).map(([name, file]) => [name, readFileSync(file, "utf8")]),
) as Record<keyof typeof routeFiles, string>;
const routes = Object.values(routeSources).join("\n");

describe("AI Context Mapper owner-visible product contract", () => {
  it("integrates into the existing Project Context owner surface without a parallel page", () => {
    expect(workbench).toContain('id="ai-context-mapper"');
    expect(workbench).toContain("Canonical Workspace Index input");
    expect(workbench).toContain("Proposed catalog");
    expect(workbench).toContain("Owner verdict required");
    expect(workbench).toContain("Validation gates");
  });

  it("exposes no Provider, Model, API-key, or failover control to the browser", () => {
    expect(workbench).not.toMatch(/<select[^>]*(?:provider|model)/i);
    expect(workbench).not.toMatch(/name=["'](?:provider|model|zai|sambanova)/i);
    expect(workbench).not.toMatch(/ZAI_API_KEY|SAMBANOVA_API_KEY|standbyEnabled|standbyGovernanceQualified/);
    expect(workbench).toMatch(/engine selection is governed server-side|محرك Context Mapping الداخلي محكوم/);
    expect(workbench).not.toMatch(/Provider\s*\/\s*Model|SambaNova|Z\.AI|glm-4\.7-flash|gpt-oss-120b/i);
  });

  it("keeps all four internal routes behind the existing Owner response boundary", () => {
    expect(routeSources.create).toMatch(/return\s+ownerCommandResponse\s*\(/);
    expect(routeSources.verdict).toMatch(/return\s+ownerCommandResponse\s*\(/);
    expect(routeSources.read).toMatch(/return\s+ownerReadResponse\s*\(/);
    expect(routeSources.attempts).toMatch(/return\s+ownerReadResponse\s*\(/);
    expect(routes.match(/return\s+ownerCommandResponse\s*\(/g)).toHaveLength(2);
    expect(routes.match(/return\s+ownerReadResponse\s*\(/g)).toHaveLength(2);
    expect(routes).not.toMatch(/NextResponse\.json|publicResponse|anonymous/i);
    expect(routeSources.create).toContain("toCustomerMappingRunView");
    expect(routeSources.read).toContain("toCustomerMappingRunView");
    expect(routeSources.attempts).toContain("toCustomerMappingAttemptView");
    const customerAttemptType = typesSource.slice(typesSource.indexOf("export type CustomerMappingAttemptView"), typesSource.indexOf("export type ContextMappingResultEnvelope"));
    expect(customerAttemptType).toContain('"normalizedErrorCode"');
    expect(customerAttemptType).toContain('"retryCount"');
    expect(customerAttemptType).toContain('"usageMetadata"');
    expect(customerAttemptType).toContain('"rateLimitMetadata"');
    expect(routeSources.verdict).toContain("toCustomerMappingRunView");
    expect(routes).not.toMatch(/ZAI_API_KEY|SAMBANOVA_API_KEY|credentialReference|credential_reference/);
  });
});
