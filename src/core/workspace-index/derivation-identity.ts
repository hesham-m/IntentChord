import { sha256Canonical } from "@/core/truth/project-truth-hash";
import { CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION } from "@/core/workspace-index/types";
import {
  DERIVATION_IDENTITY_SCHEMA_V1,
  DERIVATION_NORMALIZATION_VERSION_V1,
  EXTRACTION_POLICY_VERSION_V1,
  type PathSensitivity,
} from "@/core/workspace-index/sections/sectioned-contracts";

/**
 * Derivation identity (SPEC V3 8.3). Reuse of parser/fact/relation evidence requires this id to be
 * unchanged alongside governed-unchanged content identity. Registry v1 is frozen at introduction.
 */

export type DerivationIdentityInput = {
  parserRegistryVersion: string;
  extractorId: string;
  extractorVersion: string;
  contentTypeInputs: {
    fileKind: string;
    language: string | null;
    mediaType: string;
    encoding: string;
  };
  /** Defaults to the frozen v1 registry classification for extractorId when omitted. */
  pathSensitivity?: PathSensitivity;
};

export function deriveDerivationIdentity(input: DerivationIdentityInput): string {
  return `der_${sha256Canonical({
    schema: DERIVATION_IDENTITY_SCHEMA_V1,
    parser_registry_version: input.parserRegistryVersion,
    extractor: {
      extractor_id: input.extractorId,
      extractor_version: input.extractorVersion,
    },
    extraction_policy_version: EXTRACTION_POLICY_VERSION_V1,
    normalization_version: DERIVATION_NORMALIZATION_VERSION_V1,
    contract_version: CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
    content_type_inputs: {
      file_kind: input.contentTypeInputs.fileKind,
      language: input.contentTypeInputs.language ?? null,
      media_type: input.contentTypeInputs.mediaType,
      encoding: input.contentTypeInputs.encoding,
    },
    path_sensitivity:
      input.pathSensitivity ?? initialPathSensitivityFor(input.extractorId),
  })}`;
}

/**
 * PATH_SENSITIVITY registry v1 (frozen). Path-sensitive extractions embed relative_path in their
 * qualified names/signatures/resolved endpoints and MUST be recomputed when the path changes even
 * if content is unchanged. Everything else defaults to PATH_INSENSITIVE.
 */
export const PATH_SENSITIVE_EXTRACTOR_IDS_V1: ReadonlySet<string> = new Set([
  "csv-bounded-profile-parser/v1", // CSV bounded profile fact embeds relative_path
  "TEST_NAMING_RELATION_EXTRACTOR", // test->target inference resolves by path
]);

export function initialPathSensitivityFor(extractorId: string): PathSensitivity {
  return PATH_SENSITIVE_EXTRACTOR_IDS_V1.has(extractorId) ? "PATH_SENSITIVE" : "PATH_INSENSITIVE";
}
