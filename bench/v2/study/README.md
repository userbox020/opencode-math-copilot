# Real study runner (dry-run first)

**Status:** implemented; **no real model episode has been run.** `--execute` refuses until a runtime-verified tool inventory exists. This is not paper evidence.

`run-study.mjs` is the integration layer between the staged OpenCode adapter, the task set, the evaluator graders, and the Lean receipt bridge. It is separate from the simulated `bench/v2/run.mjs`.

## Dry-run

```text
node bench/v2/study/run-study.mjs \
  --tasks bench/v2/tasks/pilot-v1.json \
  --model provider/model \
  --out C:\path\to\study-plan
```

The dry-run validates the task file, builds the study manifest and the full A/B/F matrix, runs the inventory audit for each profile, prints the episode count and the maximum USD exposure, and writes `plan.json`. It makes **no model call, session, Docker verification, or pilot execution**. Exit code `2` means the inventory gate is not execution-ready.

## Execute (gated)

```text
set MATH_BENCH_ALLOW_EXECUTE=1
node bench/v2/study/run-study.mjs \
  --tasks <frozen-task-file> --model provider/model --out <study-dir> \
  --execute --allow-provisional \
  --lean-toolchain leanprover/lean4:v4.34.1 \
  --budget-tokens 200000 --budget-tool-calls 40 \
  --budget-duration-ms 600000 --budget-usd 1 --spend-cap-usd 25
```

Execution requires all of the following:

- `MATH_BENCH_ALLOW_EXECUTE=1`;
- a **runtime-verified** audit for A, B and F (static-equivalent is refused);
- explicit model, budgets, spend cap, and Lean toolchain label;
- `--allow-provisional` if the task file still has `provisional: true`;
- a fresh output directory or a resumable study with the same protocol hash.

The adapter currently reports a **static-equivalent** audit: staged IDs and permissions match exactly, but OpenCode 2.0.29 exposes no supported session-free endpoint that enumerates config-defined agents/effective tools. `/api/agent` returns an empty list for the staged `benchmark` agent, so it is not treated as proof. Therefore `--execute` intentionally fails closed.

A non-isolated smoke confirmed the staged `.js` plugin is auto-discovered and the model can use `execute`; the isolated HOME still lacks provider authentication, and a no-tool run can omit `step_finish`, leaving token usage unavailable. A real pilot needs evaluator-provisioned auth outside the agent-visible workspace and the session API for authoritative usage.

## Episode lifecycle

1. Prepare a fresh workspace through `prepareEpisode`; append a durable start with the public payload hash.
2. Audit the staged profile; refuse on mismatch, missing plugin, extra tool, or static-only evidence.
3. Run `executeEpisode` with the fixed model and wall-clock timeout.
4. Parse NDJSON fail-closed: final message by `messageID`, tool outcomes, `step_finish` usage/cost; missing final/usage is a failure.
5. Grade in the evaluator process. Formal tasks build the fixed target from `task.formal`, call `verifyLeanSubmission`, attach the envelope to `trusted_receipts` by `receipt_sha256`, and call the formal grader. The agent never supplies a receipt.
6. Write immutable final/events artifacts, append the episode, remove the workspace.
7. Resume treats a start without a terminal record as `interrupted`; it never silently reruns.

## Accounting

- Tokens: `input + output + reasoning` from `step_finish`; cache read/write are excluded and must be reported separately.
- Tool calls: completed/error `tool_use` events.
- Cost: summed `step_finish.cost`; missing/non-numeric cost is `null` and cannot be under budget. The study stops after an unbounded-cost episode.
- Spend cap: checked before each dispatch using observed spend plus the per-episode USD budget.
- All started episodes remain in the denominator, including extraction, operational, interrupted, and over-budget episodes.

## Evidence limits

- The evaluator bridge is not an independent kernel check, a signature, or an OS sandbox.
- Absence/explanation prose checks are heuristics or frozen fixture labels, not blinded human adjudication.
- The adapter audit is static-equivalent until a runtime proof exists.
- Provisional tasks are development/validation material. A study that allows them is not confirmatory paper evidence.
- Family-level intervals are exploratory, especially with six thematic families.

## Tests

```text
node --test bench/v2/tests/study.test.mjs
```

The tests use mocked adapters/audits/verifiers only; they do not invoke a model, Docker, or Lean.
