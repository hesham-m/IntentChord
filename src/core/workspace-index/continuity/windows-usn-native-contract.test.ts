import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVICE_NATIVE = path.resolve(process.cwd(), "src", "native", "windows", "usn-authority-service", "NativeUsnAuthority.cs");
const HEADER_BYTES = 8;
const RECORD_V2_FIXED_BYTES = 60;
const FILE_REFERENCE_MASK = (BigInt(1) << BigInt(48)) - BigInt(1);

type NativeEvent = { usn: bigint; fileReferenceNumber: string; reasonFlags: number };

function record({
  usn,
  reference,
  name = "",
  reason = 0,
}: {
  usn: bigint;
  reference: bigint;
  name?: string;
  reason?: number;
}): Buffer {
  const nameBytes = Buffer.from(name, "utf16le");
  const length = RECORD_V2_FIXED_BYTES + nameBytes.length;
  const result = Buffer.alloc(length);
  result.writeUInt32LE(length, 0);
  result.writeUInt16LE(2, 4);
  result.writeBigUInt64LE(reference, 8);
  result.writeBigInt64LE(usn, 24);
  result.writeUInt32LE(reason >>> 0, 40);
  result.writeUInt16LE(nameBytes.length, 56);
  result.writeUInt16LE(RECORD_V2_FIXED_BYTES, 58);
  nameBytes.copy(result, RECORD_V2_FIXED_BYTES);
  return result;
}

function readNativeOutput(
  output: Buffer,
  startExclusive: bigint,
  endInclusive: bigint,
  maxEvents: number,
): { continuation: bigint; events: NativeEvent[]; truncated: boolean } {
  if (output.length < HEADER_BYTES) throw new Error("MALFORMED_USN_OUTPUT_HEADER");
  if (maxEvents <= 0) throw new Error("INVALID_MAX_EVENTS");

  const continuation = output.readBigInt64LE(0);
  const events: NativeEvent[] = [];
  let offset = HEADER_BYTES;
  while (offset < output.length) {
    const remaining = output.length - offset;
    if (remaining < RECORD_V2_FIXED_BYTES) throw new Error("MALFORMED_USN_RECORD_BOUNDS");
    const length = output.readUInt32LE(offset);
    if (length < RECORD_V2_FIXED_BYTES || length > remaining) throw new Error("MALFORMED_USN_RECORD_BOUNDS");
    if (output.readUInt16LE(offset + 4) !== 2) throw new Error("UNSUPPORTED_USN_RECORD_VERSION");

    const rawReference = output.readBigUInt64LE(offset + 8);
    const sequence = rawReference >> BigInt(48);
    if (sequence === BigInt(0)) throw new Error("SEQUENCE_NOT_EXACT");
    const usn = output.readBigInt64LE(offset + 24);
    const fileNameLength = output.readUInt16LE(offset + 56);
    const fileNameOffset = output.readUInt16LE(offset + 58);
    if (
      fileNameLength % 2 !== 0 ||
      (fileNameLength > 0 && (
        fileNameOffset < RECORD_V2_FIXED_BYTES ||
        fileNameOffset > length ||
        fileNameLength > length - fileNameOffset
      ))
    ) throw new Error("MALFORMED_USN_RECORD_BOUNDS");

    if (usn > startExclusive && usn <= endInclusive) {
      events.push({
        usn,
        fileReferenceNumber: `${(rawReference & FILE_REFERENCE_MASK).toString(16)}:${sequence.toString(16)}`,
        reasonFlags: output.readUInt32LE(offset + 40),
      });
      if (events.length === maxEvents) return { continuation, events, truncated: true };
    }
    offset += length;
  }
  return { continuation, events, truncated: false };
}

describe("FSCTL_READ_USN_JOURNAL native contract", () => {
  it("binds production input ABI, volume access/share, and native authorities", async () => {
    const source = await readFile(SERVICE_NATIVE, "utf8");
    expect(source).toContain("IOCTL_USN_QUERY_JOURNAL = 0x000900F4");
    expect(source).toContain("IOCTL_USN_READ_JOURNAL = 0x000900BB");
    expect(source).toContain("[StructLayout(LayoutKind.Sequential, Pack = 8)] private struct READ_USN_JOURNAL_DATA");
    expect(source).toContain("public long StartUsn; public uint ReasonMask, ReturnOnlyOnClose;");
    expect(source).toContain("public ulong Timeout, BytesToWaitFor, UsnJournalID;");
    expect(source).toContain("public ushort MinMajorVersion, MaxMajorVersion;");
    expect(source).toContain("Marshal.SizeOf<READ_USN_JOURNAL_DATA>() != 48");
    expect(source).toContain("GENERIC_READ | GENERIC_WRITE");
    expect(source).toContain("FILE_SHARE_READ | FILE_SHARE_WRITE");
    expect(source).toContain("StartUsn = (long)start");
    expect(source).toContain("UsnJournalID = journalId");
    expect(source).toContain("ReasonMask = 0xFFFFFFFF");
  });

  it("uses the eight-byte continuation header and walks records only after it", async () => {
    const first = record({ usn: BigInt(101), reference: (BigInt(2) << BigInt(48)) | BigInt(0xabc), name: "first" });
    const second = record({ usn: BigInt(102), reference: (BigInt(3) << BigInt(48)) | BigInt(0xdef), name: "second" });
    const output = Buffer.concat([Buffer.alloc(HEADER_BYTES), first, second]);
    output.writeBigInt64LE(BigInt(103), 0);

    const parsed = readNativeOutput(output, BigInt(100), BigInt(102), 10);
    expect(parsed.continuation).toBe(BigInt(103));
    expect(parsed.events.map(event => event.usn)).toEqual([BigInt(101), BigInt(102)]);
    expect(parsed.events.map(event => event.fileReferenceNumber)).toEqual(["abc:2", "def:3"]);

    const source = await readFile(SERVICE_NATIVE, "utf8");
    expect(source).toContain("var offset = OutputHeaderBytes;");
    expect(source).toContain("var continuation = Marshal.ReadInt64(outBuffer);");
    expect(source).toContain("input.StartUsn = current;");
  });

  it("fails closed for malformed bounds, unsupported version, and fabricated sequence zero", () => {
    const malformed = Buffer.concat([Buffer.alloc(HEADER_BYTES), record({ usn: BigInt(101), reference: BigInt(1) })]);
    malformed.writeUInt32LE(59, HEADER_BYTES);
    expect(() => readNativeOutput(malformed, BigInt(100), BigInt(200), 10)).toThrow("MALFORMED_USN_RECORD_BOUNDS");

    const version3 = Buffer.concat([Buffer.alloc(HEADER_BYTES), record({ usn: BigInt(101), reference: BigInt(1) << BigInt(48) })]);
    version3.writeUInt16LE(3, HEADER_BYTES + 4);
    expect(() => readNativeOutput(version3, BigInt(100), BigInt(200), 10)).toThrow("UNSUPPORTED_USN_RECORD_VERSION");

    const sequenceZero = Buffer.concat([Buffer.alloc(HEADER_BYTES), record({ usn: BigInt(101), reference: BigInt(0x123) })]);
    expect(() => readNativeOutput(sequenceZero, BigInt(100), BigInt(200), 10)).toThrow("SEQUENCE_NOT_EXACT");
  });

  it("enforces StartExclusive/EndInclusive and maxEvents truncation while allowing a complete empty interval", () => {
    const output = Buffer.concat([
      Buffer.alloc(HEADER_BYTES),
      record({ usn: BigInt(100), reference: (BigInt(1) << BigInt(48)) | BigInt(1) }),
      record({ usn: BigInt(101), reference: (BigInt(1) << BigInt(48)) | BigInt(2) }),
      record({ usn: BigInt(102), reference: (BigInt(1) << BigInt(48)) | BigInt(3) }),
    ]);
    output.writeBigInt64LE(BigInt(103), 0);

    expect(readNativeOutput(output, BigInt(100), BigInt(102), 10).events.map(event => event.usn))
      .toEqual([BigInt(101), BigInt(102)]);
    const capped = readNativeOutput(output, BigInt(100), BigInt(102), 1);
    expect(capped.events).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    const empty = Buffer.alloc(HEADER_BYTES);
    empty.writeBigInt64LE(BigInt(102), 0);
    expect(readNativeOutput(empty, BigInt(102), BigInt(102), 10)).toEqual({
      continuation: BigInt(102), events: [], truncated: false,
    });
  });

  it("requires a forward continuation after a non-empty native page", async () => {
    const source = await readFile(SERVICE_NATIVE, "utf8");
    expect(source).toContain("if (continuation == current && !sawRecord)");
    expect(source).toContain("if (continuation <= current)");
    expect(source).toContain("for (var guard = 0; guard < 128; guard++)");
  });
});
