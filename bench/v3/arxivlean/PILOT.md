# External 60-task pilot: draft protocol

Status: **paused after seven attempts on task 1 only: six timeouts, one
DSML-only unverified output, 0 verified and 0 rejected.** A five-task set was
selected, not completed; neither the five- nor 60-task study was completed.
The first attempt timed out at 900s; the OFF DSML output completed in 186s.
The final four clean attempts are a subset: three timeouts and one unverified.
Observed subtotals: **1,034,214 tokens, $0.5272**, with incomplete billing.
See `RESULTS.md` and `HARNESS-FINDINGS.md`. This remains a draft protocol,
not confirmatory evidence; no truly offline run was established.

## Goal

Estimate the incremental value of the math toolkit on externally graded math
tasks while separating model quality, tool availability, and harness effects.
The primary question is whether plugin-ON improves independently verified task
success relative to plugin-OFF under equal resources.

## Composition

| Track | Tasks | Source | Grading |
|---|---:|---|---|
| ArXivLean September 2026 | 20 of 53 | MathArena dataset revision `e346a992a3da17797bc2ea616f5fca0e7d61570b`; repo commit `d98156fa67822629b7554faabeeea5682f4ad0ca` | Comparator with Lean 4.34.1 and the pinned mathlib |
| LeanDojo Benchmark 4 `novel_premises` | 20 | Zenodo record 12740403; pin the exact version and license | Official Lean checker; hide premises/answers used for grading |
| AIME 2026 | 20 | `MathArena/aime_2026`; pin the revision and license | Exact-answer parsing plus independent answer check |

ArXivLean selection should be deterministic (for example, a fixed seed over the
53 IDs) and recorded before running. Do not select tasks after seeing model
output.

## Conditions

- Proposed `plugin-on-verify`: a restricted toolkit with
  only `math_doctor`, `math_lean_check`, `math_lean_verify`, `math_lean_build`,
  `math_compute`, `math_comparator`, and `math_status`. Corpus/PDF retrieval is
  excluded because the local corpus may contain target proofs. The
  `MATH_TOOLKIT_TOOLSET=verify` selector exists only in the modified temporary
  plugin used by the pilots. The checked-in selector falls through to full on
  unknown values; it does not implement this proposed restriction.
- `plugin-off`: `MATH_TOOLKIT_DISABLE=1`; the plugin loads but registers no math tools.
- Optional secondary ablation: `plugin-on-minimal` (`MATH_TOOLKIT_TOOLSET=minimal`).
  Keep it out of the primary endpoint unless pre-registered.
- The first 30-minute pilots used the full plugin and were invalid for a math
  comparison: ON fetched the source paper and spawned a proof-extraction
  subagent; OFF found prior prompts in `.opencode/state`. Use a fresh workspace
  with web, subagents, shell, writes, file reads, and prior logs blocked.

Use the same model, prompts, workspace, generic tools, timeouts, and token/cost
caps in both conditions. The only intended difference is math-tool registration.

## Frozen factors

- One model, pinned by provider/model ID. Do not switch models after seeing results.
- Three repeats per task and condition, with randomized condition/task order.
- Per-episode wall-clock and token/cost budgets recorded in the manifest.
- Same workspace and permissions in both conditions. Document any auto-rejected
  tool permissions as harness limitations.
- No condition-specific hints, prompts, or retrieval privileges.

## Grading and leakage

- ArXivLean: Comparator is the acceptance boundary. A compilation success is not
  a proof. The challenge uses a `sorry` placeholder; the submission must not.
- Block `webfetch`, websearch, subagent delegation, and shell for both conditions.
  Use a fresh workspace with no prior session logs. Inspect and freeze the
  actual restricted tool inventory; an unsupported `verify` environment label
  is not evidence of masked corpus/PDF access.
- **Critical:** `webfetch`/websearch denies do not block `execute`'s `fetch`.
  Set `codemode: false` on the plugin tools and deny `execute`, or use a
  network-isolated container. The first clean run fetched the MathArena
  `arxivlean-0926_outputs` dataset—including another model's proof—through this
  path and was invalid.
- `math_lean_check` is not a safe verification sandbox: its Docker check mounts
  the corpus with network access. Lean compilation can execute arbitrary
  elaboration code, not just literal `#eval`/`IO.Process`; a blacklist or
  compile-only label is not a security boundary. Require OS isolation with an
  unprivileged runtime, immutable dependencies, no network/corpus/secrets,
  resource limits, and an independently trusted checker.
- Gate the pipeline with known positive and negative checker controls and
  isolation probes before spending model budget. The gate is not whether the
  solver can prove the selected research task. Denying `execute` alone did not
  establish offline operation in the pilots.
- LeanDojo: use the official checker and hide the gold proof/premises used for
  grading. If the local corpus contains an answer, mask it or label the result
  retrieval-assisted.
- AIME: parse the final answer independently; do not use the model's self-report
  as the grade.
- Plugin-off must not be required to produce a plugin-specific receipt. A metric
  that mechanically requires `math_lean_verify` would favor plugin-ON.
- Report `verified`, `rejected`, `incomplete` (timeout/transport), and
  `unverified` (infrastructure) separately. Never merge incomplete into rejected.

## Analysis

- Primary endpoint: ArXivLean verified rate, paired by task, with a
  problem-clustered bootstrap interval.
- Secondary: LeanDojo verified rate, AIME exact-answer accuracy, completion rate,
  timeout rate, wall time, tokens, and recorded cost.
- Report per-track results separately; do not pool tracks with different grading.
- Pre-register the primary endpoint and the minimum detectable effect. Do not
  make a general "plugin improves math" claim from a small or ceiling-limited sample.

## Scope warning

60 tasks × 3 repeats × 2 conditions = **360 episodes**. At 10–30 minutes each,
that is roughly 60–180 hours of model time before grading, plus failures and
retries. A staged design is safer:

1. Smoke: 5 ArXivLean tasks × 2 conditions × 1 repeat (10 episodes).
2. Stage A: 20 ArXivLean tasks × 2 conditions × 1 repeat (40 episodes).
3. Stage B: add LeanDojo and AIME, then expand repeats only if the Stage A
   interval is informative.

Freeze the exact stage before running it. Do not silently reduce repeats or tasks
after seeing results.

## Open decisions

- Model and provider budget.
- Whether the optional minimal condition is included.
- Per-episode timeout and token/cost caps.
- LeanDojo version/license and exact `novel_premises` split.
- AIME revision/license and answer-normalization rules.
- Whether the local corpus is available to the model, and how answer-bearing
  content is masked.

## Current pins

- ArXivLean dataset: `MathArena/arxivlean-0926`, revision
  `e346a992a3da17797bc2ea616f5fca0e7d61570b`, split `train`, 53 rows.
- ArXivLean harness: `eth-sri/matharena` commit
  `d98156fa67822629b7554faabeeea5682f4ad0ca`.
- Lean: `leanprover/lean4:v4.34.1`; mathlib
  `d13f23b723b8a846827a245b89c10fc7d3f11612`.
- Comparator: `d03acab154d269c06e60e4de7e4cc85deebff94b`.
- lean4export: `076e8e57707e813375e8f9da8bf989799ace9680`.
- Landrun: `811cfff51ceaf3d9843708aa6d22e9b84ccac8b4`.
