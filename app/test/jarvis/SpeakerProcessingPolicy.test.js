const test = require("node:test");
const assert = require("node:assert/strict");
const SpeakerProcessingPolicy = require("../../src/jarvis/main/SpeakerProcessingPolicy");

const MODEL = "whisper-final-v1";

function finalEvidence() {
  return {
    observedAt: 9_000,
    session: {
      id: "session-final",
      started_at: 1_000,
      ended_at: 8_000,
      status: "completed",
    },
    track: {
      id: "track-mic",
      session_id: "session-final",
      source_type: "mic",
      sample_rate: 24_000,
      channels: 1,
      started_at: 1_000,
      ended_at: 8_000,
      state: "ended",
    },
    chunks: [
      {
        audioChunk: {
          id: "chunk-0",
          session_id: "session-final",
          track_id: "track-mic",
          source_type: "mic",
          sequence_number: 0,
          path: "chunk-0.wav",
          started_at: 1_000,
          ended_at: 4_000,
          duration_ms: 3_000,
          sha256: "a".repeat(64),
          expires_at: 20_000,
          deleted_at: null,
          write_state: "committed",
          format: "wav",
          sample_rate: 24_000,
          channels: 1,
          transcription_status: "completed",
        },
        latestTranscriptionJob: {
          id: "job-0",
          session_id: "session-final",
          track_id: "track-mic",
          chunk_id: "chunk-0",
          job_type: "transcribe_chunk",
          state: "completed",
          input_hash: "a".repeat(64),
          input_version: 1,
          model_version: MODEL,
        },
        transcriptSegments: [
          {
            id: "segment-0",
            session_id: "session-final",
            track_id: "track-mic",
            chunk_id: "chunk-0",
            source_type: "mic",
            started_at: 1_000,
            ended_at: 4_000,
            text: "hello",
            confidence: 0.9,
            is_stable: 1,
            result_kind: "final",
            version: 1,
            model_version: MODEL,
            superseded_by: null,
            duplicate_of: null,
          },
        ],
      },
      {
        audioChunk: {
          id: "chunk-1",
          session_id: "session-final",
          track_id: "track-mic",
          source_type: "mic",
          sequence_number: 1,
          path: "chunk-1.wav",
          started_at: 4_000,
          ended_at: 8_000,
          duration_ms: 4_000,
          sha256: "b".repeat(64),
          expires_at: 20_000,
          deleted_at: null,
          write_state: "committed",
          format: "wav",
          sample_rate: 24_000,
          channels: 1,
          transcription_status: "no_speech",
        },
        latestTranscriptionJob: {
          id: "job-1",
          session_id: "session-final",
          track_id: "track-mic",
          chunk_id: "chunk-1",
          job_type: "transcribe_chunk",
          state: "completed",
          input_hash: "b".repeat(64),
          input_version: 1,
          model_version: MODEL,
        },
        transcriptSegments: [],
      },
    ],
  };
}

function policy() {
  return new SpeakerProcessingPolicy({
    transcriptionInputVersion: 1,
    transcriptionModelVersion: MODEL,
  });
}

function resultShape(result) {
  return {
    eligible: result.eligible,
    reason: result.reason,
    stableAudioRevision: result.stableAudioRevision,
    transcriptRevision: result.transcriptRevision,
    evidenceRevision: result.evidenceRevision,
  };
}

test("accepts exact terminal audio plus final/no-speech transcripts and returns three revisions", () => {
  const result = policy().evaluate(finalEvidence());

  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
  assert.match(result.stableAudioRevision, /^[0-9a-f]{64}$/);
  assert.match(result.transcriptRevision, /^[0-9a-f]{64}$/);
  assert.match(result.evidenceRevision, /^[0-9a-f]{64}$/);
  assert.notEqual(result.stableAudioRevision, result.transcriptRevision);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.chunks), true);
  assert.deepEqual(
    result.chunks.map((entry) => [entry.audioChunk.id, entry.transcriptionResult]),
    [
      ["chunk-0", "final"],
      ["chunk-1", "no_speech"],
    ]
  );
});

test("uses the documented stable reason order for terminal and audio failures", () => {
  const cases = [
    ["session_not_terminal", (input) => (input.session = null)],
    ["track_not_terminal", (input) => (input.track = null)],
    ["final_audio_incomplete", (input) => (input.chunks[0].audioChunk.sequence_number = 2)],
    ["final_audio_deleted", (input) => (input.chunks[0].audioChunk.deleted_at = 8_500)],
    ["final_audio_expired", (input) => (input.chunks[0].audioChunk.expires_at = 9_000)],
  ];

  for (const [reason, mutate] of cases) {
    const input = finalEvidence();
    mutate(input);
    assert.deepEqual(resultShape(policy().evaluate(input)), {
      eligible: false,
      reason,
      stableAudioRevision: null,
      transcriptRevision: null,
      evidenceRevision: null,
    });
  }
});

test("keeps the stable audio revision while reporting exact transcript failure reasons", () => {
  const cases = [
    ["final_transcript_missing", (input) => (input.chunks[0].latestTranscriptionJob = null)],
    [
      "final_transcript_pending",
      (input) => (input.chunks[0].latestTranscriptionJob.state = "retry"),
    ],
    [
      "final_transcript_stale",
      (input) => (input.chunks[0].latestTranscriptionJob.input_version = 2),
    ],
    [
      "final_transcript_model_mismatch",
      (input) => (input.chunks[0].latestTranscriptionJob.model_version = "whisper-other"),
    ],
    ["final_transcript_invalid", (input) => (input.chunks[0].transcriptSegments[0].is_stable = 0)],
  ];

  for (const [reason, mutate] of cases) {
    const input = finalEvidence();
    mutate(input);
    const result = policy().evaluate(input);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, reason);
    assert.match(result.stableAudioRevision, /^[0-9a-f]{64}$/);
    assert.equal(result.transcriptRevision, null);
    assert.equal(result.evidenceRevision, null);
  }
});

test("accepts fully durable failed capture states without weakening evidence checks", () => {
  const input = finalEvidence();
  input.session.status = "failed";
  input.track.state = "failed";

  assert.equal(policy().evaluate(input).eligible, true);

  input.chunks[0].audioChunk.write_state = "writing";
  assert.equal(policy().evaluate(input).reason, "final_audio_incomplete");
});

test("revisions are independent, deterministic, and insensitive to input row order", () => {
  const original = finalEvidence();
  const baseline = policy().evaluate(original);

  const reordered = finalEvidence();
  reordered.chunks.reverse();
  reordered.chunks[0].transcriptSegments.reverse();
  assert.deepEqual(resultShape(policy().evaluate(reordered)), resultShape(baseline));

  const audioChanged = finalEvidence();
  audioChanged.chunks[0].audioChunk.sample_rate = 16_000;
  const audioResult = policy().evaluate(audioChanged);
  assert.notEqual(audioResult.stableAudioRevision, baseline.stableAudioRevision);
  assert.equal(audioResult.transcriptRevision, baseline.transcriptRevision);
  assert.notEqual(audioResult.evidenceRevision, baseline.evidenceRevision);

  const transcriptChanged = finalEvidence();
  transcriptChanged.chunks[0].transcriptSegments[0].text = "hello revised";
  const transcriptResult = policy().evaluate(transcriptChanged);
  assert.equal(transcriptResult.stableAudioRevision, baseline.stableAudioRevision);
  assert.notEqual(transcriptResult.transcriptRevision, baseline.transcriptRevision);
  assert.notEqual(transcriptResult.evidenceRevision, baseline.evidenceRevision);
});

test("rejects cross-track final segments and no-speech rows carrying final text", () => {
  const crossTrack = finalEvidence();
  crossTrack.chunks[0].transcriptSegments[0].track_id = "track-other";
  assert.equal(policy().evaluate(crossTrack).reason, "final_transcript_invalid");

  const falseNoSpeech = finalEvidence();
  falseNoSpeech.chunks[1].transcriptSegments.push({
    ...falseNoSpeech.chunks[0].transcriptSegments[0],
    id: "segment-1",
    chunk_id: "chunk-1",
    started_at: 4_000,
    ended_at: 8_000,
  });
  assert.equal(policy().evaluate(falseNoSpeech).reason, "final_transcript_invalid");
});
