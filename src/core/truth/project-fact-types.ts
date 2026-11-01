export const projectFactStatuses = ["PROPOSED", "OWNER_APPROVED", "SUPERSEDED", "REJECTED"] as const;

export const initialProjectFactTypes = [
  "CURRENT_VERSION",
  "HISTORICAL_VERSION",
  "AUTHORITATIVE_PATH",
  "PROTECTED_PATH",
  "TOOLCHAIN_VERSION",
  "ARCHITECTURE_DECISION",
  "OWNER_POLICY",
  "RUNTIME_ACCEPTANCE_STATE",
  "SERVICE_IDENTITY",
  "WORKSPACE_ROLE",
] as const;

export type ProjectFactStatus = typeof projectFactStatuses[number];
export type InitialProjectFactType = typeof initialProjectFactTypes[number];
