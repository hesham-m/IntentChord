import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
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

function mockOwnerAccount() {
  vi.mocked(findOwnerById).mockResolvedValue({ ...TEST_ACCOUNT } as any);
}

// ===========================================================================
// ROUTE GROUP ARCHITECTURE
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. UNAUTHENTICATED_ROOT = REDIRECT_LOGIN (via protected layout)
// ---------------------------------------------------------------------------
describe("UNAUTHENTICATED_ROOT_REDIRECT_LOGIN", () => {
  it("protected layout checks session cookie and redirects to /login", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain("intentchord_owner_session");
    expect(source).toContain('redirect("/login")');
  });

  it("root layout has no auth logic", () => {
    const source = fs.readFileSync("src/app/layout.tsx", "utf8");
    expect(source).not.toContain("isProtectedRoute");
    expect(source).not.toContain("verifyOwnerSessionFromCookies");
    expect(source).not.toContain("intentchord_owner_session");
  });
});

// ---------------------------------------------------------------------------
// 2. UNAUTHENTICATED_PRODUCT_ROUTE = REDIRECT_LOGIN
// ---------------------------------------------------------------------------
describe("UNAUTHENTICATED_PRODUCT_ROUTE_REDIRECT_LOGIN", () => {
  it("protected layout is the single auth boundary for all product routes", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
    expect(source).toContain('redirect("/login")');
  });
});

// ---------------------------------------------------------------------------
// 3. UNAUTHENTICATED_ADMIN = REDIRECT_LOGIN
// ---------------------------------------------------------------------------
describe("UNAUTHENTICATED_ADMIN_REDIRECT_LOGIN", () => {
  it("admin page has no independent layout auth check (protected layout handles it)", () => {
    expect(fs.existsSync("src/app/(protected)/admin/layout.tsx")).toBe(false);
  });

  it("admin page renders AdminShell component", () => {
    const source = fs.readFileSync("src/app/(protected)/admin/page.tsx", "utf8");
    expect(source).toContain("AdminShell");
  });
});

// ---------------------------------------------------------------------------
// 4. LOGIN_PAGE_WITHOUT_SESSION = ACCESSIBLE
// ---------------------------------------------------------------------------
describe("LOGIN_PAGE_WITHOUT_SESSION_ACCESSIBLE", () => {
  it("login page is a client component with a form", () => {
    const source = fs.readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(source).toContain('"use client"');
    expect(source).toContain("<form");
  });

  it("login page validates session via API before redirecting", () => {
    const source = fs.readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(source).toContain("/api/auth/session");
  });
});

// ---------------------------------------------------------------------------
// 5. LOGIN_PAGE_WITH_VALID_SESSION_REDIRECT_ROOT
// ---------------------------------------------------------------------------
describe("LOGIN_PAGE_WITH_VALID_SESSION_REDIRECT_ROOT", () => {
  it("login page calls session-check API and redirects to / when session is valid", () => {
    const source = fs.readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(source).toContain("/api/auth/session");
    expect(source).toContain('router.replace("/")');
  });
});

// ---------------------------------------------------------------------------
// 6. SUCCESSFUL_LOGIN_REDIRECT = ROOT
// ---------------------------------------------------------------------------
describe("SUCCESSFUL_LOGIN_REDIRECT_ROOT", () => {
  it("login form redirects to / after successful authentication", () => {
    const source = fs.readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(source).toContain('router.push("/")');
    expect(source).not.toContain('router.push("/admin")');
  });
});

// ---------------------------------------------------------------------------
// 7. AUTHENTICATED_ROOT = ACCESSIBLE
// ---------------------------------------------------------------------------
describe("AUTHENTICATED_ROOT_ACCESSIBLE", () => {
  it("root page renders WorkflowApp with home stage", () => {
    const source = fs.readFileSync("src/app/(protected)/page.tsx", "utf8");
    expect(source).toContain("WorkflowApp");
    expect(source).toContain('stage="home"');
  });
});

// ---------------------------------------------------------------------------
// 8. AUTHENTICATED_EXISTING_PRODUCT_ROUTE = ACCESSIBLE
// ---------------------------------------------------------------------------
describe("AUTHENTICATED_EXISTING_PRODUCT_ROUTE_ACCESSIBLE", () => {
  const routes = [
    { path: "src/app/(protected)/tasks/page.tsx", stage: "tasks" },
    { path: "src/app/(protected)/tasks/new/page.tsx", mode: "NEW" },
    { path: "src/app/(protected)/tasks/current/page.tsx", mode: "CURRENT" },
    { path: "src/app/(protected)/contracts/current/page.tsx", stage: "contract" },
    { path: "src/app/(protected)/runs/page.tsx", stage: "runs" },
    { path: "src/app/(protected)/runs/current/review/page.tsx", stage: "review" },
    { path: "src/app/(protected)/runs/current/execute/page.tsx", stage: "execute" },
    { path: "src/app/(protected)/bridge/page.tsx", stage: "bridge" },
  ];

  for (const route of routes) {
    it(`${route.path} renders expected component`, () => {
      const source = fs.readFileSync(route.path, "utf8");
      if (route.stage) {
        expect(source).toContain(`stage="${route.stage}"`);
      }
      if (route.mode) {
        expect(source).toContain(`mode="${route.mode}"`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 9. AUTHENTICATED_ADMIN = ACCESSIBLE
// ---------------------------------------------------------------------------
describe("AUTHENTICATED_ADMIN_ACCESSIBLE", () => {
  it("admin page uses canonical session verifier (not fake Request)", () => {
    const source = fs.readFileSync("src/app/(protected)/admin/page.tsx", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
    expect(source).not.toContain("requireOwnerSessionAccount");
  });

  it("admin page renders AdminShell with display name", () => {
    const source = fs.readFileSync("src/app/(protected)/admin/page.tsx", "utf8");
    expect(source).toContain("AdminShell");
    expect(source).toContain("displayName");
  });
});

// ---------------------------------------------------------------------------
// 10. ADMIN_USES_SHARED_PRODUCT_SHELL = YES
// ---------------------------------------------------------------------------
describe("ADMIN_USES_SHARED_PRODUCT_SHELL", () => {
  it("AdminShell imports and renders ProductShell", () => {
    const source = fs.readFileSync("src/app/(protected)/admin/admin-shell.tsx", "utf8");
    expect(source).toContain("ProductShell");
    expect(source).toContain('import { ProductShell }');
  });

  it("AdminShell passes stage prop to ProductShell", () => {
    const source = fs.readFileSync("src/app/(protected)/admin/admin-shell.tsx", "utf8");
    expect(source).toContain("stage=");
  });
});

// ---------------------------------------------------------------------------
// 11. ADMIN_NAV_ENTRY_PRESENT = YES
// ---------------------------------------------------------------------------
describe("ADMIN_NAV_ENTRY_PRESENT", () => {
  it("ProductShell topbar contains Admin navigation link", () => {
    const source = fs.readFileSync("src/components/product-shell.tsx", "utf8");
    expect(source).toContain('href="/admin"');
  });
});

// ---------------------------------------------------------------------------
// 12. STALE_LOCAL_SESSION_BOOTSTRAP_UI = ABSENT
// ---------------------------------------------------------------------------
describe("STALE_LOCAL_SESSION_BOOTSTRAP_UI_ABSENT", () => {
  it("owner-errors.ts has no stale 'local Owner session' messages", () => {
    const source = fs.readFileSync("src/lib/owner-errors.ts", "utf8");
    expect(source).not.toContain("local Owner session is not ready");
    expect(source).not.toContain("Reload the page once");
    expect(source).not.toContain("establish the local Owner session");
  });

  it("workflow-app.tsx has no stale local session picker messages", () => {
    const source = fs.readFileSync("src/components/workflow-app.tsx", "utf8");
    expect(source).not.toContain("The local Owner session is unavailable");
    expect(source).not.toContain("The local Owner session could not be renewed");
  });

  it("ownerFetch in workflow-app.tsx redirects to /login instead of bootstrap retry", () => {
    const source = fs.readFileSync("src/components/workflow-app.tsx", "utf8");
    expect(source).toContain('window.location.href = "/login"');
    expect(source).not.toContain("bootstrap = await fetch");
  });

  it("ownerFetch in unified-task-workbench.tsx redirects to /login instead of bootstrap retry", () => {
    const source = fs.readFileSync("src/components/unified-task-workbench.tsx", "utf8");
    expect(source).toContain('window.location.href = "/login"');
    const ownerFetchMatch = source.match(/async function ownerFetch[\s\S]*?^}/m);
    expect(ownerFetchMatch).toBeTruthy();
    expect(ownerFetchMatch![0]).not.toContain("bootstrap");
  });

  it("ownerFetch in project-context-workbench.tsx redirects to /login instead of bootstrap retry", () => {
    const source = fs.readFileSync("src/components/project-context-workbench.tsx", "utf8");
    expect(source).toContain('window.location.href = "/login"');
    expect(source).not.toContain("bootstrap = await fetch");
  });

  it("ownerFetch in workspace-analysis-workbench.tsx redirects to /login instead of bootstrap retry", () => {
    const source = fs.readFileSync("src/components/workspace-analysis-workbench.tsx", "utf8");
    expect(source).toContain('window.location.href = "/login"');
    expect(source).not.toContain("bootstrap = await fetch");
  });
});

// ---------------------------------------------------------------------------
// 13. SIGNOUT_REDIRECT = LOGIN
// ---------------------------------------------------------------------------
describe("SIGNOUT_REDIRECT_LOGIN", () => {
  it("AdminShell sign-out redirects to /login", () => {
    const source = fs.readFileSync("src/app/(protected)/admin/admin-shell.tsx", "utf8");
    expect(source).toContain('router.push("/login")');
  });

  it("AdminShell calls /api/auth/logout on sign-out", () => {
    const source = fs.readFileSync("src/app/(protected)/admin/admin-shell.tsx", "utf8");
    expect(source).toContain("/api/auth/logout");
  });
});

// ---------------------------------------------------------------------------
// 14. POST_SIGNOUT_ROOT_ACCESS = REDIRECT_LOGIN (via protected layout)
// ---------------------------------------------------------------------------
describe("POST_SIGNOUT_ROOT_ACCESS_REDIRECT_LOGIN", () => {
  it("protected layout redirects unauthenticated requests to /login", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain('redirect("/login")');
  });
});

// ---------------------------------------------------------------------------
// 15. POST_SIGNOUT_ADMIN_ACCESS = REDIRECT_LOGIN (via protected layout)
// ---------------------------------------------------------------------------
describe("POST_SIGNOUT_ADMIN_ACCESS_REDIRECT_LOGIN", () => {
  it("admin page is inside protected group (layout handles auth)", () => {
    expect(fs.existsSync("src/app/(protected)/admin/page.tsx")).toBe(true);
  });

  it("protected layout redirects on missing session", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain('redirect("/login")');
  });
});

// ---------------------------------------------------------------------------
// 16. EXISTING_ADMIN_API_AUTHORITY = PRESERVED
// ---------------------------------------------------------------------------
describe("EXISTING_ADMIN_API_AUTHORITY_PRESERVED", () => {
  it("admin ai-engines API uses ownerReadResponse", () => {
    const source = fs.readFileSync("src/app/api/admin/ai-engines/route.ts", "utf8");
    expect(source).toContain("ownerReadResponse");
  });

  it("admin ai-engines API uses ownerCommandResponse", () => {
    const source = fs.readFileSync("src/app/api/admin/ai-engines/route.ts", "utf8");
    expect(source).toContain("ownerCommandResponse");
  });
});

// ---------------------------------------------------------------------------
// 17. CLIENT_SELF_ASSERTED_OWNER_AUTHORITY = REJECTED
// ---------------------------------------------------------------------------
describe("CLIENT_SELF_ASSERTED_OWNER_AUTHORITY_REJECTED", () => {
  it("requireOwnerSession validates HMAC signature, not self-asserted identity", async () => {
    const { requireOwnerSession } = await import("@/server/authority");
    mockOwnerAccount();
    const cookie = createTestSessionCookie(TEST_ACCOUNT.owner_id, 1);
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    const principal = await requireOwnerSession(req);
    expect(principal).toBe(`owner:${TEST_ACCOUNT.owner_id}`);
  });

  it("requireOwnerSession rejects requests without valid cookie", async () => {
    const { requireOwnerSession } = await import("@/server/authority");
    mockOwnerAccount();
    const req = new Request("http://localhost:3000/api/admin/ai-engines");
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_REQUIRED");
    }
  });

  it("requireOwnerSession rejects forged session tokens", async () => {
    const { requireOwnerSession } = await import("@/server/authority");
    mockOwnerAccount();
    const forgedToken = "eyJ2IjoxLCJzdWIiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEifQ.fakesignature";
    const req = new Request("http://localhost:3000/api/admin/ai-engines", {
      headers: { cookie: `intentchord_owner_session=${forgedToken}` },
    });
    try {
      await requireOwnerSession(req);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe("OWNER_SESSION_INVALID");
    }
  });
});

// ===========================================================================
// ROUTE GROUP VERIFICATION
// ===========================================================================
describe("ROUTE_GROUP_VERIFICATION", () => {
  it("login is in (auth) group, not (protected)", () => {
    expect(fs.existsSync("src/app/(auth)/login/page.tsx")).toBe(true);
    expect(fs.existsSync("src/app/(protected)/login/page.tsx")).toBe(false);
  });

  it("root layout is global (no auth logic)", () => {
    const source = fs.readFileSync("src/app/layout.tsx", "utf8");
    expect(source).not.toContain("verifyOwnerSessionFromCookies");
    expect(source).not.toContain('redirect("/login")');
  });

  it("protected layout handles all product route auth", () => {
    const source = fs.readFileSync("src/app/(protected)/layout.tsx", "utf8");
    expect(source).toContain("verifyOwnerSessionFromCookies");
    expect(source).toContain('redirect("/login")');
  });
});
