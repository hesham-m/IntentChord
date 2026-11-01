import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/server/authority";
import { ensureTestSessionSecret } from "@/server/owner-auth-test";

ensureTestSessionSecret();

describe("local owner-session authority", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("creates a valid session token with correct format", async () => {
    const { createSessionToken } = await import("@/server/authority");
    const token = createSessionToken("test-owner-id", 1);
    expect(token).toContain(".");
    const parts = token.split(".");
    expect(parts.length).toBe(2);
  });

  it("treats localhost and 127.0.0.1 as the same local Owner origin on the same port", async () => {
    const authority = await import("@/server/authority");
    expect(() => authority.requireSameOriginRequest(new Request("http://localhost:3000/api/workspaces/select", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
      },
    }))).not.toThrow();
  });

  it("still rejects a different local port", async () => {
    const authority = await import("@/server/authority");
    expect(() => authority.requireSameOriginRequest(new Request("http://localhost:3000/api/workspaces/select", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3001",
        "sec-fetch-site": "same-origin",
      },
    }))).toThrow();
  });
});
