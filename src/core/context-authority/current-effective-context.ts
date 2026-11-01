import { mapperSha256 } from "@/core/ai-context-mapper/canonical";

export type EffectiveContextAuthorityClassification = "CURRENT" | "DRIFT" | "UNPROVEN";

export type EffectiveContextSourceProof = {
  workspaceRegistrationId: string;
  registrationProven: boolean;
  observationHeadPresent: boolean;
  observationHeadQualifiedReady: boolean;
  frozenAuthorityMatchesCurrentHead: boolean;
};

export type EffectiveContextAuthorityFacts = {
  assemblyIsHead: boolean;
  taskSourceSetMatchesAssembly: boolean;
  /** Append-only proof that a source-mutating Run already consumed this frozen Context for future authority. */
  forwardAuthorityConsumed?: boolean;
  sources: EffectiveContextSourceProof[];
};

/**
 * Pure truth table for CURRENT EFFECTIVE CONTEXT AUTHORITY.
 *
 * CURRENT requires an exact immutable Assembly Head, an exact Task source-set match,
 * and proven current authority for every Workspace using the ACTUAL Observation head.
 * Missing/failed/unqualified current facts are UNPROVEN; proven-but-different facts are DRIFT.
 */
export function classifyCurrentEffectiveContextAuthority(
  facts: EffectiveContextAuthorityFacts,
): EffectiveContextAuthorityClassification {
  if (!facts.assemblyIsHead || !facts.taskSourceSetMatchesAssembly) return "DRIFT";
  if (facts.forwardAuthorityConsumed) return "UNPROVEN";
  if (!facts.sources.length) return "UNPROVEN";
  if (facts.sources.some(source =>
    !source.registrationProven
    || !source.observationHeadPresent
    || !source.observationHeadQualifiedReady
  )) return "UNPROVEN";
  if (facts.sources.some(source => !source.frozenAuthorityMatchesCurrentHead)) return "DRIFT";
  return "CURRENT";
}


export type TaskSourceSetAuthorityItem = {
  workspaceRegistrationId: string;
  workspaceRegistrationFingerprint: string;
  ordering: number;
};

/** Exact Task source-set authority identity: Registration ID + fingerprint + ordering. */
export function taskSourceSetAuthoritySha256V1(items: TaskSourceSetAuthorityItem[]): string {
  const workspaces = [...items]
    .sort((a, b) => a.workspaceRegistrationId.localeCompare(b.workspaceRegistrationId))
    .map(item => ({
      workspaceRegistrationId: item.workspaceRegistrationId,
      workspaceRegistrationFingerprint: item.workspaceRegistrationFingerprint,
      ordering: item.ordering,
    }));
  return mapperSha256({ schema: "intentchord.task-source-set-authority.v1", workspaces });
}
