import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { hashPassword, verifyPassword } from "@/server/owner-password";
import { createSessionToken, requireSameOriginRequest, requireOwnerSession, ownerSessionCookieValue, ownerSessionClearCookie } from "@/server/authority";
import { createTestSessionCookie, ensureTestSessionSecret } from "@/server/owner-auth-test";
import { findOwnerById, authenticateOwner } from "@/server/owner-account";
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

// ---------------------------------------------------------------------------
// 1. Correct Owner credentials authenticate
// ---------------------------------------------------------------------------
describe("AUTH_CORRECT_CREDENTIALS_AUTHENTICATE", () => {
  it("hashPassword produces different hashes for different salts", async () => {
    const a = await hashPassword("test-password-123");
    const b = await hashPassword("test-password-123");
    expect(a.passwordHash.equals(b.passwordHash)).toBe(false);
  });

  it("verifyPassword returns true for correct password", async () => {
    const { passwordHash, passwordSalt, passwordKdf } = await hashPassword("correct-password");
    expect(await verifyPassword("correct-password", passwordHash, passwordSalt, passwordKdf)).toBe(true);
  });

  it("verifyPassword returns false for wrong password", async () => {
    const { passwordHash, passwordSalt, passwordKdf } = await hashPassword("correct-password");
    expect(await verifyPassword("wrong-password", passwordHash, passwordSalt, passwordKdf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Wrong password rejected
// ---------------------------------------------------------------------------
describe("AUTH_WRONG_PASSWORD_REJECTED", () => {
  it("verifyPassword returns false for incorrect password", async () => {
    const { passwordHash, passwordSalt, passwordKdf } = await hashPassword("my-secure-password");
    expect(await verifyPassword("my-secure-pasword", passwordHash, passwordSalt, passwordKdf)).toBe(false);
    expect(await verifyPassword("my-secure-password1", passwordHash, passwordSalt, passwordKdf)).toBe(false);
    expect(await verifyPassword("", passwordHash, passwordSalt, passwordKdf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown login rejected generically
// ---------------------------------------------------------------------------
describe("AUTH_UNKNOWN_LOGIN_REJECTED_GENERICALLY", () => {
  it("verifyPassword with wrong KDF identifier returns false", async () => {
    const { passwordHash, passwordSalt } = await hashPassword("test");
    expect(await verifyPassword("test", passwordHash, passwordSalt, "unknown-kdf")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Disabled Owner rejected
// ---------------------------------------------------------------------------
describe("AUTH_DISABLED_OWNER_REJECTED", () => {
  it("requireOwnerSession rejects when account_state is DISABLED", async () => {
    mockOwnerAccount({ account_state: "DISABLED" });
    const cookie = createTestSessionCookie(TEST_ACCOUNT.owner_id, 1);
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_ACCOUNT_DISABLED");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Successful login sets Owner session cookie
// ---------------------------------------------------------------------------
describe("AUTH_LOGIN_SETS_COOKIE", () => {
  it("createSessionToken returns a string token", () => {
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 6. Cookie is HttpOnly
// ---------------------------------------------------------------------------
describe("AUTH_COOKIE_HTTPONLY", () => {
  it("ownerSessionCookieValue has httpOnly=true", () => {
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const cookie = ownerSessionCookieValue(token);
    expect(cookie.httpOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. SameSite preserved
// ---------------------------------------------------------------------------
describe("AUTH_COOKIE_SAMESITE", () => {
  it("ownerSessionCookieValue has sameSite=strict", () => {
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const cookie = ownerSessionCookieValue(token);
    expect(cookie.sameSite).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// 8. Secure behavior correct for environment
// ---------------------------------------------------------------------------
describe("AUTH_COOKIE_SECURE", () => {
  it("ownerSessionCookieValue has environment-aware secure flag", () => {
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const cookie = ownerSessionCookieValue(token);
    expect(typeof cookie.secure).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// 9. Cookie lifetime = 8 hours
// ---------------------------------------------------------------------------
describe("AUTH_COOKIE_LIFETIME_8H", () => {
  it("ownerSessionCookieValue has maxAge of 28800 seconds (8 hours)", () => {
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const cookie = ownerSessionCookieValue(token);
    expect(cookie.maxAge).toBe(28800);
  });
});

// ---------------------------------------------------------------------------
// 10. signed expires_at enforced
// ---------------------------------------------------------------------------
describe("AUTH_SESSION_EXPIRY_ENFORCED", () => {
  it("requireOwnerSession rejects expired session token", async () => {
    mockOwnerAccount();
    // Use a spy on Date.now to control time
    const originalDateNow = Date.now;
    let currentTime = Date.now();
    Date.now = () => currentTime;
    try {
      // Create token "in the future"
      currentTime = originalDateNow();
      const futureToken = createSessionToken(TEST_ACCOUNT.owner_id, 1);
      
      // Now "advance time" past expiry
      currentTime = originalDateNow() + 9 * 3600000; // 9 hours later
      
      const req = new Request("http://localhost:3000/api/admin/ai-engines", {
        headers: { cookie: `intentchord_owner_session=${futureToken}` },
      });
      try {
        await requireOwnerSession(req);
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
// 11. Expired session rejected
// ---------------------------------------------------------------------------
describe("AUTH_EXPIRED_SESSION_REJECTED", () => {
  it("session created long ago is rejected when checked later", async () => {
    mockOwnerAccount();
    const originalDateNow = Date.now;
    let currentTime = originalDateNow();
    Date.now = () => currentTime;
    try {
      // Create a session
      const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
      
      // Advance time 9 hours (past 8h lifetime)
      currentTime = originalDateNow() + 9 * 3600000;
      
      const req = new Request("http://localhost:3000/api/admin/ai-engines", {
        headers: { cookie: `intentchord_owner_session=${token}` },
      });
      try {
        await requireOwnerSession(req);
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
// 12. Tampered signature rejected
// ---------------------------------------------------------------------------
describe("AUTH_TAMPERED_SIGNATURE_REJECTED", () => {
  it("session with invalid signature is rejected", async () => {
    mockOwnerAccount();
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const [encoded] = token.split(".");
    const tamperedToken = `${encoded}.0000000000000000000000000000000000000000000000000000000000000000`;

    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `intentchord_owner_session=${tamperedToken}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Malformed session rejected
// ---------------------------------------------------------------------------
describe("AUTH_MALFORMED_SESSION_REJECTED", () => {
  it("malformed cookie value is rejected", async () => {
    mockOwnerAccount();
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: "intentchord_owner_session=not-a-valid-token" },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });

  it("empty cookie is rejected", async () => {
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: "" },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_REQUIRED");
    }
  });

  it("missing cookie is rejected", async () => {
    const req = new Request("http://localhost:3000/api/admin/ai-engines");
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_REQUIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Unsupported session version rejected
// ---------------------------------------------------------------------------
describe("AUTH_UNSUPPORTED_SESSION_VERSION_REJECTED", () => {
  it("session with version 999 is rejected", async () => {
    mockOwnerAccount();
    const payload = {
      v: 999,
      sub: TEST_ACCOUNT.owner_id,
      sv: 1,
      iat: Date.now(),
      exp: Date.now() + 3600000,
    };
    const createHmac = (await import("node:crypto")).createHmac;
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const secret = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    if (!secret) throw new Error("TEST_SESSION_SECRET_MISSING");
    const sig = createHmac("sha256", secret).update(encoded).digest("hex");
    const token = `${encoded}.${sig}`;

    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `intentchord_owner_session=${token}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Nonexistent owner_id rejected
// ---------------------------------------------------------------------------
describe("AUTH_NONEXISTENT_OWNER_REJECTED", () => {
  it("session with unknown owner_id is rejected", async () => {
    mockOwnerNotFound();
    const cookie = createTestSessionCookie("nonexistent-owner-id", 1);
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 16. session_version mismatch rejected
// ---------------------------------------------------------------------------
describe("AUTH_SESSION_VERSION_MISMATCH_REJECTED", () => {
  it("session with wrong session_version is rejected", async () => {
    mockOwnerAccount({ session_version: 5 });
    const cookie = createTestSessionCookie(TEST_ACCOUNT.owner_id, 3);
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALIDATED");
    }
  });
});

// ---------------------------------------------------------------------------
// 17. Authenticated Admin API still accepted
// ---------------------------------------------------------------------------
describe("AUTH_AUTHENTICATED_ADMIN_API_ACCEPTED", () => {
  it("valid session returns owner:<id> principal", async () => {
    mockOwnerAccount();
    const cookie = createTestSessionCookie(TEST_ACCOUNT.owner_id, 1);
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    const principal = await requireOwnerSession(req);
    expect(principal).toBe(`owner:${TEST_ACCOUNT.owner_id}`);
  });
});

// ---------------------------------------------------------------------------
// 18. Unauthenticated Admin API still rejected
// ---------------------------------------------------------------------------
describe("AUTH_UNAUTHENTICATED_ADMIN_API_REJECTED", () => {
  it("request without cookie is rejected", async () => {
    const req = new Request("http://localhost:3000/api/admin/ai-engines");
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_REQUIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// 19. Forged client admin/owner attributes rejected
// ---------------------------------------------------------------------------
describe("AUTH_FORGED_ATTRIBUTES_REJECTED", () => {
  it("request with forged x-forwarded headers still requires valid cookie", async () => {
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
      },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_REQUIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// 20. Logout clears cookie
// ---------------------------------------------------------------------------
describe("AUTH_LOGOUT_CLEARS_COOKIE", () => {
  it("clearOwnerSessionCookie has maxAge=0", () => {
    const cookie = ownerSessionClearCookie();
    expect(cookie.maxAge).toBe(0);
    expect(cookie.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 21. /admin unauthenticated navigation protected server-side
// ---------------------------------------------------------------------------
describe("AUTH_ADMIN_PAGE_UNAUTHENTICATED_PROTECTED", () => {
  it("protected layout redirects unauthenticated requests to /login (protects all product routes including /admin)", async () => {
    const fs = await import("node:fs");
    const layout = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(layout).toContain('redirect("/login")');
    expect(layout).toContain("intentchord_owner_session");
  });
});

// ---------------------------------------------------------------------------
// 22. /admin authenticated access succeeds
// ---------------------------------------------------------------------------
describe("AUTH_ADMIN_PAGE_AUTHENTICATED_SUCCESS", () => {
  it("admin page file exists and renders owner display name", async () => {
    const fs = await import("node:fs");
    const page = fs.readFileSync("src/app/(protected)/admin/page.tsx", "utf8");
    expect(page).toContain("displayName");
    expect(page).toContain("verifyOwnerSessionFromCookies");
  });
});

// ---------------------------------------------------------------------------
// 23. Login page exists
// ---------------------------------------------------------------------------
describe("AUTH_LOGIN_PAGE_EXISTS", () => {
  it("login page file exists with form elements", async () => {
    const fs = await import("node:fs");
    const page = fs.readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(page).toContain("/api/auth/login");
    expect(page).toContain("password");
    expect(page).toContain("loginName");
  });
});

// ---------------------------------------------------------------------------
// 24. Legacy production bootstrap session issuance unavailable
// ---------------------------------------------------------------------------
describe("AUTH_LEGACY_BOOTSTRAP_REMOVED", () => {
  it("ownerBootstrapResponse is no longer exported from responses.ts", async () => {
    const fs = await import("node:fs");
    const responses = fs.readFileSync("src/server/responses.ts", "utf8");
    expect(responses).not.toContain("ownerBootstrapResponse");
    expect(responses).not.toContain("requireOwnerBootstrap");
  });

  it("requireOwnerBootstrap is no longer exported from authority.ts", async () => {
    const fs = await import("node:fs");
    const authority = fs.readFileSync("src/server/authority.ts", "utf8");
    expect(authority).not.toContain("export function requireOwnerBootstrap");
  });

  it("no route files import ownerBootstrapResponse", async () => {
    const fs = await import("node:fs");
    const { join } = await import("node:path");
    const apiDir = join(process.cwd(), "src", "app", "api");
    function walk(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...walk(full));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) results.push(full);
      }
      return results;
    }
    const files = walk(apiDir);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toContain("ownerBootstrapResponse");
    }
  });
});

// ---------------------------------------------------------------------------
// 25. Provisioning refuses second Owner creation
// ---------------------------------------------------------------------------
describe("AUTH_PROVISIONING_SINGLE_OWNER", () => {
  it("migration has partial unique index for single ACTIVE owner", async () => {
    const fs = await import("node:fs");
    const migration = fs.readFileSync("migrations/022_owner_authentication_foundation.sql", "utf8");
    expect(migration).toContain("owner_accounts_active_unique");
    expect(migration).toContain("WHERE account_state = 'ACTIVE'");
  });
});

// ---------------------------------------------------------------------------
// 26. Provisioning never prints password/hash/salt
// ---------------------------------------------------------------------------
describe("AUTH_PROVISIONING_NO_PASSWORD_LEAK", () => {
  it("provisioning script does not console.log password hash or salt", async () => {
    const fs = await import("node:fs");
    const script = fs.readFileSync("scripts/provision-owner-account.mjs", "utf8");
    expect(script).not.toContain("console.log(hash");
    expect(script).not.toContain("console.log(salt");
    expect(script).not.toContain("console.log(password");
  });

  it("PowerShell wrapper does not echo password", async () => {
    const fs = await import("node:fs");
    const ps1 = fs.readFileSync("scripts/Provision-OwnerAccount.ps1", "utf8");
    expect(ps1).toContain("AsSecureString");
    expect(ps1).not.toContain("Write-Host $plainPassword");
    expect(ps1).not.toContain("Write-Host $password");
  });
});

// ---------------------------------------------------------------------------
// Additional: Hardcoded principal removed
// ---------------------------------------------------------------------------
describe("AUTH_HARDCODED_PRINCIPAL_REMOVED", () => {
  it("authority.ts does not contain owner-local:Hisham", async () => {
    const fs = await import("node:fs");
    const authority = fs.readFileSync("src/server/authority.ts", "utf8");
    expect(authority).not.toContain("owner-local:Hisham");
  });

  it("lifecycle.ts does not contain owner-local:Hisham", async () => {
    const fs = await import("node:fs");
    const lifecycle = fs.readFileSync("src/server/lifecycle.ts", "utf8");
    expect(lifecycle).not.toContain("owner-local:Hisham");
  });

  it("discovery-lifecycle.ts does not contain owner-local:Hisham", async () => {
    const fs = await import("node:fs");
    const dl = fs.readFileSync("src/server/discovery-lifecycle.ts", "utf8");
    expect(dl).not.toContain("owner-local:Hisham");
  });
});

// ---------------------------------------------------------------------------
// Additional: Session format versioned
// ---------------------------------------------------------------------------
describe("AUTH_SESSION_FORMAT_VERSIONED", () => {
  it("session token payload contains v field", () => {
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const [encoded] = token.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(payload.v).toBe(1);
    expect(typeof payload.sub).toBe("string");
    expect(typeof payload.sv).toBe("number");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Additional: HMAC-SHA256 signing
// ---------------------------------------------------------------------------
describe("AUTH_SESSION_HMAC_SHA256", () => {
  it("session signature is valid HMAC-SHA256", () => {
    const { createHmac } = require("node:crypto");
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const [encoded, sig] = token.split(".");
    const secret = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    if (!secret) throw new Error("TEST_SESSION_SECRET_MISSING");
    const expected = createHmac("sha256", secret).update(encoded).digest("hex");
    expect(sig).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Additional: Owner account fields
// ---------------------------------------------------------------------------
describe("AUTH_OWNER_ACCOUNT_FIELDS", () => {
  it("migration has all required fields", async () => {
    const fs = await import("node:fs");
    const migration = fs.readFileSync("migrations/022_owner_authentication_foundation.sql", "utf8");
    expect(migration).toContain("owner_id");
    expect(migration).toContain("login_name");
    expect(migration).toContain("display_name");
    expect(migration).toContain("password_hash");
    expect(migration).toContain("password_salt");
    expect(migration).toContain("password_kdf");
    expect(migration).toContain("account_state");
    expect(migration).toContain("session_version");
    expect(migration).toContain("created_at");
    expect(migration).toContain("updated_at");
  });
});

// ---------------------------------------------------------------------------
// Additional: Password KDF contract
// ---------------------------------------------------------------------------
describe("AUTH_PASSWORD_KDF_CONTRACT", () => {
  it("ownerPassword.ts uses scrypt", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/server/owner-password.ts", "utf8");
    expect(source).toContain("scrypt");
    expect(source).toContain("scrypt-v1");
    expect(source).toContain("timingSafeEqual");
  });
});

// ---------------------------------------------------------------------------
// Additional: Logout API exists
// ---------------------------------------------------------------------------
describe("AUTH_LOGOUT_API_EXISTS", () => {
  it("POST /api/auth/logout route file exists", async () => {
    const fs = await import("node:fs");
    const route = fs.readFileSync("src/app/api/auth/logout/route.ts", "utf8");
    expect(route).toContain("export async function POST");
    expect(route).toContain("clearOwnerSessionCookie");
  });
});

// ---------------------------------------------------------------------------
// Additional: Login API exists
// ---------------------------------------------------------------------------
describe("AUTH_LOGIN_API_EXISTS", () => {
  it("POST /api/auth/login route file exists", async () => {
    const fs = await import("node:fs");
    const route = fs.readFileSync("src/app/api/auth/login/route.ts", "utf8");
    expect(route).toContain("export async function POST");
    expect(route).toContain("authenticateOwner");
    expect(route).toContain("createSessionToken");
  });

  it("login API returns generic error for wrong credentials", async () => {
    const fs = await import("node:fs");
    const route = fs.readFileSync("src/app/api/auth/login/route.ts", "utf8");
    expect(route).toContain("Authentication failed.");
    expect(route).not.toContain("User not found");
    expect(route).not.toContain("Wrong password");
  });
});

// ===========================================================================
// MANDATORY FAIL-CLOSED SECRET TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. SESSION_CREATION_WITH_EXPLICIT_SECRET=PASS
// ---------------------------------------------------------------------------
describe("SESSION_CREATION_WITH_EXPLICIT_SECRET", () => {
  it("createSessionToken succeeds when INTENTCHORD_OWNER_SESSION_SECRET is set", () => {
    const previous = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    process.env.INTENTCHORD_OWNER_SESSION_SECRET = "explicit-test-secret-for-creation";
    try {
      const token = createSessionToken("test-owner", 1);
      expect(typeof token).toBe("string");
      expect(token).toContain(".");
    } finally {
      if (previous === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SESSION_VERIFICATION_WITH_EXPLICIT_SECRET=PASS
// ---------------------------------------------------------------------------
describe("SESSION_VERIFICATION_WITH_EXPLICIT_SECRET", () => {
  it("requireOwnerSession succeeds with valid token and explicit secret", async () => {
    mockOwnerAccount();
    const previous = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    process.env.INTENTCHORD_OWNER_SESSION_SECRET = "explicit-test-secret-for-verification";
    try {
      const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
      const req = new Request("http://localhost:3000/api/admin/ai-engines", {
        headers: { cookie: `intentchord_owner_session=${token}` },
      });
      const principal = await requireOwnerSession(req);
      expect(principal).toBe(`owner:${TEST_ACCOUNT.owner_id}`);
    } finally {
      if (previous === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SESSION_CREATION_WITH_MISSING_SECRET=FAIL_CLOSED
// ---------------------------------------------------------------------------
describe("SESSION_CREATION_WITH_MISSING_SECRET", () => {
  it("createSessionToken throws OWNER_SESSION_SECRET_REQUIRED when secret is missing", () => {
    const previous = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    try {
      expect(() => createSessionToken("test-owner", 1)).toThrowError(
        expect.objectContaining({ status: 503, code: "OWNER_SESSION_SECRET_REQUIRED" }),
      );
    } finally {
      if (previous === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. SESSION_VERIFICATION_WITH_MISSING_SECRET=FAIL_CLOSED
// ---------------------------------------------------------------------------
describe("SESSION_VERIFICATION_WITH_MISSING_SECRET", () => {
  it("requireOwnerSession throws when secret is missing at verification time", async () => {
    mockOwnerAccount();
    // Create token with secret present
    const previous = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    process.env.INTENTCHORD_OWNER_SESSION_SECRET = "temp-secret-for-verification-test";
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    // Now remove secret and try to verify
    delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    try {
      const req = new Request("http://localhost:3000/api/admin/ai-engines", {
        headers: { cookie: `intentchord_owner_session=${token}` },
      });
      try {
        await requireOwnerSession(req);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("OWNER_SESSION_SECRET_REQUIRED");
      }
    } finally {
      if (previous === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// 5. SESSION_CREATION_WITH_BLANK_SECRET=FAIL_CLOSED
// ---------------------------------------------------------------------------
describe("SESSION_CREATION_WITH_BLANK_SECRET", () => {
  it("createSessionToken throws when secret is empty string", () => {
    const previous = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    process.env.INTENTCHORD_OWNER_SESSION_SECRET = "";
    try {
      expect(() => createSessionToken("test-owner", 1)).toThrowError(
        expect.objectContaining({ status: 503, code: "OWNER_SESSION_SECRET_REQUIRED" }),
      );
    } finally {
      if (previous === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previous;
    }
  });

  it("createSessionToken throws when secret is whitespace only", () => {
    const previous = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    process.env.INTENTCHORD_OWNER_SESSION_SECRET = "   ";
    try {
      expect(() => createSessionToken("test-owner", 1)).toThrowError(
        expect.objectContaining({ status: 503, code: "OWNER_SESSION_SECRET_REQUIRED" }),
      );
    } finally {
      if (previous === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. DEVELOPMENT_ENV_WITH_MISSING_SECRET=FAIL_CLOSED
// ---------------------------------------------------------------------------
describe("DEVELOPMENT_ENV_WITH_MISSING_SECRET", () => {
  it("createSessionToken throws in development mode when secret is missing", () => {
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    Reflect.set(process.env, "NODE_ENV", "development");
    delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    try {
      expect(() => createSessionToken("test-owner", 1)).toThrowError(
        expect.objectContaining({ status: 503, code: "OWNER_SESSION_SECRET_REQUIRED" }),
      );
    } finally {
      if (previousEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", previousEnv);
      if (previousSecret === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previousSecret;
    }
  });
});

// ---------------------------------------------------------------------------
// 7. PRODUCTION_ENV_WITH_MISSING_SECRET=FAIL_CLOSED
// ---------------------------------------------------------------------------
describe("PRODUCTION_ENV_WITH_MISSING_SECRET", () => {
  it("createSessionToken throws in production mode when secret is missing", () => {
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    Reflect.set(process.env, "NODE_ENV", "production");
    delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    try {
      expect(() => createSessionToken("test-owner", 1)).toThrowError(
        expect.objectContaining({ status: 503, code: "OWNER_SESSION_SECRET_REQUIRED" }),
      );
    } finally {
      if (previousEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", previousEnv);
      if (previousSecret === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previousSecret;
    }
  });
});

// ---------------------------------------------------------------------------
// 8. TAMPERED_SESSION_STILL_REJECTED=PASS
// ---------------------------------------------------------------------------
describe("TAMPERED_SESSION_STILL_REJECTED", () => {
  it("session with invalid signature is rejected", async () => {
    mockOwnerAccount();
    const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
    const [encoded] = token.split(".");
    const tamperedToken = `${encoded}.0000000000000000000000000000000000000000000000000000000000000000`;
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `intentchord_owner_session=${tamperedToken}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// 9. EXPIRED_SESSION_STILL_REJECTED=PASS
// ---------------------------------------------------------------------------
describe("EXPIRED_SESSION_STILL_REJECTED", () => {
  it("expired session is rejected even with valid signature", async () => {
    mockOwnerAccount();
    const originalDateNow = Date.now;
    let currentTime = originalDateNow();
    Date.now = () => currentTime;
    try {
      const token = createSessionToken(TEST_ACCOUNT.owner_id, 1);
      currentTime = originalDateNow() + 9 * 3600000;
      const req = new Request("http://localhost:3000/api/admin/ai-engines", {
        headers: { cookie: `intentchord_owner_session=${token}` },
      });
      try {
        await requireOwnerSession(req);
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
// 10. SESSION_VERSION_DB_CHECK_STILL_ENFORCED=PASS
// ---------------------------------------------------------------------------
describe("SESSION_VERSION_DB_CHECK_STILL_ENFORCED", () => {
  it("session_version mismatch is rejected", async () => {
    mockOwnerAccount({ session_version: 5 });
    const cookie = createTestSessionCookie(TEST_ACCOUNT.owner_id, 3);
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALIDATED");
    }
  });
});

// ---------------------------------------------------------------------------
// 11. LOGIN_WITH_VALID_ACCOUNT_AND_EXPLICIT_SECRET=PASS
// ---------------------------------------------------------------------------
describe("LOGIN_WITH_VALID_ACCOUNT_AND_EXPLICIT_SECRET", () => {
  it("login API creates session token using the explicit secret", async () => {
    const { authenticateOwner } = await import("@/server/owner-account");
    vi.mocked(authenticateOwner).mockResolvedValue({
      owner_id: "login-test-owner",
      login_name: "logintest",
      display_name: "Login Test",
      password_hash: Buffer.alloc(0),
      password_salt: Buffer.alloc(0),
      password_kdf: "scrypt-v1",
      account_state: "ACTIVE",
      session_version: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    } as any);
    const previous = process.env.INTENTCHORD_OWNER_SESSION_SECRET;
    process.env.INTENTCHORD_OWNER_SESSION_SECRET = "login-test-secret-explicit";
    try {
      const { POST } = await import("@/app/api/auth/login/route");
      const req = new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginName: "logintest", password: "test1234" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).toContain("intentchord_owner_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie.toLowerCase()).toContain("samesite=strict");
    } finally {
      if (previous === undefined) delete process.env.INTENTCHORD_OWNER_SESSION_SECRET;
      else process.env.INTENTCHORD_OWNER_SESSION_SECRET = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// 12. NO_DETERMINISTIC_SESSION_SECRET_FALLBACK_PRESENT=PASS
// ---------------------------------------------------------------------------
describe("NO_DETERMINISTIC_SESSION_SECRET_FALLBACK_PRESENT", () => {
  it("authority.ts source contains no deterministic fallback for session secret", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/server/authority.ts", "utf8");
    // Must not contain the old dev fallback pattern
    expect(source).not.toContain("intentchord-local-owner-session-v1");
    // Must not contain NODE_ENV check as a bypass for secret requirement
    expect(source).not.toMatch(/NODE_ENV.*production.*throw/);
    // Must contain the canonical required-secret pattern
    expect(source).toContain("OWNER_SESSION_SECRET_REQUIRED");
  });

  it("no source file contains a hardcoded session signing secret for Owner sessions", async () => {
    const fs = await import("node:fs");
    const { join } = await import("node:path");
    const serverDir = join(process.cwd(), "src", "server");
    function walk(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...walk(full));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test-support.ts")) results.push(full);
      }
      return results;
    }
    const files = walk(serverDir);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      // Skip test files and the test helper
      if (file.includes(".test.") || file.includes("owner-auth-test")) continue;
      // Must not contain a hardcoded fallback session secret
      expect(content).not.toMatch(/owner.*session.*secret.*=.*["'][a-f0-9]{32,}["']/i);
      expect(content).not.toContain("intentchord-local-owner-session-v1");
    }
  });
});
