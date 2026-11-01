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
import { beginRollbackOnlyOwnerDbTest, type RollbackOnlyOwnerDbHarness } from "@/test/rollback-only-owner-db";
import { GET as getVendors, POST as addVendor } from "@/app/api/admin/ai-vendors/route";
import { GET as getVendorDetail, PATCH as patchVendor } from "@/app/api/admin/ai-vendors/[vendorId]/route";
import { GET as getModels, POST as addModel } from "@/app/api/admin/ai-vendors/[vendorId]/models/route";
import { PATCH as patchModel } from "@/app/api/admin/ai-vendors/[vendorId]/models/[modelId]/route";
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

function makeUnauthRequest(url: string, method = "GET", body?: any) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", host: "127.0.0.1:3000" },
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

describe("Admin AI Vendors API Owner Isolation (Gate 1)", () => {
  const BASE = "http://127.0.0.1:3000";
  const testPrefix = `test_vendor_api_${Date.now()}`;
  const vendorId = `${testPrefix}_v`;
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  beforeAll(async () => {
    rollbackHarness = await beginRollbackOnlyOwnerDbTest();
  });

  afterAll(async () => {
    const pool = databasePool();
    await pool.query("DELETE FROM intentchord.internal_ai_models WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.end().catch(() => {});
    await rollbackHarness?.close();
  });

  it("UNAUTHENTICATED_VENDOR_LIST = REJECT (401)", async () => {
    const res = await getVendors(makeUnauthRequest(`${BASE}/api/admin/ai-vendors`));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_VENDOR_ADD = REJECT (401)", async () => {
    const res = await addVendor(makeUnauthRequest(`${BASE}/api/admin/ai-vendors`, "POST", {
      vendorId: "malicious_vendor",
      displayName: "Bad",
      baseUrl: "https://evil.example.com",
      authType: "bearer_token",
      protocolProfile: "openai_chat_completions_v1",
    }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_VENDOR_DETAIL = REJECT (401)", async () => {
    const res = await getVendorDetail(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}`),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_VENDOR_PATCH = REJECT (401)", async () => {
    const res = await patchVendor(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}`, "PATCH", { state: "DISABLED" }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_MODEL_LIST = REJECT (401)", async () => {
    const res = await getModels(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/models`),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_MODEL_ADD = REJECT (401)", async () => {
    const res = await addModel(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/models`, "POST", { modelId: "m", displayName: "M" }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_MODEL_PATCH = REJECT (401)", async () => {
    const res = await patchModel(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/models/m1`, "PATCH", { state: "DISABLED" }),
      { params: Promise.resolve({ vendorId, modelId: "m1" }) },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("VALID_SESSION can list and create vendor", async () => {
    const listRes = await getVendors(makeValidAuthRequest(`${BASE}/api/admin/ai-vendors`));
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list)).toBe(true);

    const createRes = await addVendor(makeValidAuthRequest(`${BASE}/api/admin/ai-vendors`, "POST", {
      vendorId,
      displayName: "API Test Vendor",
      baseUrl: "https://api.api-test.example.com",
      authType: "bearer_token",
      protocolProfile: "openai_chat_completions_v1",
    }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.vendorId).toBe(vendorId);
  });

  it("VALID_SESSION can get detail, add model, patch model and vendor", async () => {
    const detailRes = await getVendorDetail(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}`),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.vendorId).toBe(vendorId);
    expect(Array.isArray(detail.models)).toBe(true);

    const modelRes = await addModel(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/models`, "POST", {
        modelId: `${testPrefix}_m`,
        displayName: "API Model",
        providerFacingModelId: "api-model-v1",
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(modelRes.status).toBe(201);

    const modelPatchRes = await patchModel(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/models/${testPrefix}_m`, "PATCH", { state: "DISABLED" }),
      { params: Promise.resolve({ vendorId, modelId: `${testPrefix}_m` }) },
    );
    expect(modelPatchRes.status).toBe(200);
    const patchedModel = await modelPatchRes.json();
    expect(patchedModel.state).toBe("DISABLED");

    const vendorPatchRes = await patchVendor(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}`, "PATCH", { state: "DISABLED" }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(vendorPatchRes.status).toBe(200);
    const patchedVendor = await vendorPatchRes.json();
    expect(patchedVendor.state).toBe("DISABLED");
  });
});
