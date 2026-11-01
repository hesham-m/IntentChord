import { randomUUID } from "node:crypto";
import { isSupportedProtocolFamily } from "@/core/ai-context-mapper/protocol-family";
import { databaseQuery, transaction } from "@/server/db";
import { HttpCommandError } from "@/server/errors";

export type InternalAiVendorState = "ENABLED" | "DISABLED" | "RETIRED";
export type InternalAiModelState = "ENABLED" | "DISABLED";

export type InternalAiVendorRow = {
  vendor_id: string;
  display_name: string;
  vendor_state: InternalAiVendorState;
  website_url: string | null;
  base_url: string;
  auth_type: string;
  protocol_profile: string;
  credential_reference: string | null;
  retirement_reason: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

export type InternalAiModelRow = {
  vendor_id: string;
  model_id: string;
  display_name: string;
  model_state: InternalAiModelState;
  provider_facing_model_id: string;
  capability_metadata: Record<string, unknown>;
  runtime_compatibility_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type InternalAiVendorView = {
  vendorId: string;
  displayName: string;
  state: InternalAiVendorState;
  websiteUrl: string | null;
  baseUrl: string;
  authType: string;
  protocolProfile: string;
  credentialReference: string | null;
  retirementReason: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  modelCount?: number;
};

export type InternalAiModelView = {
  vendorId: string;
  modelId: string;
  displayName: string;
  state: InternalAiModelState;
  providerFacingModelId: string;
  capabilityMetadata: Record<string, unknown>;
  runtimeCompatibilityMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type InternalAiVendorDetailView = InternalAiVendorView & {
  models: InternalAiModelView[];
};

function validateIdentifier(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 200 || /\s/.test(trimmed)) {
    throw new HttpCommandError(400, "INVALID_IDENTITY", `${name} must be a non-empty bounded string without whitespace.`);
  }
  return trimmed;
}

function requireNonEmpty(value: string | undefined, name: string, maxLength = 200): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new HttpCommandError(400, "INVALID_INPUT", `${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return trimmed;
}

async function recordVendorAuditEvent(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  input: {
    eventType: string;
    aggregateId: string;
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
      "INTERNAL_AI_VENDOR_LIFECYCLE",
      input.aggregateId,
      input.eventType,
      input.actorAuthority,
      JSON.stringify(input.metadata),
    ],
  );
}

function rowToVendorView(row: InternalAiVendorRow, modelCount?: number): InternalAiVendorView {
  return {
    vendorId: row.vendor_id,
    displayName: row.display_name,
    state: row.vendor_state,
    websiteUrl: row.website_url,
    baseUrl: row.base_url,
    authType: row.auth_type,
    protocolProfile: row.protocol_profile,
    credentialReference: row.credential_reference,
    retirementReason: row.retirement_reason,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(modelCount !== undefined ? { modelCount } : {}),
  };
}

function rowToModelView(row: InternalAiModelRow): InternalAiModelView {
  return {
    vendorId: row.vendor_id,
    modelId: row.model_id,
    displayName: row.display_name,
    state: row.model_state,
    providerFacingModelId: row.provider_facing_model_id,
    capabilityMetadata: row.capability_metadata,
    runtimeCompatibilityMetadata: row.runtime_compatibility_metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class InternalAiVendorService {
  async listVendors(options?: { state?: InternalAiVendorState }): Promise<InternalAiVendorView[]> {
    const params: unknown[] = [];
    let query = `
      SELECT v.*,
        (SELECT count(*)::int FROM intentchord.internal_ai_models m WHERE m.vendor_id = v.vendor_id) AS model_count
      FROM intentchord.internal_ai_vendors v`;
    if (options?.state) {
      params.push(options.state);
      query += ` WHERE v.vendor_state = $1`;
    }
    query += ` ORDER BY v.vendor_id ASC`;
    const result = await databaseQuery<InternalAiVendorRow & { model_count: number }>(query, params);
    return result.rows.map(row => rowToVendorView(row, row.model_count));
  }

  async getVendor(vendorId: string): Promise<InternalAiVendorDetailView | null> {
    const vendorRes = await databaseQuery<InternalAiVendorRow>(
      `SELECT * FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!vendorRes.rows[0]) return null;
    const modelsRes = await databaseQuery<InternalAiModelRow>(
      `SELECT * FROM intentchord.internal_ai_models WHERE vendor_id = $1 ORDER BY model_id ASC`,
      [vendorId],
    );
    const vendor = rowToVendorView(vendorRes.rows[0], modelsRes.rowCount ?? 0);
    return { ...vendor, models: modelsRes.rows.map(rowToModelView) };
  }

  async addVendor(
    input: {
      vendorId: string;
      displayName: string;
      websiteUrl?: string | null;
      baseUrl: string;
      authType: string;
      protocolProfile: string;
      credentialReference?: string | null;
    },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiVendorView> {
    const vendorId = validateIdentifier(input.vendorId, "vendorId");
    const displayName = requireNonEmpty(input.displayName, "displayName");
    const websiteUrl = input.websiteUrl == null || input.websiteUrl.trim() === ""
      ? null
      : requireNonEmpty(input.websiteUrl, "websiteUrl", 2048);
    if (websiteUrl && !websiteUrl.startsWith("https://")) {
      throw new HttpCommandError(400, "INVALID_CONFIGURATION", "websiteUrl must use https:// scheme.");
    }
    const baseUrl = requireNonEmpty(input.baseUrl, "baseUrl", 2048);
    if (!baseUrl.startsWith("https://")) {
      throw new HttpCommandError(400, "INVALID_CONFIGURATION", "baseUrl must use https:// scheme.");
    }
    const authType = requireNonEmpty(input.authType, "authType", 64);
    const protocolProfile = requireNonEmpty(input.protocolProfile, "protocolProfile");
    if (!isSupportedProtocolFamily(protocolProfile)) {
      throw new HttpCommandError(
        400,
        "PROTOCOL_FAMILY_UNSUPPORTED",
        `Protocol family ${protocolProfile} is not supported. Add a governed adapter/profile implementation before registering this Vendor.`,
      );
    }
    let credentialReference: string | null = null;
    if (input.credentialReference != null && input.credentialReference !== "") {
      credentialReference = validateIdentifier(input.credentialReference, "credentialReference");
    }

    return transaction(async client => {
      const existing = await client.query(
        `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
        [vendorId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        throw new HttpCommandError(409, "VENDOR_ALREADY_EXISTS", `Vendor ${vendorId} is already registered.`);
      }
      const res = await client.query<InternalAiVendorRow>(
        `INSERT INTO intentchord.internal_ai_vendors (
          vendor_id, display_name, vendor_state, website_url, base_url, auth_type, protocol_profile, credential_reference,
          created_at, updated_at
        ) VALUES ($1, $2, 'ENABLED', $3, $4, $5, $6, $7, clock_timestamp(), clock_timestamp())
        RETURNING *`,
        [vendorId, displayName, websiteUrl, baseUrl, authType, protocolProfile, credentialReference],
      );
      await recordVendorAuditEvent(client, {
        eventType: "VENDOR_REGISTERED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { vendorId, displayName, websiteUrl, protocolProfile },
      });
      return rowToVendorView(res.rows[0], 0);
    });
  }

  async setVendorState(
    vendorId: string,
    state: InternalAiVendorState,
    actor = "SYSTEM_OWNER",
    reason?: string,
  ): Promise<InternalAiVendorView> {
    return transaction(async client => {
      const existing = await client.query<InternalAiVendorRow>(
        `SELECT * FROM intentchord.internal_ai_vendors WHERE vendor_id = $1 FOR UPDATE`,
        [vendorId],
      );
      if (!existing.rowCount) {
        throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
      }
      const current = existing.rowCount ? existing.rows[0] : undefined;
      if (current?.vendor_state === "RETIRED" && state !== "RETIRED") {
        throw new HttpCommandError(409, "VENDOR_RETIRED", `Vendor ${vendorId} is retired and cannot return to ${state}.`);
      }
      if (state === "RETIRED") {
        const res = await client.query<InternalAiVendorRow>(
          `UPDATE intentchord.internal_ai_vendors
           SET vendor_state = 'RETIRED', retirement_reason = $2, retired_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE vendor_id = $1 RETURNING *`,
          [vendorId, reason ?? null],
        );
        await recordVendorAuditEvent(client, {
          eventType: "VENDOR_RETIRED",
          aggregateId: randomUUID(),
          actorAuthority: actor,
          metadata: { vendorId, state, reason },
        });
        return rowToVendorView(res.rows[0]);
      }
      const res = await client.query<InternalAiVendorRow>(
        `UPDATE intentchord.internal_ai_vendors
         SET vendor_state = $2, updated_at = clock_timestamp()
         WHERE vendor_id = $1 RETURNING *`,
        [vendorId, state],
      );
      await recordVendorAuditEvent(client, {
        eventType: state === "ENABLED" ? "VENDOR_ENABLED" : "VENDOR_DISABLED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { vendorId, state },
      });
      return rowToVendorView(res.rows[0]);
    });
  }

  async listModels(vendorId: string): Promise<InternalAiModelView[]> {
    const vendor = await databaseQuery(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    if (!vendor.rowCount) {
      throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
    }
    const result = await databaseQuery<InternalAiModelRow>(
      `SELECT * FROM intentchord.internal_ai_models WHERE vendor_id = $1 ORDER BY model_id ASC`,
      [vendorId],
    );
    return result.rows.map(rowToModelView);
  }

  async addModel(
    vendorId: string,
    input: {
      modelId: string;
      displayName: string;
      providerFacingModelId: string;
      capabilityMetadata?: Record<string, unknown>;
      runtimeCompatibilityMetadata?: Record<string, unknown>;
    },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiModelView> {
    const modelId = validateIdentifier(input.modelId, "modelId");
    const displayName = requireNonEmpty(input.displayName, "displayName");
    const providerFacingModelId = requireNonEmpty(input.providerFacingModelId, "providerFacingModelId", 300);

    return transaction(async client => {
      const vendor = await client.query<InternalAiVendorRow>(
        `SELECT * FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
        [vendorId],
      );
      if (!vendor.rowCount) {
        throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
      }
      if (vendor.rows[0]?.vendor_state === "RETIRED") {
        throw new HttpCommandError(409, "VENDOR_RETIRED", `Cannot add a model under retired vendor ${vendorId}.`);
      }
      const existing = await client.query(
        `SELECT model_id FROM intentchord.internal_ai_models WHERE vendor_id = $1 AND model_id = $2`,
        [vendorId, modelId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        throw new HttpCommandError(409, "MODEL_ALREADY_EXISTS", `Model ${modelId} already exists under vendor ${vendorId}.`);
      }
      const res = await client.query<InternalAiModelRow>(
        `INSERT INTO intentchord.internal_ai_models (
          vendor_id, model_id, display_name, model_state, provider_facing_model_id,
          capability_metadata, runtime_compatibility_metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, 'ENABLED', $4, $5::jsonb, $6::jsonb, clock_timestamp(), clock_timestamp())
        RETURNING *`,
        [
          vendorId,
          modelId,
          displayName,
          providerFacingModelId,
          JSON.stringify(input.capabilityMetadata ?? {}),
          JSON.stringify(input.runtimeCompatibilityMetadata ?? {}),
        ],
      );
      await recordVendorAuditEvent(client, {
        eventType: "MODEL_REGISTERED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { vendorId, modelId, displayName },
      });
      return rowToModelView(res.rows[0]);
    });
  }

  async setModelState(
    vendorId: string,
    modelId: string,
    state: InternalAiModelState,
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiModelView> {
    return transaction(async client => {
      const res = await client.query<InternalAiModelRow>(
        `UPDATE intentchord.internal_ai_models
         SET model_state = $3, updated_at = clock_timestamp()
         WHERE vendor_id = $1 AND model_id = $2
         RETURNING *`,
        [vendorId, modelId, state],
      );
      if (!res.rowCount) {
        throw new HttpCommandError(404, "MODEL_NOT_FOUND", `Model ${modelId} under vendor ${vendorId} was not found.`);
      }
      await recordVendorAuditEvent(client, {
        eventType: state === "ENABLED" ? "MODEL_ENABLED" : "MODEL_DISABLED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { vendorId, modelId, state },
      });
      return rowToModelView(res.rows[0]);
    });
  }

  /**
   * Gate 6: Hard-delete a Model only when it has no historical Engine Revision,
   * frozen authority, or Active/Standby reference. Otherwise require Retire/Archive
   * (DISABLED state) and fail closed.
   */
  async deleteModel(vendorId: string, modelId: string, actor = "SYSTEM_OWNER"): Promise<{ vendorId: string; modelId: string; deleted: true }> {
    return transaction(async client => {
      const modelRes = await client.query<InternalAiModelRow>(
        `SELECT * FROM intentchord.internal_ai_models WHERE vendor_id = $1 AND model_id = $2 FOR UPDATE`,
        [vendorId, modelId],
      );
      if (!modelRes.rowCount) {
        throw new HttpCommandError(404, "MODEL_NOT_FOUND", `Model ${modelId} under vendor ${vendorId} was not found.`);
      }

      const revisionRefs = await client.query(
        `SELECT engine_id, engine_config_revision FROM intentchord.internal_ai_engine_revisions
          WHERE vendor_id = $1 AND (model_id = $2 OR provider_id = $2)
          LIMIT 5`,
        [vendorId, modelId],
      );
      const providerFacingRefs = await client.query(
        `SELECT r.engine_id FROM intentchord.internal_ai_engine_revisions r
          JOIN intentchord.internal_ai_models m ON m.vendor_id = r.vendor_id AND m.model_id = $2
          WHERE r.vendor_id = $1 AND r.model_id = m.provider_facing_model_id
          LIMIT 5`,
        [vendorId, modelId],
      );

      const selectionRefs = await client.query(
        `SELECT qualification_scope FROM intentchord.internal_ai_admin_selections
          WHERE (active_engine_id, active_engine_config_revision) IN (
            SELECT engine_id, engine_config_revision FROM intentchord.internal_ai_engine_revisions
             WHERE vendor_id = $1 AND model_id = $2
          )
           OR (standby_engine_id, standby_engine_config_revision) IN (
            SELECT engine_id, engine_config_revision FROM intentchord.internal_ai_engine_revisions
             WHERE vendor_id = $1 AND model_id = $2
          )
          LIMIT 5`,
        [vendorId, modelId],
      );

      if ((revisionRefs.rowCount ?? 0) > 0 || (providerFacingRefs.rowCount ?? 0) > 0) {
        throw new HttpCommandError(
          409,
          "DELETE_NOT_ALLOWED_RETIRE_REQUIRED",
          `Model ${modelId} under vendor ${vendorId} has historical Engine Revision provenance. Retire (DISABLE) instead of hard delete.`,
        );
      }
      if ((selectionRefs.rowCount ?? 0) > 0) {
        throw new HttpCommandError(
          409,
          "ACTIVE_STANDBY_PROTECTION",
          `Model ${modelId} under vendor ${vendorId} is referenced by Active/Standby selection. Change or remove the selection before delete.`,
        );
      }

      await client.query(
        `DELETE FROM intentchord.internal_ai_models WHERE vendor_id = $1 AND model_id = $2`,
        [vendorId, modelId],
      );
      await recordVendorAuditEvent(client, {
        eventType: "MODEL_DELETED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { vendorId, modelId },
      });
      return { vendorId, modelId, deleted: true as const };
    });
  }

  /**
   * Gate 6: Hard-delete a Vendor only when it has no Models, Credentials,
   * Engine Revisions (vendor_id or provider_id), Active/Standby reference, or
   * other historical governance dependency. Otherwise require Retire/Archive.
   */
  async deleteVendor(vendorId: string, actor = "SYSTEM_OWNER"): Promise<{ vendorId: string; deleted: true }> {
    return transaction(async client => {
      const vendorRes = await client.query<InternalAiVendorRow>(
        `SELECT * FROM intentchord.internal_ai_vendors WHERE vendor_id = $1 FOR UPDATE`,
        [vendorId],
      );
      if (!vendorRes.rowCount) {
        throw new HttpCommandError(404, "VENDOR_NOT_FOUND", `Vendor ${vendorId} is not registered.`);
      }

      const revisionRefs = await client.query(
        `SELECT engine_id FROM intentchord.internal_ai_engine_revisions
          WHERE vendor_id = $1 OR provider_id = $1 LIMIT 5`,
        [vendorId],
      );
      if ((revisionRefs.rowCount ?? 0) > 0) {
        throw new HttpCommandError(
          409,
          "DELETE_NOT_ALLOWED_RETIRE_REQUIRED",
          `Vendor ${vendorId} has historical Engine Revision provenance. Retire instead of hard delete.`,
        );
      }

      const selectionRefs = await client.query(
        `SELECT s.qualification_scope FROM intentchord.internal_ai_admin_selections s
          WHERE EXISTS (
            SELECT 1 FROM intentchord.internal_ai_engine_revisions r
             WHERE (r.vendor_id = $1 OR r.provider_id = $1)
               AND (
                 (r.engine_id = s.active_engine_id AND r.engine_config_revision = s.active_engine_config_revision)
                 OR (r.engine_id = s.standby_engine_id AND r.engine_config_revision = s.standby_engine_config_revision)
               )
          ) LIMIT 5`,
        [vendorId],
      );
      if ((selectionRefs.rowCount ?? 0) > 0) {
        throw new HttpCommandError(
          409,
          "ACTIVE_STANDBY_PROTECTION",
          `Vendor ${vendorId} is referenced by Active/Standby selection. Change or remove the selection before delete.`,
        );
      }

      const modelCount = await client.query(
        `SELECT count(*)::int AS c FROM intentchord.internal_ai_models WHERE vendor_id = $1`,
        [vendorId],
      );
      if (Number(modelCount.rows[0].c) > 0) {
        throw new HttpCommandError(
          409,
          "DELETE_NOT_ALLOWED_CHILDREN_EXIST",
          `Vendor ${vendorId} still has ${modelCount.rows[0].c} model(s). Delete unused models first, or Retire the Vendor.`,
        );
      }

      const credentialCount = await client.query(
        `SELECT count(*)::int AS c FROM intentchord.internal_ai_credentials WHERE vendor_id = $1`,
        [vendorId],
      );
      if (Number(credentialCount.rows[0].c) > 0) {
        throw new HttpCommandError(
          409,
          "DELETE_NOT_ALLOWED_CREDENTIAL_EXISTS",
          `Vendor ${vendorId} has governed credential metadata. Delete/revoke the credential first, or Retire the Vendor.`,
        );
      }

      await client.query(`DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`, [vendorId]);
      await recordVendorAuditEvent(client, {
        eventType: "VENDOR_DELETED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { vendorId },
      });
      return { vendorId, deleted: true as const };
    });
  }
}

export const internalAiVendorService = new InternalAiVendorService();
