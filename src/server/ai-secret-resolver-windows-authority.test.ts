/**
 * WINDOWS CREDENTIAL MANAGER WRITE AUTHORITY — Unit Tests (Correction C1).
 *
 * Validates storeSecret / removeSecret / read semantics of the production
 * WindowsCredentialResolver against a MOCKED child_process boundary.
 *
 * HARD SAFETY RULES:
 *   - node:child_process is mocked: no real PowerShell process is spawned.
 *   - No real Windows Credential Manager credential is read or mutated.
 *   - Fake secrets always contain "-" so they can never appear in the base64
 *     alphabet used by the write script body (plaintext-echo proof).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { WindowsCredentialResolver } from "@/server/ai-secret-resolver-windows";
import type { InternalAiSecretAuthority } from "@/server/ai-secret-authority";

const WINDOWS_AUTHORITY_SOURCE = readFileSync(
  resolve(__dirname, "ai-secret-resolver-windows.ts"),
  "utf8",
);

type QueuedPowerShell = { stdout: string; error?: Error };
const queued: QueuedPowerShell[] = [];

function queuePowerShell(stdout: string, error?: Error): void {
  queued.push(error ? { stdout, error } : { stdout });
}

function capturedScript(): string {
  const call = execFileMock.mock.calls[0];
  const argv = call?.[1] as string[] | undefined;
  return argv?.[3] ?? "";
}

describe("WINDOWS_CREDENTIAL_WRITE_AUTHORITY (mocked OS boundary)", () => {
  let authority: WindowsCredentialResolver;

  beforeEach(() => {
    queued.length = 0;
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      const next = queued.shift() ?? { stdout: "" };
      callback(next.error ?? null, next.stdout);
    });
    authority = new WindowsCredentialResolver();
  });

  it("implements InternalAiSecretAuthority with full read + write surface", () => {
    const asAuthority: InternalAiSecretAuthority = authority;
    expect(typeof asAuthority.isCredentialPresent).toBe("function");
    expect(typeof asAuthority.resolveSecret).toBe("function");
    expect(typeof asAuthority.resolveSecretOrThrow).toBe("function");
    expect(typeof asAuthority.storeSecret).toBe("function");
    expect(typeof asAuthority.removeSecret).toBe("function");
  });

  it("storeSecret resolves on STORED using the governed target convention without plaintext echo", async () => {
    const secret = "c3-windows-store-secret-do-not-log";
    queuePowerShell("STORED\r\n");

    await expect(authority.storeSecret("C3_WINDOWS_STORE_KEY", secret)).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, execArgs] = execFileMock.mock.calls[0];
    expect((execArgs as string[])[0]).toBe("-NoProfile");
    const script = capturedScript();
    expect(script).toContain("IntentChord/InternalAI/C3_WINDOWS_STORE_KEY");
    expect(script).toContain("CredWriteW");
    expect(script).toContain("CRED_TYPE_GENERIC");
    expect(script).toContain("CRED_PERSIST_LOCAL_MACHINE");
    expect(script).toContain(Buffer.from(secret, "utf8").toString("base64"));
    // "-" is outside the standard base64 alphabet → plaintext cannot appear.
    expect(script).not.toContain(secret);
  });

  it("storeSecret fails closed on STORE_FAILED without exposing the secret", async () => {
    const secret = "c3-windows-store-fail-secret";
    queuePowerShell("STORE_FAILED");

    const failure = await authority.storeSecret("C3_WINDOWS_FAIL_KEY", secret).catch(e => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("WINDOWS_CREDENTIAL_STORE_FAILED");
    expect((failure as Error).message).toContain("C3_WINDOWS_FAIL_KEY");
    expect((failure as Error).message).not.toContain(secret);
  });

  it("storeSecret fails closed when the OS invocation errors or returns nothing", async () => {
    const secret = "c3-windows-os-error-secret";

    queuePowerShell("", new Error("powershell spawn failure"));
    const spawnFailure = await authority.storeSecret("C3_WINDOWS_SPAWN_KEY", secret).catch(e => e as Error);
    expect((spawnFailure as Error).message).toContain("WINDOWS_CREDENTIAL_STORE_FAILED");
    expect((spawnFailure as Error).message).not.toContain(secret);

    queuePowerShell("");
    const emptyFailure = await authority.storeSecret("C3_WINDOWS_EMPTY_KEY", secret).catch(e => e as Error);
    expect((emptyFailure as Error).message).toContain("WINDOWS_CREDENTIAL_STORE_FAILED");
    expect((emptyFailure as Error).message).not.toContain(secret);
  });

  it("storeSecret rejects an empty secret without invoking the OS", async () => {
    await expect(authority.storeSecret("C3_WINDOWS_EMPTY_INPUT_KEY", "")).rejects.toThrow(
      /WINDOWS_CREDENTIAL_STORE_FAILED/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("removeSecret resolves on REMOVED", async () => {
    queuePowerShell("REMOVED\r\n");
    await expect(authority.removeSecret("C3_WINDOWS_REMOVE_KEY")).resolves.toBeUndefined();
    const script = capturedScript();
    expect(script).toContain("CredDeleteW");
    expect(script).toContain("IntentChord/InternalAI/C3_WINDOWS_REMOVE_KEY");
  });

  it("removeSecret is idempotent: ABSENT (ERROR_NOT_FOUND) is success", async () => {
    queuePowerShell("ABSENT\r\n");
    await expect(authority.removeSecret("C3_WINDOWS_ABSENT_KEY")).resolves.toBeUndefined();
  });

  it("removeSecret fails closed on DELETE_FAILED or empty OS output", async () => {
    queuePowerShell("DELETE_FAILED\r\n");
    const explicit = await authority.removeSecret("C3_WINDOWS_DELETE_FAIL_KEY").catch(e => e as Error);
    expect((explicit as Error).message).toContain("WINDOWS_CREDENTIAL_DELETE_FAILED");
    expect((explicit as Error).message).toContain("C3_WINDOWS_DELETE_FAIL_KEY");

    queuePowerShell("", new Error("powershell spawn failure"));
    const spawn = await authority.removeSecret("C3_WINDOWS_DELETE_SPAWN_KEY").catch(e => e as Error);
    expect((spawn as Error).message).toContain("WINDOWS_CREDENTIAL_DELETE_FAILED");
  });

  it("read semantics unchanged: present/read/throw follow CredReadW behavior", async () => {
    queuePowerShell("PRESENT\r\n");
    expect(await authority.isCredentialPresent("C3_WINDOWS_READ_KEY")).toBe(true);

    queuePowerShell("ABSENT\r\n");
    expect(await authority.isCredentialPresent("C3_WINDOWS_READ_KEY")).toBe(false);

    queuePowerShell("resolved-secret-value\r\n");
    expect(await authority.resolveSecret("C3_WINDOWS_READ_KEY")).toBe("resolved-secret-value");

    queuePowerShell("");
    expect(await authority.resolveSecret("C3_WINDOWS_READ_KEY")).toBeUndefined();

    queuePowerShell("");
    await expect(authority.resolveSecretOrThrow("C3_WINDOWS_READ_KEY")).rejects.toThrow(
      /WINDOWS_CREDENTIAL_NOT_FOUND/,
    );
  });

  it("source-level: storeSecret/removeSecret fail closed and never log secret material", () => {
    const source = WINDOWS_AUTHORITY_SOURCE;
    expect(source).toContain('if (result !== "STORED")');
    expect(source).toContain('if (result !== "REMOVED" && result !== "ABSENT")');
    expect(source).toContain("WINDOWS_CREDENTIAL_STORE_FAILED");
    expect(source).toContain("WINDOWS_CREDENTIAL_DELETE_FAILED");
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)\([^)]*secret/i);
    expect(source).not.toContain("Provision-IntentChordSecret");
    expect(source).not.toMatch(/process\.env\s*\[/);
    expect(source).not.toContain("INSERT INTO intentchord");
  });
});
