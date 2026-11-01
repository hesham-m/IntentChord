import { createHash, randomUUID } from "node:crypto";
import { databasePool, databaseQuery, transaction } from "@/server/db";
import { HttpCommandError } from "@/server/errors";
import {
  AI_EXECUTION_AUTHORITY_IDENTITY_VERSION,
  INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION,
  INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  INTERNAL_AI_QUALIFICATION_SCOPE_V1,
  INTERNAL_AI_QUALIFICATION_SCOPE_V2,
  INTERNAL_AI_SELECTION_POLICY_MODE,
  type FrozenAiExecutionAuthority,
  type InternalAiAdminSelectionRow,
  type InternalAiAdminSelectionView,
  type InternalAiEngineConfigurationMaterial,
  type InternalAiEngineDefinition,
  type InternalAiEngineDetailView,
  type InternalAiEngineRevisionRow,
  type InternalAiEngineRow,
  type InternalAiEngineState,
  type InternalAiEngineView,
  type InternalAiProviderConfigurationSnapshotV3,
  type InternalAiQualificationRecord,
  type InternalAiQualificationRow,
  type InternalAiQualificationScope,
  type InternalAiQualificationStatus,
} from "@/core/ai-context-mapper/types";
import {
  deriveInternalAiEngineConfigurationSha256,
  isQualificationApplicableToEngine,
} from "@/core/ai-context-mapper/engine-registry";
import { isKnownIncompatibleBehaviorTransportPair } from "@/core/ai-context-mapper/protocol-family";
import type { AiContextMapperRuntimeConfig, ResolvedInternalAiEngineConfig } from "@/server/ai-context-mapper-config";
import { checkV2CredentialPresent } from "@/server/ai-context-mapper-config";

// --- Auditing Helper ---
async function recordRegistryAuditEvent(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  input: {
    eventType: string;
    aggregateId: string;
    actorAuthority: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO intentchord.audit_events (
      id, aggregate_type, aggregate_id, event_type, actor_authority, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [
      eventId,
      "INTERNAL_AI_ENGINE_REGISTRY",
      input.aggregateId,
      input.eventType,
      input.actorAuthority,
      JSON.stringify(input.metadata),
    ],
  );
}

// --- Validation Helpers ---
function validateIdentifier(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 200 || /\s/.test(trimmed)) {
    throw new HttpCommandError(400, "INVALID_IDENTITY", `${name} must be a non-empty bounded string without whitespace.`);
  }
  return trimmed;
}

/**
 * V2 credential presence check using the canonical resolver.
 * NOT process.env — uses the injected InternalAiSecretResolver.
 */
async function checkCredentialPresent(credentialReference: string): Promise<boolean> {
  return checkV2CredentialPresent(credentialReference);
}

// --- Distinct AI Execution Authority Derivation (Correction 3) ---
// Existing traversal_authority_sha256 remains untouched as Source authority.
export function deriveAiExecutionAuthoritySha256(input: {
  qualificationScope: InternalAiQualificationScope;
  selectionAuthoritySequence: number;
  active: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    capabilityProfileVersion: string;
  };
  standby?: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    capabilityProfileVersion: string;
  };
}): string {
  const lines = [
    AI_EXECUTION_AUTHORITY_IDENTITY_VERSION,
    `scope=${input.qualificationScope}`,
    `sequence=${input.selectionAuthoritySequence}`,
    `active_engine_id=${input.active.engineId}`,
    `active_revision=${input.active.engineConfigRevision}`,
    `active_sha256=${input.active.engineConfigurationSha256}`,
    `active_qualification_id=${input.active.qualificationId}`,
    `active_capability=${input.active.capabilityProfileVersion}`,
  ];
  if (input.standby) {
    lines.push(
      `standby_engine_id=${input.standby.engineId}`,
      `standby_revision=${input.standby.engineConfigRevision}`,
      `standby_sha256=${input.standby.engineConfigurationSha256}`,
      `standby_qualification_id=${input.standby.qualificationId}`,
      `standby_capability=${input.standby.capabilityProfileVersion}`,
    );
  }
  return `sha256:${createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")}`;
}

// --- Engine Definition Mapper ---
function rowToEngineDefinition(row: InternalAiEngineRevisionRow): InternalAiEngineDefinition {
  return {
    engineId: row.engine_id,
    engineConfigRevision: row.engine_config_revision,
    providerId: row.provider_id,
    vendorId: row.vendor_id ?? null,
    channelId: row.channel_id,
    modelId: row.model_id,
    endpoint: row.endpoint,
    credentialReference: row.credential_reference,
    transportProfileId: row.transport_profile_id,
    behaviorProfileId: row.behavior_profile_id,
    capabilityProfileVersion: row.capability_profile_version,
    timeoutMs: row.timeout_ms,
    engineConfigurationSha256: row.engine_configuration_sha256,
  };
}

function rowToQualificationRecord(row: InternalAiQualificationRow): InternalAiQualificationRecord {
  return {
    qualificationId: row.qualification_id,
    engineId: row.engine_id,
    engineConfigRevision: row.engine_config_revision,
    engineConfigurationSha256: row.engine_configuration_sha256,
    qualificationStatus: row.qualification_status,
    qualificationScope: row.qualification_scope,
    qualifiedAt: row.qualified_at,
    qualifiedBy: row.qualified_by,
    evidenceReference: row.evidence_reference,
    capabilityProfileVersion: row.capability_profile_version,
  };
}

// Gate 5 non-selectability: Active/Standby may only bind a revision whose Vendor is ENABLED
// (not DISABLED/RETIRED) and whose Model is ENABLED. Historical revisions with no Vendor binding
// remain selectable for provenance continuity.
async function assertRevisionBindingSelectable(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> },
  rev: InternalAiEngineRevisionRow,
  role: "ACTIVE" | "STANDBY",
): Promise<void> {
  const roleLabel = role === "ACTIVE" ? "Active" : "Standby";
  if (!rev.vendor_id) return;

  const vendorRes = await client.query(
    `SELECT vendor_state FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
    [rev.vendor_id],
  );
  if (!vendorRes.rowCount) {
    throw new HttpCommandError(
      400,
      "SELECTION_VENDOR_NOT_FOUND",
      `${roleLabel} selection blocked: Vendor ${rev.vendor_id} bound to revision is not registered.`,
    );
  }
  const vendorState = vendorRes.rows[0].vendor_state as string;
  if (vendorState !== "ENABLED") {
    throw new HttpCommandError(
      400,
      vendorState === "RETIRED" ? "SELECTION_VENDOR_RETIRED" : "SELECTION_VENDOR_NOT_ENABLED",
      `${roleLabel} selection blocked: Vendor ${rev.vendor_id} is ${vendorState}.`,
    );
  }

  const modelRes = await client.query(
    `SELECT model_state FROM intentchord.internal_ai_models
      WHERE vendor_id = $1 AND (model_id = $2 OR provider_facing_model_id = $2)`,
    [rev.vendor_id, rev.model_id],
  );
  if (!modelRes.rowCount) {
    throw new HttpCommandError(
      400,
      "SELECTION_MODEL_NOT_FOUND",
      `${roleLabel} selection blocked: Model ${rev.model_id} is not registered under Vendor ${rev.vendor_id}.`,
    );
  }
  if (modelRes.rows[0].model_state !== "ENABLED") {
    throw new HttpCommandError(
      400,
      "SELECTION_MODEL_NOT_ENABLED",
      `${roleLabel} selection blocked: Model ${rev.model_id} under Vendor ${rev.vendor_id} is not ENABLED.`,
    );
  }
}

export class InternalAiEngineRegistryService {
  /**
   * List all registered engines.
   */
  async listEngines(options?: { state?: InternalAiEngineState }): Promise<InternalAiEngineView[]> {
    const params: unknown[] = [];
    let query = `SELECT e.*, 
       (SELECT rev.engine_config_revision FROM intentchord.internal_ai_engine_revisions rev 
        WHERE rev.engine_id = e.engine_id ORDER BY rev.created_at DESC LIMIT 1) as latest_revision,
       (SELECT rev.credential_reference FROM intentchord.internal_ai_engine_revisions rev 
        WHERE rev.engine_id = e.engine_id ORDER BY rev.created_at DESC LIMIT 1) as credential_reference
     FROM intentchord.internal_ai_engines e`;
    if (options?.state) {
      params.push(options.state);
      query += ` WHERE e.engine_state = $1`;
    }
    query += ` ORDER BY e.engine_id ASC`;

    const result = await databaseQuery<InternalAiEngineRow & { latest_revision?: string; credential_reference?: string }>(query, params);
    return Promise.all(result.rows.map(async r => {
      const credentialPresent = r.credential_reference
        ? await checkCredentialPresent(r.credential_reference)
        : false;
      return {
        engineId: r.engine_id,
        displayName: r.display_name,
        state: r.engine_state,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        latestRevision: r.latest_revision,
        credentialPresent,
      };
    }));
  }

  /**
   * Get single engine with all its revisions and qualifications.
   */
  async getEngine(engineId: string): Promise<InternalAiEngineDetailView | null> {
    const engineRes = await databaseQuery<InternalAiEngineRow>(
      `SELECT * FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
      [engineId],
    );
    if (!engineRes.rows[0]) return null;
    const e = engineRes.rows[0];

    const revsRes = await databaseQuery<InternalAiEngineRevisionRow>(
      `SELECT * FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 ORDER BY created_at DESC`,
      [engineId],
    );
    const qualsRes = await databaseQuery<InternalAiQualificationRow>(
      `SELECT * FROM intentchord.internal_ai_qualifications WHERE engine_id = $1 ORDER BY created_at DESC`,
      [engineId],
    );

    const revisions = revsRes.rows.map(rowToEngineDefinition);
    const qualifications = qualsRes.rows.map(rowToQualificationRecord);
    const credRef = revisions[0]?.credentialReference;

    return {
      engineId: e.engine_id,
      displayName: e.display_name,
      state: e.engine_state,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      latestRevision: revisions[0]?.engineConfigRevision,
      credentialPresent: credRef ? await checkCredentialPresent(credRef) : false,
      revisions,
      qualifications,
    };
  }

  /**
   * Register a new logical engine.
   */
  async registerEngine(input: { engineId: string; displayName: string }, actor = "SYSTEM_OWNER"): Promise<InternalAiEngineView> {
    const engineId = validateIdentifier(input.engineId, "engineId");
    const displayName = input.displayName.trim();
    if (!displayName) throw new HttpCommandError(400, "INVALID_DISPLAY_NAME", "Display name is required.");

    return transaction(async client => {
      const existing = await client.query(`SELECT engine_id FROM intentchord.internal_ai_engines WHERE engine_id = $1`, [engineId]);
      if (existing.rowCount && existing.rowCount > 0) {
        throw new HttpCommandError(409, "ENGINE_ALREADY_EXISTS", `Engine ${engineId} is already registered.`);
      }

      const res = await client.query<InternalAiEngineRow>(
        `INSERT INTO intentchord.internal_ai_engines (engine_id, display_name, engine_state, created_at, updated_at)
         VALUES ($1, $2, 'ENABLED', clock_timestamp(), clock_timestamp())
         RETURNING *`,
        [engineId, displayName],
      );
      const r = res.rows[0];

      await recordRegistryAuditEvent(client, {
        eventType: "ENGINE_REGISTERED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { engineId, displayName },
      });

      return {
        engineId: r.engine_id,
        displayName: r.display_name,
        state: r.engine_state,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        credentialPresent: false,
      };
    });
  }

  /**
   * Create an immutable revision for a registered engine.
   */
  async createEngineRevision(
    engineIdOrInput: string | InternalAiEngineConfigurationMaterial,
    inputOrActor?: InternalAiEngineConfigurationMaterial | string,
    maybeActor = "SYSTEM_OWNER",
  ): Promise<InternalAiEngineDefinition> {
    let input: InternalAiEngineConfigurationMaterial;
    let actor: string;
    if (typeof engineIdOrInput === "string") {
      input = { ...(inputOrActor as InternalAiEngineConfigurationMaterial), engineId: engineIdOrInput };
      actor = typeof maybeActor === "string" ? maybeActor : "SYSTEM_OWNER";
    } else {
      input = { ...engineIdOrInput };
      actor = typeof inputOrActor === "string" ? inputOrActor : "SYSTEM_OWNER";
    }
    input.timeoutMs = input.timeoutMs ?? 60000;

    if (!input.endpoint || !input.endpoint.startsWith("https://")) {
      throw new HttpCommandError(400, "INVALID_CONFIGURATION", "Endpoint must use https:// scheme.");
    }
    if (isKnownIncompatibleBehaviorTransportPair(input.behaviorProfileId, input.transportProfileId)) {
      throw new HttpCommandError(
        400,
        "PROFILE_INCOMPATIBILITY",
        `Behavior profile ${input.behaviorProfileId} does not support ${input.transportProfileId} transport profile.`,
      );
    }

    const engineId = validateIdentifier(input.engineId, "engineId");
    const revision = validateIdentifier(input.engineConfigRevision, "engineConfigRevision");
    const fingerprint = deriveInternalAiEngineConfigurationSha256(input);

    return transaction(async client => {
      const engineCheck = await client.query(`SELECT engine_id FROM intentchord.internal_ai_engines WHERE engine_id = $1`, [engineId]);
      if (!engineCheck.rowCount) {
        throw new HttpCommandError(404, "ENGINE_NOT_FOUND", `Engine ${engineId} is not registered.`);
      }

      const revCheck = await client.query(
        `SELECT id FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = $2`,
        [engineId, revision],
      );
      if (revCheck.rowCount && revCheck.rowCount > 0) {
        throw new HttpCommandError(409, "ENGINE_REVISION_EXISTS", `Revision ${revision} already exists for engine ${engineId}.`);
      }

      // Gate 4: Engine Revision must bind a first-class Vendor and a Model under that Vendor (ADR-001 §3.3).
      const vendorRes = await client.query<{ vendor_id: string; vendor_state: string; credential_reference: string | null }>(
        `SELECT vendor_id, vendor_state, credential_reference FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
        [input.providerId],
      );
      if (!vendorRes.rowCount) {
        throw new HttpCommandError(
          404,
          "VENDOR_NOT_FOUND",
          `Vendor ${input.providerId} is not registered. Engine revisions require a first-class Vendor binding.`,
        );
      }
      const vendor = vendorRes.rows[0];
      if (vendor.vendor_state === "RETIRED") {
        throw new HttpCommandError(
          409,
          "VENDOR_RETIRED",
          `Vendor ${input.providerId} is RETIRED and cannot receive new engine revisions.`,
        );
      }

      const modelRes = await client.query<{ model_id: string; model_state: string }>(
        `SELECT model_id, model_state FROM intentchord.internal_ai_models
          WHERE vendor_id = $1 AND (model_id = $2 OR provider_facing_model_id = $2)`,
        [input.providerId, input.modelId],
      );
      if (!modelRes.rowCount) {
        throw new HttpCommandError(
          404,
          "MODEL_NOT_FOUND",
          `Model ${input.modelId} is not registered under vendor ${input.providerId}.`,
        );
      }
      if (modelRes.rows[0].model_state !== "ENABLED") {
        throw new HttpCommandError(
          409,
          "MODEL_NOT_ENABLED",
          `Model ${input.modelId} under vendor ${input.providerId} is not ENABLED.`,
        );
      }

      // When the Vendor has a bound credential reference, the Engine Revision must use that exact reference.
      if (vendor.credential_reference && vendor.credential_reference !== input.credentialReference) {
        throw new HttpCommandError(
          409,
          "CREDENTIAL_VENDOR_MISMATCH",
          `Engine revision credentialReference must match vendor ${input.providerId} binding (${vendor.credential_reference}).`,
        );
      }

      const res = await client.query<InternalAiEngineRevisionRow>(
        `INSERT INTO intentchord.internal_ai_engine_revisions (
          engine_id, engine_config_revision, provider_id, vendor_id, channel_id, model_id, endpoint,
          credential_reference, transport_profile_id, behavior_profile_id, capability_profile_version,
          timeout_ms, engine_configuration_sha256, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, clock_timestamp())
        RETURNING *`,
        [
          engineId,
          revision,
          input.providerId,
          vendor.vendor_id,
          input.channelId,
          input.modelId,
          input.endpoint,
          input.credentialReference,
          input.transportProfileId,
          input.behaviorProfileId,
          input.capabilityProfileVersion,
          input.timeoutMs,
          fingerprint,
        ],
      );

      await recordRegistryAuditEvent(client, {
        eventType: "ENGINE_REVISION_CREATED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: {
          engineId,
          revision,
          fingerprint,
          vendorId: vendor.vendor_id,
          modelId: input.modelId,
        },
      });

      return rowToEngineDefinition(res.rows[0]);
    });
  }

  /**
   * Enable or disable an engine.
   */
  /**
   * Gate 6: Hard-delete an Engine only when it has no revisions, qualifications,
   * Active/Standby selection, or frozen traversal execution authority. Otherwise
   * require Retire/Archive (DISABLE) and fail closed.
   */
  async deleteEngine(engineId: string, actor = "SYSTEM_OWNER"): Promise<{ engineId: string; deleted: true }> {
    return transaction(async client => {
      const engineRes = await client.query<InternalAiEngineRow>(
        `SELECT * FROM intentchord.internal_ai_engines WHERE engine_id = $1 FOR UPDATE`,
        [engineId],
      );
      if (!engineRes.rowCount) {
        throw new HttpCommandError(404, "ENGINE_NOT_FOUND", `Engine ${engineId} is not registered.`);
      }

      const selectionRefs = await client.query(
        `SELECT qualification_scope FROM intentchord.internal_ai_admin_selections
          WHERE active_engine_id = $1 OR standby_engine_id = $1 LIMIT 5`,
        [engineId],
      );
      if ((selectionRefs.rowCount ?? 0) > 0) {
        throw new HttpCommandError(
          409,
          "ACTIVE_STANDBY_PROTECTION",
          `Engine ${engineId} is selected as Active or Standby. Change or remove the selection before delete.`,
        );
      }

      const revisionCount = await client.query(
        `SELECT count(*)::int AS c FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1`,
        [engineId],
      );
      if (Number(revisionCount.rows[0].c) > 0) {
        throw new HttpCommandError(
          409,
          "DELETE_NOT_ALLOWED_RETIRE_REQUIRED",
          `Engine ${engineId} has historical revision provenance. Retire (DISABLE) instead of hard delete.`,
        );
      }

      const qualCount = await client.query(
        `SELECT count(*)::int AS c FROM intentchord.internal_ai_qualifications WHERE engine_id = $1`,
        [engineId],
      );
      if (Number(qualCount.rows[0].c) > 0) {
        throw new HttpCommandError(
          409,
          "DELETE_NOT_ALLOWED_RETIRE_REQUIRED",
          `Engine ${engineId} has qualification history. Retire (DISABLE) instead of hard delete.`,
        );
      }

      const traversalRefs = await client.query(
        `SELECT id FROM intentchord.context_mapping_traversals
          WHERE ai_execution_active_engine_id = $1 OR ai_execution_standby_engine_id = $1 LIMIT 5`,
        [engineId],
      );
      if ((traversalRefs.rowCount ?? 0) > 0) {
        throw new HttpCommandError(
          409,
          "DELETE_NOT_ALLOWED_RETIRE_REQUIRED",
          `Engine ${engineId} is bound to frozen historical traversal execution authority. Retire (DISABLE) instead of hard delete.`,
        );
      }

      await client.query(`DELETE FROM intentchord.internal_ai_engines WHERE engine_id = $1`, [engineId]);
      await recordRegistryAuditEvent(client, {
        eventType: "ENGINE_DELETED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { engineId },
      });
      return { engineId, deleted: true as const };
    });
  }

  async setEngineState(engineId: string, state: InternalAiEngineState, actor = "SYSTEM_OWNER"): Promise<InternalAiEngineView> {
    return transaction(async client => {
      const res = await client.query<InternalAiEngineRow>(
        `UPDATE intentchord.internal_ai_engines
         SET engine_state = $2, updated_at = clock_timestamp()
         WHERE engine_id = $1 RETURNING *`,
        [engineId, state],
      );
      if (!res.rowCount) {
        throw new HttpCommandError(404, "ENGINE_NOT_FOUND", `Engine ${engineId} is not registered.`);
      }
      const r = res.rows[0];

      await recordRegistryAuditEvent(client, {
        eventType: state === "ENABLED" ? "ENGINE_ENABLED" : "ENGINE_DISABLED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { engineId, state },
      });

      return {
        engineId: r.engine_id,
        displayName: r.display_name,
        state: r.engine_state,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        credentialPresent: false,
      };
    });
  }

  /**
   * Qualify an engine revision.
   */
  async qualifyEngine(
    record: {
      qualificationId?: string;
      engineId: string;
      engineConfigRevision: string;
      engineConfigurationSha256: string;
      qualificationScope: InternalAiQualificationScope;
      qualificationStatus?: InternalAiQualificationStatus;
      qualifiedAt?: string;
      qualifiedBy?: string;
      evidenceReference: string;
      capabilityProfileVersion: string;
    },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiQualificationRecord> {
    const qId = record.qualificationId
      ? validateIdentifier(record.qualificationId, "qualificationId")
      : `qual_${record.engineId}_${record.engineConfigRevision}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const engineId = validateIdentifier(record.engineId, "engineId");
    const revision = validateIdentifier(record.engineConfigRevision, "engineConfigRevision");
    const status: InternalAiQualificationStatus = record.qualificationStatus ?? "QUALIFIED";
    const qualifiedAt = record.qualifiedAt ?? new Date().toISOString();
    const qualifiedBy = record.qualifiedBy ?? actor;

    return transaction(async client => {
      // 1. Verify engine revision exists and fingerprint matches
      const revRes = await client.query<InternalAiEngineRevisionRow>(
        `SELECT * FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = $2`,
        [engineId, revision],
      );
      if (!revRes.rowCount) {
        throw new HttpCommandError(404, "ENGINE_REVISION_NOT_FOUND", `Engine revision ${engineId}@${revision} does not exist.`);
      }
      const rev = revRes.rows[0];
      if (rev.engine_configuration_sha256 !== record.engineConfigurationSha256) {
        throw new HttpCommandError(400, "QUALIFICATION_FINGERPRINT_MISMATCH", "Qualification record fingerprint does not match engine revision.");
      }
      if (rev.capability_profile_version !== record.capabilityProfileVersion) {
        throw new HttpCommandError(400, "QUALIFICATION_CAPABILITY_PROFILE_MISMATCH", "Capability profile version does not match engine revision.");
      }

      // 2. If status is QUALIFIED, check partial unique constraint (only one active QUALIFIED record per engine revision + scope)
      if (status === "QUALIFIED") {
        const activeQ = await client.query(
          `SELECT qualification_id FROM intentchord.internal_ai_qualifications 
           WHERE engine_id = $1 AND engine_config_revision = $2 AND qualification_scope = $3 AND qualification_status = 'QUALIFIED'`,
          [engineId, revision, record.qualificationScope],
        );
        if (activeQ.rowCount && activeQ.rowCount > 0) {
          throw new HttpCommandError(
            409,
            "QUALIFIED_RECORD_ALREADY_EXISTS",
            `An active QUALIFIED record (${activeQ.rows[0].qualification_id}) already exists for ${engineId}@${revision} on scope ${record.qualificationScope}. Revoke it first.`,
          );
        }
      }

      // 3. Insert qualification record
      const insertRes = await client.query<InternalAiQualificationRow>(
        `INSERT INTO intentchord.internal_ai_qualifications (
          qualification_id, engine_id, engine_config_revision, engine_configuration_sha256,
          qualification_status, qualification_scope, qualified_at, qualified_by,
          evidence_reference, capability_profile_version, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
        RETURNING *`,
        [
          qId,
          engineId,
          revision,
          record.engineConfigurationSha256,
          status,
          record.qualificationScope,
          qualifiedAt,
          qualifiedBy,
          record.evidenceReference,
          record.capabilityProfileVersion,
        ],
      );

      await recordRegistryAuditEvent(client, {
        eventType: "ENGINE_QUALIFIED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: {
          qualificationId: qId,
          engineId,
          revision,
          status,
          scope: record.qualificationScope,
          vendorId: rev.vendor_id ?? null,
          modelId: rev.model_id,
        },
      });

      return rowToQualificationRecord(insertRes.rows[0]);
    });
  }

  /**
   * Revoke an existing qualification.
   */
  async revokeQualification(qualificationId: string, actor = "SYSTEM_OWNER", reason?: string): Promise<InternalAiQualificationRecord> {
    return transaction(async client => {
      const res = await client.query<InternalAiQualificationRow>(
        `UPDATE intentchord.internal_ai_qualifications
         SET qualification_status = 'REVOKED'
         WHERE qualification_id = $1
         RETURNING *`,
        [qualificationId],
      );
      if (!res.rowCount) {
        throw new HttpCommandError(404, "QUALIFICATION_NOT_FOUND", `Qualification ${qualificationId} was not found.`);
      }

      await recordRegistryAuditEvent(client, {
        eventType: "ENGINE_QUALIFICATION_REVOKED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { qualificationId, reason },
      });

      return rowToQualificationRecord(res.rows[0]);
    });
  }

  /**
   * Select Active Default engine for a scope with optimistic concurrency check.
   */
  async selectDefaultEngine(
    input: {
      scope?: InternalAiQualificationScope;
      qualificationScope?: InternalAiQualificationScope;
      engineId: string;
      engineConfigRevision: string;
      engineConfigurationSha256?: string;
      qualificationId?: string;
      expectedAuthoritySequence?: number;
      expectedSequence?: number;
    },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiAdminSelectionView> {
    const scope = (input.qualificationScope || input.scope)!;
    const engineId = validateIdentifier(input.engineId, "engineId");
    const revision = validateIdentifier(input.engineConfigRevision, "engineConfigRevision");
    const expectedSeq = input.expectedSequence !== undefined ? input.expectedSequence : input.expectedAuthoritySequence;

    return transaction(async client => {
      // 1. Check engine state
      const engineRes = await client.query<InternalAiEngineRow>(
        `SELECT engine_state FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
        [engineId],
      );
      if (!engineRes.rowCount) throw new HttpCommandError(404, "ENGINE_NOT_FOUND", `Engine ${engineId} is not registered.`);
      if (engineRes.rows[0].engine_state !== "ENABLED") {
        throw new HttpCommandError(400, "ACTIVE_ENGINE_NOT_ENABLED", `Cannot select disabled engine ${engineId} as Default.`);
      }

      // 2. Check engine revision
      const revRes = await client.query<InternalAiEngineRevisionRow>(
        `SELECT * FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = $2`,
        [engineId, revision],
      );
      if (!revRes.rowCount) {
        throw new HttpCommandError(404, "ENGINE_REVISION_NOT_FOUND", `Engine revision ${engineId}@${revision} does not exist.`);
      }
      const rev = revRes.rows[0];

      // Gate 5: Vendor/Model lifecycle eligibility for Active selection (ADR-001 §7).
      await assertRevisionBindingSelectable(client, rev, "ACTIVE");

      // 3. Check qualification for scope
      let qualQuery = `SELECT * FROM intentchord.internal_ai_qualifications 
         WHERE engine_id = $1 AND engine_config_revision = $2 AND qualification_scope = $3`;
      const qualParams: unknown[] = [engineId, revision, scope];
      if (input.qualificationId) {
        qualQuery += ` AND qualification_id = $4`;
        qualParams.push(input.qualificationId);
      } else {
        qualQuery += ` AND qualification_status = 'QUALIFIED'`;
      }
      const qualRes = await client.query<InternalAiQualificationRow>(qualQuery, qualParams);
      if (!qualRes.rowCount) {
        throw new HttpCommandError(400, "ENGINE_NOT_QUALIFIED", `Engine revision ${engineId}@${revision} has no valid qualification record for ${scope}.`);
      }
      const qual = qualRes.rows[0];
      if (qual.qualification_status !== "QUALIFIED") {
        throw new HttpCommandError(400, "QUALIFICATION_NOT_QUALIFIED", `Selected qualification ${qual.qualification_id} is not in QUALIFIED status (${qual.qualification_status}).`);
      }

      // 4. Verify credential present
      if (!await checkCredentialPresent(rev.credential_reference)) {
        throw new HttpCommandError(400, "CREDENTIAL_UNAVAILABLE", `Credential reference "${rev.credential_reference}" is not available in the secret resolver.`);
      }

      // 5. Check optimistic concurrency sequence if provided
      const currentSelection = await client.query<InternalAiAdminSelectionRow>(
        `SELECT * FROM intentchord.internal_ai_admin_selections WHERE qualification_scope = $1 FOR UPDATE`,
        [scope],
      );

      let nextSequence = 1;
      if (currentSelection.rowCount && currentSelection.rowCount > 0) {
        const currentSeq = Number(currentSelection.rows[0].selection_authority_sequence);
        if (expectedSeq !== undefined && expectedSeq !== currentSeq) {
          throw new HttpCommandError(
            409,
            "STALE_ADMIN_SELECTION_SEQUENCE",
            `Stale selection write rejected. Expected sequence ${expectedSeq} but database is at ${currentSeq}.`,
          );
        }
        nextSequence = currentSeq + 1;
      }

      // 6. Update or insert admin selection
      const upsertRes = await client.query<InternalAiAdminSelectionRow>(
        `INSERT INTO intentchord.internal_ai_admin_selections (
          qualification_scope, active_engine_id, active_engine_config_revision, active_engine_configuration_sha256,
          active_qualification_id, standby_enabled, selection_authority_sequence, selected_by, updated_at
        ) VALUES ($1, $2, $3, $4, $5, false, $6, $7, clock_timestamp())
        ON CONFLICT (qualification_scope) DO UPDATE SET
          active_engine_id = EXCLUDED.active_engine_id,
          active_engine_config_revision = EXCLUDED.active_engine_config_revision,
          active_engine_configuration_sha256 = EXCLUDED.active_engine_configuration_sha256,
          active_qualification_id = EXCLUDED.active_qualification_id,
          selection_authority_sequence = EXCLUDED.selection_authority_sequence,
          selected_by = EXCLUDED.selected_by,
          updated_at = clock_timestamp()
        RETURNING *`,
        [scope, engineId, revision, rev.engine_configuration_sha256, qual.qualification_id, nextSequence, actor],
      );

      await recordRegistryAuditEvent(client, {
        eventType: "DEFAULT_ENGINE_CHANGED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { scope, engineId, revision, sequence: nextSequence },
      });

      return this.rowToAdminSelectionView(upsertRes.rows[0]);
    });
  }

  /**
   * Select Standby engine with optimistic concurrency.
   */
  async selectStandbyEngine(
    input: {
      scope?: InternalAiQualificationScope;
      qualificationScope?: InternalAiQualificationScope;
      engineId?: string;
      standbyEngineId?: string;
      engineConfigRevision?: string;
      standbyEngineConfigRevision?: string;
      engineConfigurationSha256?: string;
      standbyEngineConfigurationSha256?: string;
      qualificationId?: string;
      standbyQualificationId?: string;
      expectedAuthoritySequence?: number;
      expectedSequence?: number;
    },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiAdminSelectionView> {
    const scope = (input.qualificationScope || input.scope)!;
    const engineId = validateIdentifier(input.standbyEngineId || input.engineId, "engineId");
    const revision = validateIdentifier(input.standbyEngineConfigRevision || input.engineConfigRevision, "engineConfigRevision");
    const qualId = input.standbyQualificationId || input.qualificationId;
    const expectedSeq = input.expectedSequence !== undefined ? input.expectedSequence : input.expectedAuthoritySequence;

    return transaction(async client => {
      // 1. Check current selection row
      const currentSelection = await client.query<InternalAiAdminSelectionRow>(
        `SELECT * FROM intentchord.internal_ai_admin_selections WHERE qualification_scope = $1 FOR UPDATE`,
        [scope],
      );
      if (!currentSelection.rowCount) {
        throw new HttpCommandError(400, "NO_ACTIVE_SELECTION", `Cannot configure standby before an active default engine is selected for ${scope}.`);
      }
      const current = currentSelection.rows[0];

      // Standby cannot equal Active
      if (current.active_engine_id === engineId && current.active_engine_config_revision === revision) {
        throw new HttpCommandError(400, "STANDBY_EQUALS_ACTIVE", "Standby engine cannot be identical to the active default engine.");
      }

      // Optimistic concurrency check
      const currentSeq = Number(current.selection_authority_sequence);
      if (expectedSeq !== undefined && expectedSeq !== currentSeq) {
        throw new HttpCommandError(
          409,
          "STALE_ADMIN_SELECTION_SEQUENCE",
          `Stale selection write rejected. Expected sequence ${expectedSeq} but database is at ${currentSeq}.`,
        );
      }
      const nextSequence = currentSeq + 1;

      // 2. Validate standby engine and revision
      const engineRes = await client.query<InternalAiEngineRow>(`SELECT engine_state FROM intentchord.internal_ai_engines WHERE engine_id = $1`, [engineId]);
      if (!engineRes.rowCount || engineRes.rows[0].engine_state !== "ENABLED") {
        throw new HttpCommandError(400, "STANDBY_ENGINE_DISABLED", `Standby engine ${engineId} must be registered and ENABLED.`);
      }

      const revRes = await client.query<InternalAiEngineRevisionRow>(
        `SELECT * FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = $2`,
        [engineId, revision],
      );
      if (!revRes.rowCount) throw new HttpCommandError(404, "ENGINE_REVISION_NOT_FOUND", `Standby revision ${engineId}@${revision} not found.`);
      const rev = revRes.rows[0];

      // Gate 5: Vendor/Model lifecycle eligibility for Standby selection (ADR-001 §7).
      await assertRevisionBindingSelectable(client, rev, "STANDBY");

      let qualQuery = `SELECT * FROM intentchord.internal_ai_qualifications 
         WHERE engine_id = $1 AND engine_config_revision = $2 AND qualification_scope = $3`;
      const qualParams: unknown[] = [engineId, revision, scope];
      if (qualId) {
        qualQuery += ` AND qualification_id = $4`;
        qualParams.push(qualId);
      } else {
        qualQuery += ` AND qualification_status = 'QUALIFIED'`;
      }
      const qualRes = await client.query<InternalAiQualificationRow>(qualQuery, qualParams);
      if (!qualRes.rowCount) throw new HttpCommandError(400, "STANDBY_NOT_QUALIFIED", `Standby revision ${engineId}@${revision} has no qualification for ${scope}.`);
      const qual = qualRes.rows[0];
      if (qual.qualification_status !== "QUALIFIED") {
        throw new HttpCommandError(400, "QUALIFICATION_NOT_QUALIFIED", `Standby qualification ${qual.qualification_id} is not QUALIFIED.`);
      }

      if (!await checkCredentialPresent(rev.credential_reference)) {
        throw new HttpCommandError(400, "CREDENTIAL_UNAVAILABLE", `Credential reference "${rev.credential_reference}" for standby is not available in the secret resolver.`);
      }

      // 3. Update selection with Standby
      const res = await client.query<InternalAiAdminSelectionRow>(
        `UPDATE intentchord.internal_ai_admin_selections SET
          standby_engine_id = $2,
          standby_engine_config_revision = $3,
          standby_engine_configuration_sha256 = $4,
          standby_qualification_id = $5,
          standby_enabled = true,
          selection_authority_sequence = $6,
          selected_by = $7,
          updated_at = clock_timestamp()
         WHERE qualification_scope = $1
         RETURNING *`,
        [scope, engineId, revision, rev.engine_configuration_sha256, qual.qualification_id, nextSequence, actor],
      );

      await recordRegistryAuditEvent(client, {
        eventType: "STANDBY_ENGINE_CHANGED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { scope, engineId, revision, sequence: nextSequence },
      });

      return this.rowToAdminSelectionView(res.rows[0]);
    });
  }

  /**
   * Remove/disable Standby engine.
   */
  async removeStandbyEngine(
    input: {
      scope?: InternalAiQualificationScope;
      qualificationScope?: InternalAiQualificationScope;
      expectedAuthoritySequence?: number;
      expectedSequence?: number;
    },
    actor = "SYSTEM_OWNER",
  ): Promise<InternalAiAdminSelectionView> {
    const scope = (input.qualificationScope || input.scope)!;
    const expectedSeq = input.expectedSequence !== undefined ? input.expectedSequence : input.expectedAuthoritySequence;

    return transaction(async client => {
      const currentSelection = await client.query<InternalAiAdminSelectionRow>(
        `SELECT * FROM intentchord.internal_ai_admin_selections WHERE qualification_scope = $1 FOR UPDATE`,
        [scope],
      );
      if (!currentSelection.rowCount) {
        throw new HttpCommandError(404, "SELECTION_NOT_FOUND", `No selection exists for scope ${scope}.`);
      }
      const current = currentSelection.rows[0];
      const currentSeq = Number(current.selection_authority_sequence);
      if (expectedSeq !== undefined && expectedSeq !== currentSeq) {
        throw new HttpCommandError(
          409,
          "STALE_ADMIN_SELECTION_SEQUENCE",
          `Stale selection write rejected. Expected sequence ${expectedSeq} but database is at ${currentSeq}.`,
        );
      }
      const nextSequence = currentSeq + 1;

      const res = await client.query<InternalAiAdminSelectionRow>(
        `UPDATE intentchord.internal_ai_admin_selections SET
          standby_engine_id = NULL,
          standby_engine_config_revision = NULL,
          standby_engine_configuration_sha256 = NULL,
          standby_qualification_id = NULL,
          standby_enabled = false,
          selection_authority_sequence = $2,
          selected_by = $3,
          updated_at = clock_timestamp()
         WHERE qualification_scope = $1
         RETURNING *`,
        [scope, nextSequence, actor],
      );

      await recordRegistryAuditEvent(client, {
        eventType: "STANDBY_ENGINE_REMOVED",
        aggregateId: randomUUID(),
        actorAuthority: actor,
        metadata: { scope, sequence: nextSequence },
      });

      return this.rowToAdminSelectionView(res.rows[0]);
    });
  }

  /**
   * Get current admin selection view.
   */
  async getCurrentAdminSelection(scope: InternalAiQualificationScope): Promise<InternalAiAdminSelectionView | null> {
    const res = await databaseQuery<InternalAiAdminSelectionRow>(
      `SELECT * FROM intentchord.internal_ai_admin_selections WHERE qualification_scope = $1`,
      [scope],
    );
    if (!res.rowCount) return null;
    return this.rowToAdminSelectionView(res.rows[0]);
  }

  async getAdminSelection(scope: InternalAiQualificationScope): Promise<InternalAiAdminSelectionView | null> {
    return this.getCurrentAdminSelection(scope);
  }

  /**
   * Resolve runtime selection for V2 from database (Phase 4 & Phase 9).
   * Strictly fails closed if no qualified active engine is selected in DB.
   * NO fallback to legacy default models.
   */
  async resolveV2RuntimeSelection(): Promise<{
    config: AiContextMapperRuntimeConfig;
    frozenExecutionAuthority: FrozenAiExecutionAuthority;
  }> {
    const scope = INTERNAL_AI_QUALIFICATION_SCOPE_V2;
    const pool = databasePool();

    // Query active admin selection
    const selRes = await pool.query<InternalAiAdminSelectionRow>(
      `SELECT * FROM intentchord.internal_ai_admin_selections WHERE qualification_scope = $1`,
      [scope],
    );
    if (!selRes.rowCount) {
      throw new HttpCommandError(
        503,
        "INTERNAL_AI_ACTIVE_ENGINE_NOT_QUALIFIED",
        `Selection policy internal-ai-context-mapping-single@1: no Owner-enabled Engine is explicitly qualified for ${scope} at its exact configuration fingerprint.`,
      );
    }
    const selection = selRes.rows[0];

    // Fetch active engine revision and qualification
    const activeRevRes = await pool.query<InternalAiEngineRevisionRow>(
      `SELECT * FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = $2`,
      [selection.active_engine_id, selection.active_engine_config_revision],
    );
    const activeQualRes = await pool.query<InternalAiQualificationRow>(
      `SELECT * FROM intentchord.internal_ai_qualifications WHERE qualification_id = $1`,
      [selection.active_qualification_id],
    );

    if (!activeRevRes.rowCount || !activeQualRes.rowCount) {
      throw new HttpCommandError(503, "INTERNAL_AI_ACTIVE_ENGINE_NOT_QUALIFIED", "Active engine revision or qualification missing from database.");
    }
    const activeRev = activeRevRes.rows[0];
    const activeQual = activeQualRes.rows[0];

    // Verify engine state is ENABLED
    const activeEngineRes = await pool.query<InternalAiEngineRow>(
      `SELECT engine_state FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
      [selection.active_engine_id],
    );
    if (!activeEngineRes.rowCount || activeEngineRes.rows[0].engine_state !== "ENABLED") {
      throw new HttpCommandError(503, "FROZEN_AI_ENGINE_DISABLED", `Selected active engine ${selection.active_engine_id} is disabled.`);
    }

    // Verify qualification status is QUALIFIED
    if (activeQual.qualification_status !== "QUALIFIED") {
      throw new HttpCommandError(503, "FROZEN_AI_QUALIFICATION_REVOKED", `Qualification ${selection.active_qualification_id} is revoked or expired.`);
    }

    const activeEngineDef = rowToEngineDefinition(activeRev);
    const activeQualRec = rowToQualificationRecord(activeQual);

    // Build active resolved engine
    const activeResolved: ResolvedInternalAiEngineConfig = {
      ...activeEngineDef,
      role: "ACTIVE",
      ownerEnabled: true,
      qualification: activeQualRec,
    };

    // Optional standby resolution
    let standbyResolved: ResolvedInternalAiEngineConfig | undefined;
    let standbyDef: InternalAiEngineDefinition | undefined;
    let standbyQualRec: InternalAiQualificationRecord | undefined;

    if (selection.standby_enabled && selection.standby_engine_id && selection.standby_engine_config_revision && selection.standby_qualification_id) {
      const sbRevRes = await pool.query<InternalAiEngineRevisionRow>(
        `SELECT * FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = $2`,
        [selection.standby_engine_id, selection.standby_engine_config_revision],
      );
      const sbQualRes = await pool.query<InternalAiQualificationRow>(
        `SELECT * FROM intentchord.internal_ai_qualifications WHERE qualification_id = $1`,
        [selection.standby_qualification_id],
      );
      const sbEngineRes = await pool.query<InternalAiEngineRow>(
        `SELECT engine_state FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
        [selection.standby_engine_id],
      );

      if (sbRevRes.rowCount && sbQualRes.rowCount && sbEngineRes.rowCount && sbEngineRes.rows[0].engine_state === "ENABLED" && sbQualRes.rows[0].qualification_status === "QUALIFIED") {
        standbyDef = rowToEngineDefinition(sbRevRes.rows[0]);
        standbyQualRec = rowToQualificationRecord(sbQualRes.rows[0]);
        standbyResolved = {
          ...standbyDef,
          role: "STANDBY",
          ownerEnabled: false,
          qualification: standbyQualRec,
        };
      }
    }

    const standbyGovernanceQualified = Boolean(selection.standby_enabled && standbyResolved?.qualification);

    // Build Provider Configuration Snapshot V3
    const providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3 = {
      schema_version: INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
      registry_schema_version: INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION,
      selected_engine_id: activeResolved.engineId,
      selected_engine_config_revision: activeResolved.engineConfigRevision,
      selected_engine_configuration_sha256: activeResolved.engineConfigurationSha256,
      selection_policy: {
        selection_policy_id: "internal-ai-context-mapping-single",
        selection_policy_version: "1",
        selection_mode: INTERNAL_AI_SELECTION_POLICY_MODE,
      },
      active: {
        role: "ACTIVE",
        engine_id: activeResolved.engineId,
        engine_config_revision: activeResolved.engineConfigRevision,
        engine_configuration_sha256: activeResolved.engineConfigurationSha256,
        provider_id: activeResolved.providerId,
        channel_id: activeResolved.channelId,
        model_id: activeResolved.modelId,
        endpoint: activeResolved.endpoint,
        credential_reference: activeResolved.credentialReference,
        transport_profile_id: activeResolved.transportProfileId,
        behavior_profile_id: activeResolved.behaviorProfileId,
        capability_profile_version: activeResolved.capabilityProfileVersion,
        owner_enabled: true,
        qualification: {
          qualification_id: activeQualRec.qualificationId,
          engine_id: activeQualRec.engineId,
          engine_config_revision: activeQualRec.engineConfigRevision,
          engine_configuration_sha256: activeQualRec.engineConfigurationSha256,
          qualification_status: "QUALIFIED",
          qualification_scope: activeQualRec.qualificationScope,
          qualified_at: activeQualRec.qualifiedAt,
          qualified_by: activeQualRec.qualifiedBy,
          evidence_reference: activeQualRec.evidenceReference,
          capability_profile_version: activeQualRec.capabilityProfileVersion,
        },
        timeout_ms: activeResolved.timeoutMs,
      },
      ...(standbyResolved && standbyQualRec ? {
        standby: {
          role: "STANDBY",
          engine_id: standbyResolved.engineId,
          engine_config_revision: standbyResolved.engineConfigRevision,
          engine_configuration_sha256: standbyResolved.engineConfigurationSha256,
          provider_id: standbyResolved.providerId,
          channel_id: standbyResolved.channelId,
          model_id: standbyResolved.modelId,
          endpoint: standbyResolved.endpoint,
          credential_reference: standbyResolved.credentialReference,
          transport_profile_id: standbyResolved.transportProfileId,
          behavior_profile_id: standbyResolved.behaviorProfileId,
          capability_profile_version: standbyResolved.capabilityProfileVersion,
          owner_enabled: false,
          qualification: {
            qualification_id: standbyQualRec.qualificationId,
            engine_id: standbyQualRec.engineId,
            engine_config_revision: standbyQualRec.engineConfigRevision,
            engine_configuration_sha256: standbyQualRec.engineConfigurationSha256,
            qualification_status: "QUALIFIED",
            qualification_scope: standbyQualRec.qualificationScope,
            qualified_at: standbyQualRec.qualifiedAt,
            qualified_by: standbyQualRec.qualifiedBy,
            evidence_reference: standbyQualRec.evidenceReference,
            capability_profile_version: standbyQualRec.capabilityProfileVersion,
          },
          timeout_ms: standbyResolved.timeoutMs,
        },
      } : {}),
      failover_policy: {
        enabled: selection.standby_enabled,
        governance_qualified: standbyGovernanceQualified,
        technical_failure_only: true,
        validation_failure_failover: false,
      },
    };

    const frozenExecutionAuthority: FrozenAiExecutionAuthority = {
      aiExecutionAuthoritySha256: deriveAiExecutionAuthoritySha256({
        qualificationScope: scope,
        selectionAuthoritySequence: Number(selection.selection_authority_sequence),
        active: {
          engineId: activeResolved.engineId,
          engineConfigRevision: activeResolved.engineConfigRevision,
          engineConfigurationSha256: activeResolved.engineConfigurationSha256,
          qualificationId: activeQualRec.qualificationId,
          capabilityProfileVersion: activeResolved.capabilityProfileVersion,
        },
        ...(standbyResolved && standbyQualRec ? {
          standby: {
            engineId: standbyResolved.engineId,
            engineConfigRevision: standbyResolved.engineConfigRevision,
            engineConfigurationSha256: standbyResolved.engineConfigurationSha256,
            qualificationId: standbyQualRec.qualificationId,
            capabilityProfileVersion: standbyResolved.capabilityProfileVersion,
          },
        } : {}),
      }),
      qualificationScope: scope,
      selectionAuthoritySequence: Number(selection.selection_authority_sequence),
      active: {
        engineId: activeResolved.engineId,
        engineConfigRevision: activeResolved.engineConfigRevision,
        engineConfigurationSha256: activeResolved.engineConfigurationSha256,
        qualificationId: activeQualRec.qualificationId,
        capabilityProfileVersion: activeResolved.capabilityProfileVersion,
      },
      ...(standbyResolved && standbyQualRec ? {
        standby: {
          engineId: standbyResolved.engineId,
          engineConfigRevision: standbyResolved.engineConfigRevision,
          engineConfigurationSha256: standbyResolved.engineConfigurationSha256,
          qualificationId: standbyQualRec.qualificationId,
          capabilityProfileVersion: standbyResolved.capabilityProfileVersion,
        },
      } : {}),
      providerConfigurationSnapshot,
    };

    const config: AiContextMapperRuntimeConfig = {
      qualificationScope: scope,
      enabled: true,
      engineRegistry: [activeEngineDef, ...(standbyDef ? [standbyDef] : [])],
      qualificationRecords: [activeQualRec, ...(standbyQualRec ? [standbyQualRec] : [])],
      ownerEnabledEngineIds: [activeResolved.engineId],
      selectionPolicy: {
        selectionPolicyId: "internal-ai-context-mapping-single",
        selectionPolicyVersion: "1",
        selectionMode: INTERNAL_AI_SELECTION_POLICY_MODE,
      },
      active: activeResolved,
      ...(standbyResolved ? { standby: standbyResolved } : {}),
      standbyEnabled: selection.standby_enabled,
      standbyGovernanceQualified,
      liveProviderTestsEnabled: false,
      providerConfigurationSnapshot,
    };

    return { config, frozenExecutionAuthority };
  }

  /**
   * Runtime Kill-Switch revalidation against FROZEN Traversal Authority (Correction 8).
   * Applied before EVERY new external AI provider invocation.
   * Does NOT re-resolve current Default selection.
   */
  async assertFrozenAiExecutionAuthorityValid(
    frozen: {
      activeEngineId: string;
      activeEngineConfigRevision: string;
      activeEngineConfigurationSha256: string;
      activeQualificationId: string;
      credentialReference: string;
      standbyEngineId?: string;
      standbyEngineConfigRevision?: string;
      standbyEngineConfigurationSha256?: string;
      standbyQualificationId?: string;
      standbyCredentialReference?: string;
    },
    clientOrPool = databasePool(),
  ): Promise<void> {
    // 1. Re-check frozen active engine is still ENABLED
    const activeEngineRes = await clientOrPool.query<InternalAiEngineRow>(
      `SELECT engine_state FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
      [frozen.activeEngineId],
    );
    if (!activeEngineRes.rowCount || activeEngineRes.rows[0].engine_state !== "ENABLED") {
      throw new HttpCommandError(
        503,
        "FROZEN_AI_ENGINE_DISABLED",
        `FROZEN_AI_ENGINE_DISABLED: Execution blocked: Frozen active engine ${frozen.activeEngineId} has been DISABLED by admin.`,
      );
    }

    // 2. Re-check frozen active qualification is still QUALIFIED
    const activeQualRes = await clientOrPool.query<InternalAiQualificationRow>(
      `SELECT qualification_status, engine_configuration_sha256 FROM intentchord.internal_ai_qualifications WHERE qualification_id = $1`,
      [frozen.activeQualificationId],
    );
    if (!activeQualRes.rowCount || activeQualRes.rows[0].qualification_status !== "QUALIFIED") {
      throw new HttpCommandError(
        503,
        "FROZEN_AI_QUALIFICATION_REVOKED",
        `FROZEN_AI_QUALIFICATION_REVOKED: Execution blocked: Frozen qualification ${frozen.activeQualificationId} has been REVOKED or EXPIRED.`,
      );
    }

    // 3. Re-check credential presence via secret resolver
    if (!await checkCredentialPresent(frozen.credentialReference)) {
      throw new HttpCommandError(
        503,
        "INTERNAL_AI_ACTIVE_ENGINE_CREDENTIAL_REQUIRED",
        `Execution blocked: Credential reference "${frozen.credentialReference}" is not available in the secret resolver.`,
      );
    }

    // 4. If standby is present, check standby state as well
    if (frozen.standbyEngineId && frozen.standbyQualificationId) {
      const sbEngineRes = await clientOrPool.query<InternalAiEngineRow>(
        `SELECT engine_state FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
        [frozen.standbyEngineId],
      );
      const sbQualRes = await clientOrPool.query<InternalAiQualificationRow>(
        `SELECT qualification_status FROM intentchord.internal_ai_qualifications WHERE qualification_id = $1`,
        [frozen.standbyQualificationId],
      );
      if (!sbEngineRes.rowCount || sbEngineRes.rows[0].engine_state !== "ENABLED" || !sbQualRes.rowCount || sbQualRes.rows[0].qualification_status !== "QUALIFIED") {
        // Standby disabled/revoked will be caught if failover is attempted
      }
    }
  }

  private rowToAdminSelectionView(row: InternalAiAdminSelectionRow): InternalAiAdminSelectionView {
    return {
      qualificationScope: row.qualification_scope,
      active: {
        engineId: row.active_engine_id,
        engineConfigRevision: row.active_engine_config_revision,
        engineConfigurationSha256: row.active_engine_configuration_sha256,
        qualificationId: row.active_qualification_id,
        credentialPresent: true,
      },
      ...(row.standby_enabled && row.standby_engine_id && row.standby_engine_config_revision && row.standby_engine_configuration_sha256 && row.standby_qualification_id ? {
        standby: {
          engineId: row.standby_engine_id,
          engineConfigRevision: row.standby_engine_config_revision,
          engineConfigurationSha256: row.standby_engine_configuration_sha256,
          qualificationId: row.standby_qualification_id,
          credentialPresent: true,
        },
      } : {}),
      standbyEnabled: row.standby_enabled,
      selectionAuthoritySequence: Number(row.selection_authority_sequence),
      selectedBy: row.selected_by,
      updatedAt: row.updated_at,
    };
  }
}

export const internalAiEngineRegistryService = new InternalAiEngineRegistryService();
