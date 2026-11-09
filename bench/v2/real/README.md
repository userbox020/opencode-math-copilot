# Real-adapter exploratory pilot — 2026-11-09

**Status: exploratory, provisional tasks, not confirmatory paper evidence.** This artifact records a 90-episode real-adapter pilot. It is not the planned 360-episode pilot and does not replace owner-reviewed test tasks.

## Artifact

- Directory: `bench/v2/real/pilot-2026-11-09-opencode-go-deepseek-v4.1-flash/`
- Model: `opencode-go/deepseek-v4.1-flash` (one model, one repeat, one attempt)
- Tasks: `bench/v2/tasks/pilot-v1.json` (30 provisional tasks; `owner-review-pending`)
- Episodes: 90/90 started and terminal; 0 missing; 0 pending; 0 unknown-cost episodes
- Total observed cost: **$0.1680**; maximum single episode: $0.0103; all 90 under every registered budget
- Manifest: `manifest.json`; report: `report.json`, `report.md`; receipts: `receipts/`
- The credential copy used to launch the model is **not** in this artifact and must not be committed.

## Overall result

| Condition | Correct / started | Rate | Extraction failures |
|---|---:|---:|---:|
| A (no tools) | 18/30 | 60.0% | 0 |
| B (generic tools) | 15/30 | 50.0% | 6 |
| F (full plugin) | 14/30 | 46.7% | 4 |

Primary paired contrast **F−B = −3.33 percentage points**; exploratory 95% family-bootstrap interval **[-10, 0]** (10,000 resamples, 6 thematic families, seed 20261108). The interval includes zero and the point estimate is negative. This pilot does **not** support a claim that the plugin improves success.

## By track

| Track | A | B | F |
|---|---:|---:|---:|
| Retrieval (supplied excerpts) | 6/6 | 4/6 | 5/6 |
| Computation | 5/6 | 4/6 | 2/6 |
| Formal | 6/6 | 6/6 | 6/6 |
| Error detection | 0/6 | 0/6 | 0/6 |
| Absence | 1/6 | 1/6 | 1/6 |
| **Overall** | **18/30** | **15/30** | **14/30** |

The retrieval and computation tracks are extraction-style development tasks. The error-detection and absence tracks use exact-text/hash/scope fixtures; their near-zero rates are grader-fixture limitations, not estimates of general explanation quality.

## Formal receipts

- 18 formal episodes (6 tasks x A/B/F) were graded through the evaluator-controlled Lean bridge.
- All 18 receipts: `execution=completed`, `compilation=compiled`, `target=identified`, `proof=verified`.
- All 18 formal episodes were graded correct under the fixed Init-only targets and empty axiom policy.
- This establishes the recorded targets under the recorded policy; it is not an independent kernel recheck, informal-correspondence review, or evidence of general formalization ability.

## Failure accounting

- B: 6 extraction failures; F: 4 extraction failures; A: 0.
- No operational failures, over-budget episodes, unknown-cost episodes, or pending starts.
- Tool calls: A 0, B 68, F 104. F used more tools and more tokens (340,275) than B (220,464) and A (72,002), with a higher observed cost ($0.0802 vs $0.0633 and $0.0246).
- The paired contrast uses all started episodes; failures remain in the denominator.
- The F condition did not receive a favorable timeout: the study used the registered 600 s wall-clock budget and the adapter honored it.

## Method notes

- OpenCode 2.0.29 CLI with a **safe credential-home copy**: config/cache plus a 19 MB SQLite store containing the host credential rows only (no 42 GB session database). The host auth store was never exposed to the agent workspace; the copy was used to launch the provider.
- The model was resolved by `opencode models --standalone` before dispatch; the runtime audit observed the staged plugin load and checked static permissions/registrations.
- Each episode used a fresh workspace, external HOME/data/state, staged `.js` plugin discovery, and the evaluator-controlled graders/receipts. F used the staged math indexes and `MATH_TOOLKIT_MATH_ROOT`.
- Usage was recovered from `opencode session export`; the layered cost comes from the provider step records.
- The task excerpts were included in the public `task.json` for every condition; B also received the public corpus file.

## Free-model feasibility (not this pilot)

- `opencode/deepseek-v4.1-flash-free`, GLM and MiMo free routes returned free-quota errors.
- `free-kilo` Nemotron completed A but produced extraction failures on B/F; Kilo-auto produced extraction failures on A/B/F.
- `free-ollama-cloud/deepseek-v4.1-flash:1017` was not included in the free plan (`402`).
- These free routes were therefore not used for the 90-episode pilot. They remain a negative feasibility result, not a model comparison.

## What this artifact does not establish

- It does not establish mathematical accuracy in general, an F−B improvement, or a population-of-models effect.
- The 30 tasks are provisional development/validation material, with one repeat and one model; family intervals are exploratory.
- The explanation/absence tracks are fixture checks, not blinded human adjudication.
- The formal tasks are simple Init-only targets; 18/18 is a ceiling check, not a broad formalization benchmark.
- The safe credential home is a copy, not an OS sandbox; the F condition has shell-equivalent capability in the full interface. Do not treat this as a security guarantee.
