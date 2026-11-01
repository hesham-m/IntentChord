import { HttpCommandError } from "@/server/errors";

export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) throw new HttpCommandError(400, "EMPTY_JSON_BODY", "A JSON request body is required.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpCommandError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

export async function readRawJsonBody(request: Request): Promise<{ raw: string; body: unknown }> {
  const raw = await request.text();
  if (!raw.trim()) throw new HttpCommandError(400, "EMPTY_JSON_BODY", "A JSON request body is required.");
  try {
    return { raw, body: JSON.parse(raw) as unknown };
  } catch {
    throw new HttpCommandError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

export function requireIfMatch(request: Request): number {
  const value = request.headers.get("if-match");
  if (value === null || !/^\d+$/.test(value.trim())) {
    throw new HttpCommandError(428, "IF_MATCH_REQUIRED", "A valid non-negative If-Match revision is required.");
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new HttpCommandError(400, "INVALID_IF_MATCH", "If-Match must be a non-negative safe integer revision.");
  }
  return revision;
}
