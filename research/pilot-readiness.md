# Real pilot readiness

**Status: exploratory 90-episode pilot completed; confirmatory pilot not run.** The pilot used one model (`opencode-go/deepseek-v4.1-flash`), one repeat, and the 30 provisional tasks. It is not confirmatory paper evidence and does not support an improvement claim.

## What was run

- 90/90 episodes started and terminal; 0 missing, 0 pending, 0 unknown-cost, 0 over-budget.
- Conditions: A 18/30, B 15/30, F 14/30.
- Primary paired contrast F−B: −3.33 percentage points; exploratory 95% family-bootstrap interval [−10, 0] over six thematic families (10,000 resamples, seed 20261108).
- Extraction failures: A 0, B 6, F 4. Tool calls: A 0, B 68, F 104. Tokens: 72,002 / 220,464 / 340,275.
- Total observed provider cost: **$0.1680**; maximum single episode $0.0103; all episodes within the registered token, tool-call, wall-clock and USD budgets.
- Formal: 18/18 formal episodes graded correct; all 18 receipts `completed/compiled/identified/verified` under the empty axiom policy.
- Report: `bench/v2/real/pilot-2026-11-09-opencode-go-deepseek-v4.1-flash/report.md`; manifest, starts, episodes, receipts and immutable final/event artifacts are in the same directory (about 0.8 MB).

## Methods and constraints

- OpenCode 2.0.29 CLI; fresh staged workspace per episode; staged `.js` plugin discovery; runtime plugin-load audit plus static permission/registration checks.
- Safe credential-home copy: config/cache plus a 19 MB SQLite store containing the host credential rows only. The host's 42 GB session database was not copied. No credential is in the artifact.
- F used staged math indexes (`math-index.json`, `pdf-index.json.gz`, `lean-index.json.gz`) and `MATH_TOOLKIT_MATH_ROOT`. The corpus is the local `math/` archive.
- The model was resolved by `opencode models --standalone` before dispatch; usage was recovered from `opencode session export`.
- The credential home is a copy, not an OS sandbox. The F interface retains shell-equivalent capability; do not treat this as a security guarantee.

## What the pilot does not establish

- No plugin improvement: F−B is negative with an interval including zero.
- The 30 tasks are provisional development/validation material; owner review is still required, and this set is not an untouched confirmatory test.
- Retrieval/computation are extraction-style tasks with supplied excerpts; they do not measure open corpus search.
- Error-detection and absence rows use exact-text/hash/scope fixtures; their near-zero rates are not general explanation quality or human adjudication.
- Formal targets are simple Init-only statements; 18/18 is a ceiling check, not broad formalization ability. Receipts are not independent kernel checks or informal-correspondence reviews.
- One model, one repeat, six families; no variance, power, or population-of-models inference.
- Free-model feasibility was negative: the `opencode` free routes were quota-limited; `free-kilo` Nemotron/Kilo-auto produced B/F extraction failures; `free-ollama-cloud/...:1017` was not in the free plan. The pilot is not a free-model comparison.

## Remaining gates for a confirmatory study

1. Owner review and freeze of the task set (or a larger independently reviewed set), with family/track partitions, reference answers, rubrics and adjudication rules.
2. The planned 360-episode pilot (30 tasks × 2 models × 3 conditions × 2 repeats), fixed model versions, spend cap, retry/stop rules and cache regime; or an explicitly authorized smaller confirmatory design.
3. A second model and repeats; analysis of extraction failures and tool-use overhead; the F condition's negative pilot signal must be retained, not hidden.
4. Confirm the isolation/credential provisioning method and the runtime inventory guarantee; the pilot's safe credential copy is not an OS sandbox.
5. Freeze the protocol, graders, verifier and artifact hashes before test outcomes; keep development, validation and confirmatory tasks separate.
6. Generate confirmatory tables only from the frozen real artifacts; the current paper reports the exploratory pilot separately and leaves confirmatory results pending.
