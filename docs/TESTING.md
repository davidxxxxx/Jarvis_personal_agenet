# Testing

## Phase 4 release acceptance

The canonical Phase 4 matrix is
[`testing/jarvis-phase4-release-acceptance.md`](testing/jarvis-phase4-release-acceptance.md).
It separates `PASS`, `NOT RUN`, and `BLOCKED`, and does not treat deterministic simulations as
physical-hardware or live-network approval.

Run its machine boundary from `app/`:

```powershell
Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app
$env:TEMP='G:\Jarvis\.runtime-cache\temp'
$env:TMP=$env:TEMP
node --test test/jarvis/ReleaseAcceptanceMatrix.test.js
```

All release evidence and disposable profiles belong under
`G:\Jarvis\.release-evidence\phase-4\`; do not use the system drive for generated artifacts.

## Testing private speaker identity quality

The speaker quality gate is deliberately local and consent-gated. The repository tracks only the anonymous manifest in `app/test/fixtures/speaker-eval/manifest.json`; it must never contain audio, embeddings, transcript text, real identities, or machine paths. No data is downloaded by the gate, and local inference is the only supported execution mode.

## Private fixture setup

Use this repository-local layout (or an absolute directory outside the repository):

```text
.private/speaker-eval/
  consent.json
  profiles/self-01.wav
  profiles/known-a-01.wav
  cases/case-owner-known-unknown.wav
```

All WAV files must be readable PCM, mono, 16-bit, 16 kHz files. The case audio must match every interval in the tracked anonymous manifest. Each profile and each case speaker needs enough clean speech to satisfy the production minimum speech and window policy.

Create the untracked `.private/speaker-eval/consent.json` yourself:

```json
{ "consented": true }
```

Then opt in explicitly and run the dedicated gate from `app/`:

```powershell
$env:JARVIS_SPEAKER_EVAL_DIR="G:\Jarvis\.private\speaker-eval"
npm run test:speaker-eval
```

The gate never creates or populates this directory. If `JARVIS_SPEAKER_EVAL_DIR` is unset, or its resolved directory is missing, the test skips with the exact path and setup hint. Once the directory exists, missing, false, malformed, unreadable, symlinked, or tracked consent fails. Malformed metadata, unsafe paths, corrupt WAV files, segment bounds outside the WAV, or missing production models also fail; none of those states may skip.

## Metrics and release gates

Predicted diarization clusters are matched to truth with deterministic maximum-weight overlap matching. The anonymous aggregate report includes exact speaker-count accuracy, self/known precision and recall, unknown false-positive rate, corrections needed, integer support, and score/margin boundary evidence for every automatic confirmation.

The hard gates are:

- self automatic precision at least `0.95`, with `truthSupport > 0` and `automaticSupport > 0`;
- known automatic precision at least `0.95`, with `truthSupport > 0` and `automaticSupport > 0`;
- unknown false-positive rate at most `0.05`, with `truthSupport > 0`;
- every automatic confirmation meets the imported production score and margin thresholds.

Undefined ratios remain `null`. Zero automatic confirmations cannot pass a precision gate. Test output is limited to anonymous IDs and aggregate metrics; it does not print audio, vectors, transcript content, or private paths.

Before publishing changes, verify the privacy boundary from the repository root:

```powershell
git check-ignore -v .private/speaker-eval/consent.json
git ls-files .private app/test/fixtures/speaker-eval | rg "(^|/)(consent\.json|.*\.(wav|flac|pcm))$"
```

The first command must identify `/.private/speaker-eval/`; the second must return no files.
