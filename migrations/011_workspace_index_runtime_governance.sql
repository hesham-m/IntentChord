-- IntentChord Workspace Index runtime governance. Additive after applied Migration 010.
ALTER TABLE intentchord.workspace_index_snapshots
  ADD COLUMN IF NOT EXISTS progress_phase text,
  ADD COLUMN IF NOT EXISTS progress_evidence jsonb,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

ALTER TABLE intentchord.workspace_index_snapshots
  DROP CONSTRAINT IF EXISTS workspace_index_snapshots_progress_phase_ck;
ALTER TABLE intentchord.workspace_index_snapshots
  ADD CONSTRAINT workspace_index_snapshots_progress_phase_ck CHECK (
    progress_phase IS NULL OR progress_phase IN ('DISCOVERING','HASHING','PARSING','ASSEMBLING','VALIDATING','PERSISTING','READY','FAILED')
  );
ALTER TABLE intentchord.workspace_index_snapshots
  DROP CONSTRAINT IF EXISTS workspace_index_snapshots_progress_evidence_ck;
ALTER TABLE intentchord.workspace_index_snapshots
  ADD CONSTRAINT workspace_index_snapshots_progress_evidence_ck CHECK (
    progress_evidence IS NULL OR jsonb_typeof(progress_evidence)='object'
  );

CREATE INDEX IF NOT EXISTS workspace_index_snapshots_stale_creating_idx
  ON intentchord.workspace_index_snapshots(heartbeat_at, started_at)
  WHERE status='CREATING';

CREATE OR REPLACE FUNCTION intentchord.workspace_index_snapshot_governed_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.id,NEW.source_mode,NEW.workspace_registration_id,NEW.workspace_registration_revision,
    NEW.workspace_registration_fingerprint,NEW.project_context_id,NEW.governed_scope,
    NEW.snapshot_idempotency_key,NEW.snapshot_request_fingerprint_sha256,
    NEW.owner_reference,NEW.started_at,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.source_mode,OLD.workspace_registration_id,OLD.workspace_registration_revision,
    OLD.workspace_registration_fingerprint,OLD.project_context_id,OLD.governed_scope,
    OLD.snapshot_idempotency_key,OLD.snapshot_request_fingerprint_sha256,
    OLD.owner_reference,OLD.started_at,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_IMMUTABLE_BINDING';
  END IF;

  IF OLD.status='CREATING' AND NEW.status='CREATING' THEN
    IF ROW(NEW.canonical_contract_version,NEW.canonical_index_json,NEW.canonical_sha256,NEW.failure_code,NEW.safe_failure_evidence,NEW.completed_at)
       IS DISTINCT FROM ROW(OLD.canonical_contract_version,OLD.canonical_index_json,OLD.canonical_sha256,OLD.failure_code,OLD.safe_failure_evidence,OLD.completed_at) THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_PROGRESS_PAYLOAD_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('READY','FAILED') AND NEW.status=OLD.status
     AND (OLD.progress_phase IS NULL OR OLD.progress_evidence IS NULL OR OLD.heartbeat_at IS NULL) THEN
    IF ROW(NEW.canonical_contract_version,NEW.canonical_index_json,NEW.canonical_sha256,NEW.failure_code,NEW.safe_failure_evidence,NEW.completed_at)
       IS DISTINCT FROM ROW(OLD.canonical_contract_version,OLD.canonical_index_json,OLD.canonical_sha256,OLD.failure_code,OLD.safe_failure_evidence,OLD.completed_at)
       OR NEW.progress_phase IS DISTINCT FROM OLD.status
       OR NEW.progress_evidence IS NULL
       OR NEW.heartbeat_at IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TERMINAL_BACKFILL_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status<>'CREATING' OR NEW.status NOT IN ('READY','FAILED') THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TRANSITION_BLOCKED:%->%', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE intentchord.workspace_index_snapshots
SET progress_phase=CASE status WHEN 'READY' THEN 'READY' WHEN 'FAILED' THEN 'FAILED' ELSE COALESCE(progress_phase,'DISCOVERING') END,
    progress_evidence=COALESCE(progress_evidence,'{}'::jsonb),
    heartbeat_at=COALESCE(heartbeat_at,completed_at,started_at)
WHERE progress_phase IS NULL OR progress_evidence IS NULL OR heartbeat_at IS NULL;

