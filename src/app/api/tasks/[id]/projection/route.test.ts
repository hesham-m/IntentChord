import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tasks/[id]/projection/route";
import * as projectionService from "@/server/task-experience-projection-service";
import { createTestSessionCookie, ensureTestSessionSecret } from "@/server/owner-auth-test";

ensureTestSessionSecret();

vi.mock("@/server/owner-account", () => ({
  findOwnerById: vi.fn().mockResolvedValue({
    owner_id: "00000000-0000-0000-0000-000000000001",
    login_name: "test-owner",
    display_name: "Test Owner",
    account_state: "ACTIVE",
    session_version: 1,
  }),
}));

function makeAuthRequest(url: string) {
  const cookie = createTestSessionCookie();
  return new Request(url, {
    headers: {
      cookie: `${cookie.name}=${cookie.value}`,
    },
  });
}

describe("GET /api/tasks/:id/projection", () => {
  it("rejects request without valid owner session cookie", async () => {
    const unauthenticated = new Request("http://127.0.0.1:3000/api/tasks/550e8400-e29b-41d4-a716-446655440000/projection");
    const response = await GET(unauthenticated, { params: Promise.resolve({ id: "550e8400-e29b-41d4-a716-446655440000" }) });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("returns 404 when task projection is not found", async () => {
    vi.spyOn(projectionService, "getTaskExperienceProjection").mockResolvedValueOnce(undefined);

    const request = makeAuthRequest("http://127.0.0.1:3000/api/tasks/550e8400-e29b-41d4-a716-446655440000/projection");
    const response = await GET(request, { params: Promise.resolve({ id: "550e8400-e29b-41d4-a716-446655440000" }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("TASK_NOT_FOUND");
  });

  it("returns 200 with projected payload when task exists", async () => {
    const mockProjection: projectionService.TaskExperienceProjectionV1 = {
      taskSummary: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        revision: 1,
        title: "Test Task",
        objective: "Test objective",
        taskMode: "SOURCE_IMPLEMENTATION",
        taskContext: { kind: "INDEPENDENT" },
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
      visiblePhase: "UNDERSTAND",
      phaseStatus: "COMPONENTS_READY_FOR_WORK_SELECTION",
      workspaceSummary: { workspaces: [] },
      analysisSummary: {
        indexStatus: "READY",
        mappingStatus: "COMPLETED",
        mappingAttemptCount: 1,
        discoveryCount: 0,
        analysisReady: true,
        contextClosureState: "PASS",
        missingEvidenceCount: 0,
      },
      contextResolutionSummary: { closureState: "PASS", missingEvidenceRequests: [], resolutionRequirements: [] },
      contextAuthoritySummary: { status: "CURRENT_CONTEXT_READY_FOR_WORK", headStatus: "CURRENT", sourceAuthorityStatus: "CURRENT" },
      discoveredWorkSummary: {
        components: [],
        totalRelevantFiles: 0,
        excludedPathPatterns: [],
      },
      ownerSelectionSummary: {
        selectedContextIds: [],
        selectedComponentIds: [],
        selectionCommitted: false,
      },
      candidateScopeSummary: {
        isDerived: false,
        allowedPaths: [],
        excludedPaths: [],
        boundaryCount: 0,
      },
      effectiveAuthoritySummary: { capabilities: [] },
      scopeConfirmationSummary: { isConfirmed: false, confirmedAllowedPaths: [], confirmedExcludedPaths: [] },
      executionSetupSummary: {
        isConfigured: false,
        authoritySource: "NONE",
        providerId: null,
        modelId: null,
        executionChannelId: null,
        reasoningProfile: null,
        runtimeProfileId: null,
        modelOverrideAccepted: false,
      },
      executionOptions: {
        authorityMeaning: "OWNER_SELECTS_PLATFORM_BACKEND_RESOLVES_CONFIGURATION",
        availablePlatforms: [{ executionChannelId: "CODEX", displayName: "Codex" }],
      },
      governedExecutionInstructionsSummary: {
        isGenerated: false,
        authoritySource: "NONE",
        instructionsPreview: "",
        byteLength: 0,
        locale: "ar",
      },
      contractSummary: {
        ownerApprovalState: "DRAFT",
        mandatoryRequirementsCount: 0,
        requiredChecksCount: 0,
      },
      runSummary: {
        status: "IDLE",
        toolTracesCount: 0,
        reportSubmitted: false,
        evidenceReferencesCount: 0,
        validationEvidenceCount: 0,
        inheritedValidationEvidenceCount: 0,
        sourceEvidenceCount: 0,
        artifactEvidenceCount: 0,
      },
      verdictSummary: {
        isEvaluated: false,
        satisfiedChecksCount: 0,
        totalChecksCount: 0,
        checkLedger: [],
        detectedViolations: [],
        ownerDecision: "NONE",
      },
      primaryAction: {
        actionKey: "START_CONTEXT_ANALYSIS",
        labelEn: "Analyze & Discover Context",
        labelAr: "تحليل واستكشاف الكود",
        availability: "ENABLED",
      },
      availableOwnerActions: [],
      auditDetails: {
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        policyDecisionTraceCount: 0,
      },
    };

    const projectionSpy = vi.spyOn(projectionService, "getTaskExperienceProjection").mockResolvedValueOnce(mockProjection);

    const request = makeAuthRequest("http://127.0.0.1:3000/api/tasks/550e8400-e29b-41d4-a716-446655440000/projection?locale=en");
    const response = await GET(request, { params: Promise.resolve({ id: "550e8400-e29b-41d4-a716-446655440000" }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(projectionSpy).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000", "en");
    expect(body.taskSummary.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(body.visiblePhase).toBe("UNDERSTAND");
    expect(body.phaseStatus).toBe("COMPONENTS_READY_FOR_WORK_SELECTION");
  });
});
