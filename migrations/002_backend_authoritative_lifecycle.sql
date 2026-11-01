ALTER TABLE intentchord.tasks
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;

ALTER TABLE intentchord.workspaces
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS normalized_reference text,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_status IN ('VERIFIED','UNVERIFIED','STALE','FAILED')),
  ADD COLUMN IF NOT EXISTS verification_method text NOT NULL DEFAULT 'LEGACY_IMPORT',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_authority text NOT NULL DEFAULT 'BACKEND',
  ADD COLUMN IF NOT EXISTS device_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE intentchord.workspaces
SET normalized_reference = reference
WHERE normalized_reference IS NULL;

ALTER TABLE intentchord.workspaces
  ALTER COLUMN normalized_reference SET NOT NULL;

CREATE TABLE IF NOT EXISTS intentchord.task_draft_revisions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0),
  title text NOT NULL,
  title_manually_edited boolean NOT NULL,
  objective text NOT NULL,
  task_mode text NOT NULL CHECK (task_mode IN ('CONTROLLED_AUDIT','SOURCE_IMPLEMENTATION','REPORT_REVIEW')),
  draft_projection jsonb NOT NULL,
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, revision)
);

CREATE TABLE IF NOT EXISTS intentchord.task_workspace_snapshots (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE,
  draft_revision_id uuid NOT NULL REFERENCES intentchord.task_draft_revisions(id) ON DELETE CASCADE,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  ordering integer NOT NULL CHECK (ordering >= 0),
  display_name text NOT NULL,
  role text NOT NULL,
  reference_type text NOT NULL CHECK (reference_type IN ('LOCAL_PATH','REMOTE_REFERENCE')),
  normalized_reference text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED','UNVERIFIED','STALE','FAILED')),
  verification_method text NOT NULL,
  verified_at timestamptz,
  verification_authority text NOT NULL,
  repository_identity text,
  branch text,
  commit_sha text,
  fingerprint text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorization_context text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_revision_id, ordering),
  UNIQUE (draft_revision_id, workspace_registration_id)
);

CREATE TABLE IF NOT EXISTS intentchord.task_workspace_scope_entries (
  id uuid PRIMARY KEY,
  task_workspace_snapshot_id uuid NOT NULL REFERENCES intentchord.task_workspace_snapshots(id) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type IN ('ALLOWED','EXCLUDED')),
  path text NOT NULL,
  ordering integer NOT NULL CHECK (ordering >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_workspace_snapshot_id, entry_type, ordering),
  UNIQUE (task_workspace_snapshot_id, entry_type, path)
);

CREATE TABLE IF NOT EXISTS intentchord.contract_revisions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE,
  task_draft_revision_id uuid NOT NULL REFERENCES intentchord.task_draft_revisions(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  status text NOT NULL CHECK (status IN ('AWAITING_OWNER_APPROVAL','APPROVED','REJECTED','SUPERSEDED')),
  contract_content jsonb NOT NULL,
  content_sha256 text NOT NULL,
  policy_version text NOT NULL,
  governance_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, revision)
);

CREATE TABLE IF NOT EXISTS intentchord.contract_approvals (
  id uuid PRIMARY KEY,
  contract_revision_id uuid NOT NULL UNIQUE REFERENCES intentchord.contract_revisions(id) ON DELETE RESTRICT,
  owner_reference text NOT NULL,
  contract_content_sha256 text NOT NULL,
  approved_state_revision bigint NOT NULL,
  approval_channel text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.compiled_contract_artifacts (
  id uuid PRIMARY KEY,
  contract_revision_id uuid NOT NULL REFERENCES intentchord.contract_revisions(id) ON DELETE RESTRICT,
  run_id uuid,
  compiled_bytes bytea NOT NULL,
  content_sha256 text NOT NULL,
  compiler_version text NOT NULL,
  governance_version text NOT NULL,
  task_skill_profile_version text NOT NULL,
  agent_environment text NOT NULL,
  provider text NOT NULL,
  model_identifier text NOT NULL,
  model_profile_snapshot jsonb NOT NULL,
  reasoning_level text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en','ar')),
  delivery_state text NOT NULL CHECK (delivery_state IN ('COMPILED','DELIVERED')),
  delivery_method text,
  compiled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL REFERENCES intentchord.contract_revisions(id) ON DELETE RESTRICT,
  compiled_artifact_id uuid REFERENCES intentchord.compiled_contract_artifacts(id) ON DELETE RESTRICT,
  state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  status text NOT NULL CHECK (status IN ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY','DECIDED','SUPERSEDED')),
  source text NOT NULL CHECK (source IN ('SYNTHETIC_FIXTURE','IMPORTED_REPORT','CORRECTION_REPORT')),
  execution_type text NOT NULL CHECK (execution_type IN ('INITIAL','CORRECTION','FIXTURE')),
  round integer NOT NULL CHECK (round > 0),
  parent_run_id uuid REFERENCES intentchord.runs(id) ON DELETE RESTRICT,
  lineage_root_id uuid NOT NULL,
  correction_round integer NOT NULL DEFAULT 0 CHECK (correction_round >= 0),
  binding_nonce_hash text NOT NULL,
  binding_marker text NOT NULL UNIQUE,
  profile_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, round)
);

ALTER TABLE intentchord.compiled_contract_artifacts
  DROP CONSTRAINT IF EXISTS compiled_contract_artifacts_run_id_fkey;
ALTER TABLE intentchord.compiled_contract_artifacts
  ADD CONSTRAINT compiled_contract_artifacts_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES intentchord.runs(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS intentchord.context_leases (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  workspace_snapshot jsonb NOT NULL,
  contract_sha256 text NOT NULL,
  profile_snapshot jsonb NOT NULL,
  binding_marker text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.report_submissions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  raw_content bytea NOT NULL,
  content_type text NOT NULL,
  content_sha256 text NOT NULL,
  parser_version text NOT NULL,
  parse_status text NOT NULL CHECK (parse_status IN ('RECEIVED','PARSED','REJECTED')),
  parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  executor_claimed_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  backend_bound_identity jsonb NOT NULL,
  binding_result jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.report_claims (
  id uuid PRIMARY KEY,
  report_submission_id uuid NOT NULL REFERENCES intentchord.report_submissions(id) ON DELETE CASCADE,
  claim_type text NOT NULL,
  claim_key text NOT NULL,
  claim_status text,
  claim_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.report_evidence_references (
  id uuid PRIMARY KEY,
  report_submission_id uuid NOT NULL REFERENCES intentchord.report_submissions(id) ON DELETE CASCADE,
  workspace_registration_id uuid REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  source_reference text NOT NULL,
  observation text NOT NULL,
  evidence_type text NOT NULL,
  source_producer text NOT NULL,
  integrity_sha256 text,
  validation_relationship text NOT NULL,
  captured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.validation_evidence (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  check_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS','FAIL','EVIDENCE_REQUIRED')),
  producer_type text NOT NULL CHECK (producer_type IN ('BACKEND','HARNESS','OWNER_RUNTIME')),
  details text NOT NULL,
  integrity_sha256 text,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.tool_trace_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  command text NOT NULL,
  capability text,
  authorization_result text NOT NULL CHECK (authorization_result IN ('AUTHORIZED','UNAUTHORIZED','UNKNOWN')),
  producer_type text NOT NULL CHECK (producer_type IN ('ADAPTER','HARNESS','OWNER_RUNTIME')),
  occurred_at timestamptz NOT NULL,
  integrity_sha256 text,
  UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS intentchord.verdicts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES intentchord.runs(id) ON DELETE RESTRICT,
  report_submission_id uuid NOT NULL REFERENCES intentchord.report_submissions(id) ON DELETE RESTRICT,
  classification text NOT NULL CHECK (classification IN ('PASS','BLOCKER','VIOLATION','EVIDENCE_REQUIRED')),
  verdict_content jsonb NOT NULL,
  engine_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.owner_decisions (
  id uuid PRIMARY KEY,
  verdict_id uuid NOT NULL REFERENCES intentchord.verdicts(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL UNIQUE REFERENCES intentchord.runs(id) ON DELETE RESTRICT,
  owner_reference text NOT NULL,
  decision_type text NOT NULL CHECK (decision_type IN ('ACKNOWLEDGED','ACCEPTED','ACCEPTED_WITH_OVERRIDE','CORRECTION_REQUESTED','REJECTED')),
  reason text,
  run_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.correction_rounds (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE,
  parent_run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE RESTRICT,
  child_run_id uuid NOT NULL UNIQUE REFERENCES intentchord.runs(id) ON DELETE RESTRICT,
  governing_verdict_id uuid NOT NULL REFERENCES intentchord.verdicts(id) ON DELETE RESTRICT,
  owner_decision_id uuid NOT NULL REFERENCES intentchord.owner_decisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.audit_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_authority text NOT NULL,
  related_revision bigint,
  related_task_id uuid,
  related_contract_revision_id uuid,
  related_run_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_aggregate_idx
  ON intentchord.audit_events(aggregate_type, aggregate_id, created_at, id);
CREATE INDEX IF NOT EXISTS reports_run_idx
  ON intentchord.report_submissions(run_id, received_at);
CREATE INDEX IF NOT EXISTS snapshots_task_revision_idx
  ON intentchord.task_workspace_snapshots(task_id, draft_revision_id, ordering);

INSERT INTO intentchord.task_draft_revisions(
  id, task_id, revision, title, title_manually_edited, objective, task_mode,
  draft_projection, content_sha256, created_at
)
SELECT
  md5(t.id::text || ':draft:0')::uuid,
  t.id, 0, t.title, t.title_manually_edited, t.objective, t.task_mode,
  t.draft, encode(sha256(convert_to(t.draft::text, 'UTF8')), 'hex'), t.created_at
FROM intentchord.tasks t
ON CONFLICT (task_id, revision) DO NOTHING;

INSERT INTO intentchord.task_workspace_snapshots(
  id, task_id, draft_revision_id, workspace_registration_id, ordering,
  display_name, role, reference_type, normalized_reference,
  verification_status, verification_method, verified_at, verification_authority,
  repository_identity, branch, commit_sha, fingerprint, provenance,
  authorization_context, created_at
)
SELECT
  md5(tw.task_id::text || ':' || tw.workspace_id::text || ':snapshot:0')::uuid,
  tw.task_id,
  md5(tw.task_id::text || ':draft:0')::uuid,
  tw.workspace_id,
  tw.ordering,
  w.display_name, w.role, w.reference_type, w.normalized_reference,
  w.verification_status, w.verification_method, w.verified_at, w.verification_authority,
  w.repository_identity, w.branch, w.commit_sha, w.fingerprint,
  COALESCE(w.provenance, '{}'::jsonb), tw.authorization_context, tw.created_at
FROM intentchord.task_workspaces tw
JOIN intentchord.workspaces w ON w.id = tw.workspace_id
ON CONFLICT (draft_revision_id, ordering) DO NOTHING;

INSERT INTO intentchord.task_workspace_scope_entries(
  id, task_workspace_snapshot_id, entry_type, path, ordering, created_at
)
SELECT
  se.id,
  md5(se.task_id::text || ':' || se.workspace_id::text || ':snapshot:0')::uuid,
  se.entry_type, se.path, se.ordering, se.created_at
FROM intentchord.scope_entries se
ON CONFLICT (id) DO NOTHING;
