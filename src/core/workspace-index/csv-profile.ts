import { createReadStream } from "node:fs";
import { TextDecoder } from "node:util";
import type { FileEncoding } from "@/core/workspace-index/types";
import { WorkspaceIndexBoundedError } from "@/core/workspace-index/adapters/filesystem";

export const CSV_BOUNDED_PROFILE_PARSER_ID = "CSV_BOUNDED_PROFILE_PARSER" as const;
export const CSV_BOUNDED_PROFILE_PARSER_VERSION = "1.0.0" as const;

export type CsvProfileDiagnostic = {
  code:
    | "CSV_SAMPLE_TRUNCATED"
    | "CSV_MALFORMED_QUOTE"
    | "CSV_RECORD_EXCEEDS_SAMPLE_LIMIT"
    | "CSV_UTF16LE_ODD_SAMPLE_BYTE_TRIMMED";
  message: string;
};

export type CsvBoundedProfile = {
  parser_id: typeof CSV_BOUNDED_PROFILE_PARSER_ID;
  parser_version: typeof CSV_BOUNDED_PROFILE_PARSER_VERSION;
  encoding: FileEncoding;
  file_size_bytes: number;
  sample_limit_bytes: number;
  sample_bytes_read: number;
  sample_complete_file: boolean;
  sample_complete_record_count: number;
  exact_record_count?: number;
  header_column_count?: number;
  header_columns?: string[];
  quoted_fields_observed: boolean;
  quoted_commas_observed: boolean;
  embedded_newlines_observed: boolean;
  malformed_quote_observed: boolean;
  record_exceeds_sample_limit: boolean;
  diagnostics: CsvProfileDiagnostic[];
};

export type CsvReadStreamFactory = (absolutePath: string) => NodeJS.ReadableStream;

type ParsedCsvSample = {
  completeRecords: string[][];
  quotedFieldsObserved: boolean;
  quotedCommasObserved: boolean;
  embeddedNewlinesObserved: boolean;
  malformedQuoteObserved: boolean;
  incompleteRecordAtBoundary: boolean;
};

function boundedCheck(input: { signal?: AbortSignal; deadlineAt?: number; phase: string }): void {
  if (input.signal?.aborted) {
    throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: input.phase });
  }
  if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
    throw new WorkspaceIndexBoundedError("WORKSPACE_INDEX_TIMEOUT", { phase: input.phase });
  }
}

async function readBoundedPrefix(input: {
  absolutePath: string;
  fileSizeBytes: number;
  maxSampleBytes: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  streamFactory?: CsvReadStreamFactory;
}): Promise<{ bytes: Buffer; completeFile: boolean }> {
  if (!Number.isSafeInteger(input.maxSampleBytes) || input.maxSampleBytes <= 0) {
    throw new Error("CSV_SAMPLE_LIMIT_INVALID");
  }
  boundedCheck({ signal: input.signal, deadlineAt: input.deadlineAt, phase: "CSV_PROFILE_READ" });

  const stream = (input.streamFactory ?? ((absolutePath: string) => createReadStream(absolutePath, { highWaterMark: 64 * 1024 })))(input.absolutePath);
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  const abort = () => {
    const error = new WorkspaceIndexBoundedError("WORKSPACE_INDEX_ABORTED", { phase: "CSV_PROFILE_READ" });
    if ("destroy" in stream && typeof stream.destroy === "function") stream.destroy(error);
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  try {
    for await (const rawChunk of stream as AsyncIterable<Buffer | string>) {
      boundedCheck({ signal: input.signal, deadlineAt: input.deadlineAt, phase: "CSV_PROFILE_READ" });
      const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
      const remaining = input.maxSampleBytes - bytesRead;
      if (remaining <= 0) break;
      const taken = chunk.subarray(0, Math.min(remaining, chunk.length));
      chunks.push(taken);
      bytesRead += taken.length;
      if (bytesRead >= input.maxSampleBytes) {
        if ("destroy" in stream && typeof stream.destroy === "function") stream.destroy();
        break;
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }

  boundedCheck({ signal: input.signal, deadlineAt: input.deadlineAt, phase: "CSV_PROFILE_READ" });
  return {
    bytes: Buffer.concat(chunks, bytesRead),
    completeFile: bytesRead >= input.fileSizeBytes,
  };
}

function decodeCsvSample(bytes: Buffer): { text: string; encoding: FileEncoding; oddUtf16ByteTrimmed: boolean } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const payload = bytes.subarray(2);
    const usable = payload.length % 2 === 0 ? payload : payload.subarray(0, payload.length - 1);
    return {
      text: usable.toString("utf16le"),
      encoding: "UTF16LE",
      oddUtf16ByteTrimmed: usable.length !== payload.length,
    };
  }
  const payload = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(payload),
    encoding: "UTF8",
    oddUtf16ByteTrimmed: false,
  };
}

function parseCsvSample(text: string, completeFile: boolean): ParsedCsvSample {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  let fieldStarted = false;
  let quotedFieldsObserved = false;
  let quotedCommasObserved = false;
  let embeddedNewlinesObserved = false;
  let malformedQuoteObserved = false;

  const completeField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
    quoteClosed = false;
  };
  const completeRecord = () => {
    completeField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        if (character === ",") quotedCommasObserved = true;
        if (character === "\n" || character === "\r") embeddedNewlinesObserved = true;
        field += character;
      }
      continue;
    }

    if (quoteClosed) {
      if (character === ",") {
        completeField();
        continue;
      }
      if (character === "\n") {
        completeRecord();
        continue;
      }
      if (character === "\r" && text[index + 1] === "\n") {
        completeRecord();
        index += 1;
        continue;
      }
      malformedQuoteObserved = true;
      field += character;
      quoteClosed = false;
      fieldStarted = true;
      continue;
    }

    if (character === '"') {
      if (fieldStarted || field.length > 0) {
        malformedQuoteObserved = true;
        field += character;
      } else {
        inQuotes = true;
        fieldStarted = true;
        quotedFieldsObserved = true;
      }
      continue;
    }
    if (character === ",") {
      completeField();
      continue;
    }
    if (character === "\n") {
      completeRecord();
      continue;
    }
    if (character === "\r" && text[index + 1] === "\n") {
      completeRecord();
      index += 1;
      continue;
    }
    field += character;
    fieldStarted = true;
  }

  const hasTrailingMaterial = record.length > 0 || field.length > 0 || fieldStarted || inQuotes || quoteClosed;
  if (completeFile && hasTrailingMaterial) {
    if (inQuotes) malformedQuoteObserved = true;
    completeRecord();
  }

  return {
    completeRecords: records,
    quotedFieldsObserved,
    quotedCommasObserved,
    embeddedNewlinesObserved,
    malformedQuoteObserved,
    incompleteRecordAtBoundary: !completeFile && hasTrailingMaterial,
  };
}

function boundedHeader(record: string[] | undefined): string[] | undefined {
  if (!record) return undefined;
  return record.slice(0, 64).map(value => value.slice(0, 256));
}

export function profileCsvCapturedBytes(input: {
  bytes: Buffer;
  fileSizeBytes: number;
  maxSampleBytes: number;
  completeFile?: boolean;
}): CsvBoundedProfile {
  if (!Number.isSafeInteger(input.maxSampleBytes) || input.maxSampleBytes <= 0) throw new Error("CSV_SAMPLE_LIMIT_INVALID");
  if (input.bytes.length > input.maxSampleBytes) throw new Error("CSV_SAMPLE_BYTES_EXCEED_LIMIT");
  const completeFile = input.completeFile ?? input.bytes.length >= input.fileSizeBytes;
  const decoded = decodeCsvSample(input.bytes);
  const parsed = parseCsvSample(decoded.text, completeFile);
  const diagnostics: CsvProfileDiagnostic[] = [];

  if (!completeFile) {
    diagnostics.push({ code: "CSV_SAMPLE_TRUNCATED", message: "The CSV profile is based only on a governed prefix sample." });
  }
  if (parsed.malformedQuoteObserved) {
    diagnostics.push({ code: "CSV_MALFORMED_QUOTE", message: "Malformed CSV quote structure was observed in the bytes actually sampled." });
  }
  if (parsed.incompleteRecordAtBoundary) {
    diagnostics.push({ code: "CSV_RECORD_EXCEEDS_SAMPLE_LIMIT", message: "A CSV record crossed the governed sample boundary and was not counted as a complete sample record." });
  }
  if (decoded.oddUtf16ByteTrimmed) {
    diagnostics.push({ code: "CSV_UTF16LE_ODD_SAMPLE_BYTE_TRIMMED", message: "One trailing byte was excluded from UTF-16LE decoding because the sample boundary split a code unit." });
  }

  const header = boundedHeader(parsed.completeRecords[0]);
  return {
    parser_id: CSV_BOUNDED_PROFILE_PARSER_ID,
    parser_version: CSV_BOUNDED_PROFILE_PARSER_VERSION,
    encoding: decoded.encoding,
    file_size_bytes: input.fileSizeBytes,
    sample_limit_bytes: input.maxSampleBytes,
    sample_bytes_read: input.bytes.length,
    sample_complete_file: completeFile,
    sample_complete_record_count: parsed.completeRecords.length,
    ...(completeFile && !parsed.malformedQuoteObserved ? { exact_record_count: parsed.completeRecords.length } : {}),
    ...(header ? { header_column_count: parsed.completeRecords[0].length, header_columns: header } : {}),
    quoted_fields_observed: parsed.quotedFieldsObserved,
    quoted_commas_observed: parsed.quotedCommasObserved,
    embedded_newlines_observed: parsed.embeddedNewlinesObserved,
    malformed_quote_observed: parsed.malformedQuoteObserved,
    record_exceeds_sample_limit: parsed.incompleteRecordAtBoundary,
    diagnostics,
  };
}

export async function profileCsvFile(input: {
  absolutePath: string;
  fileSizeBytes: number;
  maxSampleBytes: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  streamFactory?: CsvReadStreamFactory;
}): Promise<CsvBoundedProfile> {
  const sample = await readBoundedPrefix(input);
  return profileCsvCapturedBytes({
    bytes: sample.bytes,
    fileSizeBytes: input.fileSizeBytes,
    maxSampleBytes: input.maxSampleBytes,
    completeFile: sample.completeFile,
  });
}
