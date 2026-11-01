import { describe, expect, it } from "vitest";
import { deriveDerivationIdentity, initialPathSensitivityFor } from "@/core/workspace-index/derivation-identity";

const BASE = {
  parserRegistryVersion: "workspace-parser-registry/v2",
  extractorId: "ts_symbols_v1",
  extractorVersion: "1.0.0",
  contentTypeInputs: {
    fileKind: "SOURCE_CODE",
    language: "typescript" as string | null,
    mediaType: "text/plain",
    encoding: "UTF8",
  },
};

describe("derivation identity (SPEC V3 8.3)", () => {
  it("matches the frozen reference vector for registry-v1 insensitive extraction", () => {
    expect(deriveDerivationIdentity(BASE)).toBe(
      "der_f9cdb81e9555957483e19d7292f39f7365fda03ad7fdd31d6e78fb559e2c0b5c",
    );
  });

  it("changes when any identity component changes", () => {
    const base = deriveDerivationIdentity(BASE);
    expect(deriveDerivationIdentity({ ...BASE, extractorVersion: "1.0.1" })).not.toBe(base);
    expect(deriveDerivationIdentity({ ...BASE, parserRegistryVersion: "workspace-parser-registry/v3" })).not.toBe(base);
    expect(
      deriveDerivationIdentity({
        ...BASE,
        pathSensitivity: "PATH_SENSITIVE",
      }),
    ).not.toBe(base);
    expect(
      deriveDerivationIdentity({
        ...BASE,
        contentTypeInputs: { ...BASE.contentTypeInputs, language: null },
      }),
    ).not.toBe(base);
  });

  it("normalizes absent language to null deterministically", () => {
    const withNull = deriveDerivationIdentity({
      ...BASE,
      contentTypeInputs: { ...BASE.contentTypeInputs, language: null },
    });
    const withUndefinedNormalized = deriveDerivationIdentity({
      ...BASE,
      contentTypeInputs: { ...BASE.contentTypeInputs, language: undefined as unknown as string },
    });
    expect(withUndefinedNormalized).toBe(withNull);
  });

  it("classifies the frozen v1 path-sensitive extractor set", () => {
    expect(initialPathSensitivityFor("csv-bounded-profile-parser/v1")).toBe("PATH_SENSITIVE");
    expect(initialPathSensitivityFor("TEST_NAMING_RELATION_EXTRACTOR")).toBe("PATH_SENSITIVE");
    expect(initialPathSensitivityFor("ts_symbols_v1")).toBe("PATH_INSENSITIVE");
  });
});
