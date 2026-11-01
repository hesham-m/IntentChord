import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/009_ai_context_mapper_v1.sql", "utf8");

describe("Migration 009 AI Context Mapper V1", () => {
  it("is additive, idempotent, and limited to the four authorized IntentChord tables", () => {
    for (const table of ["context_mapping_runs", "context_mapping_attempts", "context_catalog_proposals", "context_mapping_owner_verdicts"]) {
      expect(migration).toContain(`intentchord.${table}`);
    }
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS/g);
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|eit_/i);
  });

  it("enforces one run with two fixed provider attempts and same-run final-attempt/proposal provenance", () => {
    expect(migration).toContain("attempt_ordinal integer NOT NULL CHECK (attempt_ordinal IN (1,2))");
    expect(migration).toContain("context_mapping_attempts_run_ordinal_uq UNIQUE (mapping_run_id, attempt_ordinal)");
    expect(migration).toContain("context_mapping_attempts_fixed_channel_ck");
    expect(migration).toContain("FOREIGN KEY (final_attempt_id, id)");
    expect(migration).toContain("FOREIGN KEY (source_attempt_id, mapping_run_id)");
    expect(migration).toContain("result_envelope jsonb NOT NULL");
  });

  it("enforces governed run transitions, complete-once attempts, validated proposals, and immutable history", () => {
    expect(migration).toContain("AI_CONTEXT_MAPPING_RUN_TRANSITION_BLOCKED");
    expect(migration).toContain("INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_COMPLETE_ONCE");
    expect(migration).toContain("INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_REQUIRES_SUCCEEDED_ATTEMPT");
    expect(migration).toContain("INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_PROVENANCE_MISMATCH");
    expect(migration).toContain("NEW.deterministic_validation_evidence IS DISTINCT FROM attempt_row.validation_summary");
    expect(migration).toContain("jsonb_typeof(validation_summary->'gates')='array'");
    expect(migration).toContain("INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_REPLACEMENT_BLOCKED");
    expect(migration).toContain("INTENTCHORD_CONTEXT_MAPPING_OWNER_VERDICT_STATE_BLOCKED");
    expect(migration).toContain("INTENTCHORD_CONTEXT_MAPPING_HISTORY_APPEND_ONLY");
  });

  it("pins provider/model identities and keeps SambaNova runtime disabled unless governance is qualified", () => {
    expect(migration).toContain("primary_model_id='glm-4.7-flash'");
    expect(migration).toContain("standby_model_id='gpt-oss-120b'");
    expect(migration).toContain("standby_enabled boolean NOT NULL DEFAULT false");
    expect(migration).toContain("standby_enabled = false OR standby_governance_state = 'QUALIFIED'");
    expect(migration).toContain("INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_GOVERNANCE_BLOCKED");
  });
  it("qualifies repository persistence against an uncommitted Migration 009 before live application", () => {
    const postgresSuite = readFileSync("src/server/ai-context-mapper.postgres.integration.test.ts", "utf8");
    expect(postgresSuite).toContain('await suiteClient.query("begin")');
    expect(postgresSuite).toContain('readFileSync("migrations/009_ai_context_mapper_v1.sql", "utf8")');
    expect(postgresSuite).toContain("await suiteClient.query(migrationSql)");
    expect(postgresSuite).toContain('await suiteClient.query("rollback")');
    expect(postgresSuite).toContain("bindRollbackOnlyTestClient(suiteClient)");
  });

});
