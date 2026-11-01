import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = [
  "src/app/api/project-contexts/route.ts",
  "src/app/api/project-contexts/[id]/workspaces/route.ts",
  "src/app/api/project-contexts/[id]/facts/propose/route.ts",
  "src/app/api/project-facts/[id]/approve/route.ts",
  "src/app/api/project-facts/[id]/reject/route.ts",
  "src/app/api/project-facts/[id]/supersede/route.ts",
  "src/app/api/project-contexts/[id]/truth-snapshots/route.ts",
].map(file => readFileSync(file, "utf8")).join("\n");
const service = readFileSync("src/server/project-truth-service.ts", "utf8");

describe("Project Truth authority boundaries", () => {
  it("requires Owner authority for every exposed mutation", () => {
    expect(routes).toContain("ownerCommandResponse");
    expect(routes).not.toContain("commandResponse(");
  });

  it("does not let proposals directly produce OWNER_APPROVED state", () => {
    const proposalStart = service.indexOf("export async function proposeProjectFact");
    const approveStart = service.indexOf("export async function approveProjectFact");
    const proposalSource = service.slice(proposalStart, approveStart);
    expect(proposalSource).toContain('status: "PROPOSED"');
    expect(proposalSource).not.toContain('status: "OWNER_APPROVED"');
  });

  it("records Owner decisions as append-only audit identities", () => {
    expect(service).toContain('eventType: "PROJECT_FACT_APPROVED"');
    expect(service).toContain('eventType: "PROJECT_FACT_REJECTED"');
    expect(service).toContain('eventType = replacementProposal ? "PROJECT_FACT_REPLACED" : "PROJECT_FACT_SUPERSEDED"');
    expect(service).not.toContain("update intentchord.audit_events");
  });
});
