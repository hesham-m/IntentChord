import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

if (!process.env.DATABASE_URL && fs.existsSync(".env.local")) {
  const envContent = fs.readFileSync(".env.local", "utf8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

import { databasePool } from "@/server/db";
import {
  computeTraversalAuthoritySha256,
  type FrozenAuthorityTuple,
} from "@/server/context-mapping-traversal-repository";
import { canonicalJson } from "@/core/truth/project-truth-hash";

describe("APP <-> DATABASE AUTHORITY HASH EQUIVALENCE", () => {
  const vectors: Array<{ name: string; tuple: FrozenAuthorityTuple }> = [
    {
      name: "VECTOR_1_STANDARD_UUIDS",
      tuple: {
        context_assembly_revision_id: "5dfa1b15-cd24-44ec-9e0a-99b0478a26c3",
        workspace_registration_id: "2e0e8fff-f670-44ae-b7f4-21efccce76ae",
        workspace_revision_id: "wsr_b9a751adbdb97c66f37b6d120c138009d726a625af0ee0d714261df402d518b6",
        workspace_index_snapshot_id: "f88b0dae-cb5e-49d3-b4da-955912b776e4",
        accepted_workspace_evidence_artifact_id: "wea_a8ad540d9537243a0a0e05e88db34b805300beae673a1fe0cede656d4f9a5128",
        artifact_semantic_sha256: "sha256:60bcd93ef7797e53df5c584ea09dd32b1798e6a4d2df1185ed1b9ad3d410f0b9",
        workspace_observation_id: "c445d922-f5ac-453e-96a4-6119217f25c0",
        authority_sequence: 1,
        index_configuration_sha256: "sha256:2859994938807d3327dcede384f6a3e6e9a8e14919d151090f83706a36c6f1b0",
      },
    },
    {
      name: "VECTOR_2_LARGE_AUTHORITY_SEQUENCE",
      tuple: {
        context_assembly_revision_id: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
        workspace_registration_id: "11111111-2222-4333-8444-555555555555",
        workspace_revision_id: "wsr_0000000000000000000000000000000000000000000000000000000000000001",
        workspace_index_snapshot_id: "99999999-8888-4777-8666-555544443333",
        accepted_workspace_evidence_artifact_id: "wea_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        artifact_semantic_sha256: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        workspace_observation_id: "12345678-1234-4234-8234-1234567890ab",
        authority_sequence: 9007199254740991, // Number.MAX_SAFE_INTEGER
        index_configuration_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
    {
      name: "VECTOR_3_MINIMAL_SEQUENCE_AND_ALPHA_KEYS",
      tuple: {
        context_assembly_revision_id: "00000000-0000-4000-8000-000000000000",
        workspace_registration_id: "00000000-0000-4000-8000-000000000001",
        workspace_revision_id: "wsr_alpha_numeric_test_token",
        workspace_index_snapshot_id: "00000000-0000-4000-8000-000000000002",
        accepted_workspace_evidence_artifact_id: "wea_sample_evidence_artifact_identifier_3",
        artifact_semantic_sha256: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        workspace_observation_id: "00000000-0000-4000-8000-000000000003",
        authority_sequence: 42,
        index_configuration_sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
    {
      name: "VECTOR_4_REAL_WORKSPACE_EXACT_RECORD",
      tuple: {
        context_assembly_revision_id: "5dfa1b15-cd24-44ec-9e0a-99b0478a26c3",
        workspace_registration_id: "2e0e8fff-f670-44ae-b7f4-21efccce76ae",
        workspace_revision_id: "wsr_b9a751adbdb97c66f37b6d120c138009d726a625af0ee0d714261df402d518b6",
        workspace_index_snapshot_id: "f88b0dae-cb5e-49d3-b4da-955912b776e4",
        accepted_workspace_evidence_artifact_id: "wea_a8ad540d9537243a0a0e05e88db34b805300beae673a1fe0cede656d4f9a5128",
        artifact_semantic_sha256: "sha256:60bcd93ef7797e53df5c584ea09dd32b1798e6a4d2df1185ed1b9ad3d410f0b9",
        workspace_observation_id: "c445d922-f5ac-453e-96a4-6119217f25c0",
        authority_sequence: 1,
        index_configuration_sha256: "sha256:2859994938807d3327dcede384f6a3e6e9a8e14919d151090f83706a36c6f1b0",
      },
    },
  ];

  for (const v of vectors) {
    it(`proves byte-for-byte equivalence on ${v.name}`, async () => {
      // 1. Application computation
      const appCanonicalTuple = {
        accepted_workspace_evidence_artifact_id: v.tuple.accepted_workspace_evidence_artifact_id,
        artifact_semantic_sha256: v.tuple.artifact_semantic_sha256,
        authority_sequence: Number(v.tuple.authority_sequence),
        context_assembly_revision_id: v.tuple.context_assembly_revision_id,
        index_configuration_sha256: v.tuple.index_configuration_sha256,
        workspace_index_snapshot_id: v.tuple.workspace_index_snapshot_id,
        workspace_observation_id: v.tuple.workspace_observation_id,
        workspace_registration_id: v.tuple.workspace_registration_id,
        workspace_revision_id: v.tuple.workspace_revision_id,
      };
      const appPayload = canonicalJson(appCanonicalTuple);
      const appSha256 = computeTraversalAuthoritySha256(v.tuple);

      // 2. Database computation
      const dbRes = await databasePool().query<{ db_payload: string; db_sha256: string }>(
        `SELECT intentchord.traversal_authority_canonical_payload(
                  $1, $2, $3, $4, $5, $6, $7, $8, $9
                ) AS db_payload,
                intentchord.compute_traversal_authority_sha256(
                  $1, $2, $3, $4, $5, $6, $7, $8, $9
                ) AS db_sha256`,
        [
          v.tuple.accepted_workspace_evidence_artifact_id,
          v.tuple.artifact_semantic_sha256,
          v.tuple.authority_sequence,
          v.tuple.context_assembly_revision_id,
          v.tuple.index_configuration_sha256,
          v.tuple.workspace_index_snapshot_id,
          v.tuple.workspace_observation_id,
          v.tuple.workspace_registration_id,
          v.tuple.workspace_revision_id,
        ],
      );

      const dbPayload = dbRes.rows[0].db_payload;
      const dbSha256 = dbRes.rows[0].db_sha256;

      // 3. Assert exact byte-for-byte identity
      expect(appPayload).toBe(dbPayload);
      expect(appSha256).toBe(dbSha256);
      expect(appSha256.startsWith("sha256:")).toBe(true);
    });
  }
});
