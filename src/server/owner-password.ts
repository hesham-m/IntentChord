import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KDF_CONTRACT = "scrypt-v1";
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export type PasswordVerification = {
  passwordHash: Buffer;
  passwordSalt: Buffer;
  passwordKdf: string;
};

/**
 * Hash a plaintext password using scrypt with a cryptographically random salt.
 * Returns the hash and salt for storage. Plaintext is never retained.
 */
export async function hashPassword(plaintext: string): Promise<PasswordVerification> {
  const salt = randomBytes(32);
  const derivedKey = await deriveKey(plaintext, salt);
  return {
    passwordHash: derivedKey,
    passwordSalt: salt,
    passwordKdf: KDF_CONTRACT,
  };
}

/**
 * Verify a plaintext password against stored hash and salt.
 * Uses constant-time comparison. Returns true if the password matches.
 */
export async function verifyPassword(
  plaintext: string,
  storedHash: Buffer,
  storedSalt: Buffer,
  storedKdf: string,
): Promise<boolean> {
  if (storedKdf !== KDF_CONTRACT) return false;
  const derivedKey = await deriveKey(plaintext, storedSalt);
  if (derivedKey.length !== storedHash.length) return false;
  return timingSafeEqual(derivedKey, storedHash);
}

function deriveKey(plaintext: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(plaintext, "utf8"),
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
      },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}
