CREATE TABLE IF NOT EXISTS intentchord.schema_migrations (
  id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intentchord.tasks (
  id uuid PRIMARY KEY, title text NOT NULL, title_manually_edited boolean NOT NULL DEFAULT false,
  objective text NOT NULL, task_mode text NOT NULL CHECK (task_mode IN ('CONTROLLED_AUDIT','SOURCE_IMPLEMENTATION','REPORT_REVIEW')),
  draft jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intentchord.workspaces (
  id uuid PRIMARY KEY, display_name text NOT NULL, role text NOT NULL, reference_type text NOT NULL CHECK (reference_type IN ('LOCAL_PATH','REMOTE_REFERENCE')),
  reference text NOT NULL, repository_identity text, branch text, commit_sha text, fingerprint text NOT NULL, provenance jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intentchord.task_workspaces (
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE CASCADE, workspace_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE CASCADE,
  ordering integer NOT NULL CHECK (ordering >= 0), authorization_context text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, workspace_id), UNIQUE (task_id, ordering)
);
CREATE TABLE IF NOT EXISTS intentchord.scope_entries (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, workspace_id uuid NOT NULL, entry_type text NOT NULL CHECK (entry_type IN ('ALLOWED','EXCLUDED')),
  path text NOT NULL, ordering integer NOT NULL CHECK (ordering >= 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, workspace_id) REFERENCES intentchord.task_workspaces(task_id, workspace_id) ON DELETE CASCADE,
  UNIQUE (task_id, workspace_id, entry_type, ordering)
);
