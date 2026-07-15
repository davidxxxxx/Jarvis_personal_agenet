const TARGET_VERSION = 23;
const FLAC_ENCODER_VERSION = "ffmpeg-flac-v1";

function transcriptSegmentsSchema(tableName, { ifNotExists = false } = {}) {
  if (
    !new Set(["transcript_segments", "transcript_segments_v13", "transcript_segments_v14"]).has(
      tableName
    )
  ) {
    throw new TypeError("unsupported transcript segment table name");
  }
  return `
    CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      speaker_label TEXT NOT NULL,
      text TEXT NOT NULL,
      confidence REAL CHECK(
        confidence IS NULL OR (
          typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1
        )
      ),
      is_stable INTEGER NOT NULL CHECK(
        typeof(is_stable) = 'integer' AND is_stable IN (0,1)
      ),
      analysis_state TEXT NOT NULL DEFAULT 'pending',
      track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
      chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL DEFAULT 'mic' CHECK(source_type IN ('mic','system')),
      result_kind TEXT NOT NULL DEFAULT 'provisional'
        CHECK(result_kind IN ('provisional','final')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(
        typeof(version) = 'integer' AND version >= 1
      ),
      model_version TEXT,
      completed_at INTEGER,
      superseded_by TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
      echo_score REAL CHECK(
        echo_score IS NULL OR (
          typeof(echo_score) IN ('integer','real') AND echo_score BETWEEN 0 AND 1
        )
      ),
      duplicate_of TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
      CHECK(superseded_by IS NULL OR result_kind = 'provisional'),
      CHECK(
        duplicate_of IS NULL OR (
          source_type = 'mic' AND echo_score >= 0.8 AND duplicate_of <> id
        )
      ),
      CHECK(
        result_kind <> 'final' OR (
          track_id IS NOT NULL AND
          chunk_id IS NOT NULL AND
          model_version IS NOT NULL AND
          length(trim(model_version)) BETWEEN 1 AND 128 AND
          typeof(completed_at) = 'integer' AND
          is_stable = 1
        )
      )
    );
  `;
}

const TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS = `
  CREATE INDEX IF NOT EXISTS idx_segments_session_time
    ON transcript_segments(session_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_segments_superseded_by
    ON transcript_segments(superseded_by)
    WHERE superseded_by IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_segments_duplicate_of
    ON transcript_segments(duplicate_of)
    WHERE duplicate_of IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_chunk_model_final
    ON transcript_segments(chunk_id, model_version)
    WHERE chunk_id IS NOT NULL AND result_kind = 'final';
  CREATE TRIGGER IF NOT EXISTS validate_final_transcript_lineage_insert
  BEFORE INSERT ON transcript_segments
  WHEN NEW.result_kind = 'final'
  BEGIN
    SELECT RAISE(ABORT, 'invalid final transcript lineage')
    WHERE NOT EXISTS (
      SELECT 1
      FROM audio_chunks AS chunk
      JOIN audio_tracks AS track ON track.id = chunk.track_id
      WHERE chunk.id = NEW.chunk_id
        AND chunk.session_id = NEW.session_id
        AND chunk.track_id = NEW.track_id
        AND chunk.source_type = NEW.source_type
        AND chunk.started_at = NEW.started_at
        AND chunk.ended_at = NEW.ended_at
        AND chunk.write_state = 'committed'
        AND chunk.deleted_at IS NULL
        AND track.session_id = NEW.session_id
        AND track.source_type = NEW.source_type
    );
  END;
  CREATE TRIGGER IF NOT EXISTS validate_final_transcript_lineage_update
  BEFORE UPDATE OF session_id, started_at, ended_at, track_id, chunk_id, source_type, result_kind
  ON transcript_segments
  WHEN NEW.result_kind = 'final'
  BEGIN
    SELECT RAISE(ABORT, 'invalid final transcript lineage')
    WHERE NOT EXISTS (
      SELECT 1
      FROM audio_chunks AS chunk
      JOIN audio_tracks AS track ON track.id = chunk.track_id
      WHERE chunk.id = NEW.chunk_id
        AND chunk.session_id = NEW.session_id
        AND chunk.track_id = NEW.track_id
        AND chunk.source_type = NEW.source_type
        AND chunk.started_at = NEW.started_at
        AND chunk.ended_at = NEW.ended_at
        AND chunk.write_state = 'committed'
        AND chunk.deleted_at IS NULL
        AND track.session_id = NEW.session_id
        AND track.source_type = NEW.source_type
    );
  END;
  CREATE TRIGGER IF NOT EXISTS validate_transcript_supersession_insert
  BEFORE INSERT ON transcript_segments
  WHEN NEW.superseded_by IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'invalid transcript supersession')
    WHERE NOT EXISTS (
      SELECT 1
      FROM transcript_segments AS final
      WHERE final.id = NEW.superseded_by
        AND final.result_kind = 'final'
        AND final.session_id = NEW.session_id
        AND final.track_id = NEW.track_id
        AND NEW.started_at < final.ended_at
        AND final.started_at < NEW.ended_at
    );
  END;
  CREATE TRIGGER IF NOT EXISTS validate_transcript_supersession_update
  BEFORE UPDATE OF superseded_by, session_id, track_id, started_at, ended_at, result_kind
  ON transcript_segments
  WHEN NEW.superseded_by IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'invalid transcript supersession')
    WHERE NOT EXISTS (
      SELECT 1
      FROM transcript_segments AS final
      WHERE final.id = NEW.superseded_by
        AND final.result_kind = 'final'
        AND final.session_id = NEW.session_id
        AND final.track_id = NEW.track_id
        AND NEW.started_at < final.ended_at
        AND final.started_at < NEW.ended_at
    );
  END;
  CREATE TRIGGER IF NOT EXISTS validate_transcript_supersession_target_update
  BEFORE UPDATE OF session_id, track_id, started_at, ended_at, result_kind
  ON transcript_segments
  WHEN EXISTS (
    SELECT 1 FROM transcript_segments AS source
    WHERE source.superseded_by = OLD.id
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid transcript supersession target')
    WHERE NEW.result_kind <> 'final'
      OR EXISTS (
        SELECT 1
        FROM transcript_segments AS source
        WHERE source.superseded_by = OLD.id
          AND (
            source.session_id <> NEW.session_id
            OR source.track_id IS NOT NEW.track_id
            OR source.started_at >= NEW.ended_at
            OR NEW.started_at >= source.ended_at
          )
      );
  END;
  CREATE TRIGGER IF NOT EXISTS validate_transcript_duplicate_insert
  BEFORE INSERT ON transcript_segments
  WHEN NEW.duplicate_of IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'invalid transcript duplicate')
    WHERE NEW.source_type <> 'mic'
      OR NEW.echo_score IS NULL
      OR NEW.echo_score < 0.8
      OR NEW.id = NEW.duplicate_of
      OR NOT EXISTS (
        SELECT 1
        FROM transcript_segments AS target
        WHERE target.id = NEW.duplicate_of
          AND target.session_id = NEW.session_id
          AND target.source_type = 'system'
          AND NEW.started_at < target.ended_at
          AND target.started_at < NEW.ended_at
      );
  END;
  CREATE TRIGGER IF NOT EXISTS validate_transcript_duplicate_update
  BEFORE UPDATE OF duplicate_of, session_id, source_type, started_at, ended_at, echo_score
  ON transcript_segments
  WHEN NEW.duplicate_of IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'invalid transcript duplicate')
    WHERE NEW.source_type <> 'mic'
      OR NEW.echo_score IS NULL
      OR NEW.echo_score < 0.8
      OR NEW.id = NEW.duplicate_of
      OR NOT EXISTS (
        SELECT 1
        FROM transcript_segments AS target
        WHERE target.id = NEW.duplicate_of
          AND target.session_id = NEW.session_id
          AND target.source_type = 'system'
          AND NEW.started_at < target.ended_at
          AND target.started_at < NEW.ended_at
      );
  END;
  CREATE TRIGGER IF NOT EXISTS invalidate_transcript_duplicates_on_target_text_update
  BEFORE UPDATE OF text ON transcript_segments
  WHEN OLD.source_type = 'system' AND NEW.text IS NOT OLD.text
  BEGIN
    UPDATE transcript_segments
    SET duplicate_of = NULL
    WHERE duplicate_of = OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS validate_transcript_duplicate_target_update
  BEFORE UPDATE OF id, session_id, source_type, started_at, ended_at
  ON transcript_segments
  WHEN EXISTS (
    SELECT 1 FROM transcript_segments AS source
    WHERE source.duplicate_of = OLD.id
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid transcript duplicate target')
    WHERE NEW.source_type <> 'system'
      OR EXISTS (
        SELECT 1
        FROM transcript_segments AS source
        WHERE source.duplicate_of = OLD.id
          AND (
            source.session_id <> NEW.session_id
            OR source.started_at >= NEW.ended_at
            OR NEW.started_at >= source.ended_at
          )
      );
  END;
`;

const PROCESSING_JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS processing_jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
    chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    state TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    input_hash TEXT NOT NULL,
    input_version INTEGER NOT NULL DEFAULT 1,
    model_version TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    error_code TEXT,
    blocked_reason TEXT,
    execution_device TEXT CHECK(
      execution_device IS NULL OR execution_device IN ('cuda','cpu','cloud')
    ),
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
`;

const PROCESSING_JOBS_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_chunk_input
  ON processing_jobs(job_type, chunk_id, input_hash, input_version, model_version)
  WHERE chunk_id IS NOT NULL AND job_type <> 'compress_chunk';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_compress_identity
  ON processing_jobs(chunk_id, model_version)
  WHERE chunk_id IS NOT NULL AND job_type = 'compress_chunk';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_global_input
  ON processing_jobs(job_type, input_hash, input_version, model_version)
  WHERE chunk_id IS NULL;
`;

const MIGRATION_BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    is_self INTEGER NOT NULL DEFAULT 0,
    voice_profile_id INTEGER,
    voice_confidence REAL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('recording','paused','finalizing','completed','recovered','failed')),
    mic_device_id TEXT,
    language TEXT NOT NULL DEFAULT 'zh',
    created_at INTEGER NOT NULL,
    capture_mode TEXT NOT NULL DEFAULT 'mic',
    retention_mode TEXT NOT NULL DEFAULT 'speech_triggered',
    capture_policy_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"preRollMs":2000,"postRollMs":3000,"mergeGapMs":3000}',
    processing_state TEXT NOT NULL DEFAULT 'pending',
    timeline_version INTEGER NOT NULL DEFAULT 1,
    finalized_at INTEGER,
    ready_at INTEGER,
    stop_reason TEXT,
    durable_boundary_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS audio_chunks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    transcription_status TEXT NOT NULL DEFAULT 'pending',
    track_id TEXT,
    source_type TEXT NOT NULL DEFAULT 'mic',
    sequence_number INTEGER NOT NULL DEFAULT 0,
    write_state TEXT NOT NULL DEFAULT 'committed',
    deleted_at INTEGER,
    format TEXT NOT NULL DEFAULT 'wav',
    file_sha256 TEXT,
    sample_rate INTEGER NOT NULL DEFAULT 24000,
    channels INTEGER NOT NULL DEFAULT 1,
    retired_path TEXT,
    retired_format TEXT,
    retired_file_sha256 TEXT
  );
`;

const SPEAKER_IDENTITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS speaker_clusters (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    track_id TEXT REFERENCES audio_tracks(id) ON DELETE SET NULL,
    local_label TEXT NOT NULL,
    model_id TEXT NOT NULL,
    embedding BLOB,
    speech_ms INTEGER NOT NULL DEFAULT 0,
    window_count INTEGER NOT NULL DEFAULT 0,
    quality_score REAL,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    link_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK(link_state IN ('unknown','suggested','confirmed','rejected')),
    match_score REAL,
    match_margin REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_id, track_id, local_label)
  );
  CREATE TABLE IF NOT EXISTS speaker_cluster_segments (
    cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
    transcript_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    PRIMARY KEY(cluster_id, transcript_segment_id)
  );
  CREATE TABLE IF NOT EXISTS voice_profile_samples (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    source_cluster_id TEXT REFERENCES speaker_clusters(id) ON DELETE SET NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('enrollment','user_confirmed')),
    speech_ms INTEGER NOT NULL,
    window_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS voice_profile_aggregates (
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    accepted_speech_ms INTEGER NOT NULL CHECK(accepted_speech_ms >= 0),
    window_count INTEGER NOT NULL CHECK(window_count >= 0),
    self_consistency REAL CHECK(
      self_consistency IS NULL OR (self_consistency >= 0 AND self_consistency <= 1)
    ),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(person_id, model_id)
  );
  CREATE TABLE IF NOT EXISTS voice_profile_import_markers (
    marker_key TEXT PRIMARY KEY,
    imported_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS speaker_identity_corrections (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
    previous_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    next_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    previous_person_ref TEXT,
    next_person_ref TEXT,
    previous_state TEXT NOT NULL
      CHECK(previous_state IN ('unknown','suggested','confirmed','rejected')),
    next_state TEXT NOT NULL
      CHECK(next_state IN ('unknown','suggested','confirmed','rejected')),
    scope TEXT NOT NULL CHECK(scope IN ('session','persistent')),
    actor TEXT NOT NULL CHECK(actor IN ('user','system')),
    correction_kind TEXT NOT NULL DEFAULT 'link'
      CHECK(correction_kind IN ('link','merge')),
    resolution_commit_sequence INTEGER CHECK(
      resolution_commit_sequence IS NULL OR resolution_commit_sequence >= 0
    ),
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_speaker_clusters_session
    ON speaker_clusters(session_id, track_id, local_label);
  CREATE INDEX IF NOT EXISTS idx_speaker_cluster_segments_segment
    ON speaker_cluster_segments(transcript_segment_id, cluster_id);
  CREATE INDEX IF NOT EXISTS idx_voice_profile_samples_model_person
    ON voice_profile_samples(model_id, person_id, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_profile_user_confirmed_cluster
    ON voice_profile_samples(source_cluster_id, person_id, model_id, source_kind)
    WHERE source_cluster_id IS NOT NULL AND source_kind = 'user_confirmed';
  CREATE INDEX IF NOT EXISTS idx_speaker_corrections_cluster_time
    ON speaker_identity_corrections(cluster_id, created_at, id);
  CREATE TRIGGER IF NOT EXISTS clear_deleted_person_speaker_links
  BEFORE DELETE ON people
  BEGIN
    UPDATE speaker_clusters
    SET person_id = NULL, link_state = 'unknown', match_score = NULL,
        match_margin = NULL, updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    WHERE person_id = OLD.id;
  END;
`;

const SESSION_DIARIZATION_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_diarization_identity
    ON processing_jobs(job_type, session_id, track_id, input_hash, input_version, model_version)
    WHERE job_type = 'diarize_track';
  CREATE TABLE IF NOT EXISTS speaker_diarization_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
    transcript_revision TEXT NOT NULL CHECK(
      length(transcript_revision) = 64 AND
      transcript_revision NOT GLOB '*[^0-9a-f]*'
    ),
    policy_id TEXT NOT NULL,
    diarizer_model_id TEXT NOT NULL,
    embedding_model_id TEXT NOT NULL,
    model_artifact_sha256 TEXT NOT NULL CHECK(
      length(model_artifact_sha256) = 64 AND
      model_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    embedding_dimension INTEGER NOT NULL CHECK(embedding_dimension = 512),
    sample_rate INTEGER NOT NULL CHECK(sample_rate = 16000),
    input_version INTEGER NOT NULL CHECK(input_version = 1),
    execution_device TEXT NOT NULL CHECK(execution_device = 'cpu'),
    commit_sequence INTEGER NOT NULL UNIQUE CHECK(commit_sequence > 0),
    created_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL CHECK(completed_at >= created_at),
    UNIQUE(session_id, track_id, transcript_revision, policy_id)
  );
  CREATE TABLE IF NOT EXISTS speaker_diarization_run_clusters (
    run_id TEXT NOT NULL REFERENCES speaker_diarization_runs(id) ON DELETE CASCADE,
    cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
    local_label TEXT NOT NULL,
    embedding BLOB CHECK(
      embedding IS NULL OR (typeof(embedding) = 'blob' AND length(embedding) = 2048)
    ),
    speech_ms INTEGER NOT NULL CHECK(speech_ms >= 0),
    window_count INTEGER NOT NULL CHECK(window_count >= 0),
    quality_score REAL CHECK(
      quality_score IS NULL OR (
        typeof(quality_score) IN ('integer','real') AND quality_score BETWEEN 0 AND 1
      )
    ),
    first_appearance_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, local_label),
    UNIQUE(run_id, cluster_id),
    CHECK(
      (window_count = 0 AND speech_ms = 0 AND embedding IS NULL AND quality_score IS NULL) OR
      (window_count > 0 AND embedding IS NOT NULL AND quality_score IS NOT NULL)
    )
  );
  CREATE TABLE IF NOT EXISTS speaker_turns (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES speaker_diarization_runs(id) ON DELETE CASCADE,
    cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
    chunk_id TEXT NOT NULL REFERENCES audio_chunks(id) ON DELETE CASCADE,
    transcript_segment_id TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
    turn_index INTEGER NOT NULL CHECK(turn_index >= 0),
    raw_label TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL CHECK(ended_at > started_at),
    embedding BLOB CHECK(
      embedding IS NULL OR (typeof(embedding) = 'blob' AND length(embedding) = 2048)
    ),
    echo_state TEXT NOT NULL DEFAULT 'none'
      CHECK(echo_state IN ('none','possible','confirmed')),
    duplicate_of_turn_id TEXT REFERENCES speaker_turns(id) ON DELETE SET NULL,
    excluded_from_centroid INTEGER NOT NULL DEFAULT 0 CHECK(excluded_from_centroid IN (0,1)),
    created_at INTEGER NOT NULL,
    UNIQUE(run_id, chunk_id, turn_index),
    CHECK(duplicate_of_turn_id IS NULL OR duplicate_of_turn_id <> id),
    CHECK((echo_state = 'confirmed') = (excluded_from_centroid = 1))
  );
  CREATE TABLE IF NOT EXISTS speaker_diarization_run_cluster_segments (
    run_id TEXT NOT NULL,
    cluster_id TEXT NOT NULL,
    transcript_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    PRIMARY KEY(run_id, cluster_id, transcript_segment_id),
    FOREIGN KEY(run_id, cluster_id)
      REFERENCES speaker_diarization_run_clusters(run_id, cluster_id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_diarization_run_revision
    ON speaker_diarization_runs(session_id, track_id, transcript_revision, policy_id);
  CREATE INDEX IF NOT EXISTS idx_diarization_runs_session_sequence
    ON speaker_diarization_runs(session_id, commit_sequence);
  CREATE INDEX IF NOT EXISTS idx_diarization_run_clusters_cluster
    ON speaker_diarization_run_clusters(cluster_id, run_id);
  CREATE INDEX IF NOT EXISTS idx_speaker_turns_run_time
    ON speaker_turns(run_id, started_at, ended_at, id);
  CREATE INDEX IF NOT EXISTS idx_speaker_turns_segment
    ON speaker_turns(transcript_segment_id, run_id);
  CREATE INDEX IF NOT EXISTS idx_diarization_run_cluster_segments_segment
    ON speaker_diarization_run_cluster_segments(transcript_segment_id, run_id, cluster_id);
`;

const SPEAKER_IDENTITY_RESOLUTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS speaker_identity_resolution_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    diarization_revision TEXT NOT NULL CHECK(
      length(diarization_revision) = 64 AND
      diarization_revision NOT GLOB '*[^0-9a-f]*'
    ),
    profile_revision TEXT NOT NULL CHECK(
      length(profile_revision) = 64 AND
      profile_revision NOT GLOB '*[^0-9a-f]*'
    ),
    policy_id TEXT NOT NULL,
    commit_sequence INTEGER NOT NULL UNIQUE CHECK(commit_sequence > 0),
    expected_cluster_count INTEGER NOT NULL CHECK(expected_cluster_count >= 0),
    created_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL CHECK(completed_at >= created_at),
    UNIQUE(id, session_id, diarization_revision, profile_revision, policy_id),
    UNIQUE(session_id, diarization_revision, profile_revision, policy_id)
  );
  CREATE TABLE IF NOT EXISTS speaker_identity_resolutions (
    id TEXT PRIMARY KEY,
    resolution_run_id TEXT NOT NULL
      REFERENCES speaker_identity_resolution_runs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    evidence_run_id TEXT NOT NULL,
    cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
    diarization_revision TEXT NOT NULL CHECK(
      length(diarization_revision) = 64 AND
      diarization_revision NOT GLOB '*[^0-9a-f]*'
    ),
    profile_revision TEXT NOT NULL CHECK(
      length(profile_revision) = 64 AND
      profile_revision NOT GLOB '*[^0-9a-f]*'
    ),
    policy_id TEXT NOT NULL,
    candidate_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    candidate_person_ref TEXT,
    resolution_state TEXT NOT NULL CHECK(
      resolution_state IN ('unknown','suggested','confirmed','rejected','protected')
    ),
    match_score REAL CHECK(
      match_score IS NULL OR (
        typeof(match_score) IN ('integer','real') AND match_score BETWEEN -1 AND 1
      )
    ),
    match_margin REAL CHECK(
      match_margin IS NULL OR (
        typeof(match_margin) IN ('integer','real') AND match_margin BETWEEN 0 AND 2
      )
    ),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL CHECK(actor IN ('system','user')),
    correction_id TEXT REFERENCES speaker_identity_corrections(id) ON DELETE CASCADE,
    projection_applied INTEGER NOT NULL CHECK(projection_applied IN (0,1)),
    created_at INTEGER NOT NULL,
    FOREIGN KEY(evidence_run_id, cluster_id)
      REFERENCES speaker_diarization_run_clusters(run_id, cluster_id) ON DELETE CASCADE,
    FOREIGN KEY(
      resolution_run_id, session_id, diarization_revision, profile_revision, policy_id
    ) REFERENCES speaker_identity_resolution_runs(
      id, session_id, diarization_revision, profile_revision, policy_id
    ) ON DELETE CASCADE,
    CHECK(candidate_person_id IS NULL OR candidate_person_ref IS NOT NULL),
    CHECK(
      resolution_state IN ('unknown','protected') OR candidate_person_ref IS NOT NULL
    ),
    CHECK(
      (actor = 'system' AND resolution_state <> 'rejected' AND correction_id IS NULL) OR
      (actor = 'user' AND resolution_state = 'rejected' AND correction_id IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_identity_system_result
    ON speaker_identity_resolutions(resolution_run_id, cluster_id)
    WHERE actor = 'system';
  CREATE INDEX IF NOT EXISTS idx_speaker_identity_resolution_cluster_revision
    ON speaker_identity_resolutions(
      cluster_id, diarization_revision, profile_revision, policy_id, created_at, id
    );
  CREATE INDEX IF NOT EXISTS idx_speaker_identity_resolution_session_time
    ON speaker_identity_resolutions(session_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_speaker_identity_resolution_rejections
    ON speaker_identity_resolutions(
      cluster_id, diarization_revision, profile_revision, policy_id, candidate_person_ref
    ) WHERE resolution_state = 'rejected';
  CREATE TRIGGER IF NOT EXISTS validate_identity_resolution_evidence_session_insert
  BEFORE INSERT ON speaker_identity_resolutions
  BEGIN
    SELECT RAISE(ABORT, 'identity resolution evidence session mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM speaker_diarization_runs AS run
      WHERE run.id = NEW.evidence_run_id AND run.session_id = NEW.session_id
    );
  END;
  CREATE TRIGGER IF NOT EXISTS validate_identity_resolution_evidence_session_update
  BEFORE UPDATE OF evidence_run_id, session_id ON speaker_identity_resolutions
  BEGIN
    SELECT RAISE(ABORT, 'identity resolution evidence session mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM speaker_diarization_runs AS run
      WHERE run.id = NEW.evidence_run_id AND run.session_id = NEW.session_id
    );
  END;
`;

const MEMORY_LINEAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS analysis_inputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    transcript_revision TEXT NOT NULL CHECK(
      typeof(transcript_revision) = 'text' AND length(transcript_revision) = 64
      AND transcript_revision NOT GLOB '*[^0-9a-f]*'
    ),
    identity_revision TEXT NOT NULL CHECK(
      typeof(identity_revision) = 'text' AND length(identity_revision) = 64
      AND identity_revision NOT GLOB '*[^0-9a-f]*'
    ),
    prompt_version TEXT NOT NULL CHECK(
      typeof(prompt_version) = 'text' AND length(trim(prompt_version)) BETWEEN 1 AND 128
    ),
    input_hash TEXT NOT NULL UNIQUE CHECK(
      typeof(input_hash) = 'text' AND length(input_hash) = 64
      AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    input_contract_version TEXT NOT NULL CHECK(
      typeof(input_contract_version) = 'text'
      AND input_contract_version = 'jarvis-analysis-input-v2'
    ),
    redaction_version TEXT NOT NULL CHECK(
      typeof(redaction_version) = 'text'
      AND redaction_version = 'jarvis-redaction-v1'
    ),
    cloud_payload_json TEXT NOT NULL CHECK(
      CASE
        WHEN typeof(cloud_payload_json) = 'text' AND json_valid(cloud_payload_json)
        THEN COALESCE(
          json_type(cloud_payload_json) = 'object'
          AND json_extract(cloud_payload_json, '$.inputVersion') = input_contract_version,
          0
        )
        ELSE 0
      END
    ),
    cloud_payload_bytes INTEGER NOT NULL CHECK(
      typeof(cloud_payload_bytes) = 'integer'
      AND cloud_payload_bytes BETWEEN 2 AND 98304
      AND length(CAST(cloud_payload_json AS BLOB)) = cloud_payload_bytes
    ),
    cloud_payload_sha256 TEXT NOT NULL CHECK(
      typeof(cloud_payload_sha256) = 'text' AND length(cloud_payload_sha256) = 64
      AND cloud_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    candidate_hash TEXT CHECK(
      candidate_hash IS NULL OR (
        typeof(candidate_hash) = 'text' AND length(candidate_hash) = 64
        AND candidate_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
    applied_at INTEGER CHECK(
      applied_at IS NULL OR (typeof(applied_at) = 'integer' AND applied_at >= 0)
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    CHECK(
      (candidate_hash IS NULL AND applied_at IS NULL)
      OR (candidate_hash IS NOT NULL AND applied_at IS NOT NULL)
    )
  );
  CREATE TABLE IF NOT EXISTS analysis_input_speaker_bindings (
    analysis_input_id TEXT NOT NULL REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK(
      typeof(label) = 'text'
      AND (
        label = 'SELF'
        OR (
          length(label) BETWEEN 2 AND 16
          AND substr(label, 1, 1) = 'P'
          AND substr(label, 2, 1) BETWEEN '1' AND '9'
          AND substr(label, 2) NOT GLOB '*[^0-9]*'
        )
      )
    ),
    subject_kind TEXT NOT NULL CHECK(
      typeof(subject_kind) = 'text' AND subject_kind IN ('person','speaker_cluster')
    ),
    subject_id TEXT NOT NULL CHECK(typeof(subject_id) = 'text' AND length(subject_id) > 0),
    subject_display_name_snapshot TEXT NOT NULL CHECK(
      typeof(subject_display_name_snapshot) = 'text'
      AND length(trim(subject_display_name_snapshot)) > 0
    ),
    PRIMARY KEY(analysis_input_id, label),
    UNIQUE(analysis_input_id, subject_kind, subject_id)
  );
  CREATE TABLE IF NOT EXISTS analysis_input_segments (
    analysis_input_id TEXT NOT NULL REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(typeof(ordinal) = 'integer' AND ordinal >= 0),
    segment_id TEXT NOT NULL REFERENCES transcript_segments(id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    segment_version INTEGER NOT NULL CHECK(
      typeof(segment_version) = 'integer' AND segment_version >= 1
    ),
    text_hash TEXT NOT NULL CHECK(
      typeof(text_hash) = 'text' AND length(text_hash) = 64
      AND text_hash NOT GLOB '*[^0-9a-f]*'
    ),
    text_snapshot TEXT NOT NULL CHECK(
      typeof(text_snapshot) = 'text' AND length(text_snapshot) > 0
    ),
    speaker_binding_label TEXT NOT NULL,
    PRIMARY KEY(analysis_input_id, ordinal),
    UNIQUE(analysis_input_id, segment_id),
    FOREIGN KEY(analysis_input_id, speaker_binding_label)
      REFERENCES analysis_input_speaker_bindings(analysis_input_id, label)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
  );

  CREATE TABLE IF NOT EXISTS memory_items_v2 (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(
      typeof(kind) = 'text'
      AND kind IN ('fact','event','decision','commitment','preference','relationship','opinion')
    ),
    canonical_slot_key TEXT NOT NULL CHECK(
      typeof(canonical_slot_key) = 'text' AND length(canonical_slot_key) = 64
      AND canonical_slot_key NOT GLOB '*[^0-9a-f]*'
    ),
    canonical_value_key TEXT NOT NULL UNIQUE CHECK(
      typeof(canonical_value_key) = 'text' AND length(canonical_value_key) = 64
      AND canonical_value_key NOT GLOB '*[^0-9a-f]*'
    ),
    title TEXT NOT NULL CHECK(typeof(title) = 'text' AND length(trim(title)) > 0),
    body TEXT NOT NULL CHECK(typeof(body) = 'text' AND length(trim(body)) > 0),
    confidence REAL NOT NULL CHECK(
      typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1
    ),
    lifecycle TEXT NOT NULL CHECK(
      typeof(lifecycle) = 'text'
      AND lifecycle IN ('active','superseded','conflict','dismissed')
    ),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    provenance TEXT NOT NULL CHECK(
      typeof(provenance) = 'text'
      AND provenance IN ('evidence_linked','legacy_unverified','source_deleted')
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at)
  );
  CREATE TABLE IF NOT EXISTS memory_occurrences (
    id TEXT PRIMARY KEY,
    memory_value_id TEXT NOT NULL REFERENCES memory_items_v2(id) ON DELETE RESTRICT,
    analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    legacy_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    occurrence_key TEXT NOT NULL UNIQUE CHECK(
      typeof(occurrence_key) = 'text' AND length(occurrence_key) = 64
      AND occurrence_key NOT GLOB '*[^0-9a-f]*'
    ),
    candidate_item_fingerprint TEXT NOT NULL CHECK(
      typeof(candidate_item_fingerprint) = 'text' AND length(candidate_item_fingerprint) = 64
      AND candidate_item_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    started_at INTEGER,
    ended_at INTEGER,
    confidence REAL NOT NULL CHECK(
      typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    CHECK((analysis_input_id IS NULL) <> (legacy_session_id IS NULL)),
    CHECK(
      (started_at IS NULL AND ended_at IS NULL)
      OR (
        typeof(started_at) = 'integer' AND typeof(ended_at) = 'integer'
        AND started_at >= 0 AND ended_at >= started_at
      )
    )
  );
  CREATE TABLE IF NOT EXISTS memory_supersessions (
    previous_id TEXT NOT NULL REFERENCES memory_items_v2(id) ON DELETE RESTRICT,
    next_id TEXT NOT NULL REFERENCES memory_items_v2(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK(
      typeof(reason) = 'text'
      AND reason IN ('transcript_replacement','user_correction','conflict_resolution')
    ),
    analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    PRIMARY KEY(previous_id, next_id),
    CHECK(previous_id <> next_id)
  );
  CREATE TABLE IF NOT EXISTS memory_conflict_groups (
    id TEXT PRIMARY KEY,
    slot_key TEXT NOT NULL CHECK(
      typeof(slot_key) = 'text' AND length(slot_key) = 64
      AND slot_key NOT GLOB '*[^0-9a-f]*'
    ),
    episode INTEGER NOT NULL CHECK(typeof(episode) = 'integer' AND episode >= 1),
    state TEXT NOT NULL CHECK(typeof(state) = 'text' AND state IN ('open','resolved')),
    selected_member_id TEXT REFERENCES memory_items_v2(id) ON DELETE SET NULL,
    resolved_at INTEGER CHECK(
      resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= 0)
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),
    CHECK(
      (state = 'open' AND selected_member_id IS NULL AND resolved_at IS NULL)
      OR (state = 'resolved' AND selected_member_id IS NOT NULL AND resolved_at IS NOT NULL)
    ),
    UNIQUE(slot_key, episode)
  );
  CREATE TABLE IF NOT EXISTS memory_conflict_members (
    group_id TEXT NOT NULL REFERENCES memory_conflict_groups(id) ON DELETE RESTRICT,
    memory_item_id TEXT NOT NULL REFERENCES memory_items_v2(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    PRIMARY KEY(group_id, memory_item_id)
  );

  CREATE TABLE IF NOT EXISTS topics_v2 (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE CHECK(
      typeof(canonical_key) = 'text' AND length(canonical_key) = 64
      AND canonical_key NOT GLOB '*[^0-9a-f]*'
    ),
    name TEXT NOT NULL CHECK(typeof(name) = 'text' AND length(trim(name)) > 0),
    canonical_algorithm TEXT NOT NULL CHECK(
      typeof(canonical_algorithm) = 'text' AND canonical_algorithm = 'canonical-v1'
    ),
    lifecycle TEXT NOT NULL CHECK(
      typeof(lifecycle) = 'text' AND lifecycle IN ('active','superseded','dismissed')
    ),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    provenance TEXT NOT NULL CHECK(
      typeof(provenance) = 'text'
      AND provenance IN ('evidence_linked','legacy_unverified','source_deleted')
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at)
  );
  CREATE TABLE IF NOT EXISTS topic_revisions (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
    previous_revision_id TEXT REFERENCES topic_revisions(id) ON DELETE RESTRICT,
    summary TEXT NOT NULL CHECK(typeof(summary) = 'text'),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    provenance TEXT NOT NULL CHECK(
      typeof(provenance) = 'text'
      AND provenance IN ('evidence_linked','legacy_unverified','source_deleted')
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    UNIQUE(topic_id, revision)
  );
  CREATE TABLE IF NOT EXISTS topic_occurrences (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE RESTRICT,
    topic_revision_id TEXT NOT NULL REFERENCES topic_revisions(id) ON DELETE RESTRICT,
    analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    legacy_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    occurrence_key TEXT NOT NULL UNIQUE CHECK(
      typeof(occurrence_key) = 'text' AND length(occurrence_key) = 64
      AND occurrence_key NOT GLOB '*[^0-9a-f]*'
    ),
    candidate_item_fingerprint TEXT NOT NULL CHECK(
      typeof(candidate_item_fingerprint) = 'text' AND length(candidate_item_fingerprint) = 64
      AND candidate_item_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    CHECK((analysis_input_id IS NULL) <> (legacy_session_id IS NULL))
  );
  CREATE TABLE IF NOT EXISTS topic_merge_suggestions (
    id TEXT PRIMARY KEY,
    left_topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE RESTRICT,
    right_topic_id TEXT NOT NULL REFERENCES topics_v2(id) ON DELETE RESTRICT,
    pair_key TEXT NOT NULL UNIQUE CHECK(
      typeof(pair_key) = 'text' AND length(pair_key) = 64
      AND pair_key NOT GLOB '*[^0-9a-f]*'
    ),
    algorithm_version TEXT NOT NULL CHECK(
      typeof(algorithm_version) = 'text' AND algorithm_version = 'dice-bigram-v1'
    ),
    score REAL NOT NULL CHECK(typeof(score) IN ('integer','real') AND score BETWEEN 0 AND 1),
    state TEXT NOT NULL CHECK(typeof(state) = 'text' AND state IN ('proposed','accepted','dismissed')),
    decided_at INTEGER CHECK(
      decided_at IS NULL OR (typeof(decided_at) = 'integer' AND decided_at >= 0)
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),
    UNIQUE(left_topic_id, right_topic_id, algorithm_version),
    CHECK(left_topic_id < right_topic_id),
    CHECK((state = 'proposed' AND decided_at IS NULL) OR (state <> 'proposed' AND decided_at IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS todos_v2 (
    id TEXT PRIMARY KEY,
    canonical_base_key TEXT NOT NULL CHECK(
      typeof(canonical_base_key) = 'text' AND length(canonical_base_key) = 64
      AND canonical_base_key NOT GLOB '*[^0-9a-f]*'
    ),
    instance_key TEXT NOT NULL UNIQUE CHECK(
      typeof(instance_key) = 'text' AND length(instance_key) = 64
      AND instance_key NOT GLOB '*[^0-9a-f]*'
    ),
    title TEXT NOT NULL CHECK(typeof(title) = 'text' AND length(trim(title)) > 0),
    owner_subject_kind TEXT CHECK(
      owner_subject_kind IS NULL OR (
        typeof(owner_subject_kind) = 'text'
        AND owner_subject_kind IN ('person','speaker_cluster')
      )
    ),
    owner_subject_id TEXT CHECK(
      owner_subject_id IS NULL OR (typeof(owner_subject_id) = 'text' AND length(owner_subject_id) > 0)
    ),
    status TEXT NOT NULL CHECK(typeof(status) = 'text' AND status IN ('open','completed','dismissed')),
    completed_at INTEGER CHECK(
      completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= 0)
    ),
    dismissed_at INTEGER CHECK(
      dismissed_at IS NULL OR (typeof(dismissed_at) = 'integer' AND dismissed_at >= 0)
    ),
    recurrence_of_id TEXT REFERENCES todos_v2(id) ON DELETE SET NULL,
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    provenance TEXT NOT NULL CHECK(
      typeof(provenance) = 'text'
      AND provenance IN ('evidence_linked','legacy_unverified','suggestion','source_deleted')
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),
    CHECK((owner_subject_kind IS NULL) = (owner_subject_id IS NULL)),
    CHECK(
      (status = 'open' AND completed_at IS NULL AND dismissed_at IS NULL)
      OR (status = 'completed' AND completed_at IS NOT NULL AND dismissed_at IS NULL)
      OR (status = 'dismissed' AND dismissed_at IS NOT NULL AND completed_at IS NULL)
    ),
    CHECK(recurrence_of_id IS NULL OR recurrence_of_id <> id)
  );
  CREATE TABLE IF NOT EXISTS todo_revisions (
    id TEXT PRIMARY KEY,
    todo_instance_id TEXT NOT NULL REFERENCES todos_v2(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
    previous_revision_id TEXT REFERENCES todo_revisions(id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK(typeof(title) = 'text' AND length(trim(title)) > 0),
    due_text TEXT CHECK(due_text IS NULL OR typeof(due_text) = 'text'),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    provenance TEXT NOT NULL CHECK(
      typeof(provenance) = 'text'
      AND provenance IN ('evidence_linked','legacy_unverified','suggestion','source_deleted')
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    UNIQUE(todo_instance_id, revision)
  );
  CREATE TABLE IF NOT EXISTS todo_occurrences (
    id TEXT PRIMARY KEY,
    todo_instance_id TEXT NOT NULL REFERENCES todos_v2(id) ON DELETE RESTRICT,
    todo_revision_id TEXT NOT NULL REFERENCES todo_revisions(id) ON DELETE RESTRICT,
    analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    legacy_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    occurrence_key TEXT NOT NULL UNIQUE CHECK(
      typeof(occurrence_key) = 'text' AND length(occurrence_key) = 64
      AND occurrence_key NOT GLOB '*[^0-9a-f]*'
    ),
    candidate_item_fingerprint TEXT NOT NULL CHECK(
      typeof(candidate_item_fingerprint) = 'text' AND length(candidate_item_fingerprint) = 64
      AND candidate_item_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    started_at INTEGER,
    ended_at INTEGER,
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    CHECK((analysis_input_id IS NULL) <> (legacy_session_id IS NULL)),
    CHECK(
      (started_at IS NULL AND ended_at IS NULL)
      OR (
        typeof(started_at) = 'integer' AND typeof(ended_at) = 'integer'
        AND started_at >= 0 AND ended_at >= started_at
      )
    )
  );
  CREATE TABLE IF NOT EXISTS todo_state_transitions (
    id TEXT PRIMARY KEY,
    todo_instance_id TEXT NOT NULL REFERENCES todos_v2(id) ON DELETE RESTRICT,
    from_status TEXT CHECK(
      from_status IS NULL OR (typeof(from_status) = 'text' AND from_status IN ('open','completed','dismissed'))
    ),
    to_status TEXT NOT NULL CHECK(
      typeof(to_status) = 'text' AND to_status IN ('open','completed','dismissed')
    ),
    reason TEXT NOT NULL CHECK(
      typeof(reason) = 'text'
      AND reason IN ('analysis_created','user_action','suggestion_acceptance','recurrence')
    ),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    actor TEXT NOT NULL CHECK(typeof(actor) = 'text' AND actor IN ('system','user')),
    occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at) = 'integer' AND occurred_at >= 0),
    CHECK(from_status IS NULL OR from_status <> to_status)
  );
  CREATE TABLE IF NOT EXISTS todo_recurrences (
    id TEXT PRIMARY KEY,
    previous_todo_id TEXT NOT NULL UNIQUE REFERENCES todos_v2(id) ON DELETE RESTRICT,
    next_todo_id TEXT NOT NULL UNIQUE REFERENCES todos_v2(id) ON DELETE RESTRICT,
    source_occurrence_id TEXT UNIQUE REFERENCES todo_occurrences(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    CHECK(previous_todo_id <> next_todo_id)
  );

  CREATE TABLE IF NOT EXISTS suggestions_v2 (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE CHECK(
      typeof(canonical_key) = 'text' AND length(canonical_key) = 64
      AND canonical_key NOT GLOB '*[^0-9a-f]*'
    ),
    title TEXT NOT NULL CHECK(typeof(title) = 'text' AND length(trim(title)) > 0),
    rationale TEXT NOT NULL CHECK(typeof(rationale) = 'text' AND length(trim(rationale)) > 0),
    state TEXT NOT NULL CHECK(typeof(state) = 'text' AND state IN ('proposed','accepted','dismissed')),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
    provenance TEXT NOT NULL CHECK(
      typeof(provenance) = 'text'
      AND provenance IN ('suggestion','legacy_unverified','source_deleted')
    ),
    decided_at INTEGER CHECK(
      decided_at IS NULL OR (typeof(decided_at) = 'integer' AND decided_at >= 0)
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),
    CHECK((state = 'proposed' AND decided_at IS NULL) OR (state <> 'proposed' AND decided_at IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS suggestion_occurrences (
    id TEXT PRIMARY KEY,
    suggestion_id TEXT NOT NULL REFERENCES suggestions_v2(id) ON DELETE RESTRICT,
    analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    legacy_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    occurrence_key TEXT NOT NULL UNIQUE CHECK(
      typeof(occurrence_key) = 'text' AND length(occurrence_key) = 64
      AND occurrence_key NOT GLOB '*[^0-9a-f]*'
    ),
    candidate_item_fingerprint TEXT NOT NULL CHECK(
      typeof(candidate_item_fingerprint) = 'text' AND length(candidate_item_fingerprint) = 64
      AND candidate_item_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    CHECK((analysis_input_id IS NULL) <> (legacy_session_id IS NULL))
  );
  CREATE TABLE IF NOT EXISTS suggestion_acceptances (
    suggestion_id TEXT PRIMARY KEY REFERENCES suggestions_v2(id) ON DELETE RESTRICT,
    todo_instance_id TEXT NOT NULL UNIQUE REFERENCES todos_v2(id) ON DELETE RESTRICT,
    user_action_id TEXT NOT NULL UNIQUE CHECK(
      typeof(user_action_id) = 'text' AND length(trim(user_action_id)) > 0
    ),
    actor TEXT NOT NULL CHECK(typeof(actor) = 'text' AND actor = 'user'),
    accepted_at INTEGER NOT NULL CHECK(typeof(accepted_at) = 'integer' AND accepted_at >= 0)
  );

  CREATE TABLE IF NOT EXISTS session_summary_revisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
    previous_revision_id TEXT REFERENCES session_summary_revisions(id) ON DELETE RESTRICT,
    completeness TEXT NOT NULL CHECK(
      typeof(completeness) = 'text' AND completeness IN ('incremental','final')
    ),
    lifecycle TEXT NOT NULL CHECK(
      typeof(lifecycle) = 'text' AND lifecycle IN ('active','superseded')
    ),
    content_json TEXT NOT NULL CHECK(typeof(content_json) = 'text' AND json_valid(content_json)),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    provenance TEXT NOT NULL CHECK(
      typeof(provenance) = 'text' AND provenance IN ('evidence_linked','legacy_unverified')
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    UNIQUE(session_id, revision)
  );

  CREATE TABLE IF NOT EXISTS daily_digests (
    id TEXT PRIMARY KEY,
    local_date TEXT NOT NULL CHECK(
      typeof(local_date) = 'text' AND length(local_date) = 10
      AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    timezone TEXT NOT NULL CHECK(typeof(timezone) = 'text' AND length(trim(timezone)) > 0),
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
    completeness TEXT NOT NULL CHECK(typeof(completeness) = 'text' AND completeness IN ('partial','final')),
    lifecycle TEXT NOT NULL CHECK(typeof(lifecycle) = 'text' AND lifecycle IN ('active','superseded')),
    input_watermark_json TEXT NOT NULL CHECK(
      typeof(input_watermark_json) = 'text' AND json_valid(input_watermark_json)
    ),
    content_json TEXT NOT NULL CHECK(typeof(content_json) = 'text' AND json_valid(content_json)),
    previous_revision_id TEXT REFERENCES daily_digests(id) ON DELETE RESTRICT,
    source_hash TEXT NOT NULL CHECK(
      typeof(source_hash) = 'text' AND length(source_hash) = 64
      AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),
    UNIQUE(local_date, timezone, revision),
    UNIQUE(local_date, timezone, source_hash)
  );

  CREATE TABLE IF NOT EXISTS evidence_refs (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(
      typeof(entity_type) = 'text' AND entity_type IN (
        'memory_occurrence','topic_occurrence','todo_occurrence',
        'session_summary_revision','daily_digest','suggestion_occurrence'
      )
    ),
    entity_id TEXT NOT NULL CHECK(typeof(entity_id) = 'text' AND length(entity_id) > 0),
    source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    transcript_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    audio_chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
    track_id TEXT REFERENCES audio_tracks(id) ON DELETE SET NULL,
    started_at INTEGER NOT NULL CHECK(typeof(started_at) = 'integer' AND started_at >= 0),
    ended_at INTEGER NOT NULL CHECK(typeof(ended_at) = 'integer' AND ended_at >= started_at),
    quote_text TEXT NOT NULL CHECK(typeof(quote_text) = 'text' AND length(quote_text) > 0),
    audio_state TEXT NOT NULL CHECK(
      typeof(audio_state) = 'text' AND audio_state IN ('available','expired','missing')
    ),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    CHECK(
      (audio_state = 'missing' AND audio_chunk_id IS NULL)
      OR (audio_state IN ('available','expired') AND audio_chunk_id IS NOT NULL)
    ),
    UNIQUE(entity_type, entity_id, transcript_segment_id, started_at, ended_at)
  );

  CREATE TABLE IF NOT EXISTS legacy_import_runs (
    id TEXT PRIMARY KEY,
    importer_version TEXT NOT NULL CHECK(
      typeof(importer_version) = 'text' AND length(trim(importer_version)) > 0
    ),
    status TEXT NOT NULL CHECK(typeof(status) = 'text' AND status IN ('running','completed','failed')),
    started_at INTEGER NOT NULL CHECK(typeof(started_at) = 'integer' AND started_at >= 0),
    completed_at INTEGER CHECK(
      completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= started_at)
    ),
    imported_row_count INTEGER NOT NULL DEFAULT 0 CHECK(
      typeof(imported_row_count) = 'integer' AND imported_row_count >= 0
    ),
    CHECK((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS legacy_import_map (
    source_table TEXT NOT NULL CHECK(typeof(source_table) = 'text' AND length(trim(source_table)) > 0),
    source_key TEXT NOT NULL CHECK(typeof(source_key) = 'text' AND length(source_key) > 0),
    source_fingerprint TEXT NOT NULL CHECK(
      typeof(source_fingerprint) = 'text' AND length(source_fingerprint) = 64
      AND source_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    target_entity_type TEXT NOT NULL CHECK(
      typeof(target_entity_type) = 'text'
      AND target_entity_type IN ('memory','topic','todo','session_summary','suggestion','evidence')
    ),
    target_entity_id TEXT NOT NULL CHECK(
      typeof(target_entity_id) = 'text' AND length(target_entity_id) > 0
    ),
    import_run_id TEXT NOT NULL REFERENCES legacy_import_runs(id) ON DELETE RESTRICT,
    imported_at INTEGER NOT NULL CHECK(typeof(imported_at) = 'integer' AND imported_at >= 0),
    PRIMARY KEY(source_table, source_key, source_fingerprint)
  );

  CREATE INDEX IF NOT EXISTS idx_analysis_inputs_session_created
  ON analysis_inputs(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_items_slot_lifecycle
  ON memory_items_v2(canonical_slot_key, lifecycle);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_conflict_groups_open_slot
  ON memory_conflict_groups(slot_key)
  WHERE state = 'open';
  CREATE INDEX IF NOT EXISTS idx_memory_occurrences_value_created
  ON memory_occurrences(memory_value_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_occurrences_input_candidate
  ON memory_occurrences(analysis_input_id, candidate_item_fingerprint)
  WHERE analysis_input_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_topic_occurrences_topic_created
  ON topic_occurrences(topic_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_occurrences_input_candidate
  ON topic_occurrences(analysis_input_id, candidate_item_fingerprint)
  WHERE analysis_input_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_todo_occurrences_todo_created
  ON todo_occurrences(todo_instance_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_occurrences_input_candidate
  ON todo_occurrences(analysis_input_id, candidate_item_fingerprint)
  WHERE analysis_input_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestion_occurrences_input_candidate
  ON suggestion_occurrences(analysis_input_id, candidate_item_fingerprint)
  WHERE analysis_input_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_evidence_refs_entity
  ON evidence_refs(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_evidence_refs_audio_state
  ON evidence_refs(audio_chunk_id, audio_state)
  WHERE audio_chunk_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_daily_digests_date_timezone
  ON daily_digests(local_date, timezone, revision DESC);

  CREATE TRIGGER IF NOT EXISTS analysis_inputs_immutable_update
  BEFORE UPDATE OF id, session_id, transcript_revision, identity_revision, prompt_version,
    input_hash, input_contract_version, redaction_version, cloud_payload_json,
    cloud_payload_bytes, cloud_payload_sha256, created_at
  ON analysis_inputs
  BEGIN
    SELECT RAISE(ABORT, 'analysis input is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_inputs_candidate_cas
  BEFORE UPDATE OF candidate_hash, applied_at ON analysis_inputs
  WHEN NOT (
    OLD.candidate_hash IS NULL AND OLD.applied_at IS NULL
    AND NEW.candidate_hash IS NOT NULL AND NEW.applied_at IS NOT NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'analysis input candidate CAS is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_inputs_immutable_delete
  BEFORE DELETE ON analysis_inputs
  WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
  BEGIN
    SELECT RAISE(ABORT, 'analysis input is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_segments_immutable_update
  BEFORE UPDATE ON analysis_input_segments
  BEGIN
    SELECT RAISE(ABORT, 'analysis input manifest is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_segments_immutable_delete
  BEFORE DELETE ON analysis_input_segments
  WHEN EXISTS (
    SELECT 1
    FROM analysis_inputs AS input
    JOIN sessions AS session ON session.id = input.session_id
    WHERE input.id = OLD.analysis_input_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'analysis input manifest is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_speaker_bindings_immutable_update
  BEFORE UPDATE ON analysis_input_speaker_bindings
  BEGIN
    SELECT RAISE(ABORT, 'analysis input speaker bindings are immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_speaker_bindings_immutable_delete
  BEFORE DELETE ON analysis_input_speaker_bindings
  WHEN EXISTS (
    SELECT 1
    FROM analysis_inputs AS input
    JOIN sessions AS session ON session.id = input.session_id
    WHERE input.id = OLD.analysis_input_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'analysis input speaker bindings are immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_speaker_bindings_validate_target
  BEFORE INSERT ON analysis_input_speaker_bindings
  WHEN length(trim(NEW.subject_display_name_snapshot)) > 0 AND NOT (
    (
      NEW.subject_kind = 'person'
      AND (
        (
          NEW.label = 'SELF'
          AND EXISTS (
            SELECT 1
            FROM people
            WHERE id = NEW.subject_id
              AND is_self = 1
              AND display_name = NEW.subject_display_name_snapshot
          )
        )
        OR (
          NEW.label <> 'SELF'
          AND EXISTS (
            SELECT 1
            FROM people
            WHERE id = NEW.subject_id
              AND is_self = 0
              AND display_name = NEW.subject_display_name_snapshot
          )
          AND EXISTS (
            SELECT 1
            FROM speaker_clusters AS cluster
            JOIN analysis_inputs AS input ON input.id = NEW.analysis_input_id
            WHERE cluster.session_id = input.session_id
              AND cluster.person_id = NEW.subject_id
              AND cluster.link_state = 'confirmed'
          )
        )
      )
    )
    OR (
      NEW.subject_kind = 'speaker_cluster'
      AND NEW.label <> 'SELF'
      AND EXISTS (
        SELECT 1
        FROM speaker_clusters AS cluster
        JOIN analysis_inputs AS input ON input.id = NEW.analysis_input_id
        WHERE cluster.id = NEW.subject_id
          AND cluster.session_id = input.session_id
          AND cluster.local_label = NEW.subject_display_name_snapshot
      )
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'analysis input speaker binding target is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_segments_validate_source
  BEFORE INSERT ON analysis_input_segments
  WHEN NOT EXISTS (
    SELECT 1
    FROM analysis_inputs AS input
    JOIN transcript_segments AS segment ON segment.id = NEW.segment_id
    WHERE input.id = NEW.analysis_input_id
      AND segment.session_id = input.session_id
      AND segment.result_kind = 'final'
      AND segment.is_stable = 1
      AND segment.superseded_by IS NULL
      AND segment.duplicate_of IS NULL
      AND segment.version = NEW.segment_version
      AND segment.text = NEW.text_snapshot
  )
  BEGIN
    SELECT RAISE(ABORT, 'analysis input segment is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_segments_validate_ordinal
  BEFORE INSERT ON analysis_input_segments
  WHEN NEW.ordinal <> (
    SELECT count(*) FROM analysis_input_segments
    WHERE analysis_input_id = NEW.analysis_input_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'analysis input segment ordinal is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_segments_protect_source_update
  BEFORE UPDATE OF session_id, started_at, ended_at, speaker_label, text, is_stable,
    track_id, chunk_id, result_kind, version, superseded_by, duplicate_of
  ON transcript_segments
  WHEN EXISTS (
    SELECT 1 FROM analysis_input_segments WHERE segment_id = OLD.id
  )
  BEGIN
    SELECT RAISE(ABORT, 'manifested transcript segment is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_input_segments_protect_source_delete
  BEFORE DELETE ON transcript_segments
  WHEN EXISTS (
    SELECT 1
    FROM analysis_input_segments AS manifest
    JOIN analysis_inputs AS input ON input.id = manifest.analysis_input_id
    JOIN sessions AS session ON session.id = input.session_id
    WHERE manifest.segment_id = OLD.id
  )
  BEGIN
    SELECT RAISE(ABORT, 'manifested transcript segment is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_items_v2_source_deleted
  AFTER UPDATE OF source_analysis_input_id ON memory_items_v2
  WHEN OLD.source_analysis_input_id IS NOT NULL AND NEW.source_analysis_input_id IS NULL
  BEGIN
    UPDATE memory_items_v2 SET provenance = 'source_deleted' WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS topics_v2_source_deleted
  AFTER UPDATE OF source_analysis_input_id ON topics_v2
  WHEN OLD.source_analysis_input_id IS NOT NULL AND NEW.source_analysis_input_id IS NULL
  BEGIN
    UPDATE topics_v2 SET provenance = 'source_deleted' WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS topic_revisions_source_deleted
  AFTER UPDATE OF source_analysis_input_id ON topic_revisions
  WHEN OLD.source_analysis_input_id IS NOT NULL AND NEW.source_analysis_input_id IS NULL
  BEGIN
    UPDATE topic_revisions SET provenance = 'source_deleted' WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS todos_v2_source_deleted
  AFTER UPDATE OF source_analysis_input_id ON todos_v2
  WHEN OLD.source_analysis_input_id IS NOT NULL AND NEW.source_analysis_input_id IS NULL
  BEGIN
    UPDATE todos_v2 SET provenance = 'source_deleted' WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS todo_revisions_source_deleted
  AFTER UPDATE OF source_analysis_input_id ON todo_revisions
  WHEN OLD.source_analysis_input_id IS NOT NULL AND NEW.source_analysis_input_id IS NULL
  BEGIN
    UPDATE todo_revisions SET provenance = 'source_deleted' WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS suggestions_v2_source_deleted
  AFTER UPDATE OF source_analysis_input_id ON suggestions_v2
  WHEN OLD.source_analysis_input_id IS NOT NULL AND NEW.source_analysis_input_id IS NULL
  BEGIN
    UPDATE suggestions_v2 SET provenance = 'source_deleted' WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS memory_items_v2_immutable_content
  BEFORE UPDATE OF id, kind, canonical_slot_key, canonical_value_key, title, body,
    confidence, created_at ON memory_items_v2
  BEGIN
    SELECT RAISE(ABORT, 'memory item content is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_items_v2_source_guard
  BEFORE UPDATE OF source_analysis_input_id ON memory_items_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NOT NULL
    AND NEW.source_analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.source_analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory item source is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_items_v2_provenance_guard
  BEFORE UPDATE OF provenance ON memory_items_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NULL
    AND OLD.provenance = 'evidence_linked'
    AND NEW.provenance = 'source_deleted'
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory item provenance is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_items_v2_terminal_lifecycle
  BEFORE UPDATE OF lifecycle ON memory_items_v2
  WHEN NEW.lifecycle IS NOT OLD.lifecycle AND NOT (
    (
      OLD.lifecycle = 'active'
      AND NEW.lifecycle IN ('conflict','superseded','dismissed')
    )
    OR (
      OLD.lifecycle = 'conflict'
      AND NEW.lifecycle = 'active'
      AND EXISTS (
        SELECT 1
        FROM memory_conflict_groups AS conflict
        WHERE conflict.slot_key = OLD.canonical_slot_key
          AND conflict.state = 'resolved'
          AND conflict.selected_member_id = OLD.id
          AND conflict.episode = (
            SELECT MAX(latest.episode)
            FROM memory_conflict_groups AS latest
            WHERE latest.slot_key = OLD.canonical_slot_key
          )
      )
    )
    OR (
      OLD.lifecycle = 'conflict'
      AND NEW.lifecycle = 'superseded'
      AND EXISTS (
        SELECT 1
        FROM memory_conflict_groups AS conflict
        JOIN memory_conflict_members AS member
          ON member.group_id = conflict.id AND member.memory_item_id = OLD.id
        JOIN memory_supersessions AS supersession
          ON supersession.previous_id = OLD.id
          AND supersession.next_id = conflict.selected_member_id
          AND supersession.reason = 'conflict_resolution'
        WHERE conflict.slot_key = OLD.canonical_slot_key
          AND conflict.state = 'resolved'
          AND conflict.selected_member_id <> OLD.id
          AND conflict.episode = (
            SELECT MAX(latest.episode)
            FROM memory_conflict_groups AS latest
            WHERE latest.slot_key = OLD.canonical_slot_key
          )
      )
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory item lifecycle transition is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS topics_v2_immutable_content
  BEFORE UPDATE OF id, canonical_key, name, canonical_algorithm, created_at ON topics_v2
  BEGIN
    SELECT RAISE(ABORT, 'topic identity is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topics_v2_source_guard
  BEFORE UPDATE OF source_analysis_input_id ON topics_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NOT NULL
    AND NEW.source_analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.source_analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic source is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topics_v2_provenance_guard
  BEFORE UPDATE OF provenance ON topics_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NULL
    AND OLD.provenance = 'evidence_linked'
    AND NEW.provenance = 'source_deleted'
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic provenance is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topics_v2_terminal_lifecycle
  BEFORE UPDATE OF lifecycle ON topics_v2
  WHEN OLD.lifecycle <> 'active' AND NEW.lifecycle IS NOT OLD.lifecycle
  BEGIN
    SELECT RAISE(ABORT, 'topic lifecycle is terminal');
  END;
  CREATE TRIGGER IF NOT EXISTS todos_v2_immutable_content
  BEFORE UPDATE OF id, canonical_base_key, instance_key, title, owner_subject_kind,
    owner_subject_id, recurrence_of_id, created_at ON todos_v2
  BEGIN
    SELECT RAISE(ABORT, 'todo content is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todos_v2_source_guard
  BEFORE UPDATE OF source_analysis_input_id ON todos_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NOT NULL
    AND NEW.source_analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.source_analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo source is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todos_v2_provenance_guard
  BEFORE UPDATE OF provenance ON todos_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NULL
    AND OLD.provenance IN ('evidence_linked','suggestion')
    AND NEW.provenance = 'source_deleted'
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo provenance is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestions_v2_immutable_content
  BEFORE UPDATE OF id, canonical_key, title, rationale, created_at ON suggestions_v2
  BEGIN
    SELECT RAISE(ABORT, 'suggestion content is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestions_v2_source_guard
  BEFORE UPDATE OF source_analysis_input_id ON suggestions_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NOT NULL
    AND NEW.source_analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.source_analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'suggestion source is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestions_v2_provenance_guard
  BEFORE UPDATE OF provenance ON suggestions_v2
  WHEN NOT (
    OLD.source_analysis_input_id IS NULL
    AND OLD.provenance = 'suggestion'
    AND NEW.provenance = 'source_deleted'
  )
  BEGIN
    SELECT RAISE(ABORT, 'suggestion provenance is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS memory_items_v2_no_delete
  BEFORE DELETE ON memory_items_v2
  BEGIN
    SELECT RAISE(ABORT, 'memory item cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_occurrences_immutable_update
  BEFORE UPDATE ON memory_occurrences
  BEGIN
    SELECT RAISE(ABORT, 'memory occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_occurrences_immutable_delete
  BEFORE DELETE ON memory_occurrences
  WHEN EXISTS (
    SELECT 1
    FROM analysis_inputs AS input
    JOIN sessions AS session ON session.id = input.session_id
    WHERE input.id = OLD.analysis_input_id
  ) OR EXISTS (
    SELECT 1 FROM sessions WHERE id = OLD.legacy_session_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_supersessions_immutable_update
  BEFORE UPDATE OF previous_id, next_id, reason, created_at ON memory_supersessions
  BEGIN
    SELECT RAISE(ABORT, 'memory supersession is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_supersessions_source_clear
  BEFORE UPDATE OF analysis_input_id ON memory_supersessions
  WHEN NOT (
    OLD.analysis_input_id IS NOT NULL
    AND NEW.analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory supersession source can only be cleared when its input is deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_supersessions_immutable_delete
  BEFORE DELETE ON memory_supersessions
  BEGIN
    SELECT RAISE(ABORT, 'memory supersession is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_groups_no_delete
  BEFORE DELETE ON memory_conflict_groups
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict group cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_groups_immutable_identity
  BEFORE UPDATE OF id, slot_key, episode, created_at ON memory_conflict_groups
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict identity is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_members_immutable_update
  BEFORE UPDATE ON memory_conflict_members
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict membership is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_members_immutable_delete
  BEFORE DELETE ON memory_conflict_members
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict membership is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS topics_v2_no_delete
  BEFORE DELETE ON topics_v2
  BEGIN
    SELECT RAISE(ABORT, 'topic cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_revisions_immutable_update
  BEFORE UPDATE OF id, topic_id, revision, previous_revision_id, summary, created_at
  ON topic_revisions
  BEGIN
    SELECT RAISE(ABORT, 'topic revision is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_revisions_source_guard
  BEFORE UPDATE OF source_analysis_input_id ON topic_revisions
  WHEN NOT (
    OLD.source_analysis_input_id IS NOT NULL
    AND NEW.source_analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.source_analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic revision source is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_revisions_provenance_guard
  BEFORE UPDATE OF provenance ON topic_revisions
  WHEN NOT (
    OLD.source_analysis_input_id IS NULL
    AND OLD.provenance = 'evidence_linked'
    AND NEW.provenance = 'source_deleted'
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic revision provenance is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_revisions_immutable_delete
  BEFORE DELETE ON topic_revisions
  BEGIN
    SELECT RAISE(ABORT, 'topic revision is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_occurrences_immutable_update
  BEFORE UPDATE ON topic_occurrences
  BEGIN
    SELECT RAISE(ABORT, 'topic occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_occurrences_immutable_delete
  BEFORE DELETE ON topic_occurrences
  WHEN EXISTS (
    SELECT 1
    FROM analysis_inputs AS input
    JOIN sessions AS session ON session.id = input.session_id
    WHERE input.id = OLD.analysis_input_id
  ) OR EXISTS (
    SELECT 1 FROM sessions WHERE id = OLD.legacy_session_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_merge_suggestions_immutable_identity
  BEFORE UPDATE OF id, left_topic_id, right_topic_id, pair_key, algorithm_version, score, created_at
  ON topic_merge_suggestions
  BEGIN
    SELECT RAISE(ABORT, 'topic merge suggestion identity is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_merge_suggestions_terminal_state
  BEFORE UPDATE OF state, decided_at ON topic_merge_suggestions
  WHEN OLD.state IN ('accepted','dismissed') AND (
    NEW.state IS NOT OLD.state OR NEW.decided_at IS NOT OLD.decided_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic merge suggestion terminal state is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_merge_suggestions_no_delete
  BEFORE DELETE ON topic_merge_suggestions
  BEGIN
    SELECT RAISE(ABORT, 'topic merge suggestion cannot be deleted');
  END;

  CREATE TRIGGER IF NOT EXISTS todos_v2_no_delete
  BEFORE DELETE ON todos_v2
  BEGIN
    SELECT RAISE(ABORT, 'todo cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_revisions_immutable_update
  BEFORE UPDATE OF id, todo_instance_id, revision, previous_revision_id, title, due_text, created_at
  ON todo_revisions
  BEGIN
    SELECT RAISE(ABORT, 'todo revision is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_revisions_source_guard
  BEFORE UPDATE OF source_analysis_input_id ON todo_revisions
  WHEN NOT (
    OLD.source_analysis_input_id IS NOT NULL
    AND NEW.source_analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.source_analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo revision source is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_revisions_provenance_guard
  BEFORE UPDATE OF provenance ON todo_revisions
  WHEN NOT (
    OLD.source_analysis_input_id IS NULL
    AND OLD.provenance IN ('evidence_linked','suggestion')
    AND NEW.provenance = 'source_deleted'
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo revision provenance is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_revisions_immutable_delete
  BEFORE DELETE ON todo_revisions
  BEGIN
    SELECT RAISE(ABORT, 'todo revision is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_occurrences_immutable_update
  BEFORE UPDATE ON todo_occurrences
  BEGIN
    SELECT RAISE(ABORT, 'todo occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_occurrences_immutable_delete
  BEFORE DELETE ON todo_occurrences
  WHEN EXISTS (
    SELECT 1
    FROM analysis_inputs AS input
    JOIN sessions AS session ON session.id = input.session_id
    WHERE input.id = OLD.analysis_input_id
  ) OR EXISTS (
    SELECT 1 FROM sessions WHERE id = OLD.legacy_session_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_state_transitions_immutable_update
  BEFORE UPDATE OF id, todo_instance_id, from_status, to_status, reason, actor, occurred_at
  ON todo_state_transitions
  BEGIN
    SELECT RAISE(ABORT, 'todo state transition is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_state_transitions_source_clear
  BEFORE UPDATE OF source_analysis_input_id ON todo_state_transitions
  WHEN NOT (
    OLD.source_analysis_input_id IS NOT NULL
    AND NEW.source_analysis_input_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM analysis_inputs WHERE id = OLD.source_analysis_input_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo state transition source can only be cleared when its input is deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_state_transitions_immutable_delete
  BEFORE DELETE ON todo_state_transitions
  BEGIN
    SELECT RAISE(ABORT, 'todo state transition is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_recurrences_immutable_update
  BEFORE UPDATE OF id, previous_todo_id, next_todo_id, created_at ON todo_recurrences
  BEGIN
    SELECT RAISE(ABORT, 'todo recurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_recurrences_source_clear
  BEFORE UPDATE OF source_occurrence_id ON todo_recurrences
  WHEN NOT (
    OLD.source_occurrence_id IS NOT NULL
    AND NEW.source_occurrence_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM todo_occurrences WHERE id = OLD.source_occurrence_id)
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo recurrence source can only be cleared when its occurrence is deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_recurrences_immutable_delete
  BEFORE DELETE ON todo_recurrences
  BEGIN
    SELECT RAISE(ABORT, 'todo recurrence is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS suggestions_v2_no_delete
  BEFORE DELETE ON suggestions_v2
  BEGIN
    SELECT RAISE(ABORT, 'suggestion cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestion_occurrences_immutable_update
  BEFORE UPDATE ON suggestion_occurrences
  BEGIN
    SELECT RAISE(ABORT, 'suggestion occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestion_occurrences_immutable_delete
  BEFORE DELETE ON suggestion_occurrences
  WHEN EXISTS (
    SELECT 1
    FROM analysis_inputs AS input
    JOIN sessions AS session ON session.id = input.session_id
    WHERE input.id = OLD.analysis_input_id
  ) OR EXISTS (
    SELECT 1 FROM sessions WHERE id = OLD.legacy_session_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'suggestion occurrence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestion_acceptances_immutable_update
  BEFORE UPDATE ON suggestion_acceptances
  BEGIN
    SELECT RAISE(ABORT, 'suggestion acceptance is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestion_acceptances_immutable_delete
  BEFORE DELETE ON suggestion_acceptances
  BEGIN
    SELECT RAISE(ABORT, 'suggestion acceptance is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS session_summary_revisions_immutable_content
  BEFORE UPDATE OF id, session_id, revision, previous_revision_id, completeness, content_json,
    source_analysis_input_id, provenance, created_at
  ON session_summary_revisions
  BEGIN
    SELECT RAISE(ABORT, 'session summary revision is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS session_summary_revisions_terminal_lifecycle
  BEFORE UPDATE OF lifecycle ON session_summary_revisions
  WHEN OLD.lifecycle = 'superseded' AND NEW.lifecycle IS NOT OLD.lifecycle
  BEGIN
    SELECT RAISE(ABORT, 'session summary lifecycle is terminal');
  END;
  CREATE TRIGGER IF NOT EXISTS session_summary_revisions_immutable_delete
  BEFORE DELETE ON session_summary_revisions
  WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
  BEGIN
    SELECT RAISE(ABORT, 'session summary revision is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS daily_digests_immutable_content
  BEFORE UPDATE OF id, local_date, timezone, revision, completeness, input_watermark_json,
    content_json, previous_revision_id, source_hash, created_at
  ON daily_digests
  BEGIN
    SELECT RAISE(ABORT, 'daily digest revision is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS daily_digests_terminal_lifecycle
  BEFORE UPDATE OF lifecycle ON daily_digests
  WHEN OLD.lifecycle = 'superseded' AND NEW.lifecycle IS NOT OLD.lifecycle
  BEGIN
    SELECT RAISE(ABORT, 'daily digest lifecycle is terminal');
  END;
  CREATE TRIGGER IF NOT EXISTS daily_digests_no_delete
  BEFORE DELETE ON daily_digests
  BEGIN
    SELECT RAISE(ABORT, 'daily digest revision cannot be deleted');
  END;

  CREATE TRIGGER IF NOT EXISTS evidence_refs_immutable_update
  BEFORE UPDATE OF id, entity_type, entity_id, source_analysis_input_id, session_id,
    transcript_segment_id, audio_chunk_id, track_id, started_at, ended_at, quote_text, created_at
  ON evidence_refs
  BEGIN
    SELECT RAISE(ABORT, 'evidence reference is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS evidence_refs_audio_state_transition
  BEFORE UPDATE OF audio_state ON evidence_refs
  WHEN NOT (
    OLD.audio_state = 'available' AND NEW.audio_state = 'expired'
    AND EXISTS (
      SELECT 1 FROM audio_chunks
      WHERE id = NEW.audio_chunk_id AND deleted_at IS NOT NULL
    )
  ) AND NOT (
    OLD.audio_state IN ('available','expired') AND NEW.audio_state = 'missing'
    AND NEW.audio_chunk_id IS NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'evidence audio state transition is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS evidence_refs_immutable_delete
  BEFORE DELETE ON evidence_refs
  WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
  BEGIN
    SELECT RAISE(ABORT, 'evidence reference is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS topic_revisions_validate_predecessor
  BEFORE INSERT ON topic_revisions
  WHEN (
    NEW.revision = 1 AND NEW.previous_revision_id IS NOT NULL
  ) OR (
    NEW.revision > 1 AND NOT EXISTS (
      SELECT 1 FROM topic_revisions AS previous
      WHERE previous.id = NEW.previous_revision_id
        AND previous.topic_id = NEW.topic_id
        AND previous.revision = NEW.revision - 1
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic revision predecessor is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS topic_occurrences_validate_revision_owner
  BEFORE INSERT ON topic_occurrences
  WHEN NOT EXISTS (
    SELECT 1 FROM topic_revisions
    WHERE id = NEW.topic_revision_id AND topic_id = NEW.topic_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'topic occurrence revision owner is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_revisions_validate_predecessor
  BEFORE INSERT ON todo_revisions
  WHEN (
    NEW.revision = 1 AND NEW.previous_revision_id IS NOT NULL
  ) OR (
    NEW.revision > 1 AND NOT EXISTS (
      SELECT 1 FROM todo_revisions AS previous
      WHERE previous.id = NEW.previous_revision_id
        AND previous.todo_instance_id = NEW.todo_instance_id
        AND previous.revision = NEW.revision - 1
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo revision predecessor is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_occurrences_validate_revision_owner
  BEFORE INSERT ON todo_occurrences
  WHEN NOT EXISTS (
    SELECT 1 FROM todo_revisions
    WHERE id = NEW.todo_revision_id AND todo_instance_id = NEW.todo_instance_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo occurrence revision owner is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_recurrences_validate_relation
  BEFORE INSERT ON todo_recurrences
  WHEN NEW.source_occurrence_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM todos_v2 AS previous
    JOIN todos_v2 AS next ON next.id = NEW.next_todo_id
    JOIN todo_occurrences AS occurrence ON occurrence.id = NEW.source_occurrence_id
    WHERE previous.id = NEW.previous_todo_id
      AND previous.status = 'completed'
      AND next.recurrence_of_id = previous.id
      AND occurrence.todo_instance_id = next.id
      AND occurrence.started_at IS NOT NULL
      AND occurrence.started_at > previous.completed_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo recurrence relation is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS session_summary_revisions_validate_predecessor
  BEFORE INSERT ON session_summary_revisions
  WHEN (
    NEW.revision = 1 AND NEW.previous_revision_id IS NOT NULL
  ) OR (
    NEW.revision > 1 AND NOT EXISTS (
      SELECT 1 FROM session_summary_revisions AS previous
      WHERE previous.id = NEW.previous_revision_id
        AND previous.session_id = NEW.session_id
        AND previous.revision = NEW.revision - 1
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'session summary revision predecessor is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS daily_digests_validate_predecessor
  BEFORE INSERT ON daily_digests
  WHEN (
    NEW.revision = 1 AND NEW.previous_revision_id IS NOT NULL
  ) OR (
    NEW.revision > 1 AND NOT EXISTS (
      SELECT 1 FROM daily_digests AS previous
      WHERE previous.id = NEW.previous_revision_id
        AND previous.local_date = NEW.local_date
        AND previous.timezone = NEW.timezone
        AND previous.revision = NEW.revision - 1
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily digest predecessor is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_supersessions_validate_slot
  BEFORE INSERT ON memory_supersessions
  WHEN NOT EXISTS (
    SELECT 1
    FROM memory_items_v2 AS previous
    JOIN memory_items_v2 AS next ON next.id = NEW.next_id
    WHERE previous.id = NEW.previous_id
      AND previous.canonical_slot_key = next.canonical_slot_key
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory supersession slot mismatch');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_members_validate_slot
  BEFORE INSERT ON memory_conflict_members
  WHEN NOT EXISTS (
    SELECT 1
    FROM memory_conflict_groups AS conflict
    JOIN memory_items_v2 AS item ON item.id = NEW.memory_item_id
    WHERE conflict.id = NEW.group_id
      AND conflict.state = 'open'
      AND conflict.slot_key = item.canonical_slot_key
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict slot mismatch');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_groups_validate_resolution
  BEFORE UPDATE OF state, selected_member_id, resolved_at ON memory_conflict_groups
  WHEN NEW.state = 'resolved' AND NOT EXISTS (
    SELECT 1
    FROM memory_conflict_members AS member
    JOIN memory_items_v2 AS item ON item.id = member.memory_item_id
    WHERE member.group_id = NEW.id
      AND member.memory_item_id = NEW.selected_member_id
      AND item.canonical_slot_key = NEW.slot_key
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict resolution is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_groups_terminal_resolution
  BEFORE UPDATE OF state, selected_member_id, resolved_at, updated_at ON memory_conflict_groups
  WHEN OLD.state = 'resolved' AND (
    NEW.state IS NOT OLD.state
    OR NEW.selected_member_id IS NOT OLD.selected_member_id
    OR NEW.resolved_at IS NOT OLD.resolved_at
    OR NEW.updated_at IS NOT OLD.updated_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict resolution is terminal');
  END;
  CREATE TRIGGER IF NOT EXISTS memory_conflict_groups_require_open_insert
  BEFORE INSERT ON memory_conflict_groups
  WHEN NEW.state <> 'open' OR NEW.selected_member_id IS NOT NULL OR NEW.resolved_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'memory conflict must be created open');
  END;
  CREATE TRIGGER IF NOT EXISTS todos_v2_terminal_state
  BEFORE UPDATE OF status, completed_at, dismissed_at ON todos_v2
  WHEN OLD.status IN ('completed','dismissed') AND (
    NEW.status IS NOT OLD.status
    OR NEW.completed_at IS NOT OLD.completed_at
    OR NEW.dismissed_at IS NOT OLD.dismissed_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo terminal state is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS todos_v2_require_transition
  BEFORE UPDATE OF status, completed_at, dismissed_at ON todos_v2
  WHEN NOT EXISTS (
    SELECT 1
    FROM todo_state_transitions AS transition
    WHERE transition.todo_instance_id = OLD.id
      AND (
        (
          transition.from_status IS NULL
          AND OLD.status = 'open'
          AND NEW.status = 'open'
          AND NEW.completed_at IS NULL
          AND NEW.dismissed_at IS NULL
        )
        OR (
          transition.from_status = OLD.status
          AND OLD.status = 'open'
          AND transition.to_status = NEW.status
          AND (
            (
              NEW.status = 'completed'
              AND NEW.completed_at = transition.occurred_at
              AND NEW.dismissed_at IS NULL
            )
            OR (
              NEW.status = 'dismissed'
              AND NEW.dismissed_at = transition.occurred_at
              AND NEW.completed_at IS NULL
            )
          )
        )
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo state change requires transition history');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_state_transitions_validate_insert
  BEFORE INSERT ON todo_state_transitions
  WHEN COALESCE(
    (
      (
        NEW.reason IN ('analysis_created','recurrence')
        AND NEW.actor = 'system'
        AND NEW.source_analysis_input_id IS NOT NULL
        AND NEW.from_status IS NULL
        AND NEW.to_status = 'open'
      )
      OR (
        NEW.reason IN ('user_action','suggestion_acceptance')
        AND NEW.actor = 'user'
        AND NEW.source_analysis_input_id IS NULL
        AND NEW.from_status = 'open'
        AND NEW.to_status IN ('completed','dismissed')
      )
    ),
    0
  ) = 0
  BEGIN
    SELECT RAISE(ABORT, 'todo state transition reason contract is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_state_transitions_validate_state
  BEFORE INSERT ON todo_state_transitions
  WHEN NOT EXISTS (
    SELECT 1
    FROM todos_v2 AS todo
    WHERE todo.id = NEW.todo_instance_id
      AND (
        (
          NEW.from_status IS NULL
          AND NEW.to_status = 'open'
          AND todo.status = 'open'
        )
        OR (
          NEW.from_status = 'open'
          AND todo.status = 'open'
          AND NEW.to_status IN ('completed','dismissed')
        )
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'todo state transition is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS todo_state_transitions_apply
  AFTER INSERT ON todo_state_transitions
  BEGIN
    UPDATE todos_v2
    SET status = NEW.to_status,
        completed_at = CASE WHEN NEW.to_status = 'completed' THEN NEW.occurred_at ELSE NULL END,
        dismissed_at = CASE WHEN NEW.to_status = 'dismissed' THEN NEW.occurred_at ELSE NULL END,
        updated_at = MAX(updated_at, NEW.occurred_at)
    WHERE id = NEW.todo_instance_id;
  END;
  CREATE TRIGGER IF NOT EXISTS suggestions_v2_terminal_state
  BEFORE UPDATE OF state, decided_at ON suggestions_v2
  WHEN OLD.state IN ('accepted','dismissed') AND (
    NEW.state IS NOT OLD.state OR NEW.decided_at IS NOT OLD.decided_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'suggestion terminal state is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS suggestion_acceptances_validate_state
  BEFORE INSERT ON suggestion_acceptances
  WHEN NOT EXISTS (
    SELECT 1 FROM suggestions_v2
    WHERE id = NEW.suggestion_id AND state = 'accepted'
  )
  BEGIN
    SELECT RAISE(ABORT, 'suggestion acceptance requires accepted suggestion');
  END;

  CREATE TRIGGER IF NOT EXISTS evidence_refs_validate_lineage_insert
  BEFORE INSERT ON evidence_refs
  WHEN NOT EXISTS (
    SELECT 1
    FROM transcript_segments AS segment
    LEFT JOIN audio_chunks AS chunk ON chunk.id = NEW.audio_chunk_id
    LEFT JOIN audio_tracks AS track ON track.id = NEW.track_id
    WHERE segment.id = NEW.transcript_segment_id
      AND segment.session_id = NEW.session_id
      AND segment.result_kind = 'final'
      AND segment.is_stable = 1
      AND segment.superseded_by IS NULL
      AND segment.duplicate_of IS NULL
      AND NEW.started_at >= segment.started_at
      AND NEW.ended_at <= segment.ended_at
      AND instr(segment.text, NEW.quote_text) > 0
      AND NEW.track_id IS segment.track_id
      AND (NEW.track_id IS NULL OR track.session_id = NEW.session_id)
      AND (
        (
          NEW.audio_state = 'missing'
          AND NEW.audio_chunk_id IS NULL
          AND segment.chunk_id IS NULL
        )
        OR (
          NEW.audio_state IN ('available','expired')
          AND chunk.id IS NOT NULL
          AND segment.chunk_id = chunk.id
          AND chunk.session_id = NEW.session_id
          AND chunk.track_id IS NEW.track_id
          AND NEW.started_at >= chunk.started_at
          AND NEW.ended_at <= chunk.ended_at
          AND (
            (NEW.audio_state = 'available' AND chunk.deleted_at IS NULL)
            OR (NEW.audio_state = 'expired' AND chunk.deleted_at IS NOT NULL)
          )
        )
      )
      AND (
        (
          NEW.source_analysis_input_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM analysis_inputs AS input
            JOIN analysis_input_segments AS manifest
              ON manifest.analysis_input_id = input.id
            WHERE input.id = NEW.source_analysis_input_id
              AND input.session_id = NEW.session_id
              AND manifest.segment_id = NEW.transcript_segment_id
              AND manifest.segment_version = segment.version
              AND manifest.text_snapshot = segment.text
              AND instr(manifest.text_snapshot, NEW.quote_text) > 0
          )
        )
        OR NEW.source_analysis_input_id IS NULL
      )
      AND CASE NEW.entity_type
        WHEN 'memory_occurrence' THEN EXISTS (
          SELECT 1 FROM memory_occurrences
          WHERE id = NEW.entity_id
            AND (
              (
                NEW.source_analysis_input_id IS NOT NULL
                AND analysis_input_id = NEW.source_analysis_input_id
                AND legacy_session_id IS NULL
              )
              OR (
                NEW.source_analysis_input_id IS NULL
                AND analysis_input_id IS NULL
                AND legacy_session_id = NEW.session_id
              )
            )
        )
        WHEN 'topic_occurrence' THEN EXISTS (
          SELECT 1 FROM topic_occurrences
          WHERE id = NEW.entity_id
            AND (
              (
                NEW.source_analysis_input_id IS NOT NULL
                AND analysis_input_id = NEW.source_analysis_input_id
                AND legacy_session_id IS NULL
              )
              OR (
                NEW.source_analysis_input_id IS NULL
                AND analysis_input_id IS NULL
                AND legacy_session_id = NEW.session_id
              )
            )
        )
        WHEN 'todo_occurrence' THEN EXISTS (
          SELECT 1 FROM todo_occurrences
          WHERE id = NEW.entity_id
            AND (
              (
                NEW.source_analysis_input_id IS NOT NULL
                AND analysis_input_id = NEW.source_analysis_input_id
                AND legacy_session_id IS NULL
              )
              OR (
                NEW.source_analysis_input_id IS NULL
                AND analysis_input_id IS NULL
                AND legacy_session_id = NEW.session_id
              )
            )
        )
        WHEN 'suggestion_occurrence' THEN EXISTS (
          SELECT 1 FROM suggestion_occurrences
          WHERE id = NEW.entity_id
            AND (
              (
                NEW.source_analysis_input_id IS NOT NULL
                AND analysis_input_id = NEW.source_analysis_input_id
                AND legacy_session_id IS NULL
              )
              OR (
                NEW.source_analysis_input_id IS NULL
                AND analysis_input_id IS NULL
                AND legacy_session_id = NEW.session_id
              )
            )
        )
        WHEN 'session_summary_revision' THEN EXISTS (
          SELECT 1 FROM session_summary_revisions
          WHERE id = NEW.entity_id
            AND session_id = NEW.session_id
            AND source_analysis_input_id IS NEW.source_analysis_input_id
        )
        WHEN 'daily_digest' THEN EXISTS (
          SELECT 1 FROM daily_digests WHERE id = NEW.entity_id
        )
        ELSE 0
      END
  )
  BEGIN
    SELECT RAISE(ABORT, 'evidence lineage is invalid');
  END;
  CREATE TRIGGER IF NOT EXISTS evidence_refs_validate_target_insert
  BEFORE INSERT ON evidence_refs
  WHEN CASE NEW.entity_type
    WHEN 'memory_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM memory_occurrences WHERE id = NEW.entity_id
    )
    WHEN 'topic_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM topic_occurrences WHERE id = NEW.entity_id
    )
    WHEN 'todo_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM todo_occurrences WHERE id = NEW.entity_id
    )
    WHEN 'session_summary_revision' THEN NOT EXISTS (
      SELECT 1 FROM session_summary_revisions WHERE id = NEW.entity_id
    )
    WHEN 'daily_digest' THEN NOT EXISTS (
      SELECT 1 FROM daily_digests WHERE id = NEW.entity_id
    )
    WHEN 'suggestion_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM suggestion_occurrences WHERE id = NEW.entity_id
    )
    ELSE 1
  END
  BEGIN
    SELECT RAISE(ABORT, 'evidence target does not exist');
  END;
  CREATE TRIGGER IF NOT EXISTS evidence_refs_validate_target_update
  BEFORE UPDATE OF entity_type, entity_id ON evidence_refs
  WHEN CASE NEW.entity_type
    WHEN 'memory_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM memory_occurrences WHERE id = NEW.entity_id
    )
    WHEN 'topic_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM topic_occurrences WHERE id = NEW.entity_id
    )
    WHEN 'todo_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM todo_occurrences WHERE id = NEW.entity_id
    )
    WHEN 'session_summary_revision' THEN NOT EXISTS (
      SELECT 1 FROM session_summary_revisions WHERE id = NEW.entity_id
    )
    WHEN 'daily_digest' THEN NOT EXISTS (
      SELECT 1 FROM daily_digests WHERE id = NEW.entity_id
    )
    WHEN 'suggestion_occurrence' THEN NOT EXISTS (
      SELECT 1 FROM suggestion_occurrences WHERE id = NEW.entity_id
    )
    ELSE 1
  END
  BEGIN
    SELECT RAISE(ABORT, 'evidence target does not exist');
  END;
`;

const EVIDENCE_EXPIRY_TRIGGER = `
  CREATE TRIGGER evidence_refs_expire_audio
  AFTER UPDATE OF deleted_at ON audio_chunks
  WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
  BEGIN
    UPDATE evidence_refs
    SET audio_state = 'expired'
    WHERE audio_chunk_id = NEW.id AND audio_state = 'available';
  END;
`;

function disambiguateUnboundSpeakerClusters(db) {
  if (!tableExists(db, "speaker_clusters")) return;
  const duplicates = db
    .prepare(
      `SELECT session_id, local_label
       FROM speaker_clusters
       WHERE track_id IS NULL
       GROUP BY session_id, local_label
       HAVING count(*) > 1
       ORDER BY session_id, local_label`
    )
    .all();
  const list = db.prepare(
    `SELECT id FROM speaker_clusters
     WHERE session_id = ? AND track_id IS NULL AND local_label = ?
     ORDER BY created_at, id`
  );
  const labelExists = db.prepare(
    `SELECT 1 FROM speaker_clusters
     WHERE session_id = ? AND track_id IS NULL AND local_label = ? AND id <> ?`
  );
  const rename = db.prepare("UPDATE speaker_clusters SET local_label = ? WHERE id = ?");
  for (const duplicate of duplicates) {
    const clusters = list.all(duplicate.session_id, duplicate.local_label);
    for (const cluster of clusters.slice(1)) {
      const base = `${duplicate.local_label}#migrated-${cluster.id}`;
      let candidate = base;
      let suffix = 1;
      while (labelExists.get(duplicate.session_id, candidate, cluster.id)) {
        suffix += 1;
        candidate = `${base}-${suffix}`;
      }
      rename.run(candidate, cluster.id);
    }
  }
}

function columns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  );
}

function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!columns(db, table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function migrateSessionDiarizationV21(db) {
  if (!tableExists(db, "speaker_diarization_runs")) return;
  const hasCommitSequence = columns(db, "speaker_diarization_runs").has("commit_sequence");
  const hasRunLinks = tableExists(db, "speaker_diarization_run_cluster_segments");
  if (hasCommitSequence && hasRunLinks) return;
  const commitSequenceExpression = hasCommitSequence
    ? "commit_sequence"
    : "ROW_NUMBER() OVER (ORDER BY completed_at, id)";

  db.exec(`
    DROP INDEX IF EXISTS idx_diarization_run_revision;
    DROP INDEX IF EXISTS idx_diarization_runs_session_completed;
    DROP INDEX IF EXISTS idx_diarization_runs_session_sequence;
    DROP INDEX IF EXISTS idx_diarization_run_clusters_cluster;
    DROP INDEX IF EXISTS idx_speaker_turns_run_time;
    DROP INDEX IF EXISTS idx_speaker_turns_segment;
    DROP INDEX IF EXISTS idx_diarization_run_cluster_segments_segment;

    CREATE TABLE speaker_diarization_runs_v21 (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
      transcript_revision TEXT NOT NULL CHECK(
        length(transcript_revision) = 64 AND
        transcript_revision NOT GLOB '*[^0-9a-f]*'
      ),
      policy_id TEXT NOT NULL,
      diarizer_model_id TEXT NOT NULL,
      embedding_model_id TEXT NOT NULL,
      model_artifact_sha256 TEXT NOT NULL CHECK(
        length(model_artifact_sha256) = 64 AND
        model_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      embedding_dimension INTEGER NOT NULL CHECK(embedding_dimension = 512),
      sample_rate INTEGER NOT NULL CHECK(sample_rate = 16000),
      input_version INTEGER NOT NULL CHECK(input_version = 1),
      execution_device TEXT NOT NULL CHECK(execution_device = 'cpu'),
      commit_sequence INTEGER NOT NULL UNIQUE CHECK(commit_sequence > 0),
      created_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL CHECK(completed_at >= created_at),
      UNIQUE(session_id, track_id, transcript_revision, policy_id)
    );
    CREATE TABLE speaker_diarization_run_clusters_v21 (
      run_id TEXT NOT NULL REFERENCES speaker_diarization_runs_v21(id) ON DELETE CASCADE,
      cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
      local_label TEXT NOT NULL,
      embedding BLOB CHECK(
        embedding IS NULL OR (typeof(embedding) = 'blob' AND length(embedding) = 2048)
      ),
      speech_ms INTEGER NOT NULL CHECK(speech_ms >= 0),
      window_count INTEGER NOT NULL CHECK(window_count >= 0),
      quality_score REAL CHECK(
        quality_score IS NULL OR (
          typeof(quality_score) IN ('integer','real') AND quality_score BETWEEN 0 AND 1
        )
      ),
      first_appearance_at INTEGER NOT NULL,
      PRIMARY KEY(run_id, local_label),
      UNIQUE(run_id, cluster_id),
      CHECK(
        (window_count = 0 AND speech_ms = 0 AND embedding IS NULL AND quality_score IS NULL) OR
        (window_count > 0 AND embedding IS NOT NULL AND quality_score IS NOT NULL)
      )
    );
    CREATE TABLE speaker_turns_v21 (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES speaker_diarization_runs_v21(id) ON DELETE CASCADE,
      cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
      chunk_id TEXT NOT NULL REFERENCES audio_chunks(id) ON DELETE CASCADE,
      transcript_segment_id TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
      turn_index INTEGER NOT NULL CHECK(turn_index >= 0),
      raw_label TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL CHECK(ended_at > started_at),
      embedding BLOB CHECK(
        embedding IS NULL OR (typeof(embedding) = 'blob' AND length(embedding) = 2048)
      ),
      echo_state TEXT NOT NULL DEFAULT 'none'
        CHECK(echo_state IN ('none','possible','confirmed')),
      duplicate_of_turn_id TEXT REFERENCES speaker_turns_v21(id) ON DELETE SET NULL,
      excluded_from_centroid INTEGER NOT NULL DEFAULT 0 CHECK(excluded_from_centroid IN (0,1)),
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, chunk_id, turn_index),
      CHECK(duplicate_of_turn_id IS NULL OR duplicate_of_turn_id <> id),
      CHECK((echo_state = 'confirmed') = (excluded_from_centroid = 1))
    );
    CREATE TABLE speaker_diarization_run_cluster_segments_v21 (
      run_id TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      transcript_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
      PRIMARY KEY(run_id, cluster_id, transcript_segment_id),
      FOREIGN KEY(run_id, cluster_id)
        REFERENCES speaker_diarization_run_clusters_v21(run_id, cluster_id) ON DELETE CASCADE
    );

    INSERT INTO speaker_diarization_runs_v21 (
      id, session_id, track_id, transcript_revision, policy_id,
      diarizer_model_id, embedding_model_id, model_artifact_sha256,
      embedding_dimension, sample_rate, input_version, execution_device,
      commit_sequence, created_at, completed_at
    )
    SELECT id, session_id, track_id, transcript_revision, policy_id,
           diarizer_model_id, embedding_model_id, model_artifact_sha256,
           embedding_dimension, sample_rate, input_version, execution_device,
           ${commitSequenceExpression}, created_at, completed_at
    FROM speaker_diarization_runs;
    INSERT INTO speaker_diarization_run_clusters_v21
    SELECT * FROM speaker_diarization_run_clusters;
    INSERT INTO speaker_turns_v21 (
      id, run_id, cluster_id, chunk_id, transcript_segment_id, turn_index,
      raw_label, started_at, ended_at, embedding, echo_state,
      duplicate_of_turn_id, excluded_from_centroid, created_at
    )
    SELECT id, run_id, cluster_id, chunk_id, transcript_segment_id, turn_index,
           raw_label, started_at, ended_at, embedding, echo_state,
           duplicate_of_turn_id,
           CASE WHEN echo_state = 'confirmed' THEN 1 ELSE 0 END,
           created_at
    FROM speaker_turns;
  `);

  if (hasRunLinks) {
    db.exec(`
      INSERT OR IGNORE INTO speaker_diarization_run_cluster_segments_v21
      SELECT existing.run_id, existing.cluster_id, existing.transcript_segment_id
      FROM speaker_diarization_run_cluster_segments AS existing
      JOIN speaker_diarization_run_clusters_v21 AS run_cluster
        ON run_cluster.run_id = existing.run_id
       AND run_cluster.cluster_id = existing.cluster_id
      JOIN transcript_segments AS segment
        ON segment.id = existing.transcript_segment_id;
      DROP TABLE speaker_diarization_run_cluster_segments;
    `);
  }

  db.exec(`
    INSERT OR IGNORE INTO speaker_diarization_run_cluster_segments_v21
    SELECT turn.run_id, turn.cluster_id, turn.transcript_segment_id
    FROM speaker_turns_v21 AS turn
    JOIN speaker_diarization_run_clusters_v21 AS run_cluster
      ON run_cluster.run_id = turn.run_id
     AND run_cluster.cluster_id = turn.cluster_id
    JOIN transcript_segments AS segment
      ON segment.id = turn.transcript_segment_id
    WHERE turn.transcript_segment_id IS NOT NULL;

    DROP TABLE speaker_turns;
    DROP TABLE speaker_diarization_run_clusters;
    DROP TABLE speaker_diarization_runs;
    ALTER TABLE speaker_diarization_runs_v21 RENAME TO speaker_diarization_runs;
    ALTER TABLE speaker_diarization_run_clusters_v21
      RENAME TO speaker_diarization_run_clusters;
    ALTER TABLE speaker_turns_v21 RENAME TO speaker_turns;
    ALTER TABLE speaker_diarization_run_cluster_segments_v21
      RENAME TO speaker_diarization_run_cluster_segments;
  `);
}

function rebuildTranscriptSegmentsV13(db, { preserveLineage = false } = {}) {
  if (!tableExists(db, "transcript_segments")) return;
  const previousLegacyAlterTable = db.pragma("legacy_alter_table", { simple: true });
  db.exec(transcriptSegmentsSchema("transcript_segments_v13"));
  if (preserveLineage) {
    db.exec(`
      INSERT INTO transcript_segments_v13 (
        id, session_id, started_at, ended_at, person_id, speaker_label,
        text, confidence, is_stable, analysis_state, track_id, chunk_id,
        source_type, result_kind, version, model_version, completed_at, superseded_by
      )
      SELECT
        id, session_id, started_at, ended_at, person_id, speaker_label,
        text, confidence, is_stable, analysis_state, track_id, chunk_id,
        source_type, result_kind, version, model_version, completed_at, NULL
      FROM transcript_segments;
    `);
  } else {
    db.exec(`
      INSERT INTO transcript_segments_v13 (
        id, session_id, started_at, ended_at, person_id, speaker_label,
        text, confidence, is_stable, analysis_state, track_id, chunk_id,
        source_type, result_kind, version, model_version, completed_at
      )
      SELECT
        id, session_id, started_at, ended_at,
        CASE
          WHEN person_id IS NULL OR EXISTS (SELECT 1 FROM people WHERE people.id = person_id)
            THEN person_id
          ELSE NULL
        END,
        speaker_label, text,
        CASE
          WHEN typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1
            THEN confidence
          ELSE NULL
        END,
        CASE WHEN typeof(is_stable) = 'integer' AND is_stable IN (0,1) THEN is_stable ELSE 0 END,
        analysis_state, NULL, NULL, 'mic', 'provisional', 1, NULL, NULL
      FROM transcript_segments;
    `);
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_segments_session_time;
    DROP INDEX IF EXISTS idx_segments_superseded_by;
    DROP INDEX IF EXISTS idx_transcript_chunk_model_final;
    DROP TRIGGER IF EXISTS validate_final_transcript_lineage_insert;
    DROP TRIGGER IF EXISTS validate_final_transcript_lineage_update;
    DROP TRIGGER IF EXISTS validate_transcript_supersession_insert;
    DROP TRIGGER IF EXISTS validate_transcript_supersession_update;
    DROP TRIGGER IF EXISTS validate_transcript_supersession_target_update;
  `);
  try {
    db.pragma("legacy_alter_table = ON");
    db.exec(`
      ALTER TABLE transcript_segments RENAME TO transcript_segments_v12;
      ALTER TABLE transcript_segments_v13 RENAME TO transcript_segments;
      DROP TABLE transcript_segments_v12;
    `);
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacyAlterTable ? "ON" : "OFF"}`);
  }
  db.exec(TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS);
}

function rebuildTranscriptSegmentsV14(db) {
  if (!tableExists(db, "transcript_segments")) return;
  const previousLegacyAlterTable = db.pragma("legacy_alter_table", { simple: true });
  db.exec(transcriptSegmentsSchema("transcript_segments_v14"));
  db.exec(`
    INSERT INTO transcript_segments_v14 (
      id, session_id, started_at, ended_at, person_id, speaker_label,
      text, confidence, is_stable, analysis_state, track_id, chunk_id,
      source_type, result_kind, version, model_version, completed_at, superseded_by,
      echo_score, duplicate_of
    )
    SELECT
      id, session_id, started_at, ended_at, person_id, speaker_label,
      text, confidence, is_stable, analysis_state, track_id, chunk_id,
      source_type, result_kind, version, model_version, completed_at, superseded_by,
      NULL, NULL
    FROM transcript_segments;
    DROP INDEX IF EXISTS idx_segments_session_time;
    DROP INDEX IF EXISTS idx_segments_superseded_by;
    DROP INDEX IF EXISTS idx_segments_duplicate_of;
    DROP INDEX IF EXISTS idx_transcript_chunk_model_final;
    DROP TRIGGER IF EXISTS validate_final_transcript_lineage_insert;
    DROP TRIGGER IF EXISTS validate_final_transcript_lineage_update;
    DROP TRIGGER IF EXISTS validate_transcript_supersession_insert;
    DROP TRIGGER IF EXISTS validate_transcript_supersession_update;
    DROP TRIGGER IF EXISTS validate_transcript_supersession_target_update;
    DROP TRIGGER IF EXISTS validate_transcript_duplicate_insert;
    DROP TRIGGER IF EXISTS validate_transcript_duplicate_update;
    DROP TRIGGER IF EXISTS invalidate_transcript_duplicates_on_target_text_update;
    DROP TRIGGER IF EXISTS validate_transcript_duplicate_target_update;
  `);
  try {
    db.pragma("legacy_alter_table = ON");
    db.exec(`
      ALTER TABLE transcript_segments RENAME TO transcript_segments_v13;
      ALTER TABLE transcript_segments_v14 RENAME TO transcript_segments;
      DROP TABLE transcript_segments_v13;
    `);
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacyAlterTable ? "ON" : "OFF"}`);
  }
  db.exec(TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS);
}

function rebuildLegacyProcessingJobs(db) {
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processing_jobs'")
    .get()?.sql;
  if (!sql?.replace(/\s+/g, "").includes("UNIQUE(job_type,input_hash)")) return;

  db.exec(`
    ALTER TABLE processing_jobs RENAME TO processing_jobs_v1;
    ${PROCESSING_JOBS_SCHEMA}
    INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count, next_retry_at,
      lease_owner, lease_expires_at, error_code, created_at, completed_at
    )
    SELECT
      id, session_id, track_id, chunk_id, job_type, state, priority,
      input_hash, input_version, COALESCE(model_version, ''), attempt_count, next_retry_at,
      lease_owner, lease_expires_at, error_code, created_at, completed_at
    FROM processing_jobs_v1;
    DROP TABLE processing_jobs_v1;
  `);
}

function deduplicateCompressionJobs(db) {
  const groups = db
    .prepare(
      `SELECT chunk_id, model_version
       FROM processing_jobs
       WHERE job_type = 'compress_chunk' AND chunk_id IS NOT NULL
       GROUP BY chunk_id, model_version
       HAVING count(*) > 1
       ORDER BY chunk_id, model_version`
    )
    .all();
  const list = db.prepare(
    `SELECT * FROM processing_jobs
     WHERE job_type = 'compress_chunk' AND chunk_id = ? AND model_version = ?`
  );
  const update = db.prepare(
    `UPDATE processing_jobs
     SET attempt_count = ?, error_code = ?
     WHERE id = ?`
  );
  const remove = db.prepare("DELETE FROM processing_jobs WHERE id = ?");
  const terminalRank = (job) => {
    if (job.state === "completed") return 0;
    if (["failed", "cancelled", "audio_expired_before_processing"].includes(job.state)) return 1;
    return 2;
  };
  for (const group of groups) {
    const jobs = list.all(group.chunk_id, group.model_version).sort((left, right) => {
      const rank = terminalRank(left) - terminalRank(right);
      if (rank !== 0) return rank;
      const completion = (right.completed_at ?? -1) - (left.completed_at ?? -1);
      if (completion !== 0) return completion;
      const created = right.created_at - left.created_at;
      return created !== 0 ? created : left.id.localeCompare(right.id);
    });
    const keeper = jobs[0];
    const attemptCount = Math.max(...jobs.map((job) => job.attempt_count));
    const diagnostic = jobs.find((job) => job.error_code !== null)?.error_code ?? null;
    update.run(attemptCount, keeper.error_code ?? diagnostic, keeper.id);
    for (const duplicate of jobs.slice(1)) remove.run(duplicate.id);
  }
}

function applyJarvisMigrations(db, { now = Date.now } = {}) {
  const fromVersion = db.pragma("user_version", { simple: true });
  if (fromVersion >= TARGET_VERSION) {
    const violations = db.pragma("foreign_key_check");
    if (violations.length > 0) {
      throw new Error("schema migration would violate foreign keys");
    }
    return { fromVersion, toVersion: fromVersion };
  }

  const rebuildsTranscriptSegments = tableExists(db, "transcript_segments");
  const foreignKeysWereEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
  if (rebuildsTranscriptSegments && db.inTransaction) {
    throw new Error("transcript schema migration must own the outer transaction");
  }
  if (rebuildsTranscriptSegments && foreignKeysWereEnabled) {
    db.pragma("foreign_keys = OFF");
  }

  try {
    db.transaction(() => {
      const migratedAt = now();
      db.exec(MIGRATION_BASE_SCHEMA);

      addColumn(db, "sessions", "capture_mode TEXT NOT NULL DEFAULT 'mic'");
      // Existing sessions were captured continuously. Keep that historical meaning while
      // repository-created sessions explicitly opt into the new speech-triggered default.
      addColumn(db, "sessions", "retention_mode TEXT NOT NULL DEFAULT 'continuous'");
      addColumn(
        db,
        "sessions",
        `capture_policy_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"preRollMs":2000,"postRollMs":3000,"mergeGapMs":3000}'`
      );
      addColumn(db, "sessions", "processing_state TEXT NOT NULL DEFAULT 'pending'");
      addColumn(db, "sessions", "timeline_version INTEGER NOT NULL DEFAULT 1");
      addColumn(db, "sessions", "finalized_at INTEGER");
      addColumn(db, "sessions", "ready_at INTEGER");
      addColumn(db, "sessions", "stop_reason TEXT");
      addColumn(db, "sessions", "durable_boundary_at INTEGER");
      addColumn(db, "audio_chunks", "track_id TEXT");
      addColumn(db, "audio_chunks", "source_type TEXT NOT NULL DEFAULT 'mic'");
      addColumn(db, "audio_chunks", "sequence_number INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "audio_chunks", "write_state TEXT NOT NULL DEFAULT 'committed'");
      addColumn(db, "audio_chunks", "deleted_at INTEGER");
      addColumn(db, "audio_chunks", "format TEXT NOT NULL DEFAULT 'wav'");
      addColumn(db, "audio_chunks", "file_sha256 TEXT");
      addColumn(db, "audio_chunks", "sample_rate INTEGER NOT NULL DEFAULT 24000");
      addColumn(db, "audio_chunks", "channels INTEGER NOT NULL DEFAULT 1");
      addColumn(db, "audio_chunks", "retired_path TEXT");
      addColumn(db, "audio_chunks", "retired_format TEXT");
      addColumn(db, "audio_chunks", "retired_file_sha256 TEXT");
      db.exec(`
      CREATE TABLE IF NOT EXISTS audio_tracks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('mic','system')),
        device_id TEXT,
        device_label TEXT,
        strategy TEXT,
        sample_rate INTEGER NOT NULL,
        channels INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        state TEXT NOT NULL,
        UNIQUE(session_id, source_type)
      );
      CREATE TABLE IF NOT EXISTS audio_gaps (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        reason TEXT NOT NULL,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        restored_device_id TEXT,
        restored_device_label TEXT,
        restored_strategy TEXT,
        average_level REAL,
        peak_level REAL
      );
    `);
      if (!tableExists(db, "transcript_segments")) {
        db.exec(transcriptSegmentsSchema("transcript_segments", { ifNotExists: true }));
        db.exec(TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS);
      }
      if (fromVersion < 13 && !columns(db, "transcript_segments").has("superseded_by")) {
        rebuildTranscriptSegmentsV13(db, { preserveLineage: fromVersion >= 12 });
      }
      if (fromVersion < 14 && !columns(db, "transcript_segments").has("duplicate_of")) {
        rebuildTranscriptSegmentsV14(db);
      }
      addColumn(db, "audio_gaps", "restored_device_id TEXT");
      addColumn(db, "audio_gaps", "restored_device_label TEXT");
      addColumn(db, "audio_gaps", "restored_strategy TEXT");
      addColumn(db, "audio_gaps", "average_level REAL");
      addColumn(db, "audio_gaps", "peak_level REAL");
      db.exec(PROCESSING_JOBS_SCHEMA);
      rebuildLegacyProcessingJobs(db);
      deduplicateCompressionJobs(db);
      addColumn(db, "processing_jobs", "blocked_reason TEXT");
      addColumn(
        db,
        "processing_jobs",
        "execution_device TEXT CHECK(execution_device IS NULL OR execution_device IN ('cuda','cpu','cloud'))"
      );
      if (fromVersion < 15) {
        db.exec(`
        UPDATE processing_jobs
        SET priority = CASE
          WHEN state = 'retention_urgent' THEN 0
          WHEN state = 'storage_recovery_compress' THEN 10
          WHEN job_type = 'preview_transcription' THEN 20
          WHEN job_type = 'transcribe_chunk' THEN 30
          WHEN job_type = 'speaker' THEN 40
          WHEN job_type = 'analyze_session' THEN 50
          ELSE 60
        END;
      `);
      }
      db.exec(`
      DROP INDEX IF EXISTS idx_processing_jobs_chunk_input;
      DROP INDEX IF EXISTS idx_processing_jobs_compress_identity;
    `);
      db.exec(PROCESSING_JOBS_INDEXES);
      db.prepare(
        `INSERT OR IGNORE INTO processing_jobs (
        id, session_id, track_id, chunk_id, job_type, state, priority,
        input_hash, input_version, model_version, created_at
      )
      SELECT
        'job_compress_' || lower(hex(randomblob(16))),
        session_id, track_id, id, 'compress_chunk', 'pending', 60,
        sha256, 1, ?, ?
      FROM audio_chunks
      WHERE deleted_at IS NULL
        AND expires_at > ?
        AND format = 'wav'
        AND write_state = 'committed'
        AND track_id IS NOT NULL
        AND length(path) > 0
        AND length(sha256) > 0
        AND duration_ms > 0
        AND sample_rate = 24000
        AND channels = 1`
      ).run(FLAC_ENCODER_VERSION, migratedAt, migratedAt);
      if (fromVersion === 10) {
        db.exec(`
        DROP INDEX IF EXISTS idx_storage_usage_events_time;
        ALTER TABLE storage_usage_events RENAME TO storage_usage_events_v10;
      `);
      }
      db.exec(`
      CREATE TABLE IF NOT EXISTS storage_usage_events (
        kind TEXT NOT NULL CHECK(kind IN (
          'wav_written','flac_written','retired_deleted','retention_deleted'
        )),
        chunk_id TEXT NOT NULL REFERENCES audio_chunks(id) ON DELETE CASCADE,
        bytes INTEGER NOT NULL CHECK(bytes > 0),
        delta_bytes INTEGER NOT NULL CHECK(
          (kind IN ('wav_written','flac_written') AND delta_bytes = bytes)
          OR
          (kind IN ('retired_deleted','retention_deleted') AND delta_bytes = -bytes)
        ),
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY(kind, chunk_id)
      );
    `);
      if (fromVersion === 10) {
        db.exec(`
        INSERT INTO storage_usage_events (kind, chunk_id, bytes, delta_bytes, occurred_at)
        SELECT kind, chunk_id, bytes, bytes, occurred_at
        FROM storage_usage_events_v10;
        DROP TABLE storage_usage_events_v10;
      `);
      }
      db.exec(`
      CREATE INDEX IF NOT EXISTS idx_storage_usage_events_time
      ON storage_usage_events(occurred_at, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_chunks_track_sequence
      ON audio_chunks(track_id, sequence_number);
      CREATE INDEX IF NOT EXISTS idx_audio_gaps_track_ended_started
      ON audio_gaps(track_id, ended_at, started_at);
    `);
      db.exec(`
      CREATE TABLE IF NOT EXISTS session_continuations (
        source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        destination_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK(reason = 'local_midnight'),
        boundary_at INTEGER NOT NULL CHECK(typeof(boundary_at) = 'integer' AND boundary_at >= 0),
        destination_local_date TEXT NOT NULL CHECK(length(destination_local_date) = 10),
        PRIMARY KEY(source_session_id, destination_local_date),
        CHECK(source_session_id <> destination_session_id)
      );
    `);
      db.exec(SPEAKER_IDENTITY_SCHEMA);
      if (fromVersion < 21) {
        migrateSessionDiarizationV21(db);
      }
      db.exec(SESSION_DIARIZATION_SCHEMA);
      db.exec(SPEAKER_IDENTITY_RESOLUTION_SCHEMA);
      addColumn(db, "speaker_identity_corrections", "previous_person_ref TEXT");
      addColumn(db, "speaker_identity_corrections", "next_person_ref TEXT");
      addColumn(
        db,
        "speaker_identity_corrections",
        "correction_kind TEXT NOT NULL DEFAULT 'link' CHECK(correction_kind IN ('link','merge'))"
      );
      addColumn(
        db,
        "speaker_identity_corrections",
        "resolution_commit_sequence INTEGER CHECK(resolution_commit_sequence IS NULL OR resolution_commit_sequence >= 0)"
      );
      db.exec(`
        UPDATE speaker_identity_corrections
        SET resolution_commit_sequence = 0
        WHERE resolution_commit_sequence IS NULL;
        UPDATE speaker_identity_corrections
        SET previous_person_ref = previous_person_id
        WHERE previous_person_ref IS NULL AND previous_person_id IS NOT NULL;
        UPDATE speaker_identity_corrections
        SET next_person_ref = next_person_id
        WHERE next_person_ref IS NULL AND next_person_id IS NOT NULL;
        UPDATE speaker_identity_corrections
        SET correction_kind = 'merge',
            previous_person_ref = COALESCE(
              previous_person_ref,
              'legacy-source-unavailable:' || id
            ),
            next_person_ref = COALESCE(
              next_person_ref,
              'legacy-target-unavailable:' || id
            )
        WHERE correction_kind = 'link'
          AND scope = 'persistent'
          AND previous_person_id IS NULL
          AND previous_state = next_state
          AND previous_state IN ('confirmed','suggested');
      `);
      disambiguateUnboundSpeakerClusters(db);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_clusters_unbound_label
        ON speaker_clusters(session_id, local_label)
        WHERE track_id IS NULL;
      `);
      if (fromVersion < 23) {
        const retainedLineageSchema =
          tableExists(db, "analysis_inputs") && tableExists(db, "evidence_refs");
        db.exec(MEMORY_LINEAGE_SCHEMA);
        db.exec(
          retainedLineageSchema
            ? EVIDENCE_EXPIRY_TRIGGER.replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS")
            : EVIDENCE_EXPIRY_TRIGGER
        );
      }

      const violations = db.pragma("foreign_key_check");
      if (violations.length > 0) {
        throw new Error("schema migration would violate foreign keys");
      }
      db.pragma(`user_version = ${TARGET_VERSION}`);
    })();
  } finally {
    if (rebuildsTranscriptSegments && foreignKeysWereEnabled) {
      db.pragma("foreign_keys = ON");
    }
  }

  return { fromVersion, toVersion: TARGET_VERSION };
}

module.exports = {
  applyJarvisMigrations,
  TARGET_VERSION,
  FLAC_ENCODER_VERSION,
  transcriptSegmentsSchema,
  TRANSCRIPT_SEGMENTS_INDEXES_AND_TRIGGERS,
  SPEAKER_IDENTITY_SCHEMA,
  SESSION_DIARIZATION_SCHEMA,
};
