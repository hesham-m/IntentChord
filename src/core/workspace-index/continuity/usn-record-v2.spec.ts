import { describe, expect, it } from "vitest";
import {
  parseUsnRecordV2,
  parseUsnBuffer,
  UsnRecordParseError,
  windowsFileId128ToUsnKey,
  usnFileRefToKey,
  hasExactSequence,
} from "@/core/workspace-index/continuity/usn-record-v2";
import { classifyUsnReasons, USN_REASON } from "@/core/workspace-index/continuity/types";

function buildRecord(opts: {
  fileRef?: bigint;
  parentRef?: bigint;
  usn?: bigint;
  reason?: number;
  fileName?: string;
  padTo?: number;
}): Buffer {
  const name = Buffer.from(opts.fileName ?? "", "utf16le");
  const nameOffset = 76;
  let len = Math.max(nameOffset + name.length, 60);
  if (opts.padTo && opts.padTo > len) len = opts.padTo;
  len = Math.ceil(len / 8) * 8;
  const b = Buffer.alloc(len);
  b.writeUInt32LE(len, 0);
  b.writeUInt16LE(2, 4);
  b.writeUInt16LE(0, 6);
  b.writeBigUInt64LE(opts.fileRef ?? BigInt(0), 8);
  b.writeBigUInt64LE(opts.parentRef ?? BigInt(0), 16);
  b.writeBigUInt64LE(opts.usn ?? BigInt(0), 24);
  b.writeBigUInt64LE(BigInt(0), 32); // timestamp
  b.writeUInt32LE(opts.reason ?? 0, 56);
  b.writeUInt32LE(0, 60);
  b.writeUInt32LE(0, 64);
  b.writeUInt32LE(nameOffset, 68);
  b.writeUInt32LE(name.length, 72);
  if (name.length) name.copy(b, nameOffset);
  return b;
}

describe("USN_RECORD_V2 binary parser vectors (PART G)", () => {
  it("one valid record decodes exactly", () => {
    const rec = buildRecord({ fileRef: (BigInt(0x42) << BigInt(48)) | BigInt(0x12345), parentRef: BigInt(5), usn: BigInt(777), reason: USN_REASON.DATA_OVERWRITE });
    const p = parseUsnRecordV2(rec);
    expect(p.majorVersion).toBe(2);
    expect(p.fileReferenceNumber).toBe("12345:42");
    expect(p.usnHex).toBe(BigInt(777).toString(16));
    expect(p.reasons.category).toBe("CONTENT_AFFECTING");
  });

  it("multiple records in one buffer decode in order", () => {
    const a = buildRecord({ fileRef: BigInt(1), usn: BigInt(10) });
    const b = buildRecord({ fileRef: BigInt(2), usn: BigInt(20) });
    const { records, nextUsn } = parseUsnBuffer(Buffer.concat([Buffer.alloc(8), a, b]));
    expect(nextUsn).toBe(BigInt(0));
    expect(records.map(r => r.fileReferenceNumber)).toEqual(["1:0", "2:0"]);
  });

  it("Unicode filename decodes exactly", () => {
    const rec = buildRecord({ fileRef: BigInt(9), fileName: "رمز_α.ts" });
    expect(parseUsnRecordV2(rec).fileName).toBe("رمز_α.ts");
  });

  it("exact 64-bit reference decoding incl. high sequence bits", () => {
    const raw = (BigInt(0xfff) << BigInt(48)) | BigInt(0xffffffffffff);
    const p = parseUsnRecordV2(buildRecord({ fileRef: raw }));
    expect(p.fileReferenceNumber).toBe(`${(raw & BigInt(0xffffffffffff)).toString(16)}:${(raw >> BigInt(48)).toString(16)}`);
  });

  it("same slot different sequence => DIFFERENT identity", () => {
    const p1 = parseUsnRecordV2(buildRecord({ fileRef: (BigInt(3) << BigInt(48)) | BigInt(100) }));
    const p2 = parseUsnRecordV2(buildRecord({ fileRef: (BigInt(7) << BigInt(48)) | BigInt(100) }));
    expect(p1.fileReferenceNumber).not.toBe(p2.fileReferenceNumber);
  });

  it("rename OLD/NEW pair reasons classified as namespace", () => {
    const p = parseUsnRecordV2(buildRecord({ fileRef: BigInt(5), reason: USN_REASON.RENAME_OLD_NAME | USN_REASON.RENAME_NEW_NAME }));
    expect(p.reasons.category).toBe("NAMESPACE_PATH_AFFECTING");
  });

  it("hard-link reason classified NON_CONTENT_AFFECTING", () => {
    const p = parseUsnRecordV2(buildRecord({ fileRef: BigInt(5), reason: USN_REASON.HARD_LINK_CHANGE }));
    expect(p.reasons.category).toBe("NON_CONTENT_AFFECTING");
  });

  it("malformed RecordLength=0 fails closed", () => {
    const b = Buffer.alloc(64);
    expect(() => parseUsnRecordV2(b)).toThrow(UsnRecordParseError);
  });

  it("truncated buffer fails closed", () => {
    const good = buildRecord({ fileRef: BigInt(1) });
    const cut = good.subarray(0, 50);
    expect(() => parseUsnRecordV2(cut)).toThrow(UsnRecordParseError);
  });

  it("unsupported major version fails closed", () => {
    const b = buildRecord({ fileRef: BigInt(1) });
    b.writeUInt16LE(3, 4);
    expect(() => parseUsnRecordV2(b)).toThrow(/UNSUPPORTED_MAJOR_VERSION/);
  });
});

// =====================================================================
// PART C — WINDOWS_FILE_ID_128_V1 EQUIVALENCE PROOF
// =====================================================================
describe("WINDOWS_FILE_ID_128_V1 <-> USN FileReferenceNumber equivalence (PART C)", () => {
  it("identical physical encoding maps to identical comparison keys", () => {
    // Construct a real-shaped 128-bit FILE_ID_INFO.FileId: LE ref=0x12345, seq=0x0042 at bytes[8..9]
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(BigInt(0x12345), 0);
    b.writeUInt16LE(0x0042, 8);
    const win128 = windowsFileId128ToUsnKey(b.toString("hex"));
    const usn = usnFileRefToKey("12345:42");
    expect(win128).toEqual(usn);
    expect(win128.key).toBe(usn.key);
  });

  it("R2 semantics: same slot+same seq equivalent ; same slot+different seq NOT equivalent", () => {
    const kA = usnFileRefToKey("12345:42").key;
    const kB = windowsFileId128ToUsnKey(
      (() => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(0x12345), 0); b.writeUInt16LE(0x0042, 8); return b.toString("hex"); })()
    ).key;
    const kC = usnFileRefToKey("12345:43").key;
    expect(kA).toBe(kB);
    expect(kA).not.toBe(kC);
  });

  it("unknown/zero sequence can never satisfy strong exactness", () => {
    expect(hasExactSequence("12345:0")).toBe(false);
    expect(hasExactSequence("12345:42")).toBe(true);
    expect(hasExactSequence("garbage")).toBe(false);
  });
});
