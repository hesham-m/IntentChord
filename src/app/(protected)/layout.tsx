import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyOwnerSessionFromCookies } from "@/server/authority";

/**
 * Canonical protected-route layout.
 *
 * Performs full Owner session verification BEFORE rendering any child page.
 * This is the single authentication boundary for ALL product browser routes.
 *
 * Verification chain: cookie → HMAC → format version → expiry → PostgreSQL
 * owner lookup → ACTIVE state → session_version match.
 *
 * ANY failure redirects to /login. No cookie-presence shortcut. No next-url
 * header inspection. No per-page duplicated authentication.
 */
export default async function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("intentchord_owner_session");

  if (!sessionCookie?.value) {
    redirect("/login");
  }

  try {
    await verifyOwnerSessionFromCookies(`intentchord_owner_session=${sessionCookie.value}`);
  } catch {
    redirect("/login");
  }

  return <>{children}</>;
}
