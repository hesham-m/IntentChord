import { NextResponse } from "next/server";
import { authenticateOwner } from "@/server/owner-account";
import { createSessionToken } from "@/server/authority";
import { issueOwnerSessionCookie } from "@/server/responses";
import { readJsonBody } from "@/server/http";
import { requestError } from "@/server/errors";

export async function POST(request: Request) {
  try {
    const body = (await readJsonBody(request)) as { loginName?: string; password?: string };
    const loginName = typeof body.loginName === "string" ? body.loginName.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!loginName || !password) {
      return NextResponse.json(
        { error: "Authentication failed.", code: "AUTH_FAILED" },
        { status: 401 },
      );
    }

    const account = await authenticateOwner(loginName, password);
    if (!account) {
      return NextResponse.json(
        { error: "Authentication failed.", code: "AUTH_FAILED" },
        { status: 401 },
      );
    }

    const token = createSessionToken(account.owner_id, account.session_version);
    const cookie = issueOwnerSessionCookie(token);

    const response = NextResponse.json({
      displayName: account.display_name,
    }, { status: 200 });

    response.cookies.set(cookie);
    return response;
  } catch (error) {
    const bounded = requestError(error);
    return NextResponse.json(
      { error: bounded.message, code: bounded.code },
      { status: bounded.status },
    );
  }
}
