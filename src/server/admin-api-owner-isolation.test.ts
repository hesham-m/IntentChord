import { describe, expect, it, afterAll, beforeAll, vi } from "vitest";
import fs from "node:fs";

if (!process.env.DATABASE_URL && fs.existsSync(".env.local")) {
  const envContent = fs.readFileSync(".env.local", "utf8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

import { databasePool } from "@/server/db";
import { GET as getEngines, POST as registerEngine } from "@/app/api/admin/ai-engines/route";
import { GET as getEngineDetail, PATCH as updateEngineState } from "@/app/api/admin/ai-engines/[engineId]/route";
import { POST as createRevision } from "@/app/api/admin/ai-engines/[engineId]/revisions/route";
import { POST as qualifyEngine } from "@/app/api/admin/ai-engines/qualifications/route";
import { POST as revokeQualification } from "@/app/api/admin/ai-engines/qualifications/[qualificationId]/revoke/route";
import { GET as getSelection, POST as updateSelection } from "@/app/api/admin/ai-engines/selection/route";
import { toCustomerMappingRunView } from "@/server/ai-context-mapping-service";
import { setInternalAiSecretResolver } from "@/server/ai-context-mapper-config";
import { createTestSecretResolver } from "@/server/ai-secret-resolver-test";
import { createTestSessionCookie, ensureTestSessionSecret } from "@/server/owner-auth-test";
import type { MappingRunView } from "@/core/ai-context-mapper/types";

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

function makeUnauthRequest(url: string, method = "GET", body?: any) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makeForgedAuthRequest(url: string, method = "GET", body?: any) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      cookie: "intentchord_owner_session=forged_unauthorized_token_12345",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makeValidAuthRequest(url: string, method = "GET", body?: any) {
  const cookie = createTestSessionCookie();
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      cookie: `${cookie.name}=${cookie.value}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Admin API Owner Isolation Suite (Area 3)", () => {
  const BASE = "http://127.0.0.1:3000";

  beforeAll(() => {
    setInternalAiSecretResolver(createTestSecretResolver({}));
  });

  it("UNAUTHENTICATED_ADMIN_ENGINE_LIST = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines`, "GET");
    const res = await getEngines(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_ADMIN_ENGINE_DETAIL = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines/engine-test-123`, "GET");
    const res = await getEngineDetail(req, { params: Promise.resolve({ engineId: "engine-test-123" }) });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_ENGINE_REGISTER = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines`, "POST", {
      engineId: "engine-malicious-attempt",
      isAdmin: true,
      role: "admin",
      owner: true,
    });
    const res = await registerEngine(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_ENGINE_STATE_CHANGE = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines/engine-test-123`, "PATCH", {
      engineState: "DISABLED",
      isAdmin: true,
    });
    const res = await updateEngineState(req, { params: Promise.resolve({ engineId: "engine-test-123" }) });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_REVISION_CREATE = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines/engine-test-123/revisions`, "POST", {
      providerAdapterFamily: "openai_compatible",
      role: "admin",
    });
    const res = await createRevision(req, { params: Promise.resolve({ engineId: "engine-test-123" }) });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_QUALIFICATION_CREATE = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines/qualifications`, "POST", {
      engineId: "engine-test-123",
      owner: true,
    });
    const res = await qualifyEngine(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_QUALIFICATION_REVOKE = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines/qualifications/qual-test-123/revoke`, "POST", {
      reason: "security_test",
    });
    const res = await revokeQualification(req, { params: Promise.resolve({ qualificationId: "qual-test-123" }) });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_DEFAULT_SELECTION_CHANGE = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines/selection`, "POST", {
      action: "SELECT_DEFAULT",
      engineId: "engine-test-123",
      isAdmin: true,
    });
    const res = await updateSelection(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_STANDBY_SELECTION_CHANGE = REJECT (401)", async () => {
    const req = makeUnauthRequest(`${BASE}/api/admin/ai-engines/selection`, "POST", {
      action: "SELECT_STANDBY",
      standbyEngineId: "engine-test-123",
      isAdmin: true,
    });
    const res = await updateSelection(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("rejects self-asserted browser payloads even with forged cookies (403)", async () => {
    const req = makeForgedAuthRequest(`${BASE}/api/admin/ai-engines`, "POST", {
      engineId: "attacker-engine",
      isAdmin: true,
      role: "admin",
      owner: true,
    });
    const res = await registerEngine(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_INVALID");
  });

  it("allows requests with valid HMAC owner session cookie", async () => {
    const req = makeValidAuthRequest(`${BASE}/api/admin/ai-engines`, "GET");
    const res = await getEngines(req);
    const body = await res.json();
    if (res.status !== 200) {
      console.error("GET engines failed with status", res.status, body);
    }
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("NORMAL_USER_API_MODEL_IDENTITY_EXPOSURE = NO (customer projection strips all AI engine/provider identity)", () => {
    const internalRun: MappingRunView = ({
      id: "run-secret-123",
      status: "COMPLETED",
      mappingInputSnapshotId: "snap-in-1",
      mappingInputSha256: "sha256-in",
      workspaceSnapshotId: "ws-snap-1",
      workspaceIndexSha256: "sha256-idx",
      eligibleEntryCount: 10,
      excludedEntryCount: 2,
      estimatedTokens: 1200,
      ownerVerdictState: "ACCEPTED",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
      // Sensitive internal execution identities:
      primaryProviderId: "openrouter",
      primaryChannelId: "test-channel",
      primaryModelId: "secret-model-v1",
      standbyProviderId: "sambanova",
      standbyChannelId: "standby-channel",
      standbyModelId: "secret-standby-model",
      providerConfigurationSnapshot: {
        apiKeyRef: "SECRET_KEY_ENV",
        baseUrl: "https://api.secret.example.com",
        timeoutMs: 15000,
      },
      standbyEnabled: true,
      standbyGovernanceState: "QUALIFIED",
      proposal: {
        id: "prop-1",
        runId: "run-secret-123",
        attemptId: "att-1",
        proposalSha256: "prop-sha",
        schemaVersion: "v2",
        validationEvidence: { valid: true },
        modelProposal: { files: [] } as any,
        resultEnvelope: { rawProviderPayload: "PRIVATE_SENSITIVE_OUTPUT" } as any,
        createdAt: "2026-09-08T00:00:00.000Z",
      },
      ownerContextDecisions: [],
    } as unknown as MappingRunView);

    const customerView = toCustomerMappingRunView(internalRun);

    // Verify all internal provider & model identity fields are stripped
    expect((customerView as any).primaryProviderId).toBeUndefined();
    expect((customerView as any).primaryChannelId).toBeUndefined();
    expect((customerView as any).primaryModelId).toBeUndefined();
    expect((customerView as any).standbyProviderId).toBeUndefined();
    expect((customerView as any).standbyChannelId).toBeUndefined();
    expect((customerView as any).standbyModelId).toBeUndefined();
    expect((customerView as any).providerConfigurationSnapshot).toBeUndefined();
    expect((customerView as any).standbyEnabled).toBeUndefined();
    expect((customerView as any).standbyGovernanceState).toBeUndefined();

    // Verify raw provider response is stripped from proposal
    expect(customerView.proposal).toBeDefined();
    expect((customerView.proposal as any).resultEnvelope).toBeUndefined();
  });

  afterAll(async () => {
    setInternalAiSecretResolver(null as any);
    await databasePool().end().catch(() => {});
  });
});
