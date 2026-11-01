-- IntentChord trust-invariant closure.
-- This migration is intentionally additive and idempotent. It does not modify migrations 001-003.

ALTER TABLE intentchord.workspaces
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'MANUAL_UNVERIFIED'
    CHECK (source_type IN ('WINDOWS_NATIVE_SELECTOR','MANUAL_VERIFIED','MANUAL_UNVERIFIED','REMOTE_CONNECTOR'));

UPDATE intentchord.workspaces
SET source_type = CASE
  WHEN verification_method = 'WINDOWS_FOLDER_BROWSER_DIALOG_V1' THEN 'WINDOWS_NATIVE_SELECTOR'
  WHEN verification_status = 'VERIFIED' THEN 'MANUAL_VERIFIED'
  ELSE 'MANUAL_UNVERIFIED'
END
WHERE source_type = 'MANUAL_UNVERIFIED';

ALTER TABLE intentchord.task_workspace_snapshots
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'MANUAL_UNVERIFIED'
    CHECK (source_type IN ('WINDOWS_NATIVE_SELECTOR','MANUAL_VERIFIED','MANUAL_UNVERIFIED','REMOTE_CONNECTOR'));

UPDATE intentchord.task_workspace_snapshots s
SET source_type = w.source_type
FROM intentchord.workspaces w
WHERE w.id = s.workspace_registration_id;

ALTER TABLE intentchord.runs
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS correction_started_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS runs_single_unresolved_task_idx
  ON intentchord.runs(task_id)
  WHERE status IN ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_lineage_root_id_fkey'
      AND conrelid = 'intentchord.runs'::regclass
  ) THEN
    ALTER TABLE intentchord.runs
      ADD CONSTRAINT runs_lineage_root_id_fkey
      FOREIGN KEY (lineage_root_id) REFERENCES intentchord.runs(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

ALTER TABLE intentchord.context_leases
  ADD COLUMN IF NOT EXISTS lease_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fingerprint text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','INVALIDATED','CONSUMED')),
  ADD COLUMN IF NOT EXISTS contract_revision_id uuid REFERENCES intentchord.contract_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS task_draft_revision_id uuid REFERENCES intentchord.task_draft_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS contract_state_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS invalidation_reason text;

UPDATE intentchord.context_leases cl
SET contract_revision_id = r.contract_revision_id,
    task_draft_revision_id = cr.task_draft_revision_id,
    contract_state_revision = cr.state_revision
FROM intentchord.runs r
JOIN intentchord.contract_revisions cr ON cr.id = r.contract_revision_id
WHERE r.id = cl.run_id
  AND (cl.contract_revision_id IS NULL OR cl.task_draft_revision_id IS NULL);

-- Historical leases predate the authoritative fingerprint algorithm. Preserve
-- them for audit, but never present a compatibility hash as an active lease.
UPDATE intentchord.context_leases
SET fingerprint = encode(sha256(convert_to(contract_sha256 || ':' || binding_marker, 'UTF8')), 'hex'),
    status = 'INVALIDATED',
    invalidated_at = coalesce(invalidated_at, now()),
    invalidation_reason = coalesce(invalidation_reason, 'LEGACY_LEASE_REQUIRES_FRESH_RUN')
WHERE fingerprint IS NULL;

ALTER TABLE intentchord.context_leases
  ALTER COLUMN fingerprint SET NOT NULL,
  ALTER COLUMN contract_revision_id SET NOT NULL,
  ALTER COLUMN task_draft_revision_id SET NOT NULL;

ALTER TABLE intentchord.owner_decisions
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_by_run_id uuid REFERENCES intentchord.runs(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS owner_decisions_single_ack_idx
  ON intentchord.owner_decisions(run_id)
  WHERE decision_type = 'ACKNOWLEDGED';

CREATE UNIQUE INDEX IF NOT EXISTS owner_decisions_single_terminal_idx
  ON intentchord.owner_decisions(run_id)
  WHERE decision_type IN ('ACCEPTED','ACCEPTED_WITH_OVERRIDE','CORRECTION_REQUESTED','REJECTED');

CREATE UNIQUE INDEX IF NOT EXISTS correction_rounds_parent_unique_idx
  ON intentchord.correction_rounds(parent_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS correction_rounds_decision_unique_idx
  ON intentchord.correction_rounds(owner_decision_id);

CREATE TABLE IF NOT EXISTS intentchord.inherited_validation_evidence (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  parent_run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE RESTRICT,
  check_id text NOT NULL,
  source_validation_evidence_id uuid NOT NULL REFERENCES intentchord.validation_evidence(id) ON DELETE RESTRICT,
  inherited_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, check_id)
);

ALTER TABLE intentchord.report_submissions
  ADD COLUMN IF NOT EXISTS verified_sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS report_format text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (report_format IN ('JSON','MARKDOWN','UNKNOWN'));

ALTER TABLE intentchord.report_evidence_references
  ADD COLUMN IF NOT EXISTS relative_path text,
  ADD COLUMN IF NOT EXISTS reference_kind text
    CHECK (reference_kind IN ('INSPECTED_PATH','SUPPORTING_EVIDENCE','VALIDATION_CHECK','TOOL_TRACE_EVENT'));

ALTER TABLE intentchord.validation_evidence
  ADD COLUMN IF NOT EXISTS producer_id text,
  ADD COLUMN IF NOT EXISTS trust_basis text,
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS sequence bigint,
  ADD COLUMN IF NOT EXISTS sequence_total bigint,
  ADD COLUMN IF NOT EXISTS is_terminal boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payload_sha256 text;

CREATE UNIQUE INDEX IF NOT EXISTS validation_evidence_batch_sequence_idx
  ON intentchord.validation_evidence(run_id,batch_id,sequence)
  WHERE batch_id IS NOT NULL;

ALTER TABLE intentchord.tool_trace_events
  ADD COLUMN IF NOT EXISTS producer_id text,
  ADD COLUMN IF NOT EXISTS trust_basis text,
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS sequence_total bigint,
  ADD COLUMN IF NOT EXISTS is_terminal boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS previous_event_sha256 text,
  ADD COLUMN IF NOT EXISTS event_sha256 text;

CREATE UNIQUE INDEX IF NOT EXISTS tool_trace_batch_sequence_idx
  ON intentchord.tool_trace_events(run_id,batch_id,sequence)
  WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS intentchord.trusted_producer_receipts (
  request_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  producer_type text NOT NULL CHECK (producer_type IN ('HARNESS','ADAPTER')),
  producer_id text NOT NULL,
  trust_basis text NOT NULL CHECK (trust_basis = 'SIGNED_HARNESS'),
  route_path text NOT NULL,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE intentchord.compiled_contract_artifacts
  ADD COLUMN IF NOT EXISTS artifact_purpose text NOT NULL DEFAULT 'RUN_BOUND'
    CHECK (artifact_purpose IN ('RUN_BOUND'));

CREATE UNIQUE INDEX IF NOT EXISTS compiled_artifacts_one_per_run_idx
  ON intentchord.compiled_contract_artifacts(run_id)
  WHERE run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION intentchord.prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'INTENTCHORD_AUDIT_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only_update ON intentchord.audit_events;
DROP TRIGGER IF EXISTS audit_events_append_only_delete ON intentchord.audit_events;
CREATE TRIGGER audit_events_append_only_update
BEFORE UPDATE ON intentchord.audit_events
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_audit_mutation();
CREATE TRIGGER audit_events_append_only_delete
BEFORE DELETE ON intentchord.audit_events
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_audit_mutation();
