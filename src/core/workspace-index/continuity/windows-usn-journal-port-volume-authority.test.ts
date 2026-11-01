import { describe, expect, it } from "vitest";
import { WindowsUsnJournalPort, INTENTCHORD_USN_AUTHORITY_PROTOCOL } from "@/core/workspace-index/continuity/windows-usn-journal-port";

describe("WindowsUsnJournalPort - volume authority behavioral proof", () => {
  it("P14 preserves exact caller volume roots across independent requests", async () => {
    const requests: any[] = []; const port = new WindowsUsnJournalPort({ transport: async request => { requests.push(request); return { protocol: INTENTCHORD_USN_AUTHORITY_PROTOCOL, requestId: request.requestId, ok: true, events: [], truncated: false }; } }); await port.readInterval("C:\\", { journalId: "0x1", volumeSerial: "v" }, BigInt(0), BigInt(1)); await port.readInterval("E:\\", { journalId: "0x2", volumeSerial: "v" }, BigInt(1), BigInt(2)); expect(requests.map(request => request.volumeRoot)).toEqual(["C:\\", "E:\\"]);
  });
  it("P15 direct interval read has no prior capability dependency", async () => {
    let calls = 0; const port = new WindowsUsnJournalPort({ transport: async request => { calls++; expect(request.op).toBe("READ_USN_INTERVAL"); return { protocol: INTENTCHORD_USN_AUTHORITY_PROTOCOL, requestId: request.requestId, ok: true, events: [], truncated: false }; } }); await expect(port.readInterval("E:\\", { journalId: "0x01dc66d184ce1a80", volumeSerial: "a2f99630" }, BigInt("0x64"), BigInt("0xc8"))).resolves.toMatchObject({ ok: true }); expect(calls).toBe(1);
  });
});
