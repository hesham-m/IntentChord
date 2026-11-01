import { cookies } from "next/headers";
import { verifyOwnerSessionFromCookies } from "@/server/authority";
import AdminShell from "./admin-shell";

/**
 * AdminPage is rendered inside the (protected) layout, which has already
 * established valid Owner authority. This page only needs to retrieve the
 * verified account for display purposes.
 *
 * Uses the canonical verifyOwnerSessionFromCookies (same verifier as the
 * protected layout) rather than unsafe optional cookie dereferencing.
 */
export default async function AdminPage() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("intentchord_owner_session");

  if (!sessionCookie?.value) {
    // Protected layout should have already redirected, but fail-safe here.
    const { redirect: navRedirect } = await import("next/navigation");
    navRedirect("/login");
  }

  let displayName: string;
  try {
    const account = await verifyOwnerSessionFromCookies(`intentchord_owner_session=${sessionCookie!.value}`);
    displayName = account.display_name;
  } catch {
    const { redirect: navRedirect } = await import("next/navigation");
    navRedirect("/login");
    // Unreachable after redirect, but TypeScript needs a return.
    displayName = "";
  }

  return <AdminShell displayName={displayName} />;
}
