/**
 * PRODUCTION WRITE-CAPABLE SECRET AUTHORITY — Correction Gates C1/C2/C3.
 *
 * Proves the production runtime credential write path end-to-end WITHOUT
 * touching any real Windows Credential Manager credential:
 *
 *  1. Production bootstrap initializes a write-capable authority.
 *  2. Admin credential service receives that authority (one shared instance).
 *  3. ADD reaches storeSecret.
 *  4. REPLACE reaches storeSecret.
 *  5. ROTATE reaches storeSecret.
 *  6. REVOKE reaches removeSecret.
 *  7. DELETE reaches removeSecret.
 *  8. No secret value in API response / logs / PostgreSQL rows / audit metadata.
 *  9. Resolver-unavailable remains distinct from credential-missing.
 * 10. OS write failure fails closed.
 *
 * SECURITY:
 *   - PostgreSQL layer fully mocked in-memory: no real DB writes.
 *   - OS authority is a recording fake: no real secret is ever read/mutated.
 *   - Fake secrets carry "-" characters so they can never appear inside the
 *     base64 alphabet of any captured script/log artifact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// In-memory PostgreSQL stand-in (no real database access in this file)
// ---------------------------------------------------------------------------
const dbState = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const nowIso = () => new Date().toISOString();
  const state = {
    vendors: new Map<string, Row>(),
    credentials: [] as Row[],
    audits: [] as { eventType: string; metadata: string }[],
    queryLog: [] as { text: string; params: unknown[] }[],
    reset() {
      state.vendors.clear();
      state.credentials.length = 0;
      state.audits.length = 0;
      state.queryLog.length = 0;
    },
  };
  return state;
});

vi.mock("@/server/db", () => {
  const nowIso = () => new Date().toISOString();
  async function runQuery(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    dbState.queryLog.push({ text, params });
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.includes("INSERT INTO intentchord.audit_events")) {
      dbState.audits.push({ eventType: String(params[3]), metadata: String(params[5]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO intentchord.internal_ai_credentials")) {
      const row: Record<string, unknown> = {
        credential_reference: params[0],
        vendor_id: params[1],
        credential_state: "ACTIVE",
        last_rotated_at: null,
        revoked_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      dbState.credentials.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("SET credential_reference = NULL")) {
      const vendor = dbState.vendors.get(String(params[0]));
      if (vendor && vendor.credential_reference === params[1]) {
        vendor.credential_reference = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE intentchord.internal_ai_vendors")) {
      const vendor = dbState.vendors.get(String(params[0]));
      if (!vendor) return { rows: [], rowCount: 0 };
      vendor.credential_reference = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET last_rotated_at")) {
      const row = dbState.credentials.find(
        r =>
          r.credential_reference === params[0] &&
          r.vendor_id === params[1] &&
          r.credential_state === "ACTIVE",
      );
      if (!row) return { rows: [], rowCount: 0 };
      if (params[2] === "ROTATE") row.last_rotated_at = nowIso();
      row.updated_at = nowIso();
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("credential_state = 'REVOKED'")) {
      const row = dbState.credentials.find(
        r =>
          r.credential_reference === params[0] &&
          r.vendor_id === params[1] &&
          r.credential_state === "ACTIVE",
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.credential_state = "REVOKED";
      row.revoked_at = nowIso();
      row.updated_at = nowIso();
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM intentchord.internal_ai_credentials")) {
      const idx = dbState.credentials.findIndex(
        r => r.credential_reference === params[0] && r.vendor_id === params[1],
      );
      if (idx < 0) return { rows: [], rowCount: 0 };
      const removed = dbState.credentials.splice(idx, 1)[0];
      return { rows: [{ credential_reference: removed.credential_reference }], rowCount: 1 };
    }
    if (sql.includes("SELECT vendor_id FROM intentchord.internal_ai_vendors")) {
      const present = dbState.vendors.has(String(params[0]));
      return { rows: present ? [{ vendor_id: params[0] }] : [], rowCount: present ? 1 : 0 };
    }
    if (sql.includes("FROM intentchord.internal_ai_credentials WHERE credential_reference")) {
      const rows = dbState.credentials
        .filter(r => r.credential_reference === params[0])
        .map(r => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM intentchord.internal_ai_credentials WHERE vendor_id")) {
      const rows = dbState.credentials
        .filter(r => r.vendor_id === params[0])
        .map(r => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`UNHANDLED_TEST_QUERY: ${sql}`);
  }

  return {
    databaseQuery: (text: string, params?: unknown[]) => runQuery(text, params),
    transaction: async <T,>(
      fn: (client: { query: (t: string, p?: unknown[]) => Promise<unknown> }) => Promise<T>,
    ): Promise<T> => fn({ query: (t, p) => runQuery(t, p) }),
    databasePool: () => ({
      query: (t: string, p?: unknown[]) => runQuery(t, p),
      end: async () => undefined,
    }),
  };
});

vi.mock("@/server/owner-account", () => ({
  findOwnerById: vi.fn().mockResolvedValue({
    owner_id: "00000000-0000-0000-0000-000000000001",
    login_name: "test-owner",
    display_name: "Test Owner",
    account_state: "ACTIVE",
    session_version: 1,
  }),
}));

import { POST as credentialCommand } from "@/app/api/admin/ai-vendors/[vendorId]/credential/route";
import { internalAiCredentialService } from "@/server/internal-ai-credential-service";
import { WindowsCredentialResolver } from "@/server/ai-secret-resolver-windows";
import { ReadOnlySecretAuthority, type InternalAiSecretAuthority } from "@/server/ai-secret-authority";
import {
  setInternalAiSecretResolver,
  getInternalAiSecretResolver,
  checkV2CredentialPresent,
  resolveV2InternalAiCredential,
} from "@/server/ai-context-mapper-config";
import { createTestSecretResolver } from "@/server/ai-secret-resolver-test";
import { createTestSessionCookie, ensureTestSessionSecret } from "@/server/owner-auth-test";

ensureTestSessionSecret();

const INSTRUMENTATION_SOURCE = readFileSync(resolve(__dirname, "../instrumentation.ts"), "utf8");
const WINDOWS_AUTHORITY_SOURCE = readFileSync(resolve(__dirname, "ai-secret-resolver-windows.ts"), "utf8");
const CREDENTIAL_SERVICE_SOURCE = readFileSync(resolve(__dirname, "internal-ai-credential-service.ts"), "utf8");

const BASE = "http://127.0.0.1:3000";
const RUN = Date.now();

/** Recording OS-backed authority fake — never touches Windows Credential Manager. */
class RecordingAuthority implements InternalAiSecretAuthority {
  readonly storeCalls: string[] = [];
  readonly removeCalls: string[] = [];
  readonly secrets = new Map<string, string>();
  failNextStore = false;

  isCredentialPresent(credentialReference: string): boolean {
    return this.secrets.has(credentialReference);
  }
  resolveSecret(credentialReference: string): string | undefined {
    return this.secrets.get(credentialReference);
  }
  resolveSecretOrThrow(credentialReference: string): string {
    const secret = this.secrets.get(credentialReference);
    if (secret === undefined) {
      throw new Error(`SECRET_NOT_FOUND: Credential "${credentialReference}" is not available.`);
    }
    return secret;
  }
  storeSecret(credentialReference: string, secret: string): void {
    if (this.failNextStore) {
      this.failNextStore = false;
      throw new Error("OS_WRITE_FAILURE: Windows Credential Manager rejected the write.");
    }
    this.storeCalls.push(credentialReference);
    this.secrets.set(credentialReference, secret);
  }
  removeSecret(credentialReference: string): void {
    this.removeCalls.push(credentialReference);
    this.secrets.delete(credentialReference);
  }
}

let authority: RecordingAuthority;

function seedVendor(vendorId: string): void {
  dbState.vendors.set(vendorId, { vendor_id: vendorId, credential_reference: null });
}

function seedActiveCredential(vendorId: string, credentialReference: string): void {
  const now = new Date().toISOString();
  dbState.credentials.push({
    credential_reference: credentialReference,
    vendor_id: vendorId,
    credential_state: "ACTIVE",
    last_rotated_at: null,
    revoked_at: null,
    created_at: now,
    updated_at: now,
  });
}

function authRequest(path: string, method = "GET", body?: unknown): Request {
  const cookie = createTestSessionCookie();
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      cookie: `${cookie.name}=${cookie.value}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function credentialPath(vendorId: string): string {
  return `/api/admin/ai-vendors/${vendorId}/credential`;
}

function captureConsole(): { captured: string[]; restore: () => void } {
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.push(
        args
          .map(arg => {
            if (typeof arg === "string") return arg;
            try {
              return JSON.stringify(arg) ?? String(arg);
            } catch {
              return String(arg);
            }
          })
          .join(" "),
      );
    }),
  );
  return {
    captured,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function expectNoSecretInDataPlane(secret: string): void {
  for (const entry of dbState.queryLog) {
    expect(JSON.stringify(entry.params ?? [])).not.toContain(secret);
  }
  for (const audit of dbState.audits) {
    expect(audit.metadata).not.toContain(secret);
    expect(audit.metadata.toLowerCase()).not.toMatch(/"secret"|"apikey"|"password"/);
  }
}

describe("PRODUCTION WRITE-CAPABLE SECRET AUTHORITY (Correction C1–C3)", () => {
  beforeEach(() => {
    dbState.reset();
    authority = new RecordingAuthority();
    internalAiCredentialService.setSecretAuthority(authority);
  });

  afterEach(() => {
    try {
      setInternalAiSecretResolver(null as never);
    } catch {
      /* ok */
    }
  });

  // -------------------------------------------------------------------------
  // 1. Production bootstrap initializes write-capable authority
  // -------------------------------------------------------------------------
  it("1a. instrumentation.ts bootstrap wires setSecretAuthority with the shared Windows authority", () => {
    expect(INSTRUMENTATION_SOURCE).toContain("setSecretAuthority");
    expect(INSTRUMENTATION_SOURCE).toContain("internalAiCredentialService");
    expect(INSTRUMENTATION_SOURCE).toMatch(
      /setInternalAiSecretResolver\(new WindowsCredentialResolver\(\)\)/,
    );
    expect(INSTRUMENTATION_SOURCE).toContain("getInternalAiSecretResolver()");
    expect(INSTRUMENTATION_SOURCE).toContain("as InternalAiSecretAuthority");
    expect(INSTRUMENTATION_SOURCE).not.toContain("InMemorySecretResolver");
    expect(INSTRUMENTATION_SOURCE).not.toContain("ReadOnlySecretAuthority");
  });

  it("1b. WindowsCredentialResolver source is a write-capable InternalAiSecretAuthority", () => {
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("implements InternalAiSecretAuthority");
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("async storeSecret");
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("async removeSecret");
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("CredWriteW");
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("CredDeleteW");
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("WINDOWS_CREDENTIAL_STORE_FAILED");
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("WINDOWS_CREDENTIAL_DELETE_FAILED");
    expect(WINDOWS_AUTHORITY_SOURCE).toContain("IntentChord/InternalAI/");
    expect(WINDOWS_AUTHORITY_SOURCE).not.toContain("InMemorySecretResolver");
    expect(WINDOWS_AUTHORITY_SOURCE).not.toMatch(/process\.env\s*\[/);
  });

  // -------------------------------------------------------------------------
  // 2. Admin credential service receives that authority (one shared instance)
  // -------------------------------------------------------------------------
  it("2. bootstrap simulation: Admin credential service receives the shared Windows authority instance", () => {
    const sharedAuthority = new WindowsCredentialResolver();
    setInternalAiSecretResolver(sharedAuthority);
    internalAiCredentialService.setSecretAuthority(
      getInternalAiSecretResolver() as InternalAiSecretAuthority,
    );

    const received = (
      internalAiCredentialService as unknown as { authority: InternalAiSecretAuthority }
    ).authority;
    expect(received).toBe(sharedAuthority);
    expect(received).toBeInstanceOf(WindowsCredentialResolver);
    expect(typeof received.storeSecret).toBe("function");
    expect(typeof received.removeSecret).toBe("function");
  });

  it("2b. credential service singleton is process-wide across Next.js compilation chunks", () => {
    expect(CREDENTIAL_SERVICE_SOURCE).toContain("__intentchord_internal_ai_credential_service");
    expect(CREDENTIAL_SERVICE_SOURCE).toContain("globalThis as Record<string, unknown>");
    expect(CREDENTIAL_SERVICE_SOURCE).toContain("internalAiCredentialServiceGlobal[INTERNAL_AI_CREDENTIAL_SERVICE_GLOBAL_KEY]");
  });

  // -------------------------------------------------------------------------
  // 3–7. Admin credential API write actions reach the write-capable authority
  // -------------------------------------------------------------------------
  it("3. ADD through Admin credential API reaches storeSecret", async () => {
    const vendorId = `c3_add_${RUN}_v`;
    const credentialReference = `C3_ADD_${RUN}_KEY`;
    const secret = "c3-add-fake-secret-do-not-log";
    seedVendor(vendorId);

    const res = await credentialCommand(
      authRequest(credentialPath(vendorId), "POST", {
        action: "ADD",
        credentialReference,
        secret,
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(201);
    expect(authority.storeCalls).toEqual([credentialReference]);
    expect(authority.secrets.get(credentialReference)).toBe(secret);
    expect(dbState.credentials.some(r => r.vendor_id === vendorId)).toBe(true);
  });

  it("4. REPLACE through Admin credential API reaches storeSecret", async () => {
    const vendorId = `c3_replace_${RUN}_v`;
    const credentialReference = `C3_REPLACE_${RUN}_KEY`;
    const secret = "c3-replace-fake-secret-do-not-log";
    seedVendor(vendorId);
    seedActiveCredential(vendorId, credentialReference);
    authority.secrets.set(credentialReference, "c3-old-replaced-secret");

    const res = await credentialCommand(
      authRequest(credentialPath(vendorId), "POST", {
        action: "REPLACE",
        credentialReference,
        secret,
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(201);
    expect(authority.storeCalls).toEqual([credentialReference]);
    expect(authority.secrets.get(credentialReference)).toBe(secret);
  });

  it("5. ROTATE through Admin credential API reaches storeSecret", async () => {
    const vendorId = `c3_rotate_${RUN}_v`;
    const credentialReference = `C3_ROTATE_${RUN}_KEY`;
    const secret = "c3-rotate-fake-secret-do-not-log";
    seedVendor(vendorId);
    seedActiveCredential(vendorId, credentialReference);
    authority.secrets.set(credentialReference, "c3-old-rotated-secret");

    const res = await credentialCommand(
      authRequest(credentialPath(vendorId), "POST", {
        action: "ROTATE",
        credentialReference,
        secret,
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(201);
    expect(authority.storeCalls).toEqual([credentialReference]);
    expect(authority.secrets.get(credentialReference)).toBe(secret);
    const body = await res.json();
    expect(body.lastRotatedAt).not.toBeNull();
  });

  it("6. REVOKE through Admin credential API reaches removeSecret", async () => {
    const vendorId = `c3_revoke_${RUN}_v`;
    const credentialReference = `C3_REVOKE_${RUN}_KEY`;
    seedVendor(vendorId);
    seedActiveCredential(vendorId, credentialReference);
    authority.secrets.set(credentialReference, "c3-revoke-fake-secret");

    const res = await credentialCommand(
      authRequest(credentialPath(vendorId), "POST", { action: "REVOKE" }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(201);
    expect(authority.removeCalls).toEqual([credentialReference]);
    expect(authority.secrets.has(credentialReference)).toBe(false);
    const body = await res.json();
    expect(body.credentialState).toBe("REVOKED");
  });

  it("7. DELETE through Admin credential API reaches removeSecret", async () => {
    const vendorId = `c3_delete_${RUN}_v`;
    const credentialReference = `C3_DELETE_${RUN}_KEY`;
    seedVendor(vendorId);
    seedActiveCredential(vendorId, credentialReference);
    authority.secrets.set(credentialReference, "c3-delete-fake-secret");

    const res = await credentialCommand(
      authRequest(credentialPath(vendorId), "POST", { action: "DELETE" }),
      { params: Promise.resolve({ vendorId }) },
    );
    expect(res.status).toBe(201);
    expect(authority.removeCalls).toEqual([credentialReference]);
    expect(authority.secrets.has(credentialReference)).toBe(false);
    expect(dbState.credentials.some(r => r.vendor_id === vendorId)).toBe(false);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.credentialReference).toBe(credentialReference);
  });

  // -------------------------------------------------------------------------
  // 8. No secret value in API response / logs / PostgreSQL rows / audit metadata
  // -------------------------------------------------------------------------
  it("8. secret never appears in API response, logs, PostgreSQL query rows, or audit metadata", async () => {
    const vendorId = `c3_nosecret_${RUN}_v`;
    const credentialReference = `C3_NOSECRET_${RUN}_KEY`;
    const secret = "c3-nosecret-fake-secret-do-not-log";
    seedVendor(vendorId);

    const consoleCapture = captureConsole();
    try {
      const addRes = await credentialCommand(
        authRequest(credentialPath(vendorId), "POST", {
          action: "ADD",
          credentialReference,
          secret,
        }),
        { params: Promise.resolve({ vendorId }) },
      );
      const addText = await addRes.text();
      expect(addRes.status).toBe(201);
      expect(addText).not.toContain(secret);
      expect(addText).not.toMatch(/"secret"|"apiKey"|"api_key"|"password"/);

      const rotateRes = await credentialCommand(
        authRequest(credentialPath(vendorId), "POST", {
          action: "ROTATE",
          secret: `${secret}-rotated`,
        }),
        { params: Promise.resolve({ vendorId }) },
      );
      const rotateText = await rotateRes.text();
      expect(rotateRes.status).toBe(201);
      expect(rotateText).not.toContain(secret);
      expect(rotateText).not.toContain(`${secret}-rotated`);

      expectNoSecretInDataPlane(secret);
      expectNoSecretInDataPlane(`${secret}-rotated`);

      for (const line of consoleCapture.captured) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain(`${secret}-rotated`);
      }

      // Secret material lives ONLY inside the authority — never in PG rows.
      expect(authority.secrets.get(credentialReference)).toBe(`${secret}-rotated`);
      const pgRow = dbState.credentials.find(r => r.credential_reference === credentialReference);
      expect(pgRow).toBeDefined();
      expect(JSON.stringify(pgRow)).not.toContain(secret);
      expect(JSON.stringify(pgRow)).not.toContain(`${secret}-rotated`);
    } finally {
      consoleCapture.restore();
    }
  });

  // -------------------------------------------------------------------------
  // 9. Resolver-unavailable remains distinct from credential-missing
  // -------------------------------------------------------------------------
  it("9a. resolver-unavailable throws V2_SECRET_RESOLVER_NOT_INITIALIZED; credential-missing returns false/undefined", async () => {
    setInternalAiSecretResolver(null as never);
    let unavailableMessage = "";
    try {
      getInternalAiSecretResolver();
    } catch (error) {
      unavailableMessage = (error as Error).message;
    }
    expect(unavailableMessage).toContain("V2_SECRET_RESOLVER_NOT_INITIALIZED");

    setInternalAiSecretResolver(createTestSecretResolver({}));
    expect(await checkV2CredentialPresent("C3_DEFINITELY_MISSING_KEY")).toBe(false);
    expect(await resolveV2InternalAiCredential("C3_DEFINITELY_MISSING_KEY")).toBeUndefined();
  });

  it("9b. ReadOnlySecretAuthority write-unavailable is distinct from credential-missing", () => {
    const readOnly: InternalAiSecretAuthority = new ReadOnlySecretAuthority(
      createTestSecretResolver({}),
    );
    expect(readOnly.isCredentialPresent("C3_MISSING_REF")).toBe(false);
    expect(readOnly.resolveSecret("C3_MISSING_REF")).toBeUndefined();
    expect(() => readOnly.storeSecret("C3_MISSING_REF", "value")).toThrow(
      /SECRET_AUTHORITY_WRITE_UNAVAILABLE/,
    );
    expect(() => readOnly.removeSecret("C3_MISSING_REF")).toThrow(
      /SECRET_AUTHORITY_WRITE_UNAVAILABLE/,
    );
  });

  // -------------------------------------------------------------------------
  // 10. OS write failure fails closed
  // -------------------------------------------------------------------------
  it("10a. OS write failure during ADD fails closed: 500, no credential row, no secret exposure", async () => {
    const vendorId = `c3_failclosed_${RUN}_v`;
    const credentialReference = `C3_FAILCLOSED_${RUN}_KEY`;
    const secret = "c3-failclosed-fake-secret-do-not-log";
    seedVendor(vendorId);
    authority.failNextStore = true;

    const consoleCapture = captureConsole();
    try {
      const res = await credentialCommand(
        authRequest(credentialPath(vendorId), "POST", {
          action: "ADD",
          credentialReference,
          secret,
        }),
        { params: Promise.resolve({ vendorId }) },
      );
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(dbState.credentials.some(r => r.vendor_id === vendorId)).toBe(false);
      expect(authority.secrets.has(credentialReference)).toBe(false);
      expect(authority.storeCalls).not.toContain(credentialReference);
      expectNoSecretInDataPlane(secret);
      for (const line of consoleCapture.captured) {
        expect(line).not.toContain(secret);
      }
    } finally {
      consoleCapture.restore();
    }
  });

  it("10b. read-only authority during ADD fails closed with SECRET_AUTHORITY_WRITE_UNAVAILABLE", async () => {
    const vendorId = `c3_readonly_${RUN}_v`;
    const credentialReference = `C3_READONLY_${RUN}_KEY`;
    const secret = "c3-readonly-fake-secret-do-not-log";
    seedVendor(vendorId);
    internalAiCredentialService.setSecretAuthority(
      new ReadOnlySecretAuthority(createTestSecretResolver({})),
    );

    const res = await credentialCommand(
      authRequest(credentialPath(vendorId), "POST", {
        action: "ADD",
        credentialReference,
        secret,
      }),
      { params: Promise.resolve({ vendorId }) },
    );
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain(secret);
    expect(dbState.credentials.some(r => r.vendor_id === vendorId)).toBe(false);
    expectNoSecretInDataPlane(secret);
  });

  it("11. credential service remains write-capable via setSecretAuthority injection point", () => {
    const service = internalAiCredentialService as unknown as {
      setSecretAuthority: (a: InternalAiSecretAuthority) => void;
      authority: InternalAiSecretAuthority;
    };
    expect(typeof service.setSecretAuthority).toBe("function");
    expect(typeof service.authority.storeSecret).toBe("function");
    expect(typeof service.authority.removeSecret).toBe("function");
  });
});
