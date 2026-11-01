import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpCommandError } from "@/server/errors";
import { findOwnerById } from "@/server/owner-account";
import type { OwnerAccountRow } from "@/server/owner-account";

const OWNER_COOKIE = "intentchord_owner_session";
const SESSION_FORMAT_VERSION = 1;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000; // 8 hours

export type TrustedProducerType = "BACKEND" | "HARNESS" | "ADAPTER" | "OWNER_RUNTIME";
export type TrustedProducerContext = {
  producerType: TrustedProducerType;
  producerId: string;
  authority: string;
  trustBasis: "INTERNAL_BACKEND" | "SIGNED_HARNESS" | "OWNER_SESSION";
  requestId?: string;
  routePath?: string;
  bodySha256?: string;
};

export type SessionPayload = {
  v: number;
  sub: string;
  sv: number;
  iat: number;
  exp: number;
};

function ownerSecret(): string {
  const configured = process.env.INTENTCHORD_OWNER_SESSION_SECRET?.trim();
  if (configured) return configured;
  throw new HttpCommandError(
    503,
    "OWNER_SESSION_SECRET_REQUIRED",
    "Owner-session signing requires INTENTCHORD_OWNER_SESSION_SECRET to be configured.",
  );
}

function signPayload(payload: SessionPayload): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const signature = createHmac("sha256", ownerSecret()).update(encoded).digest("hex");
  return `${encoded}.${signature}`;
}

function verifyAndParseSession(token: string): SessionPayload | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex < 0) return null;
  const encoded = token.slice(0, dotIndex);
  const receivedSig = token.slice(dotIndex + 1);
  const expectedSig = createHmac("sha256", ownerSecret()).update(encoded).digest("hex");
  if (!secureEqual(receivedSig, expectedSig)) return null;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const payload = JSON.parse(json) as SessionPayload;
    if (typeof payload.v !== "number" || typeof payload.sub !== "string" || typeof payload.sv !== "number" || typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    if (payload.v !== SESSION_FORMAT_VERSION) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  return cookieValueFromHeader(request.headers.get("cookie") ?? "", name);
}

function cookieValueFromHeader(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function secureEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue, "utf8");
  const right = Buffer.from(rightValue, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function isEquivalentLocalOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol
    && effectivePort(left) === effectivePort(right)
    && isLoopbackHost(left.hostname)
    && isLoopbackHost(right.hostname);
}

/**
 * Owner authority is carried by an HttpOnly cookie. Reject explicit cross-site
 * browser requests so a valid local Owner session cannot be exercised by an
 * unrelated origin. Non-browser/local test requests may omit Origin and
 * Sec-Fetch-Site; an explicit mismatch always fails closed.
 */
export function requireSameOriginRequest(request: Request): void {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new HttpCommandError(403, "CROSS_ORIGIN_REQUEST_REJECTED", "The request Origin header is invalid.");
    }
    if (originUrl.origin !== requestUrl.origin && !isEquivalentLocalOrigin(originUrl, requestUrl)) {
      throw new HttpCommandError(403, "CROSS_ORIGIN_REQUEST_REJECTED", "Owner commands must originate from the IntentChord origin.");
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpCommandError(403, "CROSS_SITE_REQUEST_REJECTED", "Cross-site Owner requests are not authorized.");
  }
}

/**
 * Create a signed session cookie value for the given Owner.
 * The token includes: format version, owner_id, session_version, iat, exp.
 */
export function createSessionToken(ownerId: string, sessionVersion: number): string {
  const now = Date.now();
  const payload: SessionPayload = {
    v: SESSION_FORMAT_VERSION,
    sub: ownerId,
    sv: sessionVersion,
    iat: now,
    exp: now + SESSION_LIFETIME_MS,
  };
  return signPayload(payload);
}

/**
 * Build the Set-Cookie attributes for an Owner session.
 */
export function ownerSessionCookieValue(token: string) {
  return {
    name: OWNER_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_LIFETIME_MS / 1000,
  };
}

/**
 * Build a cookie object that clears the Owner session.
 */
export function ownerSessionClearCookie() {
  return {
    name: OWNER_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  };
}

/**
 * Verify the Owner session from the request cookie.
 * Checks: cookie exists, signature valid, payload valid, expiry, Owner exists, account active, session_version matches.
 * Returns the dynamic principal string "owner:<owner_id>".
 *
 * This function is async because it queries PostgreSQL for account verification.
 */
export async function requireOwnerSession(request: Request): Promise<string> {
  requireSameOriginRequest(request);
  const received = cookieValue(request, OWNER_COOKIE);
  if (!received) {
    throw new HttpCommandError(401, "OWNER_SESSION_REQUIRED", "An IntentChord owner session is required.");
  }

  const payload = verifyAndParseSession(received);
  if (!payload) {
    throw new HttpCommandError(403, "OWNER_SESSION_INVALID", "The IntentChord owner session is invalid.");
  }

  if (payload.exp <= Date.now()) {
    throw new HttpCommandError(401, "OWNER_SESSION_EXPIRED", "The IntentChord owner session has expired.");
  }

  const account = await findOwnerById(payload.sub);
  if (!account) {
    throw new HttpCommandError(403, "OWNER_SESSION_INVALID", "The IntentChord owner session is invalid.");
  }
  if (account.account_state !== "ACTIVE") {
    throw new HttpCommandError(403, "OWNER_ACCOUNT_DISABLED", "The Owner account is disabled.");
  }
  if (account.session_version !== payload.sv) {
    throw new HttpCommandError(401, "OWNER_SESSION_INVALIDATED", "The IntentChord owner session has been invalidated.");
  }

  return `owner:${account.owner_id}`;
}

/**
 * Verify the Owner session and return the full account row.
 * Used by login-required server components that need account details.
 */
export async function requireOwnerSessionAccount(request: Request) {
  requireSameOriginRequest(request);
  return verifyOwnerSessionFromCookies(request.headers.get("cookie") ?? "");
}

/**
 * Full Owner session verification from raw cookie header string.
 * Does NOT require a Request object — suitable for root layout and login page.
 * Checks: cookie exists, signature valid, payload valid, expiry, Owner exists, account active, session_version matches.
 * Returns the account row on success, throws HttpCommandError on any failure.
 */
export async function verifyOwnerSessionFromCookies(cookieHeader: string): Promise<OwnerAccountRow> {
  const received = cookieValueFromHeader(cookieHeader, OWNER_COOKIE);
  if (!received) {
    throw new HttpCommandError(401, "OWNER_SESSION_REQUIRED", "An IntentChord owner session is required.");
  }

  const payload = verifyAndParseSession(received);
  if (!payload) {
    throw new HttpCommandError(403, "OWNER_SESSION_INVALID", "The IntentChord owner session is invalid.");
  }

  if (payload.exp <= Date.now()) {
    throw new HttpCommandError(401, "OWNER_SESSION_EXPIRED", "The IntentChord owner session has expired.");
  }

  const account = await findOwnerById(payload.sub);
  if (!account) {
    throw new HttpCommandError(403, "OWNER_SESSION_INVALID", "The IntentChord owner session is invalid.");
  }
  if (account.account_state !== "ACTIVE") {
    throw new HttpCommandError(403, "OWNER_ACCOUNT_DISABLED", "The Owner account is disabled.");
  }
  if (account.session_version !== payload.sv) {
    throw new HttpCommandError(401, "OWNER_SESSION_INVALIDATED", "The IntentChord owner session has been invalidated.");
  }

  return account;
}

export function backendProducer(): TrustedProducerContext {
  return {
    producerType: "BACKEND",
    producerId: "intentchord-backend",
    authority: "BACKEND",
    trustBasis: "INTERNAL_BACKEND",
  };
}

export async function ownerRuntimeProducer(request: Request): Promise<TrustedProducerContext> {
  const authority = await requireOwnerSession(request);
  return {
    producerType: "OWNER_RUNTIME",
    producerId: authority,
    authority,
    trustBasis: "OWNER_SESSION",
  };
}

function evidenceSecret(): string {
  const secret = process.env.INTENTCHORD_EVIDENCE_INGESTION_SECRET?.trim();
  if (!secret) {
    throw new HttpCommandError(
      503,
      "EVIDENCE_INGESTION_SECRET_REQUIRED",
      "Trusted harness or adapter evidence ingestion is disabled until INTENTCHORD_EVIDENCE_INGESTION_SECRET is configured.",
    );
  }
  return secret;
}

export function verifySignedProducerRequest(
  request: Request,
  rawBody: string,
  allowedTypes: Array<"HARNESS" | "ADAPTER">,
): TrustedProducerContext {
  const producerType = request.headers.get("x-intentchord-producer-type") as "HARNESS" | "ADAPTER" | null;
  const producerId = request.headers.get("x-intentchord-producer-id")?.trim();
  const requestId = request.headers.get("x-intentchord-request-id")?.trim();
  const timestamp = request.headers.get("x-intentchord-timestamp")?.trim();
  const signature = request.headers.get("x-intentchord-signature")?.trim().toLowerCase();
  if (!producerType || !allowedTypes.includes(producerType) || !producerId || !requestId || !timestamp || !signature) {
    throw new HttpCommandError(401, "TRUSTED_PRODUCER_SIGNATURE_REQUIRED", "A complete signed producer identity and unique request ID are required.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new HttpCommandError(400, "TRUSTED_PRODUCER_REQUEST_ID_INVALID", "The signed producer request ID must be a UUID.");
  }
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
    throw new HttpCommandError(401, "TRUSTED_PRODUCER_TIMESTAMP_INVALID", "The signed producer timestamp is missing, invalid, or stale.");
  }
  const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
  const routePath = new URL(request.url).pathname;
  const canonical = [
    request.method.toUpperCase(),
    routePath,
    producerType,
    producerId,
    requestId,
    timestamp,
    bodySha256,
  ].join("\n");
  const expected = createHmac("sha256", evidenceSecret()).update(canonical).digest("hex");
  if (!secureEqual(signature, expected)) {
    throw new HttpCommandError(403, "TRUSTED_PRODUCER_SIGNATURE_INVALID", "The producer signature is invalid.");
  }
  return {
    producerType,
    producerId,
    authority: `${producerType}:${producerId}`,
    trustBasis: "SIGNED_HARNESS",
    requestId,
    routePath,
    bodySha256,
  };
}
