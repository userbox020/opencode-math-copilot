# Real study runner — integration design

**Status:** the runner was exercised by the exploratory 90-episode real pilot
(`opencode-go/deepseek-v4.1-flash`, one repeat, 30 provisional tasks): A 18/30,
B 15/30, F 14/30; F−B −3.33 pp, exploratory 95% CI [−10, 0]; 18/18 formal
receipts verified; $0.168. The confirmatory pilot has **not** been run. The
artifact is `bench/v2/real/pilot-2026-11-09-opencode-go-deepseek-v4.1-flash/`.
`bench/v2/run.mjs` remains the simulated harness.

## Purpose

Run the reviewed task set through A/B/F with real model processes while keeping grading, receipts, and reference answers outside the agent workspace.

## Inputs (explicit; no defaults for model or spend)

- `--tasks <file>`: frozen task file. Provisional tasks require `--allow-provisional` and are marked as development/engineering data, not paper evidence.
- `--model <provider/model>`: one fixed model per study, recorded verbatim.
- `--profiles A,B,F`, `--repeats`, `--attempts`.
- `--budget-tokens`, `--budget-tool-calls`, `--budget-duration-ms`, `--budget-usd`, `--spend-cap-usd`.
- `--lean-toolchain <label>` for formal receipts.
- `--seed`, `--resamples`.
- `--out <dir>`: append-only study directory.
- `--dry-run` (default) or `--execute` with `MATH_BENCH_ALLOW_EXECUTE=1`.

## Preflight gate

1. Validate the task file and freeze hashes for tasks, graders, verifier bridge, adapter, plugin payload, Node/OpenCode versions, and protocol.
2. Build the episode matrix and print the maximum spend estimate.
3. Run the adapter inventory audit for A/B/F. Execution requires a **runtime plugin-load** audit (the real server loads the staged `.js` plugin after `/api/config`, and static permissions/registrations match); a static-only report is insufficient. A failed or unsupported audit stops before the first model call.
4. Refuse `--execute` if the task file is provisional without `--allow-provisional`, or if budgets/model/toolchain are missing.
5. Verify no grading, reference, answer, receipt, or evaluator file is in the agent workspace.

## Episode lifecycle

For each `(task, profile, repeat, attempt)`:

1. Append a durable `start` record with the public payload hash before dispatch.
2. Create a fresh workspace through `prepareEpisode`.
3. Audit the staged profile; refuse on mismatch.
4. Run `executeEpisode` with the fixed model and per-episode wall-clock timeout.
5. Parse NDJSON fail-closed: final message by `messageID`; `tool_use` outcomes; `step_finish` usage/cost; non-zero exit, stderr, error events, or missing final are failures, never passes.
6. Extract one typed final from the final assistant message only; tool output and commentary are not the final.
7. Grade in the evaluator process with the frozen grader. For absence, supply the evaluator's consulted set/availability context; the answer is not evidence of retrieval.
8. For formal tasks, build the fixed target from `task.formal`, call `verifyLeanSubmission` on the submitted solution, attach the envelope to `trusted_receipts` by `receipt_sha256`, and call the formal grader. The agent never supplies a receipt.
9. Write the episode and immutable `final`/`events` artifacts; mark under budget; remove the workspace.
10. On interruption, keep the start record; resume records `interrupted` and never silently reruns a fresh episode.

## Budget and stop rules

- Per episode: tokens (`input+output+reasoning`; cache excluded and documented), tool calls, wall-clock, USD.
- Study: pre-dispatch spend gate using observed costs plus reserved estimates. Strict total-spend and concurrent enforcement have not been validated; this is not an established hard billing cap.
- Stop: cap reached, repeated adapter/isolation failures, verifier unavailable, provider/auth failure, or audit failure. Record the stop reason; do not hide it.
- No retry without an explicit attempt increment; failed attempts remain in the ledger.
- Unknown cost cannot count as under budget.

## Evidence and claims

- Distinguish adapter success, extraction success, grading success, Lean compilation, fixed-target proof verification, and informal correspondence (not assessed).
- Keyword or heuristic scoring is not mathematical accuracy.
- A study with provisional tasks is engineering/development evidence, not paper evidence.
- Never synthesize a receipt, a missing final, a token count, or a cost.

## Current blockers

- The inventory audit is `runtime-plugin-load`: the real server loads the staged `.js` plugin after `/api/config`, and static permissions/registrations match. `/api/agent` still does not expose a filtered catalog snapshot; this is not an OS sandbox. The exploratory pilot used the safe credential-home copy and passed the audit.
- **Provider route:** the safe credential home exposes `opencode-go/deepseek-v4.1-flash` and the pilot ran it. The free routes were quota-limited or produced B/F extraction failures; `free-ollama-cloud/...:1017` was not included in the free plan. `opencode models --standalone` remains a required preflight.
- Auth/credential provisioning and `opencode session export` usage recovery are implemented and were exercised by the 90-episode pilot. The confirmatory study has not been run.
- The exploratory pilot used one model, one repeat, 30 provisional tasks, and $0.168 total. The planned 360-episode pilot (two models, two repeats) and owner task sign-off remain pending.
- The evaluator bridge is not an independent kernel check, signature, or OS sandbox. The safe credential home is a copy, not an OS sandbox.

The exploratory pilot is complete and preserved; the confirmatory study remains
blocked on owner-reviewed tasks, the 360-episode model/spend plan, and the
remaining isolation/audit decisions.
