import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync("src/components/workflow-app.tsx", "utf8");
const lifecycle = readFileSync("src/server/lifecycle.ts", "utf8");
const connector = readFileSync("src/server/workspace-connector.ts", "utf8");
const presentation = readFileSync("src/server/presentation.ts", "utf8");
const scopeRoute = readFileSync("src/app/api/workspaces/[id]/scope/route.ts", "utf8");
const shell = readFileSync("src/components/product-shell.tsx", "utf8");
const productPreferences = readFileSync("src/lib/product-preferences.ts", "utf8");
const discoveryTools = readFileSync("src/core/discovery/discovery-tools.ts", "utf8");
const discoveryLifecycle = readFileSync("src/server/discovery-lifecycle.ts", "utf8");
const discoveryRoute = readFileSync("src/app/api/tasks/[id]/discovery-runs/route.ts", "utf8");
const discoveryRunner = readFileSync("src/core/discovery/discovery-runner.ts", "utf8");
const sourceReadBridge = readFileSync("src/server/workspace-source-read.ts", "utf8");
const filesystemAuthority = readFileSync("src/core/workspace-index/filesystem-object-authority.ts", "utf8");
const windowsFilesystemHelper = readFileSync("scripts/windows-filesystem-object-authority.ps1", "utf8");
const serverErrors = readFileSync("src/server/errors.ts", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const nonPostgresTestRunner = readFileSync("scripts/run-non-postgres-tests.mjs", "utf8");
const sampleVerifier = readFileSync("scripts/verify-canonical-workspace-index-samples.mjs", "utf8");
const allSource = [client, lifecycle, connector, presentation, scopeRoute].join("\n");

describe("authoritative architecture source boundaries", () => {
  it("does not use browser repository enumeration APIs", () => {
    expect(allSource).not.toMatch(/webkitdirectory|webkitRelativePath/);
  });

  it("does not retain repository inventory or directory-tree state", () => {
    expect(allSource).not.toMatch(/workspaceInventory|repositoryInventory|directoryTree/);
  });


  it("captures Workspace verification identity from the proof-grade Root Object without repository enumeration or Git path reads", () => {
    expect(connector).not.toContain("boundedDirectoryContent");
    expect(connector).not.toContain("readdir(");
    expect(connector).not.toContain("readFile(");
    expect(connector).not.toContain("ls-files");
    expect(connector).not.toContain("execFileAsync(\"git\"");
    expect(connector).toContain("rootObjectIdentity");
    expect(connector).toContain('gitMetadataStatus: "AUTHORITY_SAFE_NOT_CAPTURED"');
    expect(connector).toContain("fileContentRead: false");
  });


  it("keeps owner setup projections separate from internal Workspace provenance", () => {
    expect(presentation).toContain("TaskSetupOwnerView");
    const ownerWorkspaceView = presentation.match(/export type WorkspaceSetupOwnerView = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    expect(ownerWorkspaceView).toContain("effectiveReadBoundary");
    expect(ownerWorkspaceView).not.toContain("fingerprint");
    expect(ownerWorkspaceView).not.toContain("provenance");
    expect(ownerWorkspaceView).not.toContain("repositoryIdentity");
  });

  it("makes full-workspace discovery a Backend authority decision, not a Client inference", () => {
    expect(client).toContain('discoveryScopeMode: "FULL_WORKSPACE"');
    expect(client).toContain("/api/workspaces/${workspace.id}/scope");
    expect(scopeRoute).toContain("selectWorkspaceScopePathCommandSchema");
    expect(scopeRoute).toContain("selectWorkspaceScopePath");
    expect(connector).toContain("SCOPE_PATH_OUTSIDE_WORKSPACE");
    expect(connector).toContain("assertRegisteredWorkspaceSourceAuthority(workspaceId)");
    expect(connector).toContain("authorized.currentIdentity.realPath");
    expect(connector).toContain("realpath(normalizedSelected)");
  });

  it("runs native selectors as a foreground single-flight interaction", () => {
    expect(client).toContain("pickerLockRef.current");
    expect(client).toContain("disabled={pickerBusy}");
    expect(client).toContain("Opening the Workspace picker");
    expect(client).toContain("SCOPE_SELECTION_CANCELLED");
    expect(connector).toContain("NATIVE_SELECTOR_BUSY");
    expect(connector).toContain("nativeSelectorInFlight");
    expect(connector).toContain("$owner.TopMost = $true");
    expect(connector).toContain("ShowDialog($owner)");
  });

  it("keeps Objective as the only owner-entered task identity source", () => {
    expect(client).not.toContain("titleManuallyEdited: true");
    expect(client).not.toContain("Owner-edited title is frozen");
    expect(client).not.toContain("{copy.identity}");
    expect(client).toContain('data-task-title-source="objective"');
    expect(client).toContain("title: generatedTaskTitle(event.target.value)");
  });

  it("does not import the Verdict engine into the Client component", () => {
    expect(client).not.toMatch(/import\s*\{\s*evaluateVerdict/);
  });

  it("does not execute Contract approval in the Client component", () => {
    expect(client).not.toMatch(/\bapproveContract\s*\(/);
    expect(client).toContain("/api/contracts/${task.contractRevisionId}/approve");
  });

  it("does not execute Run creation in the Client component", () => {
    expect(client).not.toMatch(/\bstartPendingRun\s*\(/);
    expect(client).toContain("/api/tasks/${task.id}/runs");
  });

  it("does not create verified fingerprints from typed text", () => {
    expect(client).not.toMatch(/workspaceFingerprintFrom/);
    expect(connector).toContain('fingerprint: `unverified:${id}`');
  });

  it("keeps Project membership on the authoritative Task revision instead of global browser state", () => {
    const directClientCalls = [...client.matchAll(/localStorage\.(?:getItem|setItem)\(([^)]+)\)/g)].map(match => match[1]);
    expect(directClientCalls.every(call => /localeStorageKey|intentchord-theme/.test(call))).toBe(true);
    expect(shell).not.toMatch(/localStorage\.(?:getItem|setItem)/);
    expect(shell).not.toContain("activeEnvironmentId");
    expect(shell).not.toContain("Governed environment");
    expect(client).not.toContain("readActiveEnvironmentPreference");
    expect(client).not.toContain("writeActiveEnvironmentPreference");
    expect(client).not.toContain("contexts[0]");
    expect(client).toContain('value="INDEPENDENT"');
    expect(client).toContain('value="PROJECT_BOUND"');
    expect(client).toContain("effectiveTaskContext(input)");
    expect(productPreferences).toContain('taskProjectContextPersistence = "POSTGRESQL_TASK_REVISION_ONLY"');
    expect(productPreferences).toContain('globalProjectAutoSelection = "FORBIDDEN"');
    expect(productPreferences).not.toMatch(/localStorage|active-environment-id/);
  });

  it("uses relational lifecycle reconstruction rather than tasks.draft", () => {
    expect(lifecycle).toContain("task_draft_revisions");
    expect(lifecycle).toContain("task_workspace_snapshots");
    expect(lifecycle).not.toMatch(/select\s+.*\bdraft\b.*from intentchord\.tasks/i);
  });

  it("preserves raw bytes before parsing without identity injection", () => {
    const submitStart = lifecycle.indexOf("export async function submitRawReport");
    const rawInsert = lifecycle.indexOf("insert into intentchord.report_submissions", submitStart);
    const parseCall = lifecycle.indexOf("parseAuthoritativeReport(text, contentType)", submitStart);
    expect(submitStart).toBeGreaterThan(-1);
    expect(rawInsert).toBeGreaterThan(submitStart);
    expect(parseCall).toBeGreaterThan(rawInsert);
    expect(lifecycle).toContain("identityInjected: false");
    expect(lifecycle).not.toContain("parseImportedReport(text,");
    expect(lifecycle).toContain('new TextDecoder("utf-8", { fatal: true })');
  });

  it("binds the active Context Lease to the exact approved Task Draft revision", () => {
    expect(lifecycle).toContain("cr.task_draft_revision_id as run_task_draft_revision_id");
    expect(lifecycle).toContain("run.lease_task_draft_revision_id !== run.run_task_draft_revision_id");
  });

  it("keeps self-report validation separate from independent evidence", () => {
    expect(lifecycle).toContain("'EXECUTOR_VALIDATION'");
    expect(lifecycle).toContain("intentchord.validation_evidence");
    expect(lifecycle).toContain("only complete trusted producer batches can satisfy independent evidence gates");
    expect(lifecycle).toContain("trustedReferenceSatisfied");
  });

  it("revalidates proof-grade local Workspace Root Object authority before Contract resolution and Run creation", () => {
    expect(connector).toContain("VERIFIED_ROOT_OBJECT_REFERENCE_ONLY");
    expect(connector).toContain("assertRegisteredWorkspaceSourceAuthority");
    expect(lifecycle).toContain("verifyCurrentTaskWorkspaceFreshness(taskId)");
    expect(lifecycle).toContain("assertRegisteredWorkspaceSourceAuthority");
    expect(lifecycle).toContain("WORKSPACE_IDENTITY_STALE");
  });

  it("cannot leave the Client in authoritative success after Backend rejection", () => {
    const rejection = client.indexOf("if (!response.ok)");
    const rejectedReturn = client.indexOf("return undefined;", rejection);
    const authoritativeReplace = client.indexOf("return replaceAuthoritativeTask", rejection);
    expect(rejection).toBeGreaterThan(-1);
    expect(rejectedReturn).toBeGreaterThan(rejection);
    expect(authoritativeReplace).toBeGreaterThan(rejectedReturn);
    expect(client).toContain("await reloadAuthoritativeTask(taskIdForConflict)");
  });
  it("lets the owner describe work naturally without forcing explicit success conditions before intent resolution", () => {
    const schemas = readFileSync("src/server/schemas.ts", "utf8");
    const lifecycle = readFileSync("src/server/lifecycle.ts", "utf8");
    expect(schemas).not.toContain("Source implementation requires at least one explicit Owner-defined mandatory outcome.");
    expect(lifecycle).toContain("confirmedIntent.proposedRequirements.map");
    expect(lifecycle).toContain("intentOwnerRequirements");
  });


  it("routes built-in bounded Discovery through the Registered Workspace Root Object authority", () => {
    expect(discoveryLifecycle).toContain("assertRegisteredWorkspaceSourceAuthority(workspaceRegistrationId, governance)");
    expect(discoveryLifecycle).toContain("authorizedRootObjectIdentity");
    expect(discoveryLifecycle).toContain("WORKSPACE_SNAPSHOT_STALE");
    expect(discoveryTools).toContain("objectAuthority.enumerateRelativeDirectory");
    expect(discoveryTools).toContain("captureWorkspaceFile");
    expect(discoveryTools).toContain("DISCOVERY_WORKSPACE_ROOT_AUTHORITY_STALE");
    expect(discoveryTools).toContain("probeDirectory(boundary.rootReference, governance)");
    expect(discoveryTools).not.toContain("await readFile(");
    expect(discoveryTools).not.toContain("await readdir(");
  });


  it("propagates request abort governance into built-in Discovery instead of degrading it to an evidence gap", () => {
    expect(discoveryRoute).toContain("{ signal: request.signal }");
    expect(discoveryLifecycle).toContain("signal: governance.signal");
    expect(discoveryLifecycle).toContain("deadlineAt: governance.deadlineAt");
    expect(discoveryRunner).toContain("terminalRuntimeGovernanceCode");
    expect(discoveryRunner).toContain("if (terminalRuntimeGovernanceCode(error)) throw error");
  });

  it("keeps Windows governed source capture cancellable and budget-bounded during the helper operation", () => {
    expect(filesystemAuthority).toContain("requestGovernedCapture");
    expect(filesystemAuthority).toContain("cancelCaptureHelper");
    expect(filesystemAuthority).toContain("deadline_epoch_ms");
    expect(filesystemAuthority).toContain("max_read_bytes");
    expect(filesystemAuthority).toContain("progress_bytes");
    expect(filesystemAuthority).not.toContain("taskkill.exe");
    expect(windowsFilesystemHelper).toContain("deadlineEpochMs");
    expect(windowsFilesystemHelper).toContain("maxReadBytes");
    expect(windowsFilesystemHelper).toContain("progress_bytes");
    expect(windowsFilesystemHelper).not.toContain("taskkill.exe");
  });


  it("preserves terminal runtime governance codes at the HTTP operation boundary", () => {
    expect(serverErrors).toContain("globalRuntimeGovernanceCode(error)");
    expect(serverErrors).toContain("if (governedCode)");
    expect(serverErrors).toContain("new HttpCommandError(");
    expect(serverErrors).toContain("governedCode,");
  });

  it("routes governed Source Evidence through the shared capture bridge and preserves abort/deadline classification", () => {
    expect(sourceReadBridge).toContain("signal: input.signal");
    expect(sourceReadBridge).toContain("deadlineAt: input.deadlineAt");
    expect(sourceReadBridge).toContain("assertRegisteredWorkspaceSourceAuthority(workspaceId, governance)");
    expect(lifecycle).toContain("terminalRuntimeGovernanceCode(error)");
    expect(lifecycle).toContain("if (governedCode)");
    expect(lifecycle).toContain("captureRegisteredWorkspaceSourceFile");
  });

  it("reuses one owned Windows metadata helper and keeps file capture on a separate governed channel", () => {
    expect(filesystemAuthority).toContain("ensureMetadataHelper");
    expect(filesystemAuthority).toContain("requestGovernedMetadata");
    expect(filesystemAuthority).toContain("metadataSerial");
    expect(filesystemAuthority).toContain("ensureCaptureHelper");
    expect(filesystemAuthority).not.toContain('requestGovernedProbe(');
    expect(filesystemAuthority).not.toContain('requestGovernedEnumeration(');
    expect(filesystemAuthority).not.toContain('"-SingleRequest"');
    expect(filesystemAuthority).not.toContain("taskkill.exe");
  });

  it("keeps pre-migration validation free of PostgreSQL integration tests and verifies Canonical V1 samples deterministically", () => {
    expect(packageJson).toContain('"test:non-pg"');
    expect(packageJson).toContain('"validate:pre-migration"');
    expect(packageJson).toContain('"test:post-migration:pg"');
    expect(nonPostgresTestRunner).toContain('.postgres.integration.test.');
    expect(nonPostgresTestRunner).toContain("POSTGRES_TEST_LEAK_IN_NON_PG_GATE");
    expect(sampleVerifier).toContain("CANONICAL_WORKSPACE_INDEX_SAMPLE_VERIFY=PASS");
    expect(sampleVerifier).toContain("intentchord.workspace-source-state-fingerprint/v2");
  });

});
