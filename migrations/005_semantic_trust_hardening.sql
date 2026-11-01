-- IntentChord semantic trust hardening.
-- Additive only: migrations 001-004 remain immutable.

-- A governed required check may be recorded at most once per Run, even when
-- the trusted evidence is split across multiple complete producer batches.
CREATE UNIQUE INDEX IF NOT EXISTS validation_evidence_run_check_unique_idx
  ON intentchord.validation_evidence(run_id, check_id)
  WHERE batch_id IS NOT NULL;

-- New trusted validation rows must carry complete, internally consistent
-- sequence and integrity metadata. Legacy rows with no batch_id remain
-- readable as untrusted historical evidence and cannot satisfy a Verdict.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'validation_evidence_trusted_shape_check'
      AND conrelid = 'intentchord.validation_evidence'::regclass
  ) THEN
    ALTER TABLE intentchord.validation_evidence
      ADD CONSTRAINT validation_evidence_trusted_shape_check CHECK (
        batch_id IS NULL OR (
          sequence IS NOT NULL
          AND sequence_total IS NOT NULL
          AND sequence >= 0
          AND sequence_total > 0
          AND sequence < sequence_total
          AND is_terminal = (sequence = sequence_total - 1)
          AND producer_id IS NOT NULL
          AND trust_basis IS NOT NULL
          AND payload_sha256 ~ '^[0-9a-f]{64}$'
          AND integrity_sha256 ~ '^[0-9a-f]{64}$'
          AND payload_sha256 = integrity_sha256
          AND (
            (producer_type = 'BACKEND' AND trust_basis = 'INTERNAL_BACKEND' AND request_id IS NULL)
            OR (producer_type = 'OWNER_RUNTIME' AND trust_basis = 'OWNER_SESSION' AND request_id IS NULL)
            OR (producer_type = 'HARNESS' AND trust_basis = 'SIGNED_HARNESS' AND request_id IS NOT NULL)
          )
        )
      ) NOT VALID;
  END IF;
END;
$$;

-- New trusted tool-trace rows must form well-shaped hash-chain records.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_trace_events_trusted_shape_check'
      AND conrelid = 'intentchord.tool_trace_events'::regclass
  ) THEN
    ALTER TABLE intentchord.tool_trace_events
      ADD CONSTRAINT tool_trace_events_trusted_shape_check CHECK (
        batch_id IS NULL OR (
          sequence >= 0
          AND sequence_total IS NOT NULL
          AND sequence_total > 0
          AND sequence < sequence_total
          AND is_terminal = (sequence = sequence_total - 1)
          AND producer_id IS NOT NULL
          AND trust_basis IS NOT NULL
          AND event_sha256 ~ '^[0-9a-f]{64}$'
          AND (previous_event_sha256 IS NULL OR previous_event_sha256 ~ '^[0-9a-f]{64}$')
          AND (
            command <> 'INTENTCHORD:NO_COMMANDS_EXECUTED'
            OR (sequence = 0 AND sequence_total = 1 AND is_terminal)
          )
          AND (
            (producer_type = 'OWNER_RUNTIME' AND trust_basis = 'OWNER_SESSION' AND request_id IS NULL)
            OR (producer_type IN ('HARNESS','ADAPTER') AND trust_basis = 'SIGNED_HARNESS' AND request_id IS NOT NULL)
          )
        )
      ) NOT VALID;
  END IF;
END;
$$;
