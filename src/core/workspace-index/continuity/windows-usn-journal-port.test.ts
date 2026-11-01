import { describe, expect, it } from "vitest";
import { WindowsUsnJournalPort, INTENTCHORD_USN_AUTHORITY_PROTOCOL } from "@/core/workspace-index/continuity/windows-usn-journal-port";
import { classifyUsnReasons, USN_REASON } from "@/core/workspace-index/continuity/types";

describe("WindowsUsnJournalPort - privileged pipe boundary", () => {
  it("P07 preserves query response numeric semantics", async () => {
    const port = new WindowsUsnJournalPort({ transport: async request => ({ protocol: INTENTCHORD_USN_AUTHORITY_PROTOCOL, requestId: request.requestId, supported: true, volumeRoot: "E:\\", volumeSerial: "a2f99630", journalId: "0x01dc66d184ce1a80", firstUsn: "0x1764800000", nextUsn: "0x176691e4f8" }) });
    const result = await port.capability("E:\\"); expect(result).toMatchObject({ supported: true, journalId: "0x01dc66d184ce1a80" }); if (result.supported) expect(result.nextUsn).toBe(BigInt("0x176691e4f8"));
  });
  it("P08 preserves sequence-exact events and bounds as hexadecimal", async () => {
    let captured: any; const port = new WindowsUsnJournalPort({ transport: async request => { captured = request; return { protocol: INTENTCHORD_USN_AUTHORITY_PROTOCOL, requestId: request.requestId, ok: true, truncated: false, events: [{ usn: "0x10", fileReferenceNumber: "abc:2", fileName: "a.txt", reasonFlags: USN_REASON.DATA_OVERWRITE }] }; } });
    const result = await port.readInterval("E:\\", { journalId: "0x01", volumeSerial: "a" }, BigInt("0x10"), BigInt("0x3c4d")); expect(captured).toMatchObject({ op: "READ_USN_INTERVAL", volumeRoot: "E:\\", startUsnExclusive: "0x10", endUsnInclusive: "0x3c4d" }); if (result.ok) expect(result.events[0].reasons).toEqual(classifyUsnReasons(USN_REASON.DATA_OVERWRITE));
  });
  it("P09 rejects protocol/request-id confusion fail closed", async () => {
    const port = new WindowsUsnJournalPort({ transport: async () => ({ protocol: "wrong", requestId: "wrong", supported: true }) }); await expect(port.capability("C:\\")).resolves.toEqual({ supported: false, degradationReason: "PROTOCOL_MISMATCH" });
  });
  it("P10 service unavailable fails closed without PowerShell fallback", async () => {
    const port = new WindowsUsnJournalPort({ transport: async () => { throw Object.assign(new Error("down"), { code: "ENOENT" }); } }); await expect(port.capability("C:\\")).resolves.toEqual({ supported: false, degradationReason: "SERVICE_UNAVAILABLE" }); await expect(port.readInterval("C:\\", { journalId: "0x1", volumeSerial: "v" }, BigInt(0), BigInt(1))).resolves.toEqual({ ok: false, failure: "PROVIDER_UNAVAILABLE" });
  });
  it("P11 pre-aborted calls do not open a pipe", async () => {
    let opened = false; const ac = new AbortController(); ac.abort(); const port = new WindowsUsnJournalPort({ transport: async () => { opened = true; return {}; } }); await expect(port.capability("C:\\", ac.signal)).resolves.toEqual({ supported: false, degradationReason: "ABORTED_BEFORE_PIPE_REQUEST" }); await expect(port.readInterval("C:\\", { journalId: "0x1", volumeSerial: "v" }, BigInt(0), BigInt(1), ac.signal)).resolves.toEqual({ ok: false, failure: "HELPER_CANCELLED" }); expect(opened).toBe(false);
  });
  it("P12 in-flight abort is mapped without a process kill", async () => {
    const port = new WindowsUsnJournalPort({ transport: (_request, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { code: "ABORT_SIGNAL" })), { once: true })) }); const ac = new AbortController(); const pending = port.readInterval("C:\\", { journalId: "0x1", volumeSerial: "v" }, BigInt(0), BigInt(1), ac.signal); ac.abort(); await expect(pending).resolves.toEqual({ ok: false, failure: "HELPER_TIMEOUT" });
  });
  it("P13 fixture mode remains isolated from the service", async () => {
    const port = new WindowsUsnJournalPort({ fixtureMode: true, queryFixture: { supported: true, journalId: "J", volumeSerial: "V", firstUsn: BigInt(1), nextUsn: BigInt(2) }, readFixture: { ok: true, events: [], truncated: false } }); await expect(port.capability("C:\\")).resolves.toMatchObject({ supported: true }); await expect(port.readInterval("C:\\", { journalId: "J", volumeSerial: "V" }, BigInt(0), BigInt(2))).resolves.toEqual({ ok: true, events: [], truncated: false });
  });
});
