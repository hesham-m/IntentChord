-- IntentChord Project Truth database clock authority root correction.
-- Additive correction after migration 007; migration 007 remains immutable.
-- PostgreSQL is the sole authority for persistence metadata timestamps.
-- Owner-supplied temporal domain values remain explicit command inputs.

ALTER TABLE intentchord.project_contexts
  ALTER COLUMN created_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT clock_timestamp();

ALTER TABLE intentchord.project_context_workspaces
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

ALTER TABLE intentchord.project_facts
  ALTER COLUMN created_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT clock_timestamp();

ALTER TABLE intentchord.project_fact_revisions
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

ALTER TABLE intentchord.project_truth_snapshots
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION intentchord.enforce_project_context_projection_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  database_time timestamptz;
BEGIN
  database_time := clock_timestamp();

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := database_time;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id
    OR NEW.slug <> OLD.slug
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_CONTEXT_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_CONTEXT_REVISION_NON_MONOTONIC';
  END IF;
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_CONTEXT_UPDATED_AT_DATABASE_MANAGED';
  END IF;

  NEW.updated_at := GREATEST(database_time, OLD.updated_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_contexts_projection_revision_guard ON intentchord.project_contexts;
CREATE TRIGGER project_contexts_projection_revision_guard
BEFORE INSERT OR UPDATE ON intentchord.project_contexts
FOR EACH ROW EXECUTE FUNCTION intentchord.enforce_project_context_projection_revision();

CREATE OR REPLACE FUNCTION intentchord.enforce_project_fact_projection_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  database_time timestamptz;
BEGIN
  database_time := clock_timestamp();

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := database_time;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id
    OR NEW.project_context_id <> OLD.project_context_id
    OR NEW.fact_key <> OLD.fact_key
    OR NEW.fact_type <> OLD.fact_type
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_FACT_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.current_revision <> OLD.current_revision + 1 THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_FACT_REVISION_NON_MONOTONIC';
  END IF;
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_FACT_UPDATED_AT_DATABASE_MANAGED';
  END IF;

  NEW.updated_at := GREATEST(database_time, OLD.updated_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_facts_projection_revision_guard ON intentchord.project_facts;
CREATE TRIGGER project_facts_projection_revision_guard
BEFORE INSERT OR UPDATE ON intentchord.project_facts
FOR EACH ROW EXECUTE FUNCTION intentchord.enforce_project_fact_projection_revision();

CREATE OR REPLACE FUNCTION intentchord.assign_project_truth_history_database_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_context_workspaces_database_clock_insert ON intentchord.project_context_workspaces;
CREATE TRIGGER project_context_workspaces_database_clock_insert
BEFORE INSERT ON intentchord.project_context_workspaces
FOR EACH ROW EXECUTE FUNCTION intentchord.assign_project_truth_history_database_clock();

DROP TRIGGER IF EXISTS project_fact_revisions_database_clock_insert ON intentchord.project_fact_revisions;
CREATE TRIGGER project_fact_revisions_database_clock_insert
BEFORE INSERT ON intentchord.project_fact_revisions
FOR EACH ROW EXECUTE FUNCTION intentchord.assign_project_truth_history_database_clock();

DROP TRIGGER IF EXISTS project_truth_snapshots_database_clock_insert ON intentchord.project_truth_snapshots;
CREATE TRIGGER project_truth_snapshots_database_clock_insert
BEFORE INSERT ON intentchord.project_truth_snapshots
FOR EACH ROW EXECUTE FUNCTION intentchord.assign_project_truth_history_database_clock();

CREATE OR REPLACE FUNCTION intentchord.assign_project_truth_audit_database_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.aggregate_type IN ('PROJECT_CONTEXT','PROJECT_FACT','PROJECT_TRUTH_SNAPSHOT') THEN
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_truth_audit_events_database_clock_insert ON intentchord.audit_events;
CREATE TRIGGER project_truth_audit_events_database_clock_insert
BEFORE INSERT ON intentchord.audit_events
FOR EACH ROW EXECUTE FUNCTION intentchord.assign_project_truth_audit_database_clock();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_contexts_projection_time_order_check'
      AND conrelid = 'intentchord.project_contexts'::regclass
  ) THEN
    ALTER TABLE intentchord.project_contexts
      ADD CONSTRAINT project_contexts_projection_time_order_check
      CHECK (updated_at >= created_at) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE intentchord.project_contexts
  VALIDATE CONSTRAINT project_contexts_projection_time_order_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_facts_projection_time_order_check'
      AND conrelid = 'intentchord.project_facts'::regclass
  ) THEN
    ALTER TABLE intentchord.project_facts
      ADD CONSTRAINT project_facts_projection_time_order_check
      CHECK (updated_at >= created_at) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE intentchord.project_facts
  VALIDATE CONSTRAINT project_facts_projection_time_order_check;
