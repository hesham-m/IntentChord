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
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";
import {
  InternalAiCredentialService,
  internalAiCredentialService,
} from "@/server/internal-ai-credential-service";
import { InMemorySecretResolver } from "@/server/ai-secret-resolver-test";
import type { InternalAiSecretAuthority } from "@/server/ai-secret-authority";
import { GET as getCredential, POST as credentialCommand } from "@/app/api/admin/ai-vendors/[vendorId]/credential/route";
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

const FAKE_SECRET = "gate3-api-secret-do-not-log";

function makeUnauthRequest(url: string, method = "GET", body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", host: "127.0.0.1:3000" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makeValidAuthRequest(url: string, method = "GET", body?: unknown) {
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

describe("Admin AI Vendor Credential API Owner Isolation (Gate 3)", () => {
  const BASE = "http://127.0.0.1:3000";
  const testPrefix = `test_cred_api_${Date.now()}`;
  const vendorId = `${testPrefix}_v`;
  const credentialReference = `${testPrefix}_KEY`;
  const resolver = new InMemorySecretResolver();
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  beforeAll(async () => {
    rollbackHarness = await beginRollbackOnlyOwnerDbTest();
    internalAiCredentialService.setSecretAuthority(resolver as unknown as InternalAiSecretAuthority);
    await internalAiVendorService.addVendor(
      {
        vendorId,
        displayName: "Credential API Vendor",
        baseUrl: "https://api.cred-api-test.example.com",
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
  });

  afterAll(async () => {
    const pool = databasePool();
    await pool.query("DELETE FROM intentchord.internal_ai_credentials WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_models WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.end().catch(() => {});
    await rollbackHarness?.close();
  });

  it("UNAUTHENTICATED_CREDENTIAL_READ = REJECT (401)", async () => {
    const res = await getCredential(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("UNAUTHENTICATED_CREDENTIAL_ADD = REJECT (401)", async () => {
    const res = await credentialCommand(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`, "POST", {
        action: "ADD",
        credentialReference,
        secret: FAKE_SECRET,
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe("OWNER_SESSION_REQUIRED");
    expect(JSON.stringify(data)).not.toContain(FAKE_SECRET);
  });

  it("UNAUTHENTICATED_CREDENTIAL_REVOKE = REJECT (401)", async () => {
    const res = await credentialCommand(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`, "POST", {
        action: "REVOKE",
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(401);
  });

  it("VALID_SESSION credential ADD → GET never returns secret", async () => {
    const addRes = await credentialCommand(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`, "POST", {
        action: "ADD",
        credentialReference,
        secret: FAKE_SECRET,
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(addRes.status).toBe(201);
    const added = await addRes.json();
    expect(added.credentialReference).toBe(credentialReference);
    expect(added.presence).toBe("PRESENT");
    expect(JSON.stringify(added)).not.toContain(FAKE_SECRET);

    const getRes = await getCredential(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(getRes.status).toBe(200);
    const view = await getRes.json();
    expect(view.credentialState).toBe("ACTIVE");
    expect(JSON.stringify(view)).not.toContain(FAKE_SECRET);
  });

  it("VALID_SESSION invalid action fails 400 without secret echo", async () => {
    const res = await credentialCommand(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`, "POST", {
        action: "NONSENSE",
        secret: FAKE_SECRET,
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(data)).not.toContain(FAKE_SECRET);
  });

  it("VALID_SESSION REVOKE then GET shows REVOKED", async () => {
    const revokeRes = await credentialCommand(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`, "POST", {
        action: "REVOKE",
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(revokeRes.status).toBe(201);
    const revoked = await revokeRes.json();
    expect(revoked.credentialState).toBe("REVOKED");

    const getRes = await getCredential(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorId}/credential`),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(getRes.status).toBe(200);
    const view = await getRes.json();
    expect(view.presence).toBe("REVOKED");
    expect(JSON.stringify(view)).not.toContain(FAKE_SECRET);
  });

  it("Credential service injected with resolver is write-capable (authority check)", () => {
    const service = new InternalAiCredentialService(resolver as unknown as InternalAiSecretAuthority);
    expect(typeof (service as unknown as { setSecretAuthority: unknown }).setSecretAuthority).toBe("function");
    expect(typeof resolver.storeSecret).toBe("function");
    expect(typeof resolver.removeSecret).toBe("function");
  });
});
