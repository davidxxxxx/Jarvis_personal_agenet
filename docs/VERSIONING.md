# Jarvis version and GitHub release policy

Jarvis uses Semantic Versioning independently from the upstream OpenWhispr version.

Current source candidate: `0.2.0-rc.13` with unchanged database schema target `v60`.
This is a behavior-preserving modularization checkpoint, not a new Windows package or a claim of
production recording acceptance. See [the rc.13 verification record](testing/rc13-modularization.md).
Historical rc.12 package/runtime evidence remains associated with rc.12 and is not inherited as proof
for a new binary. Three-hour endurance and fresh physical-microphone recording remain separate gates.

## Version line

| Milestone              | App version     | Git tag                 | Meaning                                   |
| ---------------------- | --------------- | ----------------------- | ----------------------------------------- |
| Existing baseline      | `0.1.0`         | `jarvis-v0.1.0`         | Last known desktop MVP baseline           |
| Phase 1 complete       | `0.2.0-alpha.1` | `jarvis-v0.2.0-alpha.1` | Application-source and capture foundation |
| Phase 2 complete       | `0.2.0-alpha.2` | `jarvis-v0.2.0-alpha.2` | Identity and activity classification      |
| Phase 3 complete       | `0.2.0-beta.1`  | `jarvis-v0.2.0-beta.1`  | Actions and personalization               |
| Phase 4 acceptance     | `0.2.0-rc.12`   | `jarvis-v0.2.0-rc.12`   | Packaged release candidate                |
| Module organization    | `0.2.0-rc.13`   | `jarvis-v0.2.0-rc.13`   | Source-only maintenance checkpoint        |
| Final verified release | `0.2.0`         | `jarvis-v0.2.0`         | User-facing stable release                |

Database versions and app versions are deliberately separate. For example, schema `v33` is an
internal migration target and does not imply app version `33`.

## Source-control rules

- Integration stays on `codex/jarvis-start-budget-ui`; isolated `codex/` worktrees may fast-forward
  that branch after verification. Do not overwrite or stage an unrelated dirty root checkout.
- Each phase receives a focused checkpoint commit after its scoped tests pass.
- A phase version is changed only after all tasks and gates for that phase pass.
- Every packaged artifact records the app version, full Git commit, schema target, build time, and
  verification state.
- Tags are annotated and immutable. A failed build gets a new prerelease version; an existing tag
  is never moved.
- `CHANGELOG.md` is updated before every version tag.
- `npm run release:check -- --tag jarvis-vX.Y.Z` must pass before creating a tag.

## GitHub tracking

The user-owned `origin` is
`https://github.com/davidxxxxx/Jarvis_personal_agenet.git`; the upstream OpenWhispr remote must not
receive Jarvis branches or tags. Draft PR #1 is the durable prerelease change log and must be updated
instead of creating duplicate pull requests.

Each GitHub prerelease should contain:

- version and full commit SHA;
- completed phase/tasks;
- automated test and Windows package results;
- known blockers and manual UAT state;
- artifact SHA-256 values;
- migration and rollback notes.

Generated release evidence, models, recordings, databases, secrets, and user profiles stay on the
G drive and are never committed or uploaded.

The lightweight `.github/workflows/jarvis-version-release.yml` workflow validates every Jarvis tag
without downloading models or building the desktop package. A successful `jarvis-v*` tag creates a
draft GitHub Release. The signed or unsigned Windows artifact is attached only after the separate
Windows package and smoke-test gate passes.

## First GitHub setup

After creating an empty user-owned GitHub repository, run these commands once from the Jarvis
worktree:

```powershell
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin codex/jarvis-start-budget-ui
```

Do not rename or replace the `openwhispr` remote. It remains fetch-only in practice for upstream
comparison; Jarvis branches and tags go only to `origin`.

## Phase release sequence

```powershell
# From the verified worktree's app/ directory:
npm run release:check -- --tag jarvis-vX.Y.Z
cd ..
git tag -a jarvis-vX.Y.Z -m "Jarvis Memory X.Y.Z"
git push origin HEAD:codex/jarvis-start-budget-ui
git push origin jarvis-vX.Y.Z
```

Never move or overwrite a published tag. If a tagged build fails acceptance, increment the
prerelease number and create a new commit and tag.
