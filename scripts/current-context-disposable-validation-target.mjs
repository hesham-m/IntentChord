export const OWNER_DATABASE = "intentchord_dev";
export const EXPECTED_USER = "intentchord_app";
export const EXPECTED_SCHEMA = "intentchord";
export const DISPOSABLE_PREFIX = "intentchord_validation_";

export function disposableValidationUrl(env = process.env) {
  if (env.INTENTCHORD_DISPOSABLE_VALIDATION_AUTHORIZED !== "1") {
    throw new Error("DISPOSABLE_VALIDATION_AUTHORIZATION_REQUIRED");
  }
  const raw = env.INTENTCHORD_CURRENT_CONTEXT_VALIDATION_DATABASE_URL;
  if (!raw) throw new Error("INTENTCHORD_CURRENT_CONTEXT_VALIDATION_DATABASE_URL_REQUIRED");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("DISPOSABLE_VALIDATION_DATABASE_URL_INVALID"); }
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  const protocolAllowed = parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  if (!protocolAllowed || user !== EXPECTED_USER || database === OWNER_DATABASE || !database.startsWith(DISPOSABLE_PREFIX)) {
    throw new Error(`DISPOSABLE_VALIDATION_DATABASE_IDENTITY_BLOCKED: protocol=${parsed.protocol || "<missing>"}, user=${user || "<missing>"}, database=${database || "<missing>"}`);
  }
  return raw;
}

export function safeValidationTarget(raw = disposableValidationUrl()) {
  const parsed = new URL(raw);
  return {
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    host: parsed.hostname,
    port: parsed.port || "5432",
    schema: EXPECTED_SCHEMA,
  };
}
