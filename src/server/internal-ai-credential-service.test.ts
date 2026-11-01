import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { InternalAiCredentialService } from "@/server/internal-ai-credential-service";
import { InMemorySecretResolver } from "@/server/ai-secret-resolver-test";
import type { InternalAiSecretAuthority } from "@/server/ai-secret-authority";

const FAKE_SECRET = "gate3-test-secret-value-do-not-log";

function asAuthority(resolver: InMemorySecretResolver): InternalAiSecretAuthority {
  return resolver as unknown as InternalAiSecretAuthority;
}

describe("Internal AI Credential Lifecycle (Gate 3)", () => {
  const testPrefix = `test_cred_${Date.now()}`;
  const vendorId = `${testPrefix}_v`;
  const credentialReference = `${testPrefix}_KEY`;
  const resolver = new InMemorySecretResolver();
  const service = new InternalAiCredentialService(asAuthority(resolver));
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  beforeAll(async () => {
    rollbackHarness = await beginRollbackOnlyOwnerDbTest();
    await internalAiVendorService.addVendor(
      {
        vendorId,
        displayName: "Credential Test Vendor",
        baseUrl: "https://api.credential-test.example.com",
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

  it("1. Credential schema exists without any secret-valued columns", async () => {
    const tables = await databasePool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='intentchord' AND table_name='internal_ai_credentials'`,
    );
    expect(tables.rowCount).toBe(1);

    const cols = await databasePool().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='intentchord' AND table_name='internal_ai_credentials'`,
    );
    const names = cols.rows.map(r => r.column_name as string);
    expect(names).toEqual(
      expect.arrayContaining([
        "credential_reference",
        "vendor_id",
        "credential_state",
        "last_rotated_at",
        "revoked_at",
        "created_at",
        "updated_at",
      ]),
    );
    for (const name of names) {
      expect(name.toLowerCase()).not.toMatch(/secret|password|api_key|token_value|blob/);
    }
  });

  it("2. GET credential for vendor without credential returns null", async () => {
    const view = await service.getCredential(vendorId);
    expect(view).toBeNull();
  });

  it("3. ADD credential stores secret only in resolver; view has no secret", async () => {
    const view = await service.addCredential(
      vendorId,
      { credentialReference, secret: FAKE_SECRET },
      "OWNER_TEST",
    );
    expect(view.credentialReference).toBe(credentialReference);
    expect(view.credentialState).toBe("ACTIVE");
    expect(view.presence).toBe("PRESENT");
    expect(view.vendorId).toBe(vendorId);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(FAKE_SECRET);
    expect(serialized).not.toMatch(/secret|apiKey|api_key|password/i);

    expect(resolver.isCredentialPresent(credentialReference)).toBe(true);
    expect(resolver.resolveSecret(credentialReference)).toBe(FAKE_SECRET);
  });

  it("4. PG row for credential contains no secret material", async () => {
    const res = await databasePool().query(
      `SELECT * FROM intentchord.internal_ai_credentials WHERE credential_reference = $1`,
      [credentialReference],
    );
    expect(res.rowCount).toBe(1);
    const row = res.rows[0] as Record<string, unknown>;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(FAKE_SECRET);
    expect(Object.keys(row).some(k => /secret|password|api_key|blob/i.test(k))).toBe(false);
    expect(row.credential_state).toBe("ACTIVE");
    expect(row.vendor_id).toBe(vendorId);
  });

  it("5. Duplicate ADD fails with 409", async () => {
    await expect(
      service.addCredential(
        vendorId,
        { credentialReference, secret: FAKE_SECRET },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("6. REPLACE overwrites secret without exposing it in the view", async () => {
    const newSecret = `${FAKE_SECRET}_replaced`;
    const view = await service.replaceOrRotateCredential(
      vendorId,
      { secret: newSecret, mode: "REPLACE" },
      "OWNER_TEST",
    );
    expect(view.presence).toBe("PRESENT");
    expect(view.credentialState).toBe("ACTIVE");
    expect(JSON.stringify(view)).not.toContain(newSecret);
    expect(resolver.resolveSecret(credentialReference)).toBe(newSecret);
  });

  it("7. ROTATE updates secret and sets lastRotatedAt", async () => {
    const rotatedSecret = `${FAKE_SECRET}_rotated`;
    const view = await service.replaceOrRotateCredential(
      vendorId,
      { secret: rotatedSecret, mode: "ROTATE" },
      "OWNER_TEST",
    );
    expect(view.presence).toBe("PRESENT");
    expect(view.lastRotatedAt).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain(rotatedSecret);
    expect(resolver.resolveSecret(credentialReference)).toBe(rotatedSecret);
  });

  it("8. Invalid credentialReference format fails with 400", async () => {
    await expect(
      service.addCredential(
        vendorId,
        { credentialReference: "bad ref!", secret: FAKE_SECRET },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/credentialReference/i);
  });

  it("9. REVOKE marks REVOKED, removes secret from resolver, clears vendor binding", async () => {
    const view = await service.revokeCredential(vendorId, "OWNER_TEST", credentialReference);
    expect(view.credentialState).toBe("REVOKED");
    expect(view.presence).toBe("REVOKED");
    expect(view.revokedAt).not.toBeNull();
    expect(resolver.isCredentialPresent(credentialReference)).toBe(false);

    const vendor = await internalAiVendorService.getVendor(vendorId);
    expect(vendor?.credentialReference).toBeNull();
  });

  it("10. REVOKE again fails with 409", async () => {
    await expect(service.revokeCredential(vendorId, "OWNER_TEST")).rejects.toThrow(/already revoked/i);
  });

  it("11. REPLACE/ROTATE after REVOKE fails with 409", async () => {
    await expect(
      service.replaceOrRotateCredential(vendorId, { secret: FAKE_SECRET, mode: "ROTATE" }, "OWNER_TEST"),
    ).rejects.toThrow(/revoked/i);
  });

  it("12. DELETE removes PG row and resolver secret", async () => {
    await service.addCredential(
      vendorId,
      { credentialReference: `${testPrefix}_KEY2`, secret: `${FAKE_SECRET}2` },
      "OWNER_TEST",
    );
    expect(resolver.isCredentialPresent(`${testPrefix}_KEY2`)).toBe(true);

    const result = await service.deleteCredential(vendorId, "OWNER_TEST");
    expect(result.deleted).toBe(true);
    expect(resolver.isCredentialPresent(`${testPrefix}_KEY2`)).toBe(false);

    const res = await databasePool().query(
      `SELECT * FROM intentchord.internal_ai_credentials WHERE vendor_id = $1`,
      [vendorId],
    );
    expect(res.rowCount).toBe(0);
  });

  it("13. Unknown vendor fails with 404 on credential read", async () => {
    await expect(service.getCredential(`${testPrefix}_missing`)).rejects.toThrow(/not registered/i);
  });

  it("14. Audit events recorded under INTERNAL_AI_CREDENTIAL_LIFECYCLE without secret metadata", async () => {
    const res = await databasePool().query(
      `SELECT event_type, metadata FROM intentchord.audit_events
       WHERE aggregate_type = 'INTERNAL_AI_CREDENTIAL_LIFECYCLE'
         AND (metadata::text LIKE $1 OR metadata::text LIKE $2)
       ORDER BY created_at DESC`,
      [`%${testPrefix}%`, `%${credentialReference}%`],
    );
    expect((res.rowCount ?? 0)).toBeGreaterThan(0);
    const serialized = JSON.stringify(res.rows);
    expect(serialized).not.toContain(FAKE_SECRET);
    const types = res.rows.map(r => r.event_type);
    expect(types).toEqual(expect.arrayContaining(["CREDENTIAL_ADDED", "CREDENTIAL_REVOKED", "CREDENTIAL_DELETED"]));
  });

  it("15. Full serialized lifecycle views never expose the secret", async () => {
    await service.addCredential(
      vendorId,
      { credentialReference: `${testPrefix}_KEY3`, secret: `${FAKE_SECRET}3` },
      "OWNER_TEST",
    );
    const view = await service.getCredential(vendorId);
    const replaced = await service.replaceOrRotateCredential(
      vendorId,
      { secret: `${FAKE_SECRET}3b`, mode: "ROTATE" },
      "OWNER_TEST",
    );
    const revoked = await service.revokeCredential(vendorId, "OWNER_TEST");
    const deleted = await service.deleteCredential(vendorId, "OWNER_TEST");

    const all = JSON.stringify({ view, replaced, revoked, deleted });
    expect(all).not.toContain(`${FAKE_SECRET}3`);
    expect(all).not.toContain(`${FAKE_SECRET}3b`);
    expect(all).not.toMatch(/"secret"|apiKey|api_key|password/i);
  });
});
