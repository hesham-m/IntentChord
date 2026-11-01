import { classifyUsnReasons, type UsnEvent } from "@/core/workspace-index/continuity/types";

/**
 * Exact USN_RECORD_V2 binary decoder + WINDOWS_FILE_ID_128_V1 normalization (SPEC V3
 * STRONG-helper closure, Parts B/C/G). Fails closed on any structural anomaly.
 *
 * FileReferenceNumber identity representation (authoritative):
 *   "<mft-ref-hex>:<sequence-hex>"   e.g. "12345:42"
 * Derived EXACTLY from the OS-provided 64-bit field:
 *   ref  = value & 0x0000FFFFFFFFFFFF
 *   seq  = value >> 48
 */

export const USN_RECORD_V2_MIN_SIZE = 60;
const SEQ_SHIFT = BigInt(48);
const REF_MASK = (BigInt(1) << SEQ_SHIFT) - BigInt(1);

export type ParsedUsnRecordV2 = {
  recordLength: number;
  majorVersion: number;
  minorVersion: number;
  /** "<ref-hex>:<seq-hex>" — exact MFT reference INCLUDING sequence. */
  fileReferenceNumber: string;
  parentFileReferenceNumber: string;
  usnHex: string;
  timestamp1601: bigint;
  reasonFlags: number;
  sourceInfo: number;
  securityId: number;
  fileName: string;
  reasons: ReturnType<typeof classifyUsnReasons>;
};

export class UsnRecordParseError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "UsnRecordParseError";
  }
}

function readBigUInt64LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}

/** Exact split of the raw 64-bit FileReferenceNumber into (ref, sequence). */
export function splitFileReferenceNumber(raw64: bigint): { ref: string; seq: string; key: string } {
  const ref = raw64 & REF_MASK;
  const seq = raw64 >> SEQ_SHIFT;
  const refH = ref.toString(16);
  const seqH = seq.toString(16);
  return { ref: refH, seq: seqH, key: `${refH}:${seqH}` };
}

export function parseUsnRecordV2(buf: Buffer, offset = 0): ParsedUsnRecordV2 {
  if (offset + 8 > buf.length) throw new UsnRecordParseError("USN_TRUNCATED_HEADER");
  const recordLength = buf.readUInt32LE(offset);
  if (recordLength === 0) throw new UsnRecordParseError("USN_RECORD_LENGTH_ZERO");
  if (recordLength < USN_RECORD_V2_MIN_SIZE) throw new UsnRecordParseError("USN_RECORD_LENGTH_BELOW_MINIMUM");
  if (offset + recordLength > buf.length) throw new UsnRecordParseError("USN_TRUNCATED_BUFFER");

  const majorVersion = buf.readUInt16LE(offset + 4);
  if (majorVersion !== 2) throw new UsnRecordParseError(`USN_UNSUPPORTED_MAJOR_VERSION:${majorVersion}`);
  const minorVersion = buf.readUInt16LE(offset + 6);

  const fileRefRaw = readBigUInt64LE(buf, offset + 8);
  const parentRaw = readBigUInt64LE(buf, offset + 16);
  const usnRaw = readBigUInt64LE(buf, offset + 24);
  const timestamp1601 = readBigUInt64LE(buf, offset + 32);
  const reasonFlags = buf.readUInt32LE(offset + 56);
  const sourceInfo = buf.readUInt32LE(offset + 60);
  const securityId = buf.readUInt32LE(offset + 64);
  const fileNameOffset = buf.readUInt32LE(offset + 68);
  const fileNameLength = buf.readUInt32LE(offset + 72);

  const fr = splitFileReferenceNumber(fileRefRaw);
  const pr = splitFileReferenceNumber(parentRaw);

  let fileName = "";
  if (fileNameLength > 0) {
    const nameStart = offset + fileNameOffset;
    if (nameStart + fileNameLength > offset + recordLength || nameStart + fileNameLength > buf.length) {
      throw new UsnRecordParseError("USN_FILENAME_OUT_OF_RECORD");
    }
    fileName = buf.toString("utf16le", nameStart, nameStart + fileNameLength);
  }

  return {
    recordLength,
    majorVersion,
    minorVersion,
    fileReferenceNumber: `${fr.ref}:${fr.seq}`,
    parentFileReferenceNumber: `${pr.ref}:${pr.seq}`,
    usnHex: usnRaw.toString(16),
    timestamp1601,
    reasonFlags,
    sourceInfo,
    securityId,
    fileName,
    reasons: classifyUsnReasons(reasonFlags),
  };
}

/** Parses a whole FSCTL buffer; trailing partial record => fail-closed TRUNCATED_BUFFER. */
export function parseUsnBuffer(buf: Buffer): { records: ParsedUsnRecordV2[]; nextUsn: bigint } {
  const nextUsn = readBigUInt64LE(buf, 0);
  let offset = 8;
  const records: ParsedUsnRecordV2[] = [];
  while (offset < buf.length) {
    if (buf.length - offset < USN_RECORD_V2_MIN_SIZE) throw new UsnRecordParseError("USN_TRUNCATED_TAIL");
    const rec = parseUsnRecordV2(buf, offset);
    records.push(rec);
    offset += rec.recordLength;
  }
  return { records, nextUsn };
}

// ---------------------------------------------------------------------------
// WINDOWS_FILE_ID_128_V1 equivalence (Part C)
// ---------------------------------------------------------------------------
/**
 * Existing traversal identity: 32-hex FILE_ID_INFO.FileId[16] captured via GetFileInformationByHandleEx.
 * Physical layout (little-endian): bytes[0..8]=MFT reference, bytes[8..10]=MFT sequence.
 * Normalization to the SAME comparison key used by USN records proves R2 equivalence.
 */
export function windowsFileId128ToUsnKey(fileIdHex32: string): { ref: string; seq: string; key: string } {
  if (!/^[0-9a-f]{32}$/.test(fileIdHex32)) throw new UsnRecordParseError("WIN128_FILE_ID_MALFORMED");
  const b = Buffer.from(fileIdHex32, "hex");
  const ref = b.readBigUInt64LE(0) & REF_MASK;
  const seq = BigInt(b.readUInt16LE(8));
  const key = `${ref.toString(16)}:${seq.toString(16)}`;
  return { ref: ref.toString(16), seq: seq.toString(16), key };
}

export function usnFileRefToKey(fileReferenceNumber: string): { ref: string; seq: string; key: string } {
  const parts = fileReferenceNumber.split(":");
  if (parts.length !== 2 || parts.some(p => p === "")) throw new UsnRecordParseError("USN_FILE_REF_MALFORMED");
  const ref = BigInt("0x" + parts[0]);
  const seq = BigInt("0x" + parts[1]);
  return { ref: ref.toString(16), seq: seq.toString(16), key: `${ref.toString(16)}:${seq.toString(16)}` };
}

/** Strong-authority guard: a usable exact sequence must be present and non-zero. */
export function hasExactSequence(fileReferenceNumber: string): boolean {
  try {
    const parsed = usnFileRefToKey(fileReferenceNumber);
    return Number.parseInt(parsed.seq, 16) > 0;
  } catch {
    return false;
  }
}
