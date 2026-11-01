import { cookies } from "next/headers";
import { verifyOwnerSessionFromCookies } from "@/server/authority";

export async function GET() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("intentchord_owner_session");
  if (!sessionCookie?.value) {
    return new Response(JSON.stringify({ valid: false }), { status: 401, headers: { "content-type": "application/json" } });
  }
  try {
    const account = await verifyOwnerSessionFromCookies(`intentchord_owner_session=${sessionCookie.value}`);
    return new Response(JSON.stringify({ valid: true, displayName: account.display_name }), { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ valid: false }), { status: 401, headers: { "content-type": "application/json" } });
  }
}
