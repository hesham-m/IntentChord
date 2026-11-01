import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function compareCanonicalText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("CANONICAL_JSON_NON_FINITE_NUMBER");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCanonicalText(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`CANONICAL_JSON_UNSUPPORTED_TYPE:${typeof value}`);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export type ProjectFactRevisionHashInput = {
  schemaVersion: "project-fact-revision/v1";
  projectContextId: string;
  projectFactId: string;
  factKey: string;
  factType: string;
  revision: number;
  value: JsonValue;
  status: "PROPOSED" | "OWNER_APPROVED" | "SUPERSEDED" | "REJECTED";
  validFrom: string;
  validUntil?: string;
  sourceProposalRevisionId?: string;
  supersedesRevisionId?: string;
  provenance: Record<string, JsonValue>;
  ownerDecisionId?: string;
};

export function projectFactRevisionHash(input: ProjectFactRevisionHashInput): string {
  return sha256Canonical(input);
}

export type ProjectContextWorkspaceHashInput = {
  schemaVersion: "project-context-workspace/v1";
  projectContextId: string;
  workspaceRegistrationId: string;
  role: "PRIMARY" | "SUPPORTING" | "REFERENCE";
  ordering: number;
  validFrom: string;
  validUntil?: string;
  revision: number;
};

export function projectContextWorkspaceHash(input: ProjectContextWorkspaceHashInput): string {
  return sha256Canonical(input);
}

export type ProjectTruthSnapshotHashEntry = {
  factKey: string;
  factType: string;
  projectFactId: string;
  projectFactRevisionId: string;
  revision: number;
  contentSha256: string;
};

export function projectTruthSnapshotHash(input: {
  schemaVersion: "project-truth-snapshot/v1";
  projectContextId: string;
  snapshotVersion: string;
  effectiveAt: string;
  facts: ProjectTruthSnapshotHashEntry[];
}): string {
  return sha256Canonical({
    ...input,
    facts: [...input.facts].sort((left, right) =>
      compareCanonicalText(left.factKey, right.factKey)
      || compareCanonicalText(left.projectFactRevisionId, right.projectFactRevisionId)),
  });
}
