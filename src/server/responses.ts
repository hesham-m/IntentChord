import { NextResponse } from "next/server";
import {
  ownerSessionCookieValue,
  ownerSessionClearCookie,
  requireOwnerSession,
} from "@/server/authority";
import { requestError } from "@/server/errors";

export async function commandResponse<T>(command: () => Promise<T>, successStatus = 200) {
  try {
    return NextResponse.json(await command(), { status: successStatus });
  } catch (error) {
    const bounded = requestError(error);
    return NextResponse.json(
      { error: bounded.message, code: bounded.code, details: bounded.details },
      { status: bounded.status },
    );
  }
}

export async function ownerCommandResponse<T>(
  request: Request,
  command: (ownerAuthority: string) => Promise<T>,
  successStatus = 200,
) {
  return commandResponse(async () => {
    const ownerAuthority = await requireOwnerSession(request);
    return command(ownerAuthority);
  }, successStatus);
}

export async function ownerReadResponse<T>(request: Request, command: () => Promise<T>) {
  return commandResponse(async () => {
    await requireOwnerSession(request);
    return command();
  });
}

/**
 * Issue a signed Owner session cookie on successful login.
 */
export function issueOwnerSessionCookie(token: string) {
  return ownerSessionCookieValue(token);
}

/**
 * Clear the Owner session cookie on logout.
 */
export function clearOwnerSessionCookie() {
  return ownerSessionClearCookie();
}
