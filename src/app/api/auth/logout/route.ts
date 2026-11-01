import { NextResponse } from "next/server";
import { requireSameOriginRequest } from "@/server/authority";
import { clearOwnerSessionCookie } from "@/server/responses";
import { HttpCommandError } from "@/server/errors";

export async function POST(request: Request) {
  try {
    requireSameOriginRequest(request);
    const cookie = clearOwnerSessionCookie();
    const response = NextResponse.json({ ok: true }, { status: 200 });
    response.cookies.set(cookie);
    return response;
  } catch (error) {
    if (error instanceof HttpCommandError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "Logout failed.", code: "LOGOUT_FAILED" },
      { status: 500 },
    );
  }
}
