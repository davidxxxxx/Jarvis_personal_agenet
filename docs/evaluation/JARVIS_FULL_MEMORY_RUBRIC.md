# Jarvis Full Memory Human Evaluation Rubric

## Purpose

Use this template after `npm run test:full-memory-eval` passes. The automatic gate proves the structural, evidence, idempotency, todo-lifecycle, privacy, and navigation invariants. Human review judges whether each synthetic fixture is actually useful and faithful.

Do not add real names, audio paths, credentials, raw audio, or production transcripts to this document. Review only the tracked anonymous fixture corpus and its local gate result.

## Release thresholds

Scores use a 1-5 integer scale. Do not use `N/A`; for rejection fixtures, score how well the fail-closed result protects each dimension.

- Each dimension: >= 3
- Average: >= 4
- Any critical privacy, evidence, todo-completion, or navigation failure is an automatic release failure regardless of score.

The per-fixture average is:

`(Summary faithfulness + Topic usefulness + Todo precision + Person attribution + Suggestion grounding) / 5`

Every fixture must meet both numeric thresholds. The corpus is release-ready only when all 12 fixture rows pass.

## Score anchors

| Score | Meaning                                                                             |
| ----- | ----------------------------------------------------------------------------------- |
| 1     | Harmful or materially fabricated; contradicts evidence or creates an unsafe action. |
| 2     | Major omissions or attribution errors make the result unreliable.                   |
| 3     | Acceptable and evidence-backed, with noticeable but non-blocking weaknesses.        |
| 4     | Strong, concise, useful, and correctly grounded.                                    |
| 5     | Excellent; complete for the fixture without speculation or noise.                   |

## Dimension guidance

### Summary faithfulness

Check whether the summary preserves the transcript's actual meaning, handles corrections and conflicts, and avoids inventing facts. A malformed or ungrounded candidate should fail closed.

### Topic usefulness

Check whether topics are canonical, non-duplicative, specific enough to browse, and supported by source evidence. Repeated mentions of one topic should not create duplicate topics.

### Todo precision

Check whether todos come only from an explicit SELF commitment or a clearly assigned-and-accepted action. Owners and due text must remain null when ambiguous or absent. AI output must never complete a todo.

### Person attribution

Check whether only `SELF` and pseudonymous `P<n>` evidence labels are used, uncertain ownership stays uncertain, and no identity is inferred from a speaker cluster.

### Suggestion grounding

Check whether each suggestion is useful, proportionate, and tied to cited evidence and an allowed basis. Empty or noisy input should not produce speculative advice.

## Review record

- Reviewer:
- Date:
- Commit or build:
- Automatic gate result:

| Fixture | Coverage            | Summary faithfulness | Topic usefulness | Todo precision | Person attribution | Suggestion grounding | Average | Pass/Fail | Notes |
| ------- | ------------------- | -------------------: | ---------------: | -------------: | -----------------: | -------------------: | ------: | --------- | ----- |
| fm-01   | chinese             |                      |                  |                |                    |                      |         |           |       |
| fm-02   | english             |                      |                  |                |                    |                      |         |           |       |
| fm-03   | mixed-language      |                      |                  |                |                    |                      |         |           |       |
| fm-04   | repeated-topic      |                      |                  |                |                    |                      |         |           |       |
| fm-05   | ambiguous-owner     |                      |                  |                |                    |                      |         |           |       |
| fm-06   | missing-due-date    |                      |                  |                |                    |                      |         |           |       |
| fm-07   | correction          |                      |                  |                |                    |                      |         |           |       |
| fm-08   | conflicting-claims  |                      |                  |                |                    |                      |         |           |       |
| fm-09   | empty-noisy         |                      |                  |                |                    |                      |         |           |       |
| fm-10   | malformed-json      |                      |                  |                |                    |                      |         |           |       |
| fm-11   | unknown-evidence-id |                      |                  |                |                    |                      |         |           |       |
| fm-12   | duplicate-retry     |                      |                  |                |                    |                      |         |           |       |

## Sign-off

- Lowest dimension score across the corpus:
- Lowest per-fixture average:
- Critical failures found:
- Release decision:
- Reviewer notes:
