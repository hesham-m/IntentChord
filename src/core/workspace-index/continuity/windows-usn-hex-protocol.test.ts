import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { WindowsUsnJournalPort, INTENTCHORD_USN_AUTHORITY_PROTOCOL } from "@/core/workspace-index/continuity/windows-usn-journal-port";

describe("USN pipe protocol - hexadecimal authority boundary", () => {
  it("P16 encodes digit-only and alpha hexadecimal interval bounds unambiguously", async () => {
    let request: any; const port = new WindowsUsnJournalPort({ transport: async r => { request = r; return { protocol: INTENTCHORD_USN_AUTHORITY_PROTOCOL, requestId: r.requestId, ok: true, events: [], truncated: false }; } }); await port.readInterval("C:\\", { journalId: "0x1", volumeSerial: "v" }, BigInt("0x10"), BigInt("0x1a2b")); expect(request.startUsnExclusive).toBe("0x10"); expect(request.endUsnInclusive).toBe("0x1a2b");
  });
  it("P17 source keeps native FSCTL and never embeds a PowerShell fallback in the production port", async () => {
    const [service, port] = await Promise.all([readFile("src/native/windows/usn-authority-service/NativeUsnAuthority.cs", "utf8"), readFile("src/core/workspace-index/continuity/windows-usn-journal-port.ts", "utf8")]); expect(service).toContain("IOCTL_USN_QUERY_JOURNAL = 0x000900F4"); expect(service).toContain("IOCTL_USN_READ_JOURNAL = 0x000900BB"); expect(service).toContain("GENERIC_READ | GENERIC_WRITE"); expect(service).toContain("FILE_SHARE_READ | FILE_SHARE_WRITE"); expect(port).toContain("net.createConnection"); expect(port).not.toContain("powershell.exe"); expect(port).not.toContain("windows-filesystem-object-authority.ps1");
  });
});
