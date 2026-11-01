import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { verifyOwnerSessionFromCookies, createSessionToken, requireOwnerSession } from "@/server/authority";
import { createTestSessionCookie, ensureTestSessionSecret } from "@/server/owner-auth-test";
import { findOwnerById } from "@/server/owner-account";
import type { OwnerAccountRow } from "@/server/owner-account";

ensureTestSessionSecret();

const TEST_ACCOUNT: OwnerAccountRow = {
  owner_id: "11111111-1111-1111-1111-111111111111",
  login_name: "testowner",
  display_name: "Test Owner",
  password_hash: Buffer.alloc(0),
  password_salt: Buffer.alloc(0),
  password_kdf: "scrypt-v1",
  account_state: "ACTIVE",
  session_version: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

vi.mock("@/server/owner-account", () => ({
  findOwnerById: vi.fn(),
  authenticateOwner: vi.fn(),
}));

function mockOwnerAccount(overrides: Partial<OwnerAccountRow> = {}) {
  vi.mocked(findOwnerById).mockResolvedValue({ ...TEST_ACCOUNT, ...overrides } as any);
}

function mockOwnerNotFound() {
  vi.mocked(findOwnerById).mockResolvedValue(null);
}

// ===========================================================================
// MANDATORY FULL SESSION BOUNDARY TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. NO_COOKIE → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_NO_COOKIE", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_REQUIRED for empty cookie header", async () => {
    try {
      await verifyOwnerSessionFromCookies("");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_REQUIRED");
    }
  });

  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_REQUIRED for cookie header without session", async () => {
    try {
      await verifyOwnerSessionFromCookies("intentchord-locale=en; intentchord-theme=dark");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_REQUIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. GARBAGE_COOKIE → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_GARBAGE_COOKIE", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for garbage token", async () => {
    mockOwnerAccount();
    try {
      await verifyOwnerSessionFromCookies("intentchord_owner_session=not-a-real-token");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });

  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for random base64", async () => {
    mockOwnerAccount();
    try {
      await verifyOwnerSessionFromCookies("intentchord_owner_session=eyJ2IjoxLCJzdWIiOiJ0ZXN0In0.fakesig");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. MALFORMED_SESSION → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_MALFORMED", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for no-dot token", async () => {
    mockOwnerAccount();
    try {
      await verifyOwnerSessionFromCookies("intentchord_owner_session=nodotatall");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });

  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for empty encoded part", async () => {
    mockOwnerAccount();
    try {
      await verifyOwnerSessionFromCookies("intentchord_owner_session=.signatureonly");
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. TAMPERED_SIGNATURE → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_TAMPERED_SIGNATURE", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for tampered signature", async () => {
    mockOwnerAccount();
    const validToken = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const [encoded] = validToken.split(".");
    const tampered = `${encoded}.0000000000000000000000000000000000000000000000000000000000000000`;
    try {
      await verifyOwnerSessionFromCookies(`intentchord_owner_session=${tampered}`);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });

  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for modified payload", async () => {
    mockOwnerAccount();
    const validToken = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const [encoded, sig] = validToken.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    payload.sub = "00000000-0000-0000-0000-999999999999";
    const reencoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    try {
      await verifyOwnerSessionFromCookies(`intentchord_owner_session=${reencoded}.${sig}`);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. EXPIRED_SESSION → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_EXPIRED", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_EXPIRED for expired token", async () => {
    mockOwnerAccount();
    const originalDateNow = Date.now;
    let currentTime = originalDateNow();
    Date.now = () => currentTime;
    try {
      const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
      currentTime = originalDateNow() + 9 * 3600000;
      try {
        await verifyOwnerSessionFromCookies(`intentchord_owner_session=${token}`);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("OWNER_SESSION_EXPIRED");
      }
    } finally {
      Date.now = originalDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. UNSUPPORTED_SESSION_VERSION → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_UNSUPPORTED_VERSION", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for unsupported version", async () => {
    mockOwnerAccount();
    const { createHmac } = await import("node:crypto");
    const payload = { v: 999, sub: TEST_ACCOUNT.owner_id, sv: 1, iat: Date.now(), exp: Date.now() + 3600000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const secret = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    if (!secret) throw new Error("TEST_SESSION_SECRET_MISSING");
    const sig = createHmac("sha256", secret).update(encoded).digest("hex");
    try {
      await verifyOwnerSessionFromCookies(`intentchord_owner_session=${encoded}.${sig}`);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. NONEXISTENT_OWNER_ID → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_NONEXISTENT_OWNER", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALID for unknown owner_id", async () => {
    mockOwnerNotFound();
    const token = createSessionToken("00000000-0000-0000-0000-999999999999", 1);
    try {
      await verifyOwnerSessionFromCookies(`intentchord_owner_session=${token}`);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. DISABLED_OWNER → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_DISABLED_OWNER", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_ACCOUNT_DISABLED for disabled account", async () => {
    mockOwnerAccount({ account_state: "DISABLED" });
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    try {
      await verifyOwnerSessionFromCookies(`intentchord_owner_session=${token}`);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_ACCOUNT_DISABLED");
    }
  });
});

// ---------------------------------------------------------------------------
// 9. SESSION_VERSION_MISMATCH → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_VERSION_MISMATCH", () => {
  it("verifyOwnerSessionFromCookies throws OWNER_SESSION_INVALIDATED for version mismatch", async () => {
    mockOwnerAccount({ session_version: 5 });
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 3);
    try {
      await verifyOwnerSessionFromCookies(`intentchord_owner_session=${token}`);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALIDATED");
    }
  });
});

// ---------------------------------------------------------------------------
// 10. VALID_OWNER_SESSION → protected product renders
// ---------------------------------------------------------------------------
describe("FULL_SESSION_VALID_OWNER", () => {
  it("verifyOwnerSessionFromCookies returns account for valid session", async () => {
    mockOwnerAccount();
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const account = await verifyOwnerSessionFromCookies(`intentchord_owner_session=${token}`);
    expect(account.owner_id).toBe(TEST_ACCOUNT.owner_id);
    expect(account.display_name).toBe("Test Owner");
  });
});

// ---------------------------------------------------------------------------
// 11. VALID_OWNER_SESSION + /login → /
// ---------------------------------------------------------------------------
describe("FULL_SESSION_VALID_ON_LOGIN_PAGE", () => {
  it("login page calls session API which returns valid for good session", () => {
    const source = fs.readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(source).toContain("/api/auth/session");
    expect(source).toContain('router.replace("/")');
  });

  it("session API endpoint uses verifyOwnerSessionFromCookies", () => {
    const source = fs.readFileSync("src/app/api/auth/session/route.ts", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
  });
});

// ---------------------------------------------------------------------------
// 12. POST_LOGOUT + / → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_POST_LOGOUT_ROOT", () => {
  it("protected layout redirects unauthenticated requests to /login", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain('redirect("/login")');
  });

  it("protected layout uses verifyOwnerSessionFromCookies for full session check", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
  });
});

// ---------------------------------------------------------------------------
// 13. POST_LOGOUT + /admin → /login
// ---------------------------------------------------------------------------
describe("FULL_SESSION_POST_LOGOUT_ADMIN", () => {
  it("admin page is inside protected group (layout handles auth)", () => {
    expect(fs.existsSync("src/app/(protected)/admin/page.tsx")).toBe(true);
  });

  it("protected layout protects admin via full session verification", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
    expect(source).toContain('redirect("/login")');
  });
});

// ===========================================================================
// SOURCE-LEVEL VERIFICATION
// ===========================================================================
describe("FULL_SESSION_SOURCE_VERIFICATION", () => {
  it("authority.ts exports verifyOwnerSessionFromCookies", () => {
    const source = fs.readFileSync("src/server/authority.ts", "utf8");
    expect(source).toContain("export async function verifyOwnerSessionFromCookies");
  });

  it("protected layout imports and calls verifyOwnerSessionFromCookies", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
    expect(source).toContain("await verifyOwnerSessionFromCookies");
  });

  it("protected layout has try/catch around session verification", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain("try {");
    expect(source).toContain("} catch {");
  });

  it("session API route exists and uses canonical verifier", () => {
    expect(fs.existsSync("src/app/api/auth/session/route.ts")).toBe(true);
    const source = fs.readFileSync("src/app/api/auth/session/route.ts", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
  });

  it("root layout has no auth logic (protected layout handles it)", () => {
    const source = fs.readFileSync("src/app/layout.tsx", "utf8");
    expect(source).not.toContain("verifyOwnerSessionFromCookies");
    expect(source).not.toContain('redirect("/login")');
  });
});
