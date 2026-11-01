import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { workspaceDisplayNameFromReference } from "@/core/tasks/task-input";
import { databaseQuery, transaction, transactionGoverned } from "@/server/db";
import { ConflictError, HttpCommandError } from "@/server/errors";
import { createWorkspaceFilesystemObjectAuthority, sameProofGradeFilesystemObject, type ProofGradeFilesystemObjectIdentity } from "@/core/workspace-index/filesystem-object-authority";
import { terminalRuntimeGovernanceCode } from "@/core/workspace-index/adapters/filesystem-errors";

const execFileAsync = promisify(execFile);

export type WorkspaceRegistration = {
  id: string;
  revision: number;
  displayName: string;
  role: string;
  referenceType: "LOCAL_PATH" | "REMOTE_REFERENCE";
  source: "WINDOWS_NATIVE_SELECTOR" | "MANUAL_VERIFIED" | "MANUAL_UNVERIFIED" | "REMOTE_CONNECTOR";
  reference: string;
  normalizedReference: string;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | "STALE" | "FAILED";
  verificationMethod: string;
  verifiedAt?: string;
  verificationAuthority: string;
  repositoryIdentity?: string;
  branch?: string;
  commitSha?: string;
  fingerprint: string;
  provenance: Record<string, unknown>;
  authorizationContext: string;
};
export type WorkspaceAuthorityRegistration = WorkspaceRegistration & {
  verifiedRootRealPath?: string;
  verifiedRootObjectIdentity?: ProofGradeFilesystemObjectIdentity;
  verifiedRootVerifiedAt?: string;
  rootAuthorityState: "LEGACY_UNBOUND" | "VERIFIED_MATCH" | "STALE_MISMATCH" | "IDENTITY_UNPROVABLE";
  rootAuthorityCheckedAt?: string;
};



export async function listWorkspaceRegistrations(): Promise<WorkspaceRegistration[]> {
  const result = await databaseQuery<{
    id: string;
    revision: string | number;
    display_name: string;
    role: string;
    reference_type: "LOCAL_PATH" | "REMOTE_REFERENCE";
    source_type: WorkspaceRegistration["source"];
    reference: string;
    normalized_reference: string;
    verification_status: WorkspaceRegistration["verificationStatus"];
    verification_method: string;
    verified_at: string | Date | null;
    verification_authority: string;
    repository_identity: string | null;
    branch: string | null;
    commit_sha: string | null;
    fingerprint: string;
    provenance: Record<string, unknown> | null;
  }>(
    `select id,revision,display_name,role,reference_type,source_type,reference,normalized_reference,
      verification_status,verification_method,verified_at,verification_authority,repository_identity,
      branch,commit_sha,fingerprint,provenance
     from intentchord.workspaces
     order by updated_at desc, display_name asc`,
  );
  return result.rows.map(row => ({
    id: row.id,
    revision: Number(row.revision),
    displayName: row.display_name,
    role: row.role,
    referenceType: row.reference_type,
    source: row.source_type,
    reference: row.reference,
    normalizedReference: row.normalized_reference,
    verificationStatus: row.verification_status,
    verificationMethod: row.verification_method,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : undefined,
    verificationAuthority: row.verification_authority,
    repositoryIdentity: row.repository_identity ?? undefined,
    branch: row.branch ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    fingerprint: row.fingerprint,
    provenance: row.provenance ?? {},
    authorizationContext: "Registered Workspace reference; authority is granted separately by each governed Task.",
  }));
}

export async function readWorkspaceRegistration(workspaceId: string): Promise<WorkspaceRegistration> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new HttpCommandError(400, "INVALID_IDENTIFIER", "Workspace registration ID must be a UUID.");
  }
  const registrations = await listWorkspaceRegistrations();
  const registration = registrations.find(item => item.id === workspaceId);
  if (!registration) {
    throw new HttpCommandError(404, "WORKSPACE_REGISTRATION_NOT_FOUND", "The registered Workspace does not exist.");
  }
  return registration;
}

type WorkspaceAuthorityRow = {
  id: string;
  revision: string | number;
  display_name: string;
  role: string;
  reference_type: WorkspaceRegistration["referenceType"];
  source_type: WorkspaceRegistration["source"];
  reference: string;
  normalized_reference: string;
  verification_status: WorkspaceRegistration["verificationStatus"];
  verification_method: string;
  verified_at: string | Date | null;
  verification_authority: string;
  repository_identity: string | null;
  branch: string | null;
  commit_sha: string | null;
  fingerprint: string;
  provenance: Record<string, unknown> | null;
  verified_root_real_path: string | null;
  verified_root_device_id: string | null;
  verified_root_file_id: string | null;
  verified_root_identity_method: ProofGradeFilesystemObjectIdentity["proof_method"] | null;
  verified_root_verified_at: string | Date | null;
  root_authority_state: WorkspaceAuthorityRegistration["rootAuthorityState"];
  root_authority_checked_at: string | Date | null;
};

function authorityRegistrationFromRow(row: WorkspaceAuthorityRow): WorkspaceAuthorityRegistration {
  const identity = row.verified_root_device_id && row.verified_root_file_id && row.verified_root_identity_method
    ? { device_id: row.verified_root_device_id, file_id: row.verified_root_file_id, proof_method: row.verified_root_identity_method }
    : undefined;
  return {
    id: row.id,
    revision: Number(row.revision),
    displayName: row.display_name,
    role: row.role,
    referenceType: row.reference_type,
    source: row.source_type,
    reference: row.reference,
    normalizedReference: row.normalized_reference,
    verificationStatus: row.verification_status,
    verificationMethod: row.verification_method,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : undefined,
    verificationAuthority: row.verification_authority,
    repositoryIdentity: row.repository_identity ?? undefined,
    branch: row.branch ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    fingerprint: row.fingerprint,
    provenance: row.provenance ?? {},
    authorizationContext: "Registered Workspace reference; authority is granted separately by each governed Task.",
    verifiedRootRealPath: row.verified_root_real_path ?? undefined,
    verifiedRootObjectIdentity: identity,
    verifiedRootVerifiedAt: row.verified_root_verified_at ? new Date(row.verified_root_verified_at).toISOString() : undefined,
    rootAuthorityState: row.root_authority_state,
    rootAuthorityCheckedAt: row.root_authority_checked_at ? new Date(row.root_authority_checked_at).toISOString() : undefined,
  };
}

const workspaceAuthoritySelect = `select id,revision,display_name,role,reference_type,source_type,reference,normalized_reference,
  verification_status,verification_method,verified_at,verification_authority,repository_identity,branch,commit_sha,
  fingerprint,provenance,verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
  verified_root_verified_at,root_authority_state,root_authority_checked_at
  from intentchord.workspaces`;

export async function readWorkspaceAuthorityRegistration(workspaceId: string): Promise<WorkspaceAuthorityRegistration> {
  assertUuid(workspaceId, "workspaceId");
  const result = await databaseQuery<WorkspaceAuthorityRow>(`${workspaceAuthoritySelect} where id=$1`, [workspaceId]);
  if (!result.rowCount) throw new HttpCommandError(404, "WORKSPACE_REGISTRATION_NOT_FOUND", "The registered Workspace does not exist.");
  return authorityRegistrationFromRow(result.rows[0]);
}

export type AuthorizedWorkspaceSource = {
  registration: WorkspaceAuthorityRegistration;
  currentIdentity: LocalWorkspaceIdentity;
};

export async function assertRegisteredWorkspaceSourceAuthority(workspaceId: string, governance: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<AuthorizedWorkspaceSource> {
  assertUuid(workspaceId, "workspaceId");
  const runAuthorityTransaction = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
    governance.deadlineAt !== undefined
      ? transactionGoverned({ deadlineAtMs: governance.deadlineAt, signal: governance.signal }, work)
      : transaction(work);
  const outcome = await runAuthorityTransaction(async client => {
    const result = await client.query<WorkspaceAuthorityRow>(`${workspaceAuthoritySelect} where id=$1 for update`, [workspaceId]);
    if (!result.rowCount) return { code: "WORKSPACE_REGISTRATION_NOT_FOUND" as const };
    const registration = authorityRegistrationFromRow(result.rows[0]);
    if (registration.referenceType !== "LOCAL_PATH" || registration.verificationStatus !== "VERIFIED") {
      return { code: "WORKSPACE_VERIFICATION_REQUIRED" as const, registration };
    }
    if (!registration.verifiedRootRealPath || !registration.verifiedRootObjectIdentity || !registration.verifiedRootVerifiedAt) {
      await client.query(
        `update intentchord.workspaces set verification_status='STALE',root_authority_state='IDENTITY_UNPROVABLE',
          current_root_real_path=null,current_root_device_id=null,current_root_file_id=null,current_root_identity_method=null,
          root_authority_checked_at=now(),revision=revision+1,updated_at=now() where id=$1`,
        [workspaceId],
      );
      return { code: "ROOT_IDENTITY_UNPROVABLE" as const, registration };
    }
    let currentIdentity: LocalWorkspaceIdentity;
    try {
      currentIdentity = await inspectLocalWorkspaceIdentity(registration.normalizedReference, governance);
    } catch (error) {
      if (terminalRuntimeGovernanceCode(error)) throw error;
      await client.query(
        `update intentchord.workspaces set verification_status='STALE',root_authority_state='IDENTITY_UNPROVABLE',
          current_root_real_path=null,current_root_device_id=null,current_root_file_id=null,current_root_identity_method=null,
          root_authority_checked_at=now(),revision=revision+1,updated_at=now() where id=$1`,
        [workspaceId],
      );
      return { code: "ROOT_IDENTITY_UNPROVABLE" as const, registration, cause: error };
    }
    // Governing verification authority binds to the actual filesystem object, not to a heuristic or
    // textual/casing form of the path. The configured registered path is still the Source Binding used
    // to resolve the object, but C20 authority staleness is decided by proof-grade object identity.
    const objectMatches = sameProofGradeFilesystemObject(currentIdentity.rootObjectIdentity, registration.verifiedRootObjectIdentity);
    if (!objectMatches) {
      await client.query(
        `update intentchord.workspaces set verification_status='STALE',root_authority_state='STALE_MISMATCH',
          current_root_real_path=$2,current_root_device_id=$3,current_root_file_id=$4,current_root_identity_method=$5,
          root_authority_checked_at=now(),revision=revision+1,updated_at=now() where id=$1`,
        [workspaceId,currentIdentity.realPath,currentIdentity.rootObjectIdentity.device_id,currentIdentity.rootObjectIdentity.file_id,currentIdentity.rootObjectIdentity.proof_method],
      );
      return { code: "ROOT_IDENTITY_MISMATCH" as const, registration, currentIdentity };
    }
    await client.query(
      `update intentchord.workspaces set root_authority_state='VERIFIED_MATCH',current_root_real_path=$2,
        current_root_device_id=$3,current_root_file_id=$4,current_root_identity_method=$5,root_authority_checked_at=now(),updated_at=now()
       where id=$1`,
      [workspaceId,currentIdentity.realPath,currentIdentity.rootObjectIdentity.device_id,currentIdentity.rootObjectIdentity.file_id,currentIdentity.rootObjectIdentity.proof_method],
    );
    return { code: "PASS" as const, registration: { ...registration, rootAuthorityState: "VERIFIED_MATCH" as const }, currentIdentity };
  });

  if (outcome.code === "PASS") return { registration: outcome.registration, currentIdentity: outcome.currentIdentity };
  if (outcome.code === "WORKSPACE_REGISTRATION_NOT_FOUND") throw new HttpCommandError(404, outcome.code, "The registered Workspace does not exist.");
  if (outcome.code === "WORKSPACE_VERIFICATION_REQUIRED") throw new HttpCommandError(409, outcome.code, "The registered Workspace must be VERIFIED before source acquisition.");
  if (outcome.code === "ROOT_IDENTITY_MISMATCH") throw new HttpCommandError(409, "WORKSPACE_VERIFICATION_STALE", "The current Workspace root filesystem object no longer matches the Owner-verified root object.");
  throw new HttpCommandError(409, "ROOT_IDENTITY_UNPROVABLE", "The current Workspace root filesystem object identity cannot be proven; re-verification is required.");
}


export interface LocalWorkspaceConnector {
  readonly id: string;
  selectDirectory(initialDirectory?: string): Promise<string | undefined>;
  selectFile?(initialDirectory?: string): Promise<string | undefined>;
}

let nativeSelectorInFlight = false;

async function runNativeSelector(script: string): Promise<string | undefined> {
  if (nativeSelectorInFlight) {
    throw new HttpCommandError(409, "NATIVE_SELECTOR_BUSY", "Another native selector is already open.");
  }
  nativeSelectorInFlight = true;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-STA", "-Command", script],
      { windowsHide: false, timeout: 5 * 60_000, maxBuffer: 16 * 1024 },
    );
    return stdout.trim() || undefined;
  } catch (error: unknown) {
    const commandError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (commandError.code === "ETIMEDOUT" || commandError.killed) {
      throw new HttpCommandError(504, "NATIVE_SELECTOR_TIMEOUT", "The native selector timed out before the Owner completed the selection.");
    }
    throw new HttpCommandError(500, "NATIVE_SELECTOR_FAILED", "The Windows native selector could not be opened or completed.");
  } finally {
    nativeSelectorInFlight = false;
  }
}

function nativeDialogOwnerScript(dialogScript: string[]): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
    "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
    "$owner.Size = New-Object System.Drawing.Size(1, 1)",
    "$owner.Opacity = 0.01",
    "$owner.Show()",
    "$owner.Activate()",
    ...dialogScript,
  ].join("; ");
}

export class WindowsNativeWorkspaceConnector implements LocalWorkspaceConnector {
  readonly id = "WINDOWS_FOLDER_BROWSER_DIALOG_V1";

  async selectDirectory(initialDirectory?: string): Promise<string | undefined> {
    if (process.platform !== "win32") {
      throw new HttpCommandError(501, "NATIVE_SELECTOR_UNAVAILABLE", "The Windows native Workspace selector is unavailable on this runtime.");
    }
    const script = nativeDialogOwnerScript([
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Select an IntentChord folder'",
      "$dialog.ShowNewFolderButton = $false",
      ...(initialDirectory ? [`$dialog.SelectedPath = '${initialDirectory.replaceAll("'", "''")}'`] : []),
      "try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } } finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }",
    ]);
    return runNativeSelector(script);
  }

  async selectFile(initialDirectory?: string): Promise<string | undefined> {
    if (process.platform !== "win32") {
      throw new HttpCommandError(501, "NATIVE_SELECTOR_UNAVAILABLE", "The Windows native file selector is unavailable on this runtime.");
    }
    const script = nativeDialogOwnerScript([
      "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
      "$dialog.Title = 'Select an IntentChord file'",
      "$dialog.CheckFileExists = $true",
      "$dialog.Multiselect = $false",
      "$dialog.RestoreDirectory = $true",
      ...(initialDirectory ? [`$dialog.InitialDirectory = '${initialDirectory.replaceAll("'", "''")}'`] : []),
      "try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) } } finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }",
    ]);
    return runNativeSelector(script);
  }
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpCommandError(400, "INVALID_IDENTIFIER", `${label} must be a valid UUID.`);
  }
}

function canonicalLocalReference(reference: string) {
  return path.normalize(path.resolve(reference.trim()));
}

export type LocalWorkspaceIdentity = {
  normalizedReference: string;
  realPath: string;
  rootObjectIdentity: ProofGradeFilesystemObjectIdentity;
  repositoryIdentity?: string;
  branch?: string;
  commitSha?: string;
  fingerprint: string;
  provenance: Record<string, unknown>;
};

export async function inspectLocalWorkspaceIdentity(reference: string, governance: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<LocalWorkspaceIdentity> {
  const normalizedReference = canonicalLocalReference(reference);
  const authority = createWorkspaceFilesystemObjectAuthority();
  let rootProbe;
  try {
    rootProbe = await authority.probeDirectory(normalizedReference, governance);
  } catch (error) {
    if (terminalRuntimeGovernanceCode(error)) throw error;
    const code = (error as { code?: string })?.code;
    if (code === "WORKSPACE_OBJECT_IDENTITY_UNPROVABLE") {
      throw new HttpCommandError(409, "ROOT_IDENTITY_UNPROVABLE", "The Workspace root filesystem object identity cannot be proven on this runtime.");
    }
    throw new HttpCommandError(422, "WORKSPACE_NOT_FOUND", "The selected Workspace path does not resolve to a proof-grade local directory object.");
  } finally {
    await authority.close().catch(() => undefined);
  }

  const resolvedRealPath = rootProbe.resolved_real_path;
  const pathIdentityMaterial = JSON.stringify({
    normalizedReference: process.platform === "win32" ? normalizedReference.toLowerCase() : normalizedReference,
    verifiedRootRealPath: process.platform === "win32" ? resolvedRealPath.toLowerCase() : resolvedRealPath,
    rootObjectIdentity: rootProbe.identity,
  });

  return {
    normalizedReference,
    realPath: resolvedRealPath,
    rootObjectIdentity: rootProbe.identity,
    fingerprint: `sha256:${sha256(pathIdentityMaterial)}`,
    provenance: {
      repositoryMetadataCaptured: false,
      browserRepositoryEnumeration: false,
      fullRepositoryEnumeration: false,
      repositoryEnumeration: false,
      fileContentRead: false,
      boundedBackendContentSnapshot: false,
      snapshotStrength: "VERIFIED_ROOT_OBJECT_REFERENCE_ONLY",
      snapshotComplete: true,
      pathIdentityComplete: true,
      rootObjectIdentityProof: rootProbe.identity.proof_method,
      contentFreshnessStatus: "UNKNOWN",
      gitMetadataStatus: "AUTHORITY_SAFE_NOT_CAPTURED",
      gitDiagnostics: [],
      untrackedFilesEnumerated: false,
      untrackedContentRead: false,
    },
  };
}

async function persistRegistration(client: PoolClient, registration: WorkspaceAuthorityRegistration) {
  await client.query(
    `insert into intentchord.workspaces(
      id, display_name, role, reference_type, reference, normalized_reference,
      verification_status, verification_method, verified_at, verification_authority,
      repository_identity, branch, commit_sha, fingerprint, provenance, device_provenance, source_type, revision,
      verified_root_real_path, verified_root_device_id, verified_root_file_id, verified_root_identity_method,
      verified_root_verified_at, root_authority_state, current_root_real_path, current_root_device_id, current_root_file_id,
      current_root_identity_method, root_authority_checked_at
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,0,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
    [
      registration.id,
      registration.displayName,
      registration.role,
      registration.referenceType,
      registration.reference,
      registration.normalizedReference,
      registration.verificationStatus,
      registration.verificationMethod,
      registration.verifiedAt ?? null,
      registration.verificationAuthority,
      registration.repositoryIdentity ?? null,
      registration.branch ?? null,
      registration.commitSha ?? null,
      registration.fingerprint,
      JSON.stringify(registration.provenance),
      JSON.stringify({ runtime: process.platform, device: hostname() }),
      registration.source,
      registration.verifiedRootRealPath ?? null,
      registration.verifiedRootObjectIdentity?.device_id ?? null,
      registration.verifiedRootObjectIdentity?.file_id ?? null,
      registration.verifiedRootObjectIdentity?.proof_method ?? null,
      registration.verifiedRootVerifiedAt ?? null,
      registration.rootAuthorityState,
      registration.verifiedRootRealPath ?? null,
      registration.verifiedRootObjectIdentity?.device_id ?? null,
      registration.verifiedRootObjectIdentity?.file_id ?? null,
      registration.verifiedRootObjectIdentity?.proof_method ?? null,
      registration.verifiedRootVerifiedAt ?? null,
    ],
  );
  await client.query(
    `insert into intentchord.audit_events(
      id, aggregate_type, aggregate_id, event_type, actor_authority, related_revision, metadata
    ) values($1,'WORKSPACE',$2,'WORKSPACE_REGISTERED','BACKEND',0,$3)`,
    [
      randomUUID(),
      registration.id,
      JSON.stringify({
        verificationStatus: registration.verificationStatus,
        verificationMethod: registration.verificationMethod,
      }),
    ],
  );
  return registration;
}

async function inspectVerifiedWorkspace(input: {
  displayName: string;
  role: string;
  reference: string;
  authorizationContext: string;
  verificationMethod?: string;
}, identity: { id: string; revision: number } = { id: randomUUID(), revision: 0 }) {
  const identitySnapshot = await inspectLocalWorkspaceIdentity(input.reference);
  const verifiedAt = new Date().toISOString();
  const registration: WorkspaceAuthorityRegistration = {
    id: identity.id,
    revision: identity.revision,
    displayName: input.displayName,
    role: input.role,
    referenceType: "LOCAL_PATH",
    source: (input.verificationMethod ?? "BACKEND_LOCAL_STAT_V1") === "WINDOWS_FOLDER_BROWSER_DIALOG_V1" ? "WINDOWS_NATIVE_SELECTOR" : "MANUAL_VERIFIED",
    reference: identitySnapshot.normalizedReference,
    normalizedReference: identitySnapshot.normalizedReference,
    verificationStatus: "VERIFIED",
    verificationMethod: input.verificationMethod ?? "BACKEND_LOCAL_STAT_V1",
    verifiedAt,
    verificationAuthority: "BACKEND",
    repositoryIdentity: identitySnapshot.repositoryIdentity,
    branch: identitySnapshot.branch,
    commitSha: identitySnapshot.commitSha,
    fingerprint: identitySnapshot.fingerprint,
    provenance: {
      ...identitySnapshot.provenance,
      connector: input.verificationMethod ?? "BACKEND_LOCAL_STAT_V1",
    },
    authorizationContext: input.authorizationContext,
    verifiedRootRealPath: identitySnapshot.realPath,
    verifiedRootObjectIdentity: identitySnapshot.rootObjectIdentity,
    verifiedRootVerifiedAt: verifiedAt,
    rootAuthorityState: "VERIFIED_MATCH",
    rootAuthorityCheckedAt: verifiedAt,
  };
  return registration;
}

export async function verifyAndRegisterWorkspace(input: {
  displayName: string;
  role: string;
  reference: string;
  authorizationContext: string;
  verificationMethod?: string;
}) {
  const registration = await inspectVerifiedWorkspace(input);
  return transaction(client => persistRegistration(client, registration));
}

export async function registerManualWorkspace(input: {
  displayName: string;
  role: string;
  referenceType: "LOCAL_PATH";
  reference: string;
  authorizationContext: string;
}) {
  const id = randomUUID();
  const registration: WorkspaceAuthorityRegistration = {
    id,
    revision: 0,
    displayName: input.displayName,
    role: input.role,
    referenceType: input.referenceType,
    source: "MANUAL_UNVERIFIED",
    reference: input.reference.trim(),
    normalizedReference: input.reference.trim(),
    verificationStatus: "UNVERIFIED",
    verificationMethod: "ADVANCED_UNVERIFIED_FALLBACK",
    verificationAuthority: "BACKEND",
    fingerprint: `unverified:${id}`,
    provenance: {
      typedReference: true,
      browserRepositoryEnumeration: false,
      fullRepositoryEnumeration: false,
      boundedBackendContentSnapshot: false,
      repositoryEnumeration: false,
      warning: "Owner-entered text is not verified Workspace identity.",
    },
    authorizationContext: input.authorizationContext,
    rootAuthorityState: "LEGACY_UNBOUND",
  };
  return transaction(client => persistRegistration(client, registration));
}

export async function selectAndRegisterWorkspace(
  input: { displayName: string; role: string; authorizationContext: string },
  connector: LocalWorkspaceConnector = new WindowsNativeWorkspaceConnector(),
) {
  const selected = await connector.selectDirectory();
  if (!selected) {
    throw new HttpCommandError(409, "WORKSPACE_SELECTION_CANCELLED", "No Workspace was selected.");
  }
  const requestedDisplayName = input.displayName.trim();
  const selectedDisplayName = workspaceDisplayNameFromReference(selected);
  return verifyAndRegisterWorkspace({
    ...input,
    displayName:
      !requestedDisplayName || /^Workspace \d+$/i.test(requestedDisplayName)
        ? selectedDisplayName || requestedDisplayName
        : requestedDisplayName,
    reference: selected,
    verificationMethod: connector.id,
  });
}

export async function selectWorkspaceScopePath(
  workspaceId: string,
  selectionType: "FOLDER" | "FILE",
  connector: LocalWorkspaceConnector = new WindowsNativeWorkspaceConnector(),
) {
  assertUuid(workspaceId, "workspaceId");
  // Scope selection is a Registered Workspace filesystem operation. Prove the current Root Object
  // authority before resolving or presenting any source-relative selection path.
  const authorized = await assertRegisteredWorkspaceSourceAuthority(workspaceId);
  const workspace = authorized.currentIdentity.realPath;

  const selected = selectionType === "FILE"
    ? await connector.selectFile?.(workspace)
    : await connector.selectDirectory(workspace);
  if (!selected) {
    throw new HttpCommandError(409, "SCOPE_SELECTION_CANCELLED", "No scope path was selected.");
  }

  const normalizedSelected = canonicalLocalReference(selected);
  // The native selector may remain open for an arbitrary Owner interaction interval. Re-prove the
  // Registered Root Object before accepting its result so a path replacement cannot freeze scope
  // against stale Workspace verification authority.
  const currentAuthority = await assertRegisteredWorkspaceSourceAuthority(workspaceId);
  if (!sameProofGradeFilesystemObject(currentAuthority.currentIdentity.rootObjectIdentity, authorized.currentIdentity.rootObjectIdentity)) {
    throw new HttpCommandError(409, "WORKSPACE_VERIFICATION_STALE", "The Workspace Root Object changed while scope selection was open.");
  }
  const workspaceRealPath = currentAuthority.currentIdentity.realPath;
  const selectedRealPath = await realpath(normalizedSelected);
  const relative = path.relative(workspaceRealPath, selectedRealPath).replaceAll("\\", "/");
  if (relative === "") {
    return { path: "@workspace-root", impliedDiscoveryScopeMode: "FULL_WORKSPACE" as const };
  }
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new HttpCommandError(422, "SCOPE_PATH_OUTSIDE_WORKSPACE", "The selected path is outside the registered Workspace.");
  }
  return { path: relative, impliedDiscoveryScopeMode: "SELECTED_PATHS" as const };
}

export async function verifyManualWorkspaceRegistration(workspaceId: string, command: { expectedRevision: number }) {
  assertUuid(workspaceId, "workspaceId");
  return transaction(async client => {
    const result = await client.query(
      `select display_name,role,reference_type,reference,verification_status,revision,
        root_authority_state,verified_root_device_id,verified_root_file_id,verified_root_identity_method
       from intentchord.workspaces where id=$1 for update`,
      [workspaceId],
    );
    if (!result.rowCount) {
      throw new HttpCommandError(404, "WORKSPACE_NOT_FOUND", "Workspace Registration not found.");
    }
    const row = result.rows[0];
    if (Number(row.revision) !== command.expectedRevision) {
      throw new ConflictError("The Workspace revision is stale.");
    }
    if (row.reference_type !== "LOCAL_PATH") {
      throw new HttpCommandError(422, "LOCAL_VERIFICATION_UNAVAILABLE", "Only a local path can be verified by the local Backend connector.");
    }
    const legacyUnboundVerified = row.verification_status === "VERIFIED" && (
      row.root_authority_state === "LEGACY_UNBOUND"
      || !row.verified_root_device_id
      || !row.verified_root_file_id
      || !row.verified_root_identity_method
    );
    if (!(["UNVERIFIED", "STALE"] as string[]).includes(row.verification_status) && !legacyUnboundVerified) {
      throw new HttpCommandError(409, "WORKSPACE_ALREADY_PROCESSED", "This Workspace Registration is not awaiting verification or root-object authority re-verification.");
    }
    const registration = await inspectVerifiedWorkspace({
      displayName: row.display_name,
      role: row.role,
      reference: row.reference,
      authorizationContext: "Backend verification of ADVANCED_UNVERIFIED_FALLBACK",
      verificationMethod: "BACKEND_MANUAL_REFERENCE_VERIFICATION_V1",
    }, {
      id: workspaceId,
      revision: Number(row.revision) + 1,
    });
    await client.query(
      `update intentchord.workspaces set
        display_name=$2,role=$3,reference_type=$4,reference=$5,normalized_reference=$6,
        verification_status=$7,verification_method=$8,verified_at=$9,verification_authority=$10,
        repository_identity=$11,branch=$12,commit_sha=$13,fingerprint=$14,provenance=$15,
        device_provenance=$16,source_type=$17,revision=$18,
        verified_root_real_path=$19,verified_root_device_id=$20,verified_root_file_id=$21,verified_root_identity_method=$22,
        verified_root_verified_at=$23,root_authority_state='VERIFIED_MATCH',current_root_real_path=$19,
        current_root_device_id=$20,current_root_file_id=$21,current_root_identity_method=$22,root_authority_checked_at=$23,
        updated_at=now()
       where id=$1`,
      [
        workspaceId,
        registration.displayName,
        registration.role,
        registration.referenceType,
        registration.reference,
        registration.normalizedReference,
        registration.verificationStatus,
        registration.verificationMethod,
        registration.verifiedAt ?? null,
        registration.verificationAuthority,
        registration.repositoryIdentity ?? null,
        registration.branch ?? null,
        registration.commitSha ?? null,
        registration.fingerprint,
        JSON.stringify(registration.provenance),
        JSON.stringify({ runtime: process.platform, device: hostname() }),
        registration.source,
        registration.revision,
        registration.verifiedRootRealPath ?? null,
        registration.verifiedRootObjectIdentity?.device_id ?? null,
        registration.verifiedRootObjectIdentity?.file_id ?? null,
        registration.verifiedRootObjectIdentity?.proof_method ?? null,
        registration.verifiedRootVerifiedAt ?? null,
      ],
    );
    await client.query(
      `insert into intentchord.audit_events(
        id,aggregate_type,aggregate_id,event_type,actor_authority,related_revision,metadata
      ) values($1,'WORKSPACE',$2,'WORKSPACE_VERIFIED','BACKEND',$3,$4)`,
      [
        randomUUID(),
        workspaceId,
        registration.revision,
        JSON.stringify({
          verificationStatus: registration.verificationStatus,
          verificationMethod: registration.verificationMethod,
          priorRevision: Number(row.revision),
        }),
      ],
    );
    return registration;
  });
}
