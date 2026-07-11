# Jarvis Full Memory and AI Analysis Specification

## Status and scope

This specification extends the approved Jarvis MVP design with the concrete implementation contract for the five navigation destinations: Today, People, Topics, Todos, and Memory. It also incorporates the approved microphone-selector fallback design.

The user approved automatic MiniMax analysis with one privacy boundary: only stable transcript text and pseudonymous speaker labels may leave the computer. Raw audio, voice embeddings, real names, API keys, logs, and unrelated memories must remain local.

## System classification and framework choice

Jarvis analysis is a deterministic structured-extraction pipeline, not an autonomous agent. The selected approach is a small main-process service using MiniMax's OpenAI-compatible HTTP API and a forced tool schema, followed by local Zod-style validation and repository transactions.

No agent framework is added. LangChain, LangGraph, and multi-agent frameworks would add state and packaging overhead without improving this linear workflow. Electron main owns credentials, network calls, budgeting, validation, retries, and database writes. The renderer only requests/query results through narrow IPC methods.

MiniMax endpoints are configurable by region. The default for this Windows installation is `https://api.minimaxi.com/v1`; the international equivalent is `https://api.minimax.io/v1`. The default model is `MiniMax-M2.7`. Available models are discovered through `/v1/models`; an unavailable configured model falls back to `MiniMax-M2.7` and is reported in the UI.

Official references:

- https://platform.minimax.io/docs/token-plan/quickstart
- https://platform.minimax.io/docs/token-plan/other-tools
- https://platform.minimax.io/docs/api-reference/text-openai-api
- https://platform.minimax.io/docs/api-reference/models/openai/list-models

## Product behavior

### Today

- Keep the existing recording controls and live transcript.
- Show the current incremental summary, topics, new todos, decisions, and suggestions.
- Refresh analysis after each successful ten-minute window and when the session finishes.
- Show `Waiting for analysis`, `Analyzing`, `Ready`, `Offline`, `Quota limited`, or `Retry needed` without blocking recording.
- Show today's recent sessions under the live area, with a jump to the Memory detail view.

### People

- List local people ordered by most recent appearance.
- Show `Me`, enrolled voice status, display name, last interaction, session count, related topics, open todos, and evidence excerpts.
- Unknown speakers remain `Speaker 2`, `Speaker 3`, and so on until renamed.
- Renaming or marking a speaker as self changes local display and relationships only; cloud prompts use pseudonyms.

### Topics

- List canonical topics ordered by `last_seen_at`.
- A topic detail shows description, current status, related people, sessions, decisions, memories, todos, and evidence.
- Exact normalized titles merge automatically. Similar but non-identical titles remain separate in the MVP to avoid destructive AI-only merges.
- Users may rename a topic locally.

### Todos

- List open and completed todos with content, owner, optional due date, source session, and evidence.
- Users can complete/reopen a todo. AI may create or update an open todo but may never mark one completed.
- Duplicate AI todos merge only when normalized content, owner, and source topic match.

### Memory

- List all sessions newest first, grouped by day.
- Search session summaries, transcript text, memories, topic titles, and person display names locally.
- A session detail shows time, duration, status, actual microphone, final summary, structured analysis, full transcript, speakers, and audio chunks.
- Audio chunks are playable while present and display their deletion date. After seven-day cleanup the transcript, summary, and structured memories remain.
- Failed sessions remain visible with their failure state and any recovered transcript/audio.

## Local data contract

Existing `sessions`, `people`, `transcript_segments`, and `audio_chunks` remain the evidence source. Add idempotent SQLite migrations for:

### `analysis_runs`

- `id`, `session_id`, `kind` (`incremental` or `final`)
- `window_start`, `window_end`, `input_hash`
- `model`, `status`, `attempt_count`, `next_retry_at`
- `response_json`, `error_code`, `created_at`, `completed_at`
- unique `(session_id, kind, input_hash)`

### `session_summaries`

- `session_id` primary key
- `summary`, `decisions_json`, `suggestions_json`
- `analysis_run_id`, `updated_at`, `is_final`

### `topics` and `session_topics`

- topic: `id`, `canonical_title`, `normalized_title`, `description`, `status`, `created_at`, `last_seen_at`
- link: `session_id`, `topic_id`, `analysis_run_id`

### `todos`

- `id`, `content`, `normalized_content`, `owner_person_id`, `topic_id`
- `due_at`, `status`, `confidence`, `created_at`, `updated_at`, `completed_at`
- `source_session_id`, `source_segment_id`, `analysis_run_id`

### `memories` and `memory_evidence`

- memory: `id`, `type`, `content`, `normalized_content`, `person_id`, `topic_id`, `confidence`, `status`, `first_seen_at`, `last_seen_at`, `occurrence_count`, `needs_confirmation`
- evidence: `memory_id`, `segment_id`, `analysis_run_id`

All foreign keys use explicit cascade/set-null behavior. Model output never executes SQL directly.

## MiniMax request contract

The scheduler sends only stable, unprocessed transcript segments. Each segment contains:

- stable segment id
- start/end time
- pseudonymous speaker reference such as `self` or `person_2`
- transcript text

Incremental requests include a small amount of previous session analysis for continuity. They do not include unrelated sessions. Final analysis uses the stable transcript plus incremental results and produces the canonical session summary.

The model must call `submit_jarvis_analysis` with:

```json
{
  "summary": "objective summary",
  "topics": [
    {
      "title": "topic title",
      "description": "what was discussed",
      "evidenceSegmentIds": ["segment-id"]
    }
  ],
  "memories": [
    {
      "type": "fact|decision|commitment|opinion",
      "content": "memory text",
      "personRef": "self|person_2|null",
      "topicRef": "topic title|null",
      "confidence": 0.0,
      "evidenceSegmentIds": ["segment-id"]
    }
  ],
  "todos": [
    {
      "content": "action",
      "ownerRef": "self|person_2|null",
      "dueDate": null,
      "topicRef": null,
      "evidenceSegmentIds": ["segment-id"]
    }
  ],
  "decisions": ["decision text"],
  "suggestions": [
    {"content": "advice", "reason": "evidence-based reason"}
  ]
}
```

Validation rejects unknown segment ids, invalid dates, non-finite confidence, unsupported memory types, empty required strings, oversized arrays, and output beyond configured byte limits. One format-repair request is allowed. Invalid results remain visible as retryable analysis runs and do not alter derived tables.

## Scheduling and failure behavior

- A session receives an incremental job after ten minutes of accumulated recording time and every ten minutes thereafter.
- Only one analysis request runs at a time.
- Finish persists all stable segments, schedules a final job, and returns control to the UI; recording completion is never blocked indefinitely by cloud work.
- Network errors, 429, and retryable 5xx use bounded exponential backoff with jitter.
- Authentication and quota failures are not retried continuously.
- Restart resumes pending jobs whose retry time has arrived.
- Duplicate input hashes are idempotent.
- Budget/Token Plan exhaustion pauses analysis only. Recording, local transcription, browsing, and audio retention continue.

## Secret and privacy controls

- Add a dedicated `MINIMAX_API_KEY` secret managed by the existing EnvironmentManager/secure-key path.
- The key is set through a narrow IPC command and is never returned to the renderer; only `keyConfigured` is returned.
- Requests execute in Electron main through `net.fetch`.
- Logs include opaque run id, status, duration, token counts, and error code only.
- No transcript, response JSON, speaker name, audio path, key, or HTTP authorization header is logged.

## Evaluation contract

Start with 12 anonymized fixtures covering Chinese, English, mixed-language speech, repeated topics, ambiguous owners, missing due dates, corrections, conflicting claims, empty/noisy transcripts, malformed model JSON, unknown evidence ids, and duplicate retries.

Code-based gates:

- 100% schema validity for accepted outputs.
- 100% evidence ids refer to allowed input segments.
- 100% idempotency across identical input hashes.
- No AI result can complete a todo.
- No raw audio or secret enters request/log fixtures.
- Every rendered memory/todo/topic can navigate to at least one source session/segment.

Human review rubric (1-5): summary faithfulness, topic usefulness, todo precision, person attribution, and suggestion grounding. A fixture is release-ready when no dimension is below 3 and the average is at least 4.

Critical failure guardrails:

- Unsupported statements cannot become high-confidence memories without evidence.
- Model output cannot delete or overwrite raw transcript evidence.
- Cloud failure cannot interrupt recording.
- Secret exposure tests and transcript-log scans must pass before packaging.

## Acceptance criteria

- All five left navigation entries are enabled and render real data/empty/error/loading states.
- The seven existing sessions are visible in Memory without migration loss.
- A Memory detail can open the complete stored transcript and available audio.
- A ten-minute recording produces incremental insights; Finish produces a final summary.
- People, Topics, and Todos reflect the same persisted analysis and link back to evidence.
- MiniMax receives text only, and the Token Plan key remains main-process-only.
- The microphone selector and same-session default-device fallback meet their approved specification.
- Main, renderer, typecheck, lint, i18n, build, packaging, and Windows hardware acceptance pass.
