# Jarvis Memory Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the verified capture foundation with MiniMax ten-minute analysis, final summaries, evidence-backed long-term memory, people/topics/todos views, natural-language recall, failure recovery, seven-day audio deletion, and a usable Windows MVP build.

**Architecture:** Keep MiniMax behind a main-process `MiniMaxClient`; the renderer never receives the API key. An idempotent scheduler sends only stable anonymous transcript windows, validates model JSON and evidence IDs, then passes accepted candidates to a deterministic `MemoryMerger`. Store memory revisions and evidence in `jarvis.db`; use local MiniLM embeddings plus SQLite FTS for recall.

**Tech Stack:** Electron 41 main process, OpenAI-compatible MiniMax Chat Completions over built-in `fetch`, Zod 4, better-sqlite3 12 with FTS5, all-MiniLM-L6-v2 local embeddings, React 19, Zustand 5, Vitest, Node 24 test runner.

## Global Constraints

- Begin only after every completion gate in `docs/superpowers/plans/2026-07-10-jarvis-capture-foundation.md` passes.
- MiniMax base URL is exactly `https://api.minimaxi.com/v1`; requests use `POST /chat/completions`.
- Default incremental model is `MiniMax-M2.7-highspeed`; default final model is `MiniMax-M3`.
- Every request sets `reasoning_split=true`; parse only `choices[0].message.content` as business JSON.
- Final M3 requests set `thinking: {"type":"disabled"}`.
- Send text, timestamps, allowed evidence IDs, and anonymous speaker IDs only; never send raw audio or local display names.
- Store `MINIMAX_API_KEY` only through the imported encrypted secret storage; never return it to the renderer.
- Every fact, decision, commitment, and todo must cite one or more valid transcript segment IDs.
- Suggestions remain suggestions and cannot mutate facts, decisions, commitments, or todos.
- Automatically merge only when normalized cosine similarity is at least 0.86 with the same person, topic, and memory type.
- Similarity from 0.78 through less than 0.86 creates a `possible_duplicate` relation; lower similarity stays separate.
- A todo closes only after explicit transcript evidence or a manual user action.
- Audio expires after seven days; transcript, summary, and evidence-backed memory remain.
- Recording and local transcription must continue during MiniMax errors or network loss.
- Use test-driven development and commit after every task.

## Locked File Structure

```text
app/src/jarvis/
  main/
    MiniMaxClient.js                   # OpenAI-compatible HTTP client, no renderer secrets
    analysisSchema.js                  # Zod model response schema
    AnalysisValidator.js               # Evidence and anonymity enforcement
    retryPolicy.js                     # 401/403 terminal; 429/5xx/network backoff
    TranscriptWindowBuilder.js         # New stable text + relevant anonymous context
    AnalysisScheduler.js               # Ten-minute cursor, idempotency, retry queue
    MemoryMerger.js                    # Deterministic merge/version/conflict rules
    MemorySearchService.js             # FTS + local embedding recall
    FinalSummaryService.js             # M3 session/day summaries
    similarity.js                      # Float32 BLOB and cosine helpers
  renderer/
    AnalysisRail.tsx                   # Current topic/decision/todo/advice cards
    PeopleView.tsx                     # Interaction history and commitments
    TopicsView.tsx                     # Consolidated topic memory
    TodosView.tsx                      # Open/completed todos with evidence
    MemoryView.tsx                     # Search and source navigation
    SessionSummaryView.tsx             # Final summary and source links
    MiniMaxSettings.tsx                # Key state, base URL, models, test button
    JarvisSettingsView.tsx             # Mic/model/retention/privacy/system-audio status
    EvidenceDrawer.tsx                 # Original transcript evidence
    __tests__/*.test.tsx
app/test/jarvis/
  MiniMaxClient.test.js
  AnalysisValidator.test.js
  AnalysisScheduler.test.js
  MemoryMerger.test.js
  MemorySearchService.test.js
  deletionCascade.test.js
  secretLeak.test.js
  fixtures/minimax-analysis.json
```

---

### Task 1: Add Encrypted MiniMax Configuration and a Validated Client

**Files:**
- Create: `app/src/jarvis/main/analysisSchema.js`
- Create: `app/src/jarvis/main/MiniMaxClient.js`
- Create: `app/src/jarvis/main/AnalysisValidator.js`
- Create: `app/test/jarvis/MiniMaxClient.test.js`
- Create: `app/test/jarvis/AnalysisValidator.test.js`
- Create: `app/test/jarvis/fixtures/minimax-analysis.json`
- Modify: `app/src/helpers/environment.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/preload.js`
- Modify: `app/src/types/electron.ts`

**Interfaces:**
- Consumes: encrypted `EnvironmentManager`, built-in `fetch`, stable transcript segment IDs.
- Produces: `MiniMaxClient.chatJson`, `analysisEnvelopeSchema`, `AnalysisValidator.validate`, settings IPC that never returns the secret value.

- [ ] **Step 1: Write failing MiniMax client tests**

Create `app/test/jarvis/MiniMaxClient.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { MiniMaxClient, MiniMaxError } = require("../../src/jarvis/main/MiniMaxClient");

test("sends reasoning_split and parses content only", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: {
        reasoning_content: "private reasoning",
        content: "```json\n{\"summary\":\"完成讨论\",\"topics\":[],\"memories\":[],\"todos\":[],\"suggestions\":[]}\n```",
      }}] }),
    };
  };
  const client = new MiniMaxClient({ apiKey: "unit-test-key", fetchImpl });
  const result = await client.chatJson({
    model: "MiniMax-M2.7-highspeed",
    messages: [{ role: "user", content: "analyze" }],
  });

  assert.equal(request.url, "https://api.minimaxi.com/v1/chat/completions");
  assert.equal(request.body.reasoning_split, true);
  assert.equal(request.options.headers.Authorization, "Bearer unit-test-key");
  assert.equal(result.summary, "完成讨论");
  assert.equal(JSON.stringify(result).includes("private reasoning"), false);
});

test("classifies authorization errors as terminal", async () => {
  const client = new MiniMaxClient({
    apiKey: "bad", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "denied" }),
  });
  await assert.rejects(
    client.chatJson({ model: "MiniMax-M3", messages: [] }),
    (error) => error instanceof MiniMaxError && error.code === "AUTH" && !error.retryable
  );
});
```

- [ ] **Step 2: Write failing schema and evidence tests**

Create `AnalysisValidator.test.js` with an allowed segment set `{"seg-1"}`. Assert a decision citing `seg-1` is accepted, a fact citing `seg-999` is rejected, a suggestion without evidence is accepted, and a payload containing `displayName:"张三"` is rejected before network send.

Use this valid fixture in `fixtures/minimax-analysis.json`:

```json
{
  "summary": "讨论了支付功能上线。",
  "topics": [{"title": "支付功能上线", "evidence_segment_ids": ["seg-1"]}],
  "memories": [{
    "type": "decision",
    "content": "首版仅支持支付宝",
    "person_ref": "self",
    "topic_ref": "支付功能上线",
    "confidence": 0.94,
    "evidence_segment_ids": ["seg-1"]
  }],
  "todos": [{
    "content": "整理验收清单",
    "owner_ref": "self",
    "due_date": null,
    "completed": false,
    "evidence_segment_ids": ["seg-1"]
  }],
  "suggestions": [{
    "content": "明确测试负责人和截止日期",
    "reason": "对话中尚未明确"
  }]
}
```

- [ ] **Step 3: Run the client and validator tests and verify they fail**

```powershell
node --test test/jarvis/MiniMaxClient.test.js test/jarvis/AnalysisValidator.test.js
```

Expected: FAIL because the three main-process modules are missing.

- [ ] **Step 4: Implement the Zod envelope**

Create `analysisSchema.js` using imported `zod`:

```js
const { z } = require("zod");
const evidenceIds = z.array(z.string().min(1)).min(1);
const topic = z.object({ title: z.string().min(1), evidence_segment_ids: evidenceIds });
const memory = z.object({
  type: z.enum(["fact", "decision", "commitment", "opinion"]),
  content: z.string().min(1),
  person_ref: z.string().nullable().default(null),
  topic_ref: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  evidence_segment_ids: evidenceIds,
  relation: z.enum(["new", "reaffirm", "supersedes", "conflicts"]).default("new"),
  related_memory_id: z.string().nullable().default(null),
});
const todo = z.object({
  content: z.string().min(1), owner_ref: z.string().nullable().default(null),
  due_date: z.string().nullable().default(null), completed: z.boolean().default(false),
  evidence_segment_ids: evidenceIds, related_memory_id: z.string().nullable().default(null),
});
const suggestion = z.object({ content: z.string().min(1), reason: z.string().min(1) });
const analysisEnvelopeSchema = z.object({
  summary: z.string(), topics: z.array(topic), memories: z.array(memory),
  todos: z.array(todo), suggestions: z.array(suggestion),
});
module.exports = { analysisEnvelopeSchema };
```

Zod's default object behavior strips unknown fields, matching the design requirement.

- [ ] **Step 5: Implement `MiniMaxClient`**

The class must:

- accept `{ apiKey, baseUrl="https://api.minimaxi.com/v1", fetchImpl=globalThis.fetch, timeoutMs=30000 }`;
- POST to `${baseUrl}/chat/completions`;
- send `reasoning_split:true` for every request;
- add `thinking:{type:"disabled"}` only when requested for M3;
- strip one outer Markdown code fence, parse JSON, and validate with `analysisEnvelopeSchema`;
- never include response bodies or API keys in thrown error messages;
- classify 401/403 as `AUTH` non-retryable, 429 as `RATE_LIMIT` retryable, 5xx as `UPSTREAM` retryable, timeout/network as `NETWORK` retryable, invalid JSON as `INVALID_RESPONSE` retryable once.

Expose:

```js
class MiniMaxClient {
  async chatJson({ model, messages, disableThinking = false, signal })
  async testConnection(model = "MiniMax-M2.7-highspeed")
}
class MiniMaxError extends Error {
  constructor(code, message, { status = null, retryable = false } = {})
}
module.exports = { MiniMaxClient, MiniMaxError };
```

- [ ] **Step 6: Implement anonymity and evidence validation**

Create `AnalysisValidator.js`:

```js
class AnalysisValidator {
  validate(envelope, { allowedSegmentIds, allowedMemoryIds })
  assertAnonymousRequest(window)
}
```

`assertAnonymousRequest` permits speaker refs matching `self|person_[A-Za-z0-9_-]+` and rejects keys named `displayName`, `email`, `realName`, or `audio`. `validate` removes an item when any evidence ID is outside `allowedSegmentIds`; removes `related_memory_id` unless it is inside `allowedMemoryIds`; returns `{ accepted, rejected }` without logging content.

- [ ] **Step 7: Add encrypted MiniMax key methods**

In `environment.js`:

```js
// Add to SECRET_KEYS
"MINIMAX_API_KEY"

getMiniMaxKey() { return this._getKey("MINIMAX_API_KEY"); }
saveMiniMaxKey(key) { return this._saveKey("MINIMAX_API_KEY", key); }
```

Extend the Jarvis repository with `jarvis_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)` and methods `getSetting(key, fallback)` and `setSetting(key, value)`. Store only:

```text
minimax_base_url=https://api.minimaxi.com/v1
minimax_incremental_model=MiniMax-M2.7-highspeed
minimax_final_model=MiniMax-M3
analysis_interval_ms=600000
```

Register IPC:

```js
getMiniMaxConfig()           // returns base URL, model names, hasKey boolean
saveMiniMaxKey(key)          // returns { success:true }, never echoes key
saveMiniMaxConfig(config)    // allow only official HTTPS base and nonempty model strings
testMiniMaxConnection()      // returns { success, code? }, no provider response body
```

- [ ] **Step 8: Run security, client, type, and build checks**

```powershell
node --test test/jarvis/MiniMaxClient.test.js test/jarvis/AnalysisValidator.test.js
npm run typecheck
npm run build:renderer
```

Expected: tests PASS; no Key value appears in returned IPC payloads.

- [ ] **Step 9: Commit the MiniMax boundary**

```powershell
git add app/src/helpers/environment.js app/src/jarvis app/test/jarvis app/preload.js app/src/types/electron.ts
git commit -m "feat: add secure MiniMax analysis client"
```

---

### Task 2: Add the Ten-Minute Idempotent Analysis Scheduler

**Files:**
- Create: `app/src/jarvis/main/retryPolicy.js`
- Create: `app/src/jarvis/main/TranscriptWindowBuilder.js`
- Create: `app/src/jarvis/main/AnalysisScheduler.js`
- Create: `app/test/jarvis/retryPolicy.test.js`
- Create: `app/test/jarvis/TranscriptWindowBuilder.test.js`
- Create: `app/test/jarvis/AnalysisScheduler.test.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/src/jarvis/main/JarvisService.js`
- Modify: `app/main.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`

**Interfaces:**
- Consumes: stable unanalysed segments, MiniMaxClient, AnalysisValidator, clock and timers.
- Produces: `AnalysisScheduler.tick`, retryable `analysis_runs`, renderer progress states, and validated envelopes for MemoryMerger.

- [ ] **Step 1: Write failing retry and anonymous-window tests**

`retryPolicy.test.js` must assert:

```js
assert.equal(nextRetryDelay({ code: "AUTH", attempt: 1 }), null);
assert.equal(nextRetryDelay({ code: "RATE_LIMIT", attempt: 1 }), 60_000);
assert.equal(nextRetryDelay({ code: "NETWORK", attempt: 2 }), 120_000);
assert.equal(nextRetryDelay({ code: "UPSTREAM", attempt: 9 }), 900_000);
```

`TranscriptWindowBuilder.test.js` must insert local people named `张三` and `李四`, build a window, and assert the JSON contains `person_2`/`person_3` but contains neither real name.

- [ ] **Step 2: Write the failing scheduler idempotency test**

Use injected fake clock `now=601000`, fake client, and in-memory repository containing session `s1` and two pending segments. Call `tick()` twice and assert:

- client called once;
- one `analysis_run` exists;
- accepted envelope delivered once to `onEnvelope`;
- segments become `analysis_state='analyzed'` only after `onEnvelope` succeeds.

- [ ] **Step 3: Run tests and verify they fail**

```powershell
node --test test/jarvis/retryPolicy.test.js test/jarvis/TranscriptWindowBuilder.test.js test/jarvis/AnalysisScheduler.test.js
```

Expected: FAIL because scheduler modules and `analysis_runs` methods are missing.

- [ ] **Step 4: Extend the repository analysis schema**

Add:

```sql
CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  input_hash TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  response_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('incremental','final','daily')),
  local_date TEXT,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  content TEXT NOT NULL,
  analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_summary_date
  ON summaries(local_date) WHERE kind = 'daily';
```

Implement `findPendingAnalysisWindow`, `createAnalysisRun`, `updateAnalysisRun`, `listDueAnalysisRuns`, `markSegmentsAnalyzed`, `insertSummary`, and `getLatestAnalysisState`.

- [ ] **Step 5: Implement retry policy and anonymous window builder**

`retryPolicy.js` uses delays `[60000,120000,240000,480000,900000]`, capped at 15 minutes. Return `null` for `AUTH` and non-retryable errors. Return `null` for `INVALID_RESPONSE` after its first repair/retry attempt.

`TranscriptWindowBuilder.build({ sessionId, segments, relatedMemories })` returns:

```js
{
  windowStart,
  windowEnd,
  allowedSegmentIds,
  allowedMemoryIds,
  messages: [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ transcript, related_memories }) }
  ]
}
```

The system prompt must demand the Task 1 JSON schema, prohibit guesses, require evidence IDs, and state that suggestions are not facts. Map local people to anonymous refs in a per-session stable map.

- [ ] **Step 6: Implement `AnalysisScheduler`**

Expose:

```js
class AnalysisScheduler {
  constructor({ repository, clientFactory, validator, windowBuilder, onEnvelope,
                onState, now = Date.now, intervalMs = 600000 })
  start()
  stop()
  async tick(at = this.now())
  async analyzeSessionNow(sessionId, { final = false } = {})
  async retryDue(at = this.now())
}
```

Calculate `input_hash = sha256(model + canonical JSON input)`. Create the run before calling MiniMax. On accepted result, call `onEnvelope` inside the same high-level operation, then mark the run succeeded and segments analyzed. On failure, store only the error code and retry time. Emit state `{ status:'analyzing|waiting|error|ready', code?, lastAnalyzedAt? }` without content.

- [ ] **Step 7: Wire scheduling to recording lifecycle**

Instantiate scheduler in `main.js` after JarvisService. Start it after windows load. JarvisService broadcasts `recording` without triggering analysis before 10 minutes; on pause it leaves pending segments; on finish it sets `finalizing` and calls `analyzeSessionNow(sessionId,{final:true})` after segment persistence settles. In this task, `final:true` means “flush the last incremental window immediately”; it does not create the hierarchical final summary. Task 4 connects `FinalSummaryService` and only then changes the session from `finalizing` to `completed`.

Add IPC `jarvis:analysis:state`, `jarvis:analysis:retry`, and `jarvis:analysis:run-now`. `run-now` is allowed only for a current user-owned session ID and remains disabled when no Key is configured.

- [ ] **Step 8: Run scheduler and foundation regression tests**

```powershell
node --test "test/jarvis/*.test.js"
npm run test:renderer
npm run typecheck
```

Expected: scheduler tests PASS and capture foundation remains PASS.

- [ ] **Step 9: Commit the scheduler**

```powershell
git add app/src/jarvis app/test/jarvis app/main.js app/preload.js app/src/types/electron.ts
git commit -m "feat: schedule idempotent MiniMax analysis"
```

---

### Task 3: Add Evidence-Backed Long-Term Memory and Deterministic Merge Rules

**Files:**
- Create: `app/src/jarvis/main/similarity.js`
- Create: `app/src/jarvis/main/MemoryMerger.js`
- Create: `app/test/jarvis/similarity.test.js`
- Create: `app/test/jarvis/MemoryMerger.test.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/src/jarvis/main/AnalysisScheduler.js`

**Interfaces:**
- Consumes: validated analysis envelopes, `LocalEmbeddings.embedText`, evidence IDs, and existing candidate memories.
- Produces: topics, versioned memories, evidence links, possible-duplicate/conflict relations, and open/completed todo records.

- [ ] **Step 1: Write failing similarity and merge-rule tests**

`similarity.test.js` must assert orthogonal vectors score `0`, equal normalized vectors score `1`, and Float32 BLOB round-trip preserves values.

`MemoryMerger.test.js` must cover these exact cases with injected similarity:

1. score `0.90`, same person/topic/type → one memory, occurrence count becomes 2;
2. score `0.82` → two memories plus one `possible_duplicate` relation;
3. model relation `supersedes` with allowed related ID → new revision points to old memory;
4. model relation `conflicts` → both remain and both need confirmation;
5. suggestion stays type `suggestion`;
6. todo `completed:true` cannot close an existing todo without an evidence segment containing an explicit completion phrase or a manual close flag.

- [ ] **Step 2: Run tests and verify they fail**

```powershell
node --test test/jarvis/similarity.test.js test/jarvis/MemoryMerger.test.js
```

Expected: FAIL because memory tables and merger are missing.

- [ ] **Step 3: Extend the memory schema**

Add:

```sql
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY, canonical_title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  confidence REAL NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  status_source TEXT NOT NULL DEFAULT 'model',
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  supersedes_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  needs_confirmation INTEGER NOT NULL DEFAULT 0,
  due_date TEXT, completed_at INTEGER, embedding BLOB
);
CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  PRIMARY KEY(memory_id, segment_id)
);
CREATE TABLE IF NOT EXISTS memory_relations (
  from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('possible_duplicate','conflicts','related')),
  score REAL,
  PRIMARY KEY(from_memory_id, to_memory_id, relation)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid');
```

Create insert/update/delete triggers to keep `memories_fts` synchronized. Implement candidate, topic, evidence, relation, todo, and analysis-context repository methods used by the merger.

- [ ] **Step 4: Implement similarity helpers**

`similarity.js` exports:

```js
function float32ToBuffer(vector) { return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength); }
function bufferToFloat32(buffer) {
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
```

- [ ] **Step 5: Implement `MemoryMerger`**

Expose:

```js
class MemoryMerger {
  constructor({ repository, embedText, now = Date.now })
  async mergeEnvelope({ sessionId, analysisRunId, envelope, anonymousPersonMap })
  async mergeMemory(candidate, context)
  async mergeTodo(candidate, context)
}
```

Canonicalize whitespace but preserve original wording. Resolve topics case-insensitively. Retrieve candidates by type/person/topic. Embed candidate once. Apply thresholds exactly. A merge adds evidence and increments occurrence count; it does not replace content. `supersedes` creates a new row. `conflicts` creates a new row, marks both confirmation flags, and adds a relation. Store suggestions without evidence as `suggestion`, `confidence<=0.5`, and `needs_confirmation=0` because they are visibly non-factual.

Todo completion phrases for the automatic rule are limited to `已完成|完成了|已经做完|done|completed`; the evidence text itself must contain one. Manual completion bypasses phrase matching but records `status_source='manual'` in repository audit metadata.

- [ ] **Step 6: Connect the merger to scheduler success**

Construct `MemoryMerger` in `main.js` using imported `localEmbeddings.embedText`. Pass:

```js
onEnvelope: ({ sessionId, analysisRunId, envelope, anonymousPersonMap }) =>
  memoryMerger.mergeEnvelope({ sessionId, analysisRunId, envelope, anonymousPersonMap })
```

Only mark an analysis run succeeded after the merge transaction commits.

- [ ] **Step 7: Run merge, repository, and scheduler tests**

```powershell
node --test "test/jarvis/*.test.js"
npm run typecheck
```

Expected: all memory thresholds, conflicts, versions, evidence, and scheduler idempotency tests PASS.

- [ ] **Step 8: Commit the memory core**

```powershell
git add app/src/jarvis app/test/jarvis app/main.js
git commit -m "feat: add evidence-backed long-term memory"
```

---

### Task 4: Add Final Summaries, MiniMax Settings, and Memory Views

**Files:**
- Create: `app/src/jarvis/main/FinalSummaryService.js`
- Create: `app/test/jarvis/FinalSummaryService.test.js`
- Create: `app/src/jarvis/renderer/AnalysisRail.tsx`
- Create: `app/src/jarvis/renderer/PeopleView.tsx`
- Create: `app/src/jarvis/renderer/TopicsView.tsx`
- Create: `app/src/jarvis/renderer/TodosView.tsx`
- Create: `app/src/jarvis/renderer/SessionSummaryView.tsx`
- Create: `app/src/jarvis/renderer/MiniMaxSettings.tsx`
- Create: `app/src/jarvis/renderer/JarvisSettingsView.tsx`
- Create: `app/src/jarvis/renderer/EvidenceDrawer.tsx`
- Create: `app/src/jarvis/renderer/__tests__/AnalysisRail.test.tsx`
- Create: `app/src/jarvis/renderer/__tests__/MemoryViews.test.tsx`
- Modify: `app/src/jarvis/renderer/JarvisShell.tsx`
- Modify: `app/src/jarvis/renderer/TodayView.tsx`
- Modify: `app/src/jarvis/renderer/jarvisStore.ts`
- Modify: `app/src/locales/en/translation.json`
- Modify: `app/src/locales/zh-CN/translation.json`

**Interfaces:**
- Consumes: repository read models, analysis state, MiniMax configuration IPC, and MemoryEvidence.
- Produces: final session summary, live right rail, People/Topics/Todos pages, evidence navigation, and a secure MiniMax setup page.

- [ ] **Step 1: Write failing final-summary and view tests**

`FinalSummaryService.test.js` must prove the M3 request contains incremental summaries and active memories but not the full raw transcript, sets `disableThinking:true`, and persists one `kind='final'` summary.

`AnalysisRail.test.tsx` must render four states: no Key, waiting, analyzing, and ready. Ready must show one current topic, one new todo, and one suggestion while rendering suggestions under an `AI 建议` heading.

`MemoryViews.test.tsx` must verify a person card shows interaction count and commitments; a todo has owner, due date, source button, and explicit manual complete action.

- [ ] **Step 2: Run the tests and verify they fail**

```powershell
node --test test/jarvis/FinalSummaryService.test.js
npm run test:renderer -- src/jarvis/renderer/__tests__/AnalysisRail.test.tsx src/jarvis/renderer/__tests__/MemoryViews.test.tsx
```

Expected: FAIL because services and views are missing.

- [ ] **Step 3: Implement final hierarchical summary**

`FinalSummaryService.createForSession(sessionId)` loads:

- incremental summaries ordered by window;
- active memories and todos from the session;
- anonymous people refs;
- unresolved conflicts.

Call `MiniMax-M3` with `disableThinking:true` and require JSON:

```json
{
  "overview": "",
  "people": [{"person_ref":"person_2","discussed":[]}],
  "topics": [{"title":"","outcome":"","next_steps":[]}],
  "decisions": [],
  "commitments": [],
  "todos": [],
  "suggestions": [],
  "needs_confirmation": []
}
```

Persist the JSON string in `summaries.content`, broadcast `summary-ready`, and set session status `completed`. On failure, keep session `finalizing` with a retryable summary job; recording remains closed.

Also implement `createDaily(localDate)` using completed session summaries and memories for that local calendar day, never raw transcript. Store `kind='daily'`. Trigger it after a session final summary with a five-minute debounce and from an explicit `生成今日总结` button. Multiple triggers for the same day must upsert one daily summary by a unique `(kind, local_date)` key.

- [ ] **Step 4: Implement secure MiniMax settings**

`MiniMaxSettings.tsx` receives only:

```ts
type MiniMaxConfigView = {
  baseUrl: "https://api.minimaxi.com/v1";
  incrementalModel: string;
  finalModel: string;
  hasKey: boolean;
};
```

Use a password input whose state is cleared immediately after `saveMiniMaxKey`. Never prefill or read the stored Key. Include `测试连接`; render only `连接成功`, `Key 无效`, `订阅不支持所选模型`, `网络不可用`, or `服务暂时不可用`.

Compose `MiniMaxSettings` inside `JarvisSettingsView`. The full settings view also includes the selected microphone, local transcription model (`turbo` recommended for Chinese), self-voice enrollment status, audio retention fixed to 7 days for the MVP, and a disabled system-audio row labeled `电脑声音：即将支持`. Add a privacy note stating that transcript text is protected by the Windows user account and disk encryption rather than application-level database encryption, and recommend BitLocker on the data volume.

- [ ] **Step 5: Implement AnalysisRail and memory views**

`AnalysisRail` reads the latest incremental summary, topics, new todos, and suggestions. `PeopleView`, `TopicsView`, and `TodosView` query paginated repository read models through IPC. Every factual row has `查看来源`; clicking opens `EvidenceDrawer` with timestamp, anonymous/local display label, and transcript text.

Do not display suggestion content inside facts, decisions, or todo sections. Use badges `待确认`, `可能重复`, and `已被新决定替代` based on memory state.

- [ ] **Step 6: Wire navigation and live refresh**

Extend JarvisShell navigation IDs to `today | people | topics | todos | memory | settings`. Subscribe to `jarvis:state-changed`, `jarvis:analysis:state`, and `jarvis:memory:changed`; reload only the affected view. Do not poll faster than once per second.

- [ ] **Step 7: Add localized copy and run UI checks**

Add the same key set for connection states, memory types, confirmation badges, empty states, source drawer, and summary sections to all supported locale files (`en`, `de`, `es`, `fr`, `it`, `ja`, `pt`, `ru`, `zh-CN`, `zh-TW`). Use reviewed Chinese and English values; use English fallback values in other locales when needed so `i18n:check` remains strict. Then run:

```powershell
node --test test/jarvis/FinalSummaryService.test.js
npm run test:renderer
npm run typecheck
npm run i18n:check
npm run build:renderer
```

Expected: all checks PASS.

- [ ] **Step 8: Commit summaries and views**

```powershell
git add app/src/jarvis app/test/jarvis app/src/locales app/preload.js app/src/types/electron.ts
git commit -m "feat: add Jarvis summaries and memory views"
```

---

### Task 5: Add Hybrid Memory Search and Source Traceability

**Files:**
- Create: `app/src/jarvis/main/MemorySearchService.js`
- Create: `app/test/jarvis/MemorySearchService.test.js`
- Create: `app/src/jarvis/renderer/MemoryView.tsx`
- Create: `app/src/jarvis/renderer/__tests__/MemoryView.test.tsx`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/preload.js`
- Modify: `app/src/types/electron.ts`
- Modify: `app/src/jarvis/renderer/JarvisShell.tsx`

**Interfaces:**
- Consumes: SQLite FTS5, local MiniLM embeddings, people/topic/date filters, evidence rows.
- Produces: ranked memory search results with source transcript links and no cloud dependency.

- [ ] **Step 1: Write the failing hybrid search test**

Create three memories: `首版仅支持支付宝`, `周五整理验收清单`, and unrelated `午饭吃面`. Inject embeddings so query `支付方案是什么` has semantic score `0.92` for the first memory. Assert:

- semantic match ranks first even without exact token overlap;
- person/date filters remove nonmatching results;
- each result includes at least one evidence segment;
- empty query returns recent memories, not all transcript bodies.

- [ ] **Step 2: Run the test and verify it fails**

```powershell
node --test test/jarvis/MemorySearchService.test.js
```

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement repository search primitives**

Add:

```js
searchMemoryFts(query, { personId, topicId, from, to, limit })
listMemoryCandidates({ personId, topicId, from, to, limit = 200 })
getMemoryWithEvidence(memoryId)
getRecentMemories(limit = 50)
```

FTS results return normalized BM25 lexical scores. Candidate rows include Float32 embedding BLOBs but renderer IPC results must not include raw embedding bytes.

- [ ] **Step 4: Implement hybrid ranking**

`MemorySearchService.search(query, filters)`:

1. For an empty trimmed query, return recent memories.
2. Run FTS and candidate fetch in parallel.
3. Embed query locally.
4. Compute semantic cosine score for candidates.
5. Normalize lexical score to `[0,1]`.
6. Rank by `0.65 * semantic + 0.35 * lexical`.
7. Keep results with semantic at least `0.45` or a lexical match.
8. Attach top evidence timestamp and text after ranking; default limit 30.

If the embedding model is unavailable, return FTS results and expose `semanticAvailable:false`; do not call MiniMax for search.

- [ ] **Step 5: Add IPC and MemoryView**

Expose `jarvis.searchMemory(query, filters)` and `jarvis.getMemoryWithEvidence(id)`. `MemoryView.tsx` contains one search field and filters for person, topic, and date range. Debounce by 250 ms, cancel stale requests using an incrementing request ID, show whether semantic search is available, and render the source button for each result.

- [ ] **Step 6: Run search tests, typecheck, and renderer tests**

```powershell
node --test test/jarvis/MemorySearchService.test.js
npm run test:renderer -- src/jarvis/renderer/__tests__/MemoryView.test.tsx
npm run typecheck
npm run build:renderer
```

Expected: all checks PASS; search works when MiniMax is unavailable.

- [ ] **Step 7: Commit memory recall**

```powershell
git add app/src/jarvis app/test/jarvis app/preload.js app/src/types/electron.ts
git commit -m "feat: add local hybrid memory search"
```

---

### Task 6: Harden Deletion, Error Recovery, Secret Safety, and Ship the Windows MVP

**Files:**
- Create: `app/test/jarvis/deletionCascade.test.js`
- Create: `app/test/jarvis/secretLeak.test.js`
- Create: `app/test/jarvis/endToEndAnalysis.test.js`
- Create: `app/scripts/verify-no-secrets.js`
- Create: `app/docs/JARVIS-UAT.md`
- Modify: `app/package.json`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/src/jarvis/main/AnalysisScheduler.js`
- Modify: `app/src/jarvis/main/JarvisService.js`
- Modify: `app/src/jarvis/renderer/TodayView.tsx`

**Interfaces:**
- Consumes: all capture and intelligence modules.
- Produces: correct deletion cascades, visible failure states, automated secret scan, deterministic fake-MiniMax end-to-end test, and final unsigned Windows installer/portable artifacts.

- [ ] **Step 1: Write failing deletion and secret tests**

`deletionCascade.test.js` creates two sessions sharing one memory through two evidence rows. Delete session A and assert its audio/transcript/summary/analysis rows disappear while shared memory remains with session B evidence. Delete B and assert the now-evidence-free factual memory disappears. A suggestion may remain only when it is explicitly global; session suggestions are deleted.

`secretLeak.test.js` constructs a fake subscription-shaped value at runtime with `["sk", "cp", "unit", "test", "secret", "value"].join("-")`, writes it through EnvironmentManager's MiniMax method, then asserts it is absent from `.env`, `jarvis.db`, and captured debug logs while an encrypted `MINIMAX_API_KEY.enc` exists. Do not place a literal subscription-key prefix and value together in any tracked fixture.

- [ ] **Step 2: Write the failing end-to-end analysis test**

Create a local HTTP fake MiniMax server on `127.0.0.1` with a random port. Insert a session and transcript, run scheduler tick, return `fixtures/minimax-analysis.json`, finalize the session, and assert:

- one analysis run succeeded;
- one decision, one todo, one suggestion, and evidence links exist;
- final summary exists;
- search for `支付方案` returns the decision;
- the fake server received no audio path, `.wav`, display name, or API key in the JSON body.

- [ ] **Step 3: Run the new tests and verify they fail**

```powershell
node --test test/jarvis/deletionCascade.test.js test/jarvis/secretLeak.test.js test/jarvis/endToEndAnalysis.test.js
```

Expected: at least deletion cascade and end-to-end tests FAIL before hardening.

- [ ] **Step 4: Implement session deletion as a transaction**

Add `deleteSession(sessionId)`:

1. Return audio paths before database mutation.
2. Delete files; treat missing files as success, abort on other file errors.
3. In one transaction delete session, cascading transcript, summary, run, and evidence rows.
4. Delete factual memories with zero remaining evidence.
5. Delete session-scoped suggestions with zero evidence.
6. Recalculate topic last-seen dates and delete empty topics.
7. Delete the affected day's aggregate summary and enqueue daily-summary regeneration from remaining sessions.
8. Return counts only.

Expose a confirmation dialog in TodayView that states audio, transcript, summary, and exclusive memories will be removed.

- [ ] **Step 5: Implement explicit UI failure states**

Map codes exactly:

```text
AUTH              -> MiniMax Key 无效，请重新输入
MODEL_NOT_ALLOWED -> 当前订阅不支持所选模型
RATE_LIMIT        -> MiniMax 请求较多，稍后自动重试
NETWORK           -> 网络不可用；录音和转写仍在继续
UPSTREAM          -> MiniMax 暂时不可用；稍后自动重试
INVALID_RESPONSE  -> 分析格式异常；正在重新处理
MIC_PERMISSION    -> 未获得麦克风权限，录音已暂停
MIC_DISCONNECTED  -> 麦克风已断开，录音已暂停
DISK_SPACE_LOW    -> 磁盘空间不足，录音已停止
```

Only AUTH and MODEL_NOT_ALLOWED require user action. Retriable errors show next retry time. Never render provider response bodies.

- [ ] **Step 6: Add automated secret scanning**

Create `scripts/verify-no-secrets.js` that scans tracked text files, built renderer assets, and packaged config for:

```js
const patterns = [
  /sk-cp-[A-Za-z0-9_-]{16,}/g,
  /Authorization\s*:\s*Bearer\s+[A-Za-z0-9_-]{16,}/gi,
  /MINIMAX_API_KEY\s*=\s*[^\s]+/g,
];
```

Ignore the pattern source file itself by scanning content after replacing the literal test pattern tokens. Fail with file paths and line numbers, never print the matched secret. Add:

```json
"verify:no-secrets": "node scripts/verify-no-secrets.js"
```

- [ ] **Step 7: Make all automated checks pass**

```powershell
npm run test:jarvis
npm run typecheck
npm run i18n:check
npm run lint
npm run build:renderer
npm run verify:no-secrets
```

Expected: every command PASS.

- [ ] **Step 8: Write and execute the conversational UAT checklist**

Create `app/docs/JARVIS-UAT.md` with unchecked evidence fields for:

1. enter a newly rotated MiniMax subscription Key in settings;
2. test connection;
3. record a real 12-minute Chinese two-person conversation;
4. verify live transcript latency target of about 5 seconds;
5. rename the other speaker and mark self;
6. verify a ten-minute topic/todo/advice update;
7. finish and verify final summary sections;
8. search by person, topic, date, and natural-language paraphrase;
9. open evidence from one decision and one todo;
10. disable network during a second recording, then restore it and verify deferred analysis;
11. use a test clock or repository fixture to verify seven-day audio cleanup;
12. delete a session and verify cascade behavior.

Fill the evidence fields with timestamps and results during execution; do not mark a step complete without observing it.

- [ ] **Step 9: Build and smoke-test unsigned Windows artifacts**

```powershell
npm run build:win:unsigned
npm run verify:no-secrets
Get-ChildItem dist -File | Select-Object Name,Length,LastWriteTime
```

Install or launch the portable artifact, repeat a three-minute recording, close and reopen the app, and verify session/search persistence. Confirm the taskbar recording state remains visible while the window is minimized.

- [ ] **Step 10: Commit the MVP and record build evidence**

```powershell
git add app/src app/test app/scripts app/docs app/package.json app/package-lock.json
git commit -m "feat: complete Jarvis memory assistant MVP"
git status --short
git log --oneline --decorate -12
```

Expected: status is clean. Build artifacts remain untracked in `app/dist`; the delivery message identifies their local paths without committing binaries.

## MVP Completion Gate

The MVP is complete only when:

- all automated checks in Task 6 Step 7 pass;
- the full UAT checklist contains observed evidence;
- raw audio never appears in a MiniMax request;
- API Key never appears in source, database, logs, renderer bundles, or Git;
- network and MiniMax errors do not interrupt recording/transcription;
- memory results link back to valid transcript evidence;
- seven-day audio cleanup and session deletion behave as specified;
- the Windows portable build launches and persists data on the target computer.
