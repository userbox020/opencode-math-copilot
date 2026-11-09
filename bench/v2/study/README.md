# Real study runner (dry-run first)

**Status:** implemented and exercised by the exploratory 90-episode pilot with
`opencode-go/deepseek-v4.1-flash`; the confirmatory pilot is not run. The pilot
is not confirmatory paper evidence. `--execute` requires a runtime plugin-load
audit, the exact model listed by `opencode models --standalone`, explicit
budgets/toolchain, and `--allow-provisional` for provisional tasks.

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
- a **runtime plugin-load** audit for A, B and F: the real server loads the
  staged `.js` plugin after `/api/config`, and the static
  permission/registration audit matches (this is not a filtered catalog
  snapshot or an OS sandbox);
- explicit model, budgets, spend cap, and Lean toolchain label;
- `--allow-provisional` if the task file still has `provisional: true`;
- a fresh output directory or a resumable study with the same protocol hash.

The exploratory 90-episode pilot passed the audit with
`opencode-go/deepseek-v4.1-flash` and a `MATH_BENCH_SAFE_HOME` copy (config/cache
plus a 19 MB credential DB; no 42 GB session database). It produced A 18/30,
B 15/30, F 14/30; F−B −3.33 percentage points, exploratory 95% CI [−10, 0];
18/18 formal receipts verified; total $0.168. The result is negative/neutral
for F and is **not confirmatory**. The free-model routes were quota-limited or
produced B/F extraction failures; see `real/README.md`.

The adapter also requires `opencode models --standalone` to list the exact
requested model before dispatch; the pilot used the safe credential DB and the
`opencode-go` provider. `/api/agent` still does not list the staged
config-defined agent, so the audit's guarantee is plugin-load plus static
permissions, not a filtered catalog snapshot.

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
- The adapter audit is runtime plugin-load, not a filtered catalog snapshot;
  the safe credential home is a copy, not an OS sandbox. The exploratory pilot
  is one model/one repeat and provisional tasks.
- Provisional tasks are development/validation material. A study that allows them is not confirmatory paper evidence.
- Family-level intervals are exploratory, especially with six thematic families.

## Tests

```text
node --test bench/v2/tests/study.test.mjs
```

The tests use mocked adapters/audits/verifiers only; they do not invoke a model, Docker, or Lean.
