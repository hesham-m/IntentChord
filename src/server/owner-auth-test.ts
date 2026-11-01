import { createSessionToken } from "@/server/authority";

const TEST_OWNER_ID = "00000000-0000-0000-0000-000000000001";
const TEST_SESSION_VERSION = 1;
const TEST_SESSION_SECRET = "test-intentchord-owner-session-secret-synthetic-only";

/**
 * Ensure the test session secret is set for the current process.
 * Must be called before any session creation/verification in tests.
 */
export function ensureTestSessionSecret(): void {
  if (!process.env.INTENTCHORD_OWNER_SESSION_SECRET) {
    process.env.INTENTCHORD_OWNER_SESSION_SECRET = TEST_SESSION_SECRET;
  }
}

/**
 * Create a valid session cookie for testing.
 * Uses a deterministic test Owner ID and session version.
 * Requires INTENTCHORD_OWNER_SESSION_SECRET to be set (call ensureTestSessionSecret first).
 */
export function createTestSessionCookie(ownerId = TEST_OWNER_ID, sessionVersion = TEST_SESSION_VERSION) {
  const token = createSessionToken(ownerId, sessionVersion);
  return {
    name: "intentchord_owner_session",
    value: token,
  };
}
