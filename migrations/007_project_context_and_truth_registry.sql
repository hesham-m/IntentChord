-- IntentChord Project Context and temporal Project Truth Registry.
-- Additive and idempotent. Migrations 001-006 remain immutable.
-- This migration must not be applied without separate explicit Owner authorization.

CREATE TABLE IF NOT EXISTS intentchord.project_contexts (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.project_context_workspaces (
  project_context_id uuid NOT NULL REFERENCES intentchord.project_contexts(id) ON DELETE RESTRICT,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('PRIMARY','SUPPORTING','REFERENCE')),
  ordering integer NOT NULL CHECK (ordering >= 0 AND ordering <= 999),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  revision bigint NOT NULL CHECK (revision > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_context_id, workspace_registration_id, valid_from),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_context_workspaces_current_registration_idx
  ON intentchord.project_context_workspaces(project_context_id, workspace_registration_id)
  WHERE valid_until IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS project_context_workspaces_current_ordering_idx
  ON intentchord.project_context_workspaces(project_context_id, ordering)
  WHERE valid_until IS NULL;

CREATE INDEX IF NOT EXISTS project_context_workspaces_history_idx
  ON intentchord.project_context_workspaces(project_context_id, ordering, valid_from, workspace_registration_id);

CREATE TABLE IF NOT EXISTS intentchord.project_facts (
  id uuid PRIMARY KEY,
  project_context_id uuid NOT NULL REFERENCES intentchord.project_contexts(id) ON DELETE RESTRICT,
  fact_key text NOT NULL CHECK (fact_key ~ '^[A-Z0-9][A-Z0-9._:-]{0,199}$'),
  fact_type text NOT NULL CHECK (fact_type ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  current_revision bigint NOT NULL CHECK (current_revision > 0),
  current_status text NOT NULL CHECK (current_status IN ('PROPOSED','OWNER_APPROVED','SUPERSEDED','REJECTED')),
  current_fact_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_context_id, fact_key)
);

CREATE TABLE IF NOT EXISTS intentchord.project_fact_revisions (
  id uuid PRIMARY KEY,
  project_fact_id uuid NOT NULL REFERENCES intentchord.project_facts(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  value_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PROPOSED','OWNER_APPROVED','SUPERSEDED','REJECTED')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  source_proposal_revision_id uuid,
  supersedes_revision_id uuid,
  provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_decision_id uuid REFERENCES intentchord.audit_events(id) ON DELETE RESTRICT,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_fact_id, revision),
  UNIQUE (id, project_fact_id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (
    (status = 'PROPOSED'
      AND source_proposal_revision_id IS NULL
      AND supersedes_revision_id IS NULL
      AND owner_decision_id IS NULL)
    OR (status = 'OWNER_APPROVED'
      AND source_proposal_revision_id IS NOT NULL
      AND owner_decision_id IS NOT NULL)
    OR (status = 'REJECTED'
      AND source_proposal_revision_id IS NOT NULL
      AND supersedes_revision_id IS NULL
      AND owner_decision_id IS NOT NULL)
    OR (status = 'SUPERSEDED'
      AND source_proposal_revision_id IS NULL
      AND supersedes_revision_id IS NOT NULL
      AND owner_decision_id IS NOT NULL)
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_facts_current_revision_same_fact_fkey'
      AND conrelid = 'intentchord.project_facts'::regclass
  ) THEN
    ALTER TABLE intentchord.project_facts
      ADD CONSTRAINT project_facts_current_revision_same_fact_fkey
      FOREIGN KEY (current_fact_revision_id, id)
      REFERENCES intentchord.project_fact_revisions(id, project_fact_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_fact_revisions_source_proposal_same_fact_fkey'
      AND conrelid = 'intentchord.project_fact_revisions'::regclass
  ) THEN
    ALTER TABLE intentchord.project_fact_revisions
      ADD CONSTRAINT project_fact_revisions_source_proposal_same_fact_fkey
      FOREIGN KEY (source_proposal_revision_id, project_fact_id)
      REFERENCES intentchord.project_fact_revisions(id, project_fact_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_fact_revisions_supersedes_same_fact_fkey'
      AND conrelid = 'intentchord.project_fact_revisions'::regclass
  ) THEN
    ALTER TABLE intentchord.project_fact_revisions
      ADD CONSTRAINT project_fact_revisions_supersedes_same_fact_fkey
      FOREIGN KEY (supersedes_revision_id, project_fact_id)
      REFERENCES intentchord.project_fact_revisions(id, project_fact_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS project_facts_context_status_idx
  ON intentchord.project_facts(project_context_id, current_status, fact_key, id);

CREATE INDEX IF NOT EXISTS project_fact_revisions_fact_history_idx
  ON intentchord.project_fact_revisions(project_fact_id, revision, created_at, id);

CREATE INDEX IF NOT EXISTS project_fact_revisions_status_idx
  ON intentchord.project_fact_revisions(project_fact_id, status, revision);

CREATE TABLE IF NOT EXISTS intentchord.project_truth_snapshots (
  id uuid PRIMARY KEY,
  project_context_id uuid NOT NULL REFERENCES intentchord.project_contexts(id) ON DELETE RESTRICT,
  snapshot_version text NOT NULL CHECK (char_length(snapshot_version) BETWEEN 1 AND 120),
  effective_at timestamptz NOT NULL,
  selected_fact_revision_ids jsonb NOT NULL CHECK (jsonb_typeof(selected_fact_revision_ids) = 'array'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_authority text NOT NULL CHECK (char_length(created_by_authority) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_context_id, snapshot_version, content_sha256)
);

ALTER TABLE intentchord.project_truth_snapshots
  ADD COLUMN IF NOT EXISTS effective_at timestamptz;

UPDATE intentchord.project_truth_snapshots
SET effective_at = created_at
WHERE effective_at IS NULL;

ALTER TABLE intentchord.project_truth_snapshots
  ALTER COLUMN effective_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS project_truth_snapshots_context_idx
  ON intentchord.project_truth_snapshots(project_context_id, effective_at, created_at, id);

CREATE OR REPLACE FUNCTION intentchord.prevent_project_truth_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'INTENTCHORD_PROJECT_TRUTH_HISTORY_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS project_context_workspaces_append_only_update ON intentchord.project_context_workspaces;
DROP TRIGGER IF EXISTS project_context_workspaces_append_only_delete ON intentchord.project_context_workspaces;
CREATE TRIGGER project_context_workspaces_append_only_update
BEFORE UPDATE ON intentchord.project_context_workspaces
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_project_truth_history_mutation();
CREATE TRIGGER project_context_workspaces_append_only_delete
BEFORE DELETE ON intentchord.project_context_workspaces
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_project_truth_history_mutation();

DROP TRIGGER IF EXISTS project_fact_revisions_append_only_update ON intentchord.project_fact_revisions;
DROP TRIGGER IF EXISTS project_fact_revisions_append_only_delete ON intentchord.project_fact_revisions;
CREATE TRIGGER project_fact_revisions_append_only_update
BEFORE UPDATE ON intentchord.project_fact_revisions
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_project_truth_history_mutation();
CREATE TRIGGER project_fact_revisions_append_only_delete
BEFORE DELETE ON intentchord.project_fact_revisions
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_project_truth_history_mutation();

DROP TRIGGER IF EXISTS project_truth_snapshots_append_only_update ON intentchord.project_truth_snapshots;
DROP TRIGGER IF EXISTS project_truth_snapshots_append_only_delete ON intentchord.project_truth_snapshots;
CREATE TRIGGER project_truth_snapshots_append_only_update
BEFORE UPDATE ON intentchord.project_truth_snapshots
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_project_truth_history_mutation();
CREATE TRIGGER project_truth_snapshots_append_only_delete
BEFORE DELETE ON intentchord.project_truth_snapshots
FOR EACH ROW EXECUTE FUNCTION intentchord.prevent_project_truth_history_mutation();

CREATE OR REPLACE FUNCTION intentchord.enforce_project_context_projection_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.slug <> OLD.slug
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_CONTEXT_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_CONTEXT_REVISION_NON_MONOTONIC';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_CONTEXT_TIME_NON_MONOTONIC';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_contexts_projection_revision_guard ON intentchord.project_contexts;
CREATE TRIGGER project_contexts_projection_revision_guard
BEFORE UPDATE ON intentchord.project_contexts
FOR EACH ROW EXECUTE FUNCTION intentchord.enforce_project_context_projection_revision();

CREATE OR REPLACE FUNCTION intentchord.enforce_project_fact_projection_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_FACT_TIME_NON_MONOTONIC';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_facts_projection_revision_guard ON intentchord.project_facts;
CREATE TRIGGER project_facts_projection_revision_guard
BEFORE UPDATE ON intentchord.project_facts
FOR EACH ROW EXECUTE FUNCTION intentchord.enforce_project_fact_projection_revision();

CREATE OR REPLACE FUNCTION intentchord.assert_project_fact_projection_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  history_status text;
BEGIN
  SELECT status INTO history_status
  FROM intentchord.project_fact_revisions
  WHERE id = NEW.current_fact_revision_id
    AND project_fact_id = NEW.id;

  IF history_status IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_FACT_CURRENT_HISTORY_MISSING';
  END IF;
  IF history_status <> NEW.current_status THEN
    RAISE EXCEPTION 'INTENTCHORD_PROJECT_FACT_CURRENT_STATUS_MISMATCH';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS project_facts_projection_integrity_guard ON intentchord.project_facts;
CREATE CONSTRAINT TRIGGER project_facts_projection_integrity_guard
AFTER INSERT OR UPDATE ON intentchord.project_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION intentchord.assert_project_fact_projection_integrity();
