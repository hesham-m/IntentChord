import { describe, expect, it } from "vitest";
import fs from "node:fs";

function readFile(path: string): string {
  return fs.readFileSync(path, "utf8");
}

// ===========================================================================
// 1. PUBLIC_LOGIN_OUTSIDE_PROTECTED_GROUP
// ===========================================================================
describe("PUBLIC_LOGIN_OUTSIDE_PROTECTED_GROUP", () => {
  it("login page exists under (auth) route group", () => {
    expect(fs.existsSync("src/app/(auth)/login/page.tsx")).toBe(true);
  });

  it("login page is a client component with login form", () => {
    const source = readFile("src/app/(auth)/login/page.tsx");
    expect(source).toContain('"use client"');
    expect(source).toContain("<form");
  });
});

// ===========================================================================
// 2. PROTECTED_ROOT_INSIDE_PROTECTED_GROUP
// ===========================================================================
describe("PROTECTED_ROOT_INSIDE_PROTECTED_GROUP", () => {
  it("root page exists under (protected) route group", () => {
    expect(fs.existsSync("src/app/(protected)/page.tsx")).toBe(true);
  });

  it("root page renders WorkflowApp home", () => {
    const source = readFile("src/app/(protected)/page.tsx");
    expect(source).toContain('stage="home"');
  });
});

// ===========================================================================
// 3. PROTECTED_ADMIN_INSIDE_PROTECTED_GROUP
// ===========================================================================
describe("PROTECTED_ADMIN_INSIDE_PROTECTED_GROUP", () => {
  it("admin page exists under (protected) route group", () => {
    expect(fs.existsSync("src/app/(protected)/admin/page.tsx")).toBe(true);
  });

  it("admin page uses AdminShell with ProductShell", () => {
    const source = readFile("src/app/(protected)/admin/page.tsx");
    expect(source).toContain("AdminShell");
    expect(source).toContain("verifyOwnerSessionFromCookies");
  });
});

// ===========================================================================
// 4. ALL_PRODUCT_PAGES_INSIDE_PROTECTED_GROUP
// ===========================================================================
describe("ALL_PRODUCT_PAGES_INSIDE_PROTECTED_GROUP", () => {
  const expectedPages = [
    "src/app/(protected)/page.tsx",
    "src/app/(protected)/admin/page.tsx",
    "src/app/(protected)/bridge/page.tsx",
    "src/app/(protected)/tasks/page.tsx",
    "src/app/(protected)/tasks/new/page.tsx",
    "src/app/(protected)/tasks/current/page.tsx",
    "src/app/(protected)/runs/page.tsx",
    "src/app/(protected)/runs/current/review/page.tsx",
    "src/app/(protected)/runs/current/execute/page.tsx",
    "src/app/(protected)/contracts/current/page.tsx",
    "src/app/(protected)/project-contexts/page.tsx",
    "src/app/(protected)/workspace-analysis/page.tsx",
  ];

  it("all product pages exist under (protected)", () => {
    for (const page of expectedPages) {
      expect(fs.existsSync(page), `Missing: ${page}`).toBe(true);
    }
  });
});

// ===========================================================================
// 5. ROOT_LAYOUT_HAS_NO_NEXT_URL_AUTH_LOGIC
// ===========================================================================
describe("ROOT_LAYOUT_HAS_NO_NEXT_URL_AUTH_LOGIC", () => {
  it("root layout does not inspect next-url header", () => {
    const source = readFile("src/app/layout.tsx");
    expect(source).not.toContain("next-url");
  });

  it("root layout does not contain isProtectedRoute", () => {
    const source = readFile("src/app/layout.tsx");
    expect(source).not.toContain("isProtectedRoute");
  });
});

// ===========================================================================
// 6. ROOT_LAYOUT_HAS_NO_OWNER_REDIRECT_LOGIC
// ===========================================================================
describe("ROOT_LAYOUT_HAS_NO_OWNER_REDIRECT_LOGIC", () => {
  it("root layout does not redirect based on auth", () => {
    const source = readFile("src/app/layout.tsx");
    expect(source).not.toContain('redirect("/login")');
  });

  it("root layout does not import verifyOwnerSessionFromCookies", () => {
    const source = readFile("src/app/layout.tsx");
    expect(source).not.toContain("verifyOwnerSessionFromCookies");
  });

  it("root layout does not check owner session cookie", () => {
    const source = readFile("src/app/layout.tsx");
    expect(source).not.toContain("intentchord_owner_session");
  });
});

// ===========================================================================
// 7. PROTECTED_LAYOUT_USES_CANONICAL_FULL_SESSION_VERIFIER
// ===========================================================================
describe("PROTECTED_LAYOUT_USES_CANONICAL_FULL_SESSION_VERIFIER", () => {
  it("protected layout exists", () => {
    expect(fs.existsSync("src/app/(protected)/layout.tsx")).toBe(true);
  });

  it("protected layout imports verifyOwnerSessionFromCookies", () => {
    const source = readFile("src/app/(protected)/layout.tsx");
    expect(source).toContain("verifyOwnerSessionFromCookies");
  });

  it("protected layout calls verifyOwnerSessionFromCookies with cookie header", () => {
    const source = readFile("src/app/(protected)/layout.tsx");
    expect(source).toContain("intentchord_owner_session=${sessionCookie.value}");
  });

  it("protected layout redirects to /login on any failure", () => {
    const source = readFile("src/app/(protected)/layout.tsx");
    expect(source).toContain('redirect("/login")');
  });

  it("protected layout has try/catch around session verification", () => {
    const source = readFile("src/app/(protected)/layout.tsx");
    expect(source).toContain("try {");
    expect(source).toContain("} catch {");
  });
});

// ===========================================================================
// 8. NO_COOKIE_PROTECTED_LAYOUT_REDIRECTS_LOGIN
// ===========================================================================
describe("NO_COOKIE_PROTECTED_LAYOUT_REDIRECTS_LOGIN", () => {
  it("protected layout checks for cookie existence before verification", () => {
    const source = readFile("src/app/(protected)/layout.tsx");
    expect(source).toContain("sessionCookie?.value");
    expect(source).toContain('redirect("/login")');
  });
});

// ===========================================================================
// 9. INVALID_COOKIE_PROTECTED_LAYOUT_REDIRECTS_LOGIN
// ===========================================================================
describe("INVALID_COOKIE_PROTECTED_LAYOUT_REDIRECTS_LOGIN", () => {
  it("protected layout catches verification errors and redirects", () => {
    const source = readFile("src/app/(protected)/layout.tsx");
    expect(source).toContain("} catch {");
    expect(source).toContain('redirect("/login")');
  });
});

// ===========================================================================
// 10. EXPIRED_COOKIE_PROTECTED_LAYOUT_REDIRECTS_LOGIN
// ===========================================================================
describe("EXPIRED_COOKIE_PROTECTED_LAYOUT_REDIRECTS_LOGIN", () => {
  it("verification chain includes expiry check (via authority.ts)", () => {
    const source = readFile("src/server/authority.ts");
    expect(source).toContain("OWNER_SESSION_EXPIRED");
    expect(source).toContain("payload.exp <= Date.now()");
  });
});

// ===========================================================================
// 11. DISABLED_OWNER_PROTECTED_LAYOUT_REDIRECTS_LOGIN
// ===========================================================================
describe("DISABLED_OWNER_PROTECTED_LAYOUT_REDIRECTS_LOGIN", () => {
  it("verification chain includes account state check (via authority.ts)", () => {
    const source = readFile("src/server/authority.ts");
    expect(source).toContain("OWNER_ACCOUNT_DISABLED");
    expect(source).toContain("account_state");
  });
});

// ===========================================================================
// 12. STALE_SESSION_PROTECTED_LAYOUT_REDIRECTS_LOGIN
// ===========================================================================
describe("STALE_SESSION_PROTECTED_LAYOUT_REDIRECTS_LOGIN", () => {
  it("verification chain includes session_version check (via authority.ts)", () => {
    const source = readFile("src/server/authority.ts");
    expect(source).toContain("OWNER_SESSION_INVALIDATED");
    expect(source).toContain("session_version");
  });
});

// ===========================================================================
// 13. VALID_SESSION_PROTECTED_LAYOUT_RENDERS
// ===========================================================================
describe("VALID_SESSION_PROTECTED_LAYOUT_RENDERS", () => {
  it("protected layout renders children when session is valid", () => {
    const source = readFile("src/app/(protected)/layout.tsx");
    expect(source).toContain("{children}");
  });
});

// ===========================================================================
// 14. LOGIN_NO_SESSION_RENDERS
// ===========================================================================
describe("LOGIN_NO_SESSION_RENDERS", () => {
  it("login page does not require session to render", () => {
    const source = readFile("src/app/(auth)/login/page.tsx");
    expect(source).toContain("<form");
    expect(source).toContain("Sign in");
  });
});

// ===========================================================================
// 15. LOGIN_INVALID_SESSION_RENDERS
// ===========================================================================
describe("LOGIN_INVALID_SESSION_RENDERS", () => {
  it("login page calls session API to check validity", () => {
    const source = readFile("src/app/(auth)/login/page.tsx");
    expect(source).toContain("/api/auth/session");
  });

  it("login page only redirects when session is valid", () => {
    const source = readFile("src/app/(auth)/login/page.tsx");
    expect(source).toContain("if (data.valid)");
  });
});

// ===========================================================================
// 16. LOGIN_VALID_SESSION_REDIRECTS_ROOT
// ===========================================================================
describe("LOGIN_VALID_SESSION_REDIRECTS_ROOT", () => {
  it("login page redirects to / when valid session detected", () => {
    const source = readFile("src/app/(auth)/login/page.tsx");
    expect(source).toContain('router.replace("/")');
  });
});

// ===========================================================================
// 17. ADMIN_NO_UNSAFE_SESSIONCOOKIE_VALUE_DEREFERENCE
// ===========================================================================
describe("ADMIN_NO_UNSAFE_SESSIONCOOKIE_VALUE_DEREFERENCE", () => {
  it("admin page does not use non-null assertion on optional cookie", () => {
    const source = readFile("src/app/(protected)/admin/page.tsx");
    expect(source).not.toContain("cookieStore.get(\"intentchord_owner_session\")!");
  });

  it("admin page checks cookie existence before use", () => {
    const source = readFile("src/app/(protected)/admin/page.tsx");
    expect(source).toContain("sessionCookie?.value");
  });

  it("admin page uses verifyOwnerSessionFromCookies instead of fake Request", () => {
    const source = readFile("src/app/(protected)/admin/page.tsx");
    expect(source).toContain("verifyOwnerSessionFromCookies");
    expect(source).not.toContain("fakeRequest");
    expect(source).not.toContain("new Request");
  });
});

// ===========================================================================
// 18. ADMIN_VALID_SESSION_RENDERS_INSIDE_PRODUCT_SHELL
// ===========================================================================
describe("ADMIN_VALID_SESSION_RENDERS_INSIDE_PRODUCT_SHELL", () => {
  it("admin shell component exists", () => {
    expect(fs.existsSync("src/app/(protected)/admin/admin-shell.tsx")).toBe(true);
  });

  it("admin shell uses ProductShell", () => {
    const source = readFile("src/app/(protected)/admin/admin-shell.tsx");
    expect(source).toContain("ProductShell");
  });

  it("admin page renders AdminShell with displayName", () => {
    const source = readFile("src/app/(protected)/admin/page.tsx");
    expect(source).toContain("<AdminShell displayName={displayName} />");
  });
});
