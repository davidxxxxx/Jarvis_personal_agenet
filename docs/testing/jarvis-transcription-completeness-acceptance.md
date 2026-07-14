# Jarvis Transcript Completeness Acceptance

This gate proves durable recovery and transcript-readiness invariants without using a microphone,
network service, real Whisper inference, or CUDA. Model-quality and hardware acceptance are separate,
consented local checks and must never be inferred from this automated gate.

## Automated commands

Run from `app/`.

Focused copied-database recovery gate:

```powershell
node --test --test-concurrency=1 test/jarvis/ExistingRecordingBackfill.test.js
```

Canonical full Jarvis main and renderer gate:

```powershell
npm run test:jarvis
```

For a controlled-concurrency Task 7 run that excludes only the already-approved three-virtual-hour
capture simulation, expand the canonical gate as follows:

```powershell
$mainTests = Get-ChildItem test/jarvis/*.test.js |
  Where-Object Name -ne 'AllDayCaptureSoak.test.js' |
  ForEach-Object FullName
node --test --test-concurrency=1 $mainTests
npm run test:renderer -- --maxWorkers=1
```

The excluded simulation is `npm run test:jarvis:capture-soak`. It advances a deterministic virtual
clock by three hours; it is not a three-hour wall-clock or physical-device test. Task 7 does not
substitute a shorter result or claim that this simulation validates real hardware.

Static, locale, and renderer gates:

```powershell
npm run typecheck
npm run lint
npm run i18n:check
npm run build:renderer
```

JSON and patch hygiene checks used by this gate:

```powershell
node -e "for (const p of ['src/locales/en/translation.json','src/locales/zh-CN/translation.json']) JSON.parse(require('node:fs').readFileSync(p, 'utf8'))"
git diff --check
```

## Readiness invariant

The copied-database test inspects the migrated database directly. The minimum invariant query is:

```sql
SELECT session.id AS session_id, job.id AS job_id, job.state
FROM sessions AS session
JOIN processing_jobs AS job ON job.session_id = session.id
WHERE session.processing_state = 'ready'
  AND job.chunk_id IS NOT NULL
  AND job.job_type = 'transcribe_chunk'
  AND job.state <> 'completed';
```

Acceptance requires zero rows. The gate also checks that each retained committed chunk has exactly
one durable chunk job in the fixture, that blocked jobs have a non-empty safe `error_code`, and that
a copied database remains idempotent after backfill, runtime drain, close, and reopen. A session with
a missing required transcription job, a non-terminal chunk transcription state, or missing final
coverage must not be marked `ready`.

## Consented local bilingual evaluation

This procedure may run only after every recorded speaker has consented. Fixtures stay on the local
machine and must not be uploaded. Use one frozen manifest and keep the `near_field` and `noisy`
cohorts separate throughout scoring.

Canonical manifest input:

```json
{
  "schemaVersion": 1,
  "fixtureSetId": "jarvis-private-bilingual-v1",
  "fixtures": [
    {
      "id": "stable-fixture-id",
      "cohort": "near_field",
      "language": "zh-CN|en-US|mixed",
      "audioPath": "local absolute path",
      "audioSha256": "64 lowercase hex characters",
      "referenceText": "consented reference transcript",
      "customTerms": ["locked name or glossary term"]
    }
  ]
}
```

The manifest must contain at least one Chinese and one English near-field fixture. Noisy fixtures use
`"cohort": "noisy"`; their scores are reported independently and are never merged into near-field
aggregates. Hash the exact UTF-8 manifest bytes with SHA-256 before inference and preserve that hash
with the results.

For every fixture, run the selected local model with one frozen model/backend/version/configuration
and record this output shape:

```json
{
  "fixtureId": "stable-fixture-id",
  "transcript": "model output",
  "model": "selected model",
  "backend": "actual backend",
  "version": "runtime and model version",
  "startedAt": "ISO-8601 timestamp",
  "completedAt": "ISO-8601 timestamp",
  "hardware": { "cpu": "observed value", "gpu": "observed value or null" },
  "failure": null,
  "skipReason": null
}
```

Score Chinese CER as character-level edit distance divided by reference-character count, English WER
as word-level edit distance divided by reference-word count, and custom-name/glossary recall as
matched locked terms divided by all locked terms. Record normalization and tokenization rules with
the report; do not silently drop failed fixtures.

Locked near-field thresholds:

- Chinese CER must be `<= 15%`.
- English WER must be `<= 20%`.
- Custom-name and glossary recall must be `>= 90%`.
- Noisy-cohort metrics are reported separately and never merged into near-field scores.

Every result report must include model/backend/version, manifest SHA-256, timestamp, per-fixture
metrics, near-field aggregate metrics, separate noisy metrics, failures, skips, and observed
hardware/runtime facts.

## Truthful current status

| Check | Status | Evidence boundary |
| --- | --- | --- |
| Copied-database automated recovery | `PASS` | On 2026-07-14 the focused gate passed 1/1; the controlled non-soak main gate passed 707 with 2 platform skips and the renderer gate passed 218/218. No quality or hardware inference. |
| Consented private bilingual fixtures | `BLOCKED BY MISSING PRIVATE FIXTURES` | No private fixture set is present in the repository. |
| CER/WER/glossary scorer automation | `AUTOMATION PENDING` | The repository contains no scorer command; none is invented here. |
| Selected local model bilingual quality | `NOT RUN` | No passing CER/WER/recall values are claimed. |
| CUDA/local GPU validation | `NOT RUN` | Task 7 neither installs nor validates CUDA. |
