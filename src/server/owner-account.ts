import { databaseQuery } from "@/server/db";
import { verifyPassword } from "@/server/owner-password";

export type OwnerAccountRow = {
  owner_id: string;
  login_name: string;
  display_name: string;
  password_hash: Buffer;
  password_salt: Buffer;
  password_kdf: string;
  account_state: string;
  session_version: number;
  created_at: string;
  updated_at: string;
};

/**
 * Look up an Owner account by login name.
 * Returns null if no account exists.
 */
export async function findOwnerByLoginName(loginName: string): Promise<OwnerAccountRow | null> {
  const result = await databaseQuery<OwnerAccountRow>(
    `SELECT owner_id, login_name, display_name, password_hash, password_salt,
            password_kdf, account_state, session_version, created_at, updated_at
     FROM intentchord.owner_accounts
     WHERE login_name = $1`,
    [loginName],
  );
  return result.rows[0] ?? null;
}

/**
 * Look up an Owner account by owner_id.
 * Returns null if no account exists.
 */
export async function findOwnerById(ownerId: string): Promise<OwnerAccountRow | null> {
  const result = await databaseQuery<OwnerAccountRow>(
    `SELECT owner_id, login_name, display_name, password_hash, password_salt,
            password_kdf, account_state, session_version, created_at, updated_at
     FROM intentchord.owner_accounts
     WHERE owner_id = $1`,
    [ownerId],
  );
  return result.rows[0] ?? null;
}

/**
 * Verify Owner credentials against PostgreSQL.
 * Returns the Owner account row if authentication succeeds, null otherwise.
 * Does not reveal which component failed (login vs password).
 */
export async function authenticateOwner(
  loginName: string,
  plaintextPassword: string,
): Promise<OwnerAccountRow | null> {
  const account = await findOwnerByLoginName(loginName);
  if (!account) return null;
  if (account.account_state !== "ACTIVE") return null;
  const valid = await verifyPassword(
    plaintextPassword,
    account.password_hash,
    account.password_salt,
    account.password_kdf,
  );
  if (!valid) return null;
  return account;
}

/**
 * Increment session_version to invalidate all existing sessions for this Owner.
 */
export async function bumpSessionVersion(ownerId: string): Promise<number> {
  const result = await databaseQuery<{ session_version: number }>(
    `UPDATE intentchord.owner_accounts
     SET session_version = session_version + 1,
         updated_at = clock_timestamp()
     WHERE owner_id = $1
     RETURNING session_version`,
    [ownerId],
  );
  if (!result.rows[0]) throw new Error("OWNER_NOT_FOUND");
  return result.rows[0].session_version;
}
