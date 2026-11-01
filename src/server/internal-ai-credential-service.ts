import { randomUUID } from "node:crypto";
import type { InternalAiSecretAuthority } from "@/server/ai-secret-authority";
import { ReadOnlySecretAuthority } from "@/server/ai-secret-authority";
import type { InternalAiSecretResolver } from "@/server/ai-secret-resolver";
import { databaseQuery, transaction } from "@/server/db";
import { HttpCommandError } from "@/server/errors";

export type InternalAiCredentialState = "ACTIVE" | "REVOKED";
export type InternalAiCredentialPresence = "PRESENT" | "MISSING" | "REVOKED" | "NONE";

export type InternalAiCredentialRow = {
  credential_reference: string;
  vendor_id: string;
  credential_state: InternalAiCredentialState;
  last_rotated_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Governed non-secret view. Never includes a secret value. */
export type InternalAiCredentialView = {
  credentialReference: string;
  vendorId: string;
  credentialState: InternalAiCredentialState;
  presence: InternalAiCredentialPresence;
  lastRotatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InternalAiCredentialLifecycleAction =
  | "ADD"
  | "REPLACE"
  | "ROTATE"
  | "REVOKE"
  | "DELETE";

function validateCredentialReference(value: string | undefined, name = "credentialReference"): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 200 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new HttpCommandError(
      400,
      "INVALID_IDENTITY",
      `${name} must match ^[A-Za-z_][A-Za-z0-9_]*$ and be at most 200 characters.`,
    );
  }
  return trimmed;
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpCommandError(400, "INVALID_INPUT", "secret must be a non-empty string.");
  }
  if (value.length > 8192) {
    throw new HttpCommandError(400, "INVALID_INPUT", "secret must be at most 8192 characters.");
  }
  return value;
}

async function recordCredentialAuditEvent(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  input: {
    eventType: string;
    actorAuthority: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.audit_events (
      id, aggregate_type, aggregate_id, event_type, actor_authority, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [
      randomUUID(),
      "INTERNAL_AI_CREDENTIAL_LIFECYCLE",
      randomUUID(),
      input.eventType,
      input.actorAuthority,
      JSON.stringify(input.metadata),
    ],
  );
}

function rowToView(row: InternalAiCredentialRow, presence: InternalAiCredentialPresence): InternalAiCredentialView {
  return {
    credentialReference: row.credential_reference,
    vendorId: row.vendor_id,
    credentialState: row.credential_state,
    presence,
    lastRotatedAt: row.last_rotated_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class InternalAiCredentialService {
  private authority: InternalAiSecretAuthority;

  constructor(resolver?: InternalAiSecretAuthority | InternalAiSecretResolver) {
    this.authority =
      resolver && typeof (resolver as InternalAiSecretAuthority).storeSecret === "function"
        ? (resolver as InternalAiSecretAuthority)
        : new ReadOnlySecretAuthority(resolver ?? {
            isCredentialPresent: () => false,
            resolveSecret: () => undefined,
            resolveSecretOrThrow: () => {
              throw new Error("SECRET_NOT_FOUND");
            },
          });
  }

  /** Test/prod injection point. */
  setSecretAuthority(authority: InternalAiSecretAuthority): void {
    this.authority = authority;
  }

  private async resolvePresence(credentialReference: string, credentialState: InternalAiCredentialState): Promise<InternalAiCredentialPresence> {
    if (credentialState === "REVOKED") return "REVOKED";
    try {
      const present = await this.authority.isCredentialPresent(credentialReference);
      return present ? "PRESENT" : "MISSING";
    } catch {
      // Resolver unavailable ≠ credential missing: report MISSING for UI, do not throw read-path invariant break.
      return "MISSING";
    }
  }

  async getCredential(vendorId: string): Promise<InternalAiCredentialView | null> {
    const vendor = await databaseQuery(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!vendor.rowCount) {
      throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
    }
    const res = await databaseQuery<InternalAiCredentialRow>(
      `SELECT * FROM intentchord.internal_ai_credentials WHERE vendor_id = $1`,
      [vendorId],
    );
    const row = res.rows.find(r => r.credential_state === "ACTIVE") ?? res.rows[0];
    if (!row) return null;
    const presence = await this.resolvePresence(row.credential_reference, row.credential_state);
    return rowToView(row, presence);
  }

  async addCredential(
    vendorId: string,
    input: { credentialReference: string; secret: string },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiCredentialView> {
    const credentialReference = validateCredentialReference(input.credentialReference);
    const secret = requireSecret(input.secret);

    const vendor = await databaseQuery(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!vendor.rowCount) {
      throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
    }

    const existing = await databaseQuery<InternalAiCredentialRow>(
      `SELECT * FROM intentchord.internal_ai_credentials WHERE credential_reference = $1`,
      [credentialReference],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new HttpCommandError(
        409,
        "CREDENTIAL_ALREADY_EXISTS",
        `Credential ${credentialReference} already exists.`,
      );
    }

    await this.authority.storeSecret(credentialReference, secret);

    try {
      return await transaction(async client => {
        const res = await client.query<InternalAiCredentialRow>(
          `INSERT INTO intentchord.internal_ai_credentials (
            credential_reference, vendor_id, credential_state, created_at, updated_at
          ) VALUES ($1, $2, 'ACTIVE', clock_timestamp(), clock_timestamp())
          RETURNING *`,
          [credentialReference, vendorId],
        );
        await client.query(
          `UPDATE intentchord.internal_ai_vendors
           SET credential_reference = $2, updated_at = clock_timestamp()
           WHERE vendor_id = $1`,
          [vendorId, credentialReference],
        );
        await recordCredentialAuditEvent(client, {
          eventType: "CREDENTIAL_ADDED",
          actorAuthority: actor,
          metadata: { vendorId, credentialReference },
        });
        const row = res.rows[0];
        if (!row) throw new HttpCommandError(500, "INTERNAL_ERROR", "Credential insert failed.");
        return rowToView(row, "PRESENT");
      });
    } catch (error) {
      try {
        await this.authority.removeSecret(credentialReference);
      } catch {
        // Best-effort secret cleanup on failed insert; original error still surfaces.
      }
      throw error;
    }
  }

  async replaceOrRotateCredential(
    vendorId: string,
    input: { credentialReference?: string; secret: string; mode: "REPLACE" | "ROTATE" },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiCredentialView> {
    if (input.mode !== "REPLACE" && input.mode !== "ROTATE") {
      throw new HttpCommandError(400, "INVALID_INPUT", "mode must be REPLACE or ROTATE.");
    }
    const secret = requireSecret(input.secret);

    const vendor = await databaseQuery(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!vendor.rowCount) {
      throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
    }

    const existing = await databaseQuery<InternalAiCredentialRow>(
      `SELECT * FROM intentchord.internal_ai_credentials WHERE vendor_id = $1`,
      [vendorId],
    );
    const row = existing.rows.find(r => r.credential_state === "ACTIVE") ?? existing.rows[0];
    if (!row) {
      throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Vendor ${vendorId} has no credential to ${input.mode.toLowerCase()}.`);
    }
    if (row.credential_state === "REVOKED") {
      throw new HttpCommandError(
        409,
        "CREDENTIAL_REVOKED",
        `Credential ${row.credential_reference} is revoked. Use Add to provision a new credential.`,
      );
    }

    const credentialReference = input.credentialReference != null && input.credentialReference !== ""
      ? validateCredentialReference(input.credentialReference)
      : row.credential_reference;
    if (credentialReference !== row.credential_reference) {
      throw new HttpCommandError(
        409,
        "CREDENTIAL_REFERENCE_IMMUTABLE",
        "credentialReference cannot change on Replace/Rotate. Delete then Add to change the reference.",
      );
    }

    await this.authority.storeSecret(credentialReference, secret);

    return transaction(async client => {
      const res = await client.query<InternalAiCredentialRow>(
        `UPDATE intentchord.internal_ai_credentials
         SET last_rotated_at = CASE WHEN $3 = 'ROTATE' THEN clock_timestamp() ELSE last_rotated_at END,
             updated_at = clock_timestamp()
         WHERE credential_reference = $1 AND vendor_id = $2 AND credential_state = 'ACTIVE'
         RETURNING *`,
        [credentialReference, vendorId, input.mode],
      );
      const updated = res.rows[0];
      if (!updated) {
        throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Credential ${credentialReference} was not found as ACTIVE.`);
      }
      await recordCredentialAuditEvent(client, {
        eventType: input.mode === "ROTATE" ? "CREDENTIAL_ROTATED" : "CREDENTIAL_REPLACED",
        actorAuthority: actor,
        metadata: { vendorId, credentialReference },
      });
      return rowToView(updated, "PRESENT");
    });
  }

  async revokeCredential(
    vendorId: string,
    actor = "SYSTEM_OWNER",
    credentialReference?: string,
  ): Promise<InternalAiCredentialView> {
    const vendor = await databaseQuery(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!vendor.rowCount) {
      throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
    }

    const existing = await databaseQuery<InternalAiCredentialRow>(
      `SELECT * FROM intentchord.internal_ai_credentials WHERE vendor_id = $1`,
      [vendorId],
    );
    const row =
      (credentialReference != null && credentialReference !== ""
        ? existing.rows.find(r => r.credential_reference === credentialReference)
        : undefined) ??
      existing.rows.find(r => r.credential_state === "ACTIVE") ??
      existing.rows[0];
    if (!row) {
      throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Vendor ${vendorId} has no credential to revoke.`);
    }
    if (credentialReference != null && credentialReference !== "") {
      const requested = validateCredentialReference(credentialReference);
      if (requested !== row.credential_reference) {
        throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Credential ${requested} is not bound to vendor ${vendorId}.`);
      }
    }
    if (row.credential_state === "REVOKED") {
      throw new HttpCommandError(409, "CREDENTIAL_REVOKED", `Credential ${row.credential_reference} is already revoked.`);
    }

    await this.authority.removeSecret(row.credential_reference);

    return transaction(async client => {
      const res = await client.query<InternalAiCredentialRow>(
        `UPDATE intentchord.internal_ai_credentials
         SET credential_state = 'REVOKED', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE credential_reference = $1 AND vendor_id = $2 AND credential_state = 'ACTIVE'
         RETURNING *`,
        [row.credential_reference, vendorId],
      );
      const updated = res.rows[0];
      if (!updated) {
        throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Credential ${row.credential_reference} was not found as ACTIVE.`);
      }
      await client.query(
        `UPDATE intentchord.internal_ai_vendors
         SET credential_reference = NULL, updated_at = clock_timestamp()
         WHERE vendor_id = $1 AND credential_reference = $2`,
        [vendorId, row.credential_reference],
      );
      await recordCredentialAuditEvent(client, {
        eventType: "CREDENTIAL_REVOKED",
        actorAuthority: actor,
        metadata: { vendorId, credentialReference: row.credential_reference },
      });
      return rowToView(updated, "REVOKED");
    });
  }

  async deleteCredential(
    vendorId: string,
    actor = "SYSTEM_OWNER",
    credentialReference?: string,
  ): Promise<{ deleted: true; credentialReference: string }> {
    const vendor = await databaseQuery(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!vendor.rowCount) {
      throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
    }

    const existing = await databaseQuery<InternalAiCredentialRow>(
      `SELECT * FROM intentchord.internal_ai_credentials WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!existing.rowCount) {
      throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Vendor ${vendorId} has no credential to delete.`);
    }

    let rowsToDelete = existing.rows;
    if (credentialReference != null && credentialReference !== "") {
      const requested = validateCredentialReference(credentialReference);
      rowsToDelete = existing.rows.filter(r => r.credential_reference === requested);
      if (!rowsToDelete.length) {
        throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Credential ${requested} is not bound to vendor ${vendorId}.`);
      }
    }

    for (const row of rowsToDelete) {
      await this.authority.removeSecret(row.credential_reference);
    }

    return transaction(async client => {
      let deletedReference: string | null = null;
      for (const row of rowsToDelete) {
        const res = await client.query(
          `DELETE FROM intentchord.internal_ai_credentials
           WHERE credential_reference = $1 AND vendor_id = $2
           RETURNING credential_reference`,
          [row.credential_reference, vendorId],
        );
        if (!res.rowCount) {
          throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Credential ${row.credential_reference} was not found.`);
        }
        deletedReference = row.credential_reference;
        await client.query(
          `UPDATE intentchord.internal_ai_vendors
           SET credential_reference = NULL, updated_at = clock_timestamp()
           WHERE vendor_id = $1 AND credential_reference = $2`,
          [vendorId, row.credential_reference],
        );
        await recordCredentialAuditEvent(client, {
          eventType: "CREDENTIAL_DELETED",
          actorAuthority: actor,
          metadata: { vendorId, credentialReference: row.credential_reference },
        });
      }
      if (!deletedReference) {
        throw new HttpCommandError(404, "CREDENTIAL_NOT_FOUND", `Vendor ${vendorId} has no credential to delete.`);
      }
      return { deleted: true as const, credentialReference: deletedReference };
    });
  }

  /**
   * Lifecycle dispatcher used by the admin route.
   */
  async performLifecycle(
    vendorId: string,
    action: InternalAiCredentialLifecycleAction,
    body: { credentialReference?: string; secret?: string },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiCredentialView | { deleted: true; credentialReference: string }> {
    switch (action) {
      case "ADD": {
        if (!body.credentialReference) {
          throw new HttpCommandError(400, "INVALID_INPUT", "credentialReference is required for ADD.");
        }
        return this.addCredential(
          vendorId,
          { credentialReference: body.credentialReference, secret: requireSecret(body.secret) },
          actor,
        );
      }
      case "REPLACE":
      case "ROTATE":
        return this.replaceOrRotateCredential(
          vendorId,
          { credentialReference: body.credentialReference, secret: requireSecret(body.secret), mode: action },
          actor,
        );
      case "REVOKE":
        return this.revokeCredential(vendorId, actor, body.credentialReference);
      case "DELETE":
        return this.deleteCredential(vendorId, actor, body.credentialReference);
      default:
        throw new HttpCommandError(400, "INVALID_INPUT", `Unknown credential action ${String(action)}.`);
    }
  }
}

// Next.js compiles instrumentation and route handlers into separate module chunks.
// A module-level singleton can therefore diverge between bootstrap and API runtime.
// Keep the credential service process-wide so production authority injection performed
// by instrumentation.ts is observed by every Admin route chunk.
const INTERNAL_AI_CREDENTIAL_SERVICE_GLOBAL_KEY = "__intentchord_internal_ai_credential_service" as const;
const internalAiCredentialServiceGlobal = globalThis as Record<string, unknown>;

export const internalAiCredentialService =
  (internalAiCredentialServiceGlobal[INTERNAL_AI_CREDENTIAL_SERVICE_GLOBAL_KEY] as InternalAiCredentialService | undefined)
  ?? new InternalAiCredentialService();

internalAiCredentialServiceGlobal[INTERNAL_AI_CREDENTIAL_SERVICE_GLOBAL_KEY] = internalAiCredentialService;
