import net from "node:net";
import { randomUUID } from "node:crypto";
import { classifyUsnReasons } from "@/core/workspace-index/continuity/types";
import type { UsnEvent, JournalIdentity } from "@/core/workspace-index/continuity/types";
import { hasExactSequence } from "@/core/workspace-index/continuity/usn-record-v2";

/** This is a local Windows named pipe, never a TCP/HTTP endpoint. */
export const INTENTCHORD_USN_AUTHORITY_PIPE = "IntentChordUsnAuthority.v1";
export const INTENTCHORD_USN_AUTHORITY_PROTOCOL = "intentchord.usn-authority/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 64 * 1024;
const USN_HEX_RE = /^0x[0-9a-f]+$/;

type AuthorityRequest = {
  protocol: typeof INTENTCHORD_USN_AUTHORITY_PROTOCOL;
  requestId: string;
  op: "QUERY_USN" | "READ_USN_INTERVAL";
  volumeRoot: string;
  journalId?: string;
  startUsnExclusive?: string;
  endUsnInclusive?: string;
  maxEvents?: number;
};
export type UsnAuthorityTransport = (request: AuthorityRequest, signal?: AbortSignal) => Promise<unknown>;
function pipePath(name: string): string { return `\\\\.\\pipe\\${name}`; }
function validateQuery(raw: any, requestId: string): string | null {
  if (raw?.protocol !== INTENTCHORD_USN_AUTHORITY_PROTOCOL || raw?.requestId !== requestId) return "PROTOCOL_MISMATCH";
  if (raw.supported === false) return typeof raw.degradationReason === "string" ? null : "INVALID_RESPONSE";
  if (raw.supported !== true || typeof raw.journalId !== "string" || !USN_HEX_RE.test(raw.journalId) || typeof raw.volumeSerial !== "string" || !raw.volumeSerial || typeof raw.firstUsn !== "string" || !USN_HEX_RE.test(raw.firstUsn) || typeof raw.nextUsn !== "string" || !USN_HEX_RE.test(raw.nextUsn)) return "INVALID_RESPONSE";
  return BigInt(raw.firstUsn) <= BigInt(raw.nextUsn) ? null : "INVALID_RESPONSE";
}
function validateRead(raw: any, requestId: string): string | null {
  if (raw?.protocol !== INTENTCHORD_USN_AUTHORITY_PROTOCOL || raw?.requestId !== requestId) return "PROTOCOL_MISMATCH";
  if (raw.ok === false) return typeof raw.failure === "string" ? null : "INVALID_RESPONSE";
  if (raw.ok !== true || !Array.isArray(raw.events)) return "INVALID_RESPONSE";
  for (const event of raw.events) if (typeof event?.usn !== "string" || !USN_HEX_RE.test(event.usn) || typeof event.fileReferenceNumber !== "string" || !hasExactSequence(event.fileReferenceNumber) || typeof event.reasonFlags !== "number" || event.reasonFlags < 0) return "INVALID_RESPONSE";
  return null;
}
function mapTransportFailure(error: unknown): "SERVICE_UNAVAILABLE" | "ACCESS_DENIED" | "TIMEOUT" | "PROTOCOL_MISMATCH" | "INVALID_REQUEST" {
  const code = String((error as { code?: string })?.code ?? error);
  if (code.includes("ABORT")) return "TIMEOUT";
  if (code.includes("EACCES") || code.includes("ACCESS_DENIED")) return "ACCESS_DENIED";
  if (code.includes("TIMEOUT")) return "TIMEOUT";
  if (code.includes("PROTOCOL")) return "PROTOCOL_MISMATCH";
  if (code.includes("INVALID")) return "INVALID_REQUEST";
  return "SERVICE_UNAVAILABLE";
}
async function requestNamedPipe(name: string, request: AuthorityRequest, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw Object.assign(new Error("ABORT_SIGNAL"), { code: "ABORT_SIGNAL" });
  const body = Buffer.from(JSON.stringify(request), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: pipePath(name) }); let settled = false; let buffer = Buffer.alloc(0); let expected: number | undefined;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.removeAllListeners(); socket.destroy(); fn(); };
    const abort = () => finish(() => reject(Object.assign(new Error("ABORT_SIGNAL"), { code: "ABORT_SIGNAL" })));
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }))), timeoutMs);
    socket.once("connect", () => { const header = Buffer.alloc(4); header.writeInt32LE(body.length); socket.write(Buffer.concat([header, body])); });
    socket.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); if (expected === undefined && buffer.length >= 4) { expected = buffer.readInt32LE(0); if (expected <= 0 || expected > MAX_FRAME_BYTES) return finish(() => reject(Object.assign(new Error("PROTOCOL_MISMATCH"), { code: "PROTOCOL_MISMATCH" }))); } const responseLength = expected; if (responseLength !== undefined && buffer.length >= responseLength + 4) { try { finish(() => resolve(JSON.parse(buffer.subarray(4, responseLength + 4).toString("utf8")))); } catch { finish(() => reject(Object.assign(new Error("PROTOCOL_MISMATCH"), { code: "PROTOCOL_MISMATCH" }))); } } });
    socket.once("error", error => finish(() => reject(error))); socket.once("end", () => { if (!settled) finish(() => reject(Object.assign(new Error("SERVICE_UNAVAILABLE"), { code: "SERVICE_UNAVAILABLE" }))); }); signal?.addEventListener("abort", abort, { once: true });
  });
}
export interface WindowsUsnJournalPortOptions {
  fixtureMode?: boolean;
  queryFixture?: { supported: boolean; journalId?: string; volumeSerial?: string; firstUsn?: bigint; nextUsn?: bigint; degradationReason?: string };
  readFixture?: { ok: boolean; events?: UsnEvent[]; truncated?: boolean; failure?: string };
  /** Kept as a compatibility alias; this now bounds one named-pipe request. */
  helperTimeoutMs?: number;
  requestTimeoutMs?: number;
  pipeName?: string;
  /** Test seam only; production always uses the authenticated named pipe. */
  transport?: UsnAuthorityTransport;
}
/** Windows USN port. Production reaches only the privileged local named-pipe service. */
export class WindowsUsnJournalPort {
  private readonly fixtureMode: boolean; private readonly queryFixture: WindowsUsnJournalPortOptions["queryFixture"]; private readonly readFixture: WindowsUsnJournalPortOptions["readFixture"]; private readonly timeoutMs: number; private readonly pipeName: string; private readonly transport?: UsnAuthorityTransport;
  constructor(options: WindowsUsnJournalPortOptions = {}) { this.fixtureMode = options.fixtureMode ?? false; this.queryFixture = options.queryFixture; this.readFixture = options.readFixture; this.timeoutMs = options.requestTimeoutMs ?? options.helperTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS; this.pipeName = options.pipeName ?? INTENTCHORD_USN_AUTHORITY_PIPE; this.transport = options.transport; }
  async capability(volumeRoot: string, signal?: AbortSignal): Promise<{ supported: boolean; journalId: string; volumeSerial: string; firstUsn: bigint; nextUsn: bigint } | { supported: false; degradationReason: string }> {
    if (signal?.aborted) return { supported: false, degradationReason: "ABORTED_BEFORE_PIPE_REQUEST" };
    if (this.fixtureMode && this.queryFixture) return this.queryFixture.supported ? { supported: true, journalId: this.queryFixture.journalId!, volumeSerial: this.queryFixture.volumeSerial!, firstUsn: this.queryFixture.firstUsn!, nextUsn: this.queryFixture.nextUsn! } : { supported: false, degradationReason: this.queryFixture.degradationReason ?? "USN_QUERY_FAILED" };
    const request: AuthorityRequest = { protocol: INTENTCHORD_USN_AUTHORITY_PROTOCOL, requestId: randomUUID(), op: "QUERY_USN", volumeRoot };
    try { const raw: any = await (this.transport ? this.transport(request, signal) : requestNamedPipe(this.pipeName, request, this.timeoutMs, signal)); const invalid = validateQuery(raw, request.requestId); if (invalid) return { supported: false, degradationReason: invalid }; if (!raw.supported) return { supported: false, degradationReason: raw.degradationReason }; return { supported: true, journalId: raw.journalId.toLowerCase(), volumeSerial: raw.volumeSerial.toLowerCase(), firstUsn: BigInt(raw.firstUsn), nextUsn: BigInt(raw.nextUsn) }; } catch (error) { return { supported: false, degradationReason: mapTransportFailure(error) }; }
  }
  async readInterval(volumeRoot: string, journal: JournalIdentity, startUsnExclusive: bigint, endUsnInclusive: bigint, signal?: AbortSignal): Promise<{ ok: true; events: UsnEvent[]; truncated: boolean } | { ok: false; failure: string }> {
    if (signal?.aborted) return { ok: false, failure: "HELPER_CANCELLED" };
    if (this.fixtureMode && this.readFixture) return this.readFixture.ok ? { ok: true, events: this.readFixture.events ?? [], truncated: this.readFixture.truncated ?? false } : { ok: false, failure: this.readFixture.failure ?? "HELPER_FAILED" };
    const request: AuthorityRequest = { protocol: INTENTCHORD_USN_AUTHORITY_PROTOCOL, requestId: randomUUID(), op: "READ_USN_INTERVAL", volumeRoot, journalId: journal.journalId, startUsnExclusive: `0x${startUsnExclusive.toString(16)}`, endUsnInclusive: `0x${endUsnInclusive.toString(16)}`, maxEvents: 4096 };
    try { const raw: any = await (this.transport ? this.transport(request, signal) : requestNamedPipe(this.pipeName, request, this.timeoutMs, signal)); const invalid = validateRead(raw, request.requestId); if (invalid) return { ok: false, failure: "HELPER_FAILED" }; if (!raw.ok) return { ok: false, failure: String(raw.failure) === "JOURNAL_RESET" ? "JOURNAL_RESET" : String(raw.failure) === "GAP_BEFORE_RETAINED" ? "GAP_BEFORE_RETAINED" : "HELPER_FAILED" }; return { ok: true, truncated: raw.truncated === true, events: raw.events.map((event: any) => ({ usn: BigInt(event.usn), fileReferenceNumber: event.fileReferenceNumber, fileName: event.fileName == null ? undefined : String(event.fileName), reasonFlags: event.reasonFlags, reasons: classifyUsnReasons(event.reasonFlags) })) }; } catch (error) { const code = mapTransportFailure(error); return { ok: false, failure: code === "TIMEOUT" ? "HELPER_TIMEOUT" : (code === "ACCESS_DENIED" || code === "SERVICE_UNAVAILABLE") ? "PROVIDER_UNAVAILABLE" : "HELPER_FAILED" }; }
  }
}
