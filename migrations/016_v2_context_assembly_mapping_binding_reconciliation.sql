-- Migration 016: V2 Context Assembly Mapping Binding Reconciliation
-- Additive after 015. Replaces the context_mapping_run_insert_snapshot_guard
-- trigger function to correctly handle V2 AI_CONTEXT_MAPPING_V2 runs.
--
-- PROVEN CONTRADICTION:
-- Migration 014 check constraint: V2 requires workspace_index_snapshot_id IS NULL
-- Migration 015 trigger: unconditionally requires workspace_index_snapshot_id IS NOT NULL
-- No value satisfies both. Migration 016 resolves by validating V2 against context_assembly_sources.
--
-- V1 behavior is preserved unchanged. Historical rows remain readable.

CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql AS $cisg$
DECLARE
  snapshot_row intentchord.workspace_index_snapshots%ROWTYPE;
  wea_row intentchord.workspace_evidence_artifacts%ROWTYPE;
  assembly_rev RECORD;
  assembly_sources intentchord.context_assembly_sources%ROWTYPE;
  sources jsonb;
  source_count integer;
  ord integer;
  source_obj jsonb;
  expected_ws_reg_id uuid;
  expected_ws_rev_id text;
  expected_snap_id uuid;
  expected_artifact_id text;
  expected_idx_sha text;
  expected_sem_sha text;
  is_registered_v2 boolean := false;
BEGIN
  IF NEW.mapping_idempotency_key IS NULL
     OR btrim(NEW.mapping_idempotency_key) = ''
     OR NEW.mapping_request_fingerprint_sha256 IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED';
  END IF;

  IF NEW.context_assembly_revision_id IS NOT NULL THEN
    -------------------------------------------------------------------
    -- V2 path: validate against context_assembly_sources (Migration 016)
    -------------------------------------------------------------------

    -- workspace_index_snapshot_id must be NULL for V2 (defense-in-depth;
    -- the check constraint context_mapping_runs_snapshot_binding_shape_ck
    -- also enforces this, but the trigger provides an explicit guard).
    IF NEW.workspace_index_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SNAPSHOT_ID_MUST_BE_NULL';
    END IF;

    -- Validate the Context Assembly Revision exists.
    SELECT id, assembly_sha256 INTO assembly_rev
      FROM intentchord.context_assembly_revisions
     WHERE id = NEW.context_assembly_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ASSEMBLY_REVISION_NOT_FOUND';
    END IF;

    -- Validate assembly SHA256 matches.
    IF assembly_rev.assembly_sha256 IS DISTINCT FROM NEW.context_assembly_sha256 THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ASSEMBLY_SHA_MISMATCH';
    END IF;

    -- Extract source_bindings from the governed mapping input snapshot envelope.
    sources := NEW.mapping_input_snapshot -> 'source_bindings';
    IF sources IS NULL OR jsonb_typeof(sources) <> 'array' THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_BINDINGS_MISSING';
    END IF;
    source_count := jsonb_array_length(sources);

    -- Validate exact source count match with context_assembly_sources.
    IF (SELECT count(*)::integer FROM intentchord.context_assembly_sources
         WHERE context_assembly_revision_id = NEW.context_assembly_revision_id)
       IS DISTINCT FROM source_count THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_COUNT_MISMATCH';
    END IF;

    -- Validate each source binding against context_assembly_sources.
    FOR ord IN 0 .. source_count - 1 LOOP
      source_obj := sources -> ord;

      -- Extract expected values from the persisted binding.
      expected_ws_reg_id := (source_obj ->> 'workspace_id')::uuid;
      expected_ws_rev_id := source_obj ->> 'workspace_revision_id';
      expected_snap_id   := (source_obj ->> 'workspace_index_snapshot_id')::uuid;
      expected_artifact_id := COALESCE(source_obj ->> 'accepted_workspace_evidence_artifact_id', source_obj ->> 'canonical_index_artifact_id');
      expected_idx_sha   := source_obj ->> 'workspace_index_sha256';
      expected_sem_sha   := source_obj ->> 'artifact_semantic_sha256';

      -- Find the matching context_assembly_sources row by (revision, ordering).
      SELECT * INTO assembly_sources
        FROM intentchord.context_assembly_sources
       WHERE context_assembly_revision_id = NEW.context_assembly_revision_id
         AND ordering = ord;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_BINDING_MISSING order=%', ord;
      END IF;

      -- Validate workspace registration identity.
      IF assembly_sources.workspace_registration_id IS DISTINCT FROM expected_ws_reg_id THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_WORKSPACE_MISMATCH order=%', ord;
      END IF;

      -- Validate workspace revision.
      IF assembly_sources.workspace_revision_id IS DISTINCT FROM expected_ws_rev_id THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_REVISION_MISMATCH order=%', ord;
      END IF;

      -- Validate workspace index snapshot.
      IF assembly_sources.workspace_index_snapshot_id IS DISTINCT FROM expected_snap_id THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_SNAPSHOT_MISMATCH order=%', ord;
      END IF;

      -- Validate canonical/effective artifact id against accepted_workspace_evidence_artifact_id.
      IF assembly_sources.accepted_workspace_evidence_artifact_id IS DISTINCT FROM expected_artifact_id THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_ARTIFACT_MISMATCH order=%', ord;
      END IF;

      -- Validate workspace index sha256.
      IF assembly_sources.workspace_index_sha256 IS DISTINCT FROM expected_idx_sha THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_INDEX_SHA_MISMATCH order=%', ord;
      END IF;

      -- Validate artifact semantic sha256.
      IF assembly_sources.artifact_semantic_sha256 IS DISTINCT FROM expected_sem_sha THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_SOURCE_SEMANTIC_SHA_MISMATCH order=%', ord;
      END IF;
    END LOOP;

  ELSE
    -------------------------------------------------------------------
    -- Direct snapshot path (V2 registered workspace)
    -------------------------------------------------------------------
    IF NEW.workspace_index_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED';
    END IF;
    SELECT * INTO snapshot_row FROM intentchord.workspace_index_snapshots WHERE id=NEW.workspace_index_snapshot_id;
    IF NOT FOUND OR snapshot_row.status<>'READY' THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_READY_SNAPSHOT_REQUIRED';
    END IF;
    is_registered_v2 := snapshot_row.source_mode='REGISTERED_WORKSPACE' AND snapshot_row.accepted_workspace_evidence_artifact_id IS NOT NULL;
    IF is_registered_v2 THEN
      SELECT * INTO wea_row FROM intentchord.workspace_evidence_artifacts WHERE id=snapshot_row.accepted_workspace_evidence_artifact_id;
      IF NOT FOUND
         OR NEW.canonical_index_artifact_id IS DISTINCT FROM wea_row.id
         OR NEW.artifact_semantic_sha256 IS DISTINCT FROM wea_row.artifact_semantic_sha256
         OR NEW.workspace_index_sha256 IS DISTINCT FROM wea_row.artifact_semantic_sha256
         OR NEW.workspace_snapshot_id IS DISTINCT FROM snapshot_row.workspace_revision_id
         OR NEW.mapping_input_snapshot->>'mapping_input_schema_version' IS DISTINCT FROM 'intentchord.ai-context-mapping-input.v2'
         OR NEW.mapping_input_snapshot->>'source_authority' IS DISTINCT FROM 'CANONICAL_INDEX_ARTIFACT'
         OR NEW.mapping_input_snapshot->>'canonical_index_artifact_id' IS DISTINCT FROM wea_row.id
         OR NEW.mapping_input_snapshot->>'artifact_semantic_sha256' IS DISTINCT FROM wea_row.artifact_semantic_sha256
         OR NEW.mapping_input_snapshot->>'workspace_index_sha256' IS DISTINCT FROM wea_row.artifact_semantic_sha256
         OR NEW.mapping_input_snapshot->>'workspace_snapshot_id' IS DISTINCT FROM snapshot_row.workspace_revision_id THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_ARTIFACT_HASH_MISMATCH';
      END IF;
    ELSE
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED';
    END IF;
  END IF;

  RETURN NEW;
END;
$cisg$;
