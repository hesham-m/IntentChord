import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { profileCsvFile } from "@/core/workspace-index/csv-profile";

async function withCsv(bytes: Buffer | string, run: (filePath: string, size: number) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "intentchord-csv-profile-"));
  const filePath = path.join(root, "evidence.csv");
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  try {
    await writeFile(filePath, buffer);
    await run(filePath, buffer.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("bounded CSV evidence profiling", () => {
  it("enforces the exact sample-byte boundary without reading a permanent large fixture", async () => {
    await withCsv("a,b\n1,2\n3,4\n", async (filePath, size) => {
      const profile = await profileCsvFile({ absolutePath: filePath, fileSizeBytes: size, maxSampleBytes: 8 });
      expect(profile.sample_bytes_read).toBe(8);
      expect(profile.sample_bytes_read).toBeLessThanOrEqual(profile.sample_limit_bytes);
      expect(profile.sample_complete_file).toBe(false);
      expect(profile.exact_record_count).toBeUndefined();
    });
  });

  it("supports quoted commas and embedded newlines within the bytes actually sampled", async () => {
    const csv = 'name,note\nalice,"x,y"\nbob,"line1\nline2"\n';
    await withCsv(csv, async (filePath, size) => {
      const profile = await profileCsvFile({ absolutePath: filePath, fileSizeBytes: size, maxSampleBytes: size });
      expect(profile.quoted_fields_observed).toBe(true);
      expect(profile.quoted_commas_observed).toBe(true);
      expect(profile.embedded_newlines_observed).toBe(true);
      expect(profile.exact_record_count).toBe(3);
      expect(profile.header_columns).toEqual(["name", "note"]);
    });
  });

  it("recognizes UTF-8 BOM and UTF-16LE BOM without including BOM text in the header", async () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n1,2\n", "utf8")]);
    await withCsv(utf8, async (filePath, size) => {
      const profile = await profileCsvFile({ absolutePath: filePath, fileSizeBytes: size, maxSampleBytes: size });
      expect(profile.encoding).toBe("UTF8");
      expect(profile.header_columns).toEqual(["a", "b"]);
    });

    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\r\n1,2\r\n", "utf16le")]);
    await withCsv(utf16, async (filePath, size) => {
      const profile = await profileCsvFile({ absolutePath: filePath, fileSizeBytes: size, maxSampleBytes: size });
      expect(profile.encoding).toBe("UTF16LE");
      expect(profile.header_columns).toEqual(["a", "b"]);
      expect(profile.exact_record_count).toBe(2);
    });
  });

  it("records actual malformed quote evidence and does not claim an exact record count", async () => {
    await withCsv('a,b\n1,"broken\n', async (filePath, size) => {
      const profile = await profileCsvFile({ absolutePath: filePath, fileSizeBytes: size, maxSampleBytes: size });
      expect(profile.malformed_quote_observed).toBe(true);
      expect(profile.diagnostics.map(item => item.code)).toContain("CSV_MALFORMED_QUOTE");
      expect(profile.exact_record_count).toBeUndefined();
    });
  });

  it("classifies a record crossing the sample limit without calling it a final file record", async () => {
    const csv = `a,b\n${"x".repeat(128)},2\n`;
    await withCsv(csv, async (filePath, size) => {
      const profile = await profileCsvFile({ absolutePath: filePath, fileSizeBytes: size, maxSampleBytes: 16 });
      expect(profile.record_exceeds_sample_limit).toBe(true);
      expect(profile.diagnostics.map(item => item.code)).toContain("CSV_RECORD_EXCEEDS_SAMPLE_LIMIT");
      expect(profile.exact_record_count).toBeUndefined();
      expect(profile.sample_complete_record_count).toBe(1);
    });
  });

  it("propagates timeout during CSV streaming as a global governed failure", async () => {
    const streamFactory = () => Readable.from((async function* () {
      await new Promise(resolve => setTimeout(resolve, 20));
      yield Buffer.from("a,b\n1,2\n");
    })());
    await expect(profileCsvFile({
      absolutePath: "virtual.csv",
      fileSizeBytes: 10,
      maxSampleBytes: 10,
      deadlineAt: Date.now() + 5,
      streamFactory,
    })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
  });

  it("propagates abort during CSV streaming as a global governed failure", async () => {
    const controller = new AbortController();
    const streamFactory = () => Readable.from((async function* () {
      await new Promise(resolve => setTimeout(resolve, 20));
      yield Buffer.from("a,b\n1,2\n");
    })());
    setTimeout(() => controller.abort(), 5);
    await expect(profileCsvFile({
      absolutePath: "virtual.csv",
      fileSizeBytes: 10,
      maxSampleBytes: 10,
      signal: controller.signal,
      streamFactory,
    })).rejects.toMatchObject({ code: "WORKSPACE_INDEX_ABORTED" });
  });
});
