-- IntentChord intelligence-resolution and evidence-semantics foundation.
-- Additive and idempotent. It enables the built-in bounded read-only discovery foundation; external AI adapters remain inactive until explicitly configured.

CREATE TABLE IF NOT EXISTS intentchord.intent_resolutions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE,
  task_draft_revision_id uuid NOT NULL REFERENCES intentchord.task_draft_revisions(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('PROPOSED','CONFIRMED','SUPERSEDED','REJECTED')),
  literal_objective text NOT NULL,
  resolution_content jsonb NOT NULL,
  resolver_adapter_id text NOT NULL,
  resolver_provider_id text CHECK (resolver_provider_id IS NULL OR resolver_provider_id IN ('OPENAI','ANTHROPIC','GOOGLE')),
  resolver_model_id text,
  resolver_execution_channel_id text CHECK (resolver_execution_channel_id IS NULL OR resolver_execution_channel_id IN ('CODEX','CLAUDE_CODE','GEMINI_CLI')),
  requested_provider_id text NOT NULL CHECK (requested_provider_id IN ('OPENAI','ANTHROPIC','GOOGLE')),
  requested_model_id text NOT NULL,
  requested_execution_channel_id text NOT NULL CHECK (requested_execution_channel_id IN ('CODEX','CLAUDE_CODE','GEMINI_CLI')),
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[0-9a-f]{64}$'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 text NOT NULL CHECK (output_sha256 ~ '^[0-9a-f]{64}$'),
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, revision),
  CHECK (
    (resolver_provider_id IS NULL AND resolver_model_id IS NULL AND resolver_execution_channel_id IS NULL)
    OR (resolver_provider_id IS NOT NULL AND resolver_model_id IS NOT NULL AND resolver_execution_channel_id IS NOT NULL)
  ),
  CHECK (
    (status = 'CONFIRMED' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (status <> 'CONFIRMED')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS intent_resolutions_one_active_proposal_idx
  ON intentchord.intent_resolutions(task_id)
  WHERE status = 'PROPOSED';

CREATE UNIQUE INDEX IF NOT EXISTS intent_resolutions_one_confirmed_draft_idx
  ON intentchord.intent_resolutions(task_draft_revision_id)
  WHERE status = 'CONFIRMED';



CREATE TABLE IF NOT EXISTS intentchord.discovery_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE,
  task_draft_revision_id uuid NOT NULL REFERENCES intentchord.task_draft_revisions(id) ON DELETE RESTRICT,
  intent_resolution_id uuid NOT NULL REFERENCES intentchord.intent_resolutions(id) ON DELETE RESTRICT,
  state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  status text NOT NULL CHECK (status IN (
    'CREATED','RUNNING','AWAITING_FINDINGS','READY_TO_COMPLETE',
    'COMPLETED','EVIDENCE_REQUIRED','FAILED','SUPERSEDED'
  )),
  schema_version text NOT NULL,
  planner_version text NOT NULL,
  adapter_id text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id IN ('OPENAI','ANTHROPIC','GOOGLE')),
  model_id text NOT NULL,
  execution_channel_id text NOT NULL CHECK (execution_channel_id IN ('CODEX','CLAUDE_CODE','GEMINI_CLI')),
  provider_invocation_state text NOT NULL DEFAULT 'NOT_INVOKED' CHECK (provider_invocation_state IN ('NOT_INVOKED','INVOKED')),
  external_invocation_id text,
  authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[0-9a-f]{64}$'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 text CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
  assessment jsonb,
  evidence_gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (provider_invocation_state = 'INVOKED') = (external_invocation_id IS NOT NULL)
  ),
  CHECK (
    (status IN ('COMPLETED','EVIDENCE_REQUIRED') AND completed_at IS NOT NULL AND output_sha256 IS NOT NULL)
    OR status NOT IN ('COMPLETED','EVIDENCE_REQUIRED')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS discovery_runs_one_active_draft_idx
  ON intentchord.discovery_runs(task_draft_revision_id)
  WHERE status IN ('CREATED','RUNNING','AWAITING_FINDINGS','READY_TO_COMPLETE');

CREATE INDEX IF NOT EXISTS discovery_runs_task_created_idx
  ON intentchord.discovery_runs(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intentchord.discovery_items (
  id uuid PRIMARY KEY,
  discovery_run_id uuid NOT NULL REFERENCES intentchord.discovery_runs(id) ON DELETE CASCADE,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  relative_path text NOT NULL,
  symbol text,
  line_start integer CHECK (line_start IS NULL OR line_start > 0),
  line_end integer CHECK (line_end IS NULL OR line_end > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  requirement_ids jsonb NOT NULL,
  relevance_reason text NOT NULL,
  matched_concepts jsonb NOT NULL DEFAULT '[]'::jsonb,
  match_score integer NOT NULL DEFAULT 0 CHECK (match_score >= 0),
  item_state text NOT NULL CHECK (item_state IN ('DISCOVERED','INSPECTED','NOT_RELEVANT','OUTSIDE_SCOPE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((line_start IS NULL) = (line_end IS NULL)),
  CHECK (line_start IS NULL OR line_end >= line_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS discovery_items_identity_idx
  ON intentchord.discovery_items(
    discovery_run_id, workspace_registration_id, relative_path, content_sha256,
    COALESCE(symbol, ''), COALESCE(line_start, 0), COALESCE(line_end, 0)
  );

CREATE INDEX IF NOT EXISTS discovery_items_requirement_gin_idx
  ON intentchord.discovery_items USING gin(requirement_ids);

CREATE TABLE IF NOT EXISTS intentchord.discovery_findings (
  id uuid PRIMARY KEY,
  discovery_run_id uuid NOT NULL REFERENCES intentchord.discovery_runs(id) ON DELETE CASCADE,
  requirement_id text NOT NULL,
  claim text NOT NULL,
  finding_status text NOT NULL CHECK (finding_status IN (
    'PROVEN_BY_SOURCE','PROVEN_BY_ARTIFACT','PROVEN_BY_VALIDATION','PROVEN_BY_RUNTIME',
    'CONTRADICTED','NOT_PROVEN','EVIDENCE_REQUIRED'
  )),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  accepted boolean NOT NULL,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  producer_adapter_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_findings_run_requirement_idx
  ON intentchord.discovery_findings(discovery_run_id, requirement_id);

CREATE TABLE IF NOT EXISTS intentchord.discovery_scope_expansion_requests (
  id uuid PRIMARY KEY,
  discovery_run_id uuid NOT NULL REFERENCES intentchord.discovery_runs(id) ON DELETE CASCADE,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  requested_path text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
  owner_decision_id uuid REFERENCES intentchord.owner_decisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS intentchord.source_evidence (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  requirement_id text NOT NULL,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  relative_path text NOT NULL,
  symbol text,
  line_start integer CHECK (line_start IS NULL OR line_start > 0),
  line_end integer CHECK (line_end IS NULL OR line_end > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  observation text NOT NULL,
  producer_type text NOT NULL CHECK (producer_type IN ('BACKEND','ADAPTER','SIGNED_HARNESS','OWNER_RUNTIME')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((line_start IS NULL) = (line_end IS NULL)),
  CHECK (line_start IS NULL OR line_end >= line_start),
  UNIQUE (run_id, requirement_id, workspace_registration_id, relative_path, content_sha256, line_start, line_end)
);

CREATE TABLE IF NOT EXISTS intentchord.artifact_evidence (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES intentchord.runs(id) ON DELETE CASCADE,
  requirement_id text NOT NULL,
  artifact_id text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_relationship text,
  producer_type text NOT NULL CHECK (producer_type IN ('BACKEND','SIGNED_HARNESS','OWNER_RUNTIME')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, requirement_id, artifact_id, artifact_sha256)
);



ALTER TABLE intentchord.source_evidence
  ADD COLUMN IF NOT EXISTS discovery_run_id uuid REFERENCES intentchord.discovery_runs(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_evidence_single_parent_check'
      AND conrelid = 'intentchord.source_evidence'::regclass
  ) THEN
    ALTER TABLE intentchord.source_evidence
      ADD CONSTRAINT source_evidence_single_parent_check CHECK (
        (run_id IS NULL) <> (discovery_run_id IS NULL)
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS source_evidence_discovery_identity_idx
  ON intentchord.source_evidence(
    discovery_run_id, requirement_id, workspace_registration_id, relative_path, content_sha256,
    COALESCE(line_start, 0), COALESCE(line_end, 0)
  )
  WHERE discovery_run_id IS NOT NULL;


-- Expand the normalized report-reference vocabulary while preserving existing rows.
ALTER TABLE intentchord.report_evidence_references
  DROP CONSTRAINT IF EXISTS report_evidence_references_reference_kind_check;

ALTER TABLE intentchord.report_evidence_references
  ADD CONSTRAINT report_evidence_references_reference_kind_check CHECK (
    reference_kind IS NULL OR reference_kind IN (
      'INSPECTED_PATH',
      'SUPPORTING_EVIDENCE',
      'VALIDATION_CHECK',
      'TOOL_TRACE_EVENT',
      'SOURCE_EVIDENCE',
      'ARTIFACT_EVIDENCE',
      'VALIDATION_EVIDENCE',
      'RUNTIME_EVIDENCE'
    )
  );


CREATE UNIQUE INDEX IF NOT EXISTS source_evidence_identity_idx
  ON intentchord.source_evidence(
    run_id, requirement_id, workspace_registration_id, relative_path, content_sha256,
    COALESCE(line_start, 0), COALESCE(line_end, 0)
  )
  WHERE run_id IS NOT NULL;
