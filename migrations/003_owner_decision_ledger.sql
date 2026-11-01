ALTER TABLE intentchord.owner_decisions
  DROP CONSTRAINT IF EXISTS owner_decisions_run_id_key;

CREATE INDEX IF NOT EXISTS owner_decisions_run_history_idx
  ON intentchord.owner_decisions(run_id, created_at, id);
