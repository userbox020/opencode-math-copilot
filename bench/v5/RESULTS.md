# v5 external math benchmarks — results

**Status: MathArena 40-task pilot complete; IMO-AnswerBench capture running;
formal and comparator tracks are pack-only or blocked. Exploratory, not
confirmatory.** One model, one repeat, one seed, deterministic graders. No
causal or general mathematical-accuracy claim follows.

## Clean benchmark workspace

The main workspace exposes Code Mode `execute` (including `fetch`), so the first
two-task smoke there was discarded as a plugin measurement. The clean workspace
is `C:\Users\MiPC\AppData\Local\Temp\opencode\math-bench-env-20261117`:

- copied math toolkit with `codemode:false` (direct tools);
- `math` junction to the corpus;
- `oh-my-opencode-slim` present only to register the `opencode-go` route;
- `webfetch`, `websearch`, `execute`, `bash`, `shell`, `edit`, `write`, `read`,
  `grep`, `glob`, `ast_grep_*`, `list`, `find`, `lsp`, `task_*`,
  `external_directory` denied.

Probes: ON exposes only math tools plus `question`/`wait_for_user`/`skill`;
`math_status` completes directly; OFF returns `TOOLS_UNAVAILABLE`; web, shell,
and execute are absent. Residual risks: diagnostics print host paths; the corpus
junction is writable; `math_reindex`/`math_lean_build` can write; Lean/Docker
process execution is not an OS sandbox.

## MathArena 2026 — 40-task pilot

Tasks: 10 each from AIME 2026, HMMT February 2026, BRUMO 2025, SMT 2025.
Model: `opencode-go/deepseek-v4.1-flash`. Conditions: plugin-on vs plugin-off
(`MATH_TOOLKIT_DISABLE=1`), same prompt, model, workspace, 300 s/episode, one
repeat, sequential, no retries. All 80 episodes were attempted and captured.

### Corrected grader (SymPy-backed symbolic equivalence)

| Condition | Scheduled | Completed | Correct | Incorrect | Unparseable | Missing (timeout) | Pass/scheduled |
|---|---:|---:|---:|---:|---:|---:|---:|
| plugin-on | 40 | 36 | 36 | 0 | 0 | 4 | **90.0%** |
| plugin-off | 40 | 34 | 34 | 0 | 0 | 6 | **85.0%** |

Paired: **33 both, 0 ON-only, 0 OFF-only, 0 neither, 7 ungraded**. The seven
ungraded are the union of timeouts; a pair with one timeout is not a
condition-only win.

### Conservative bounded grader (sensitivity, same answers)

| Condition | Correct | Unparseable | Missing | Pass/scheduled |
|---|---:|---:|---:|---:|
| plugin-on | 29 | 7 | 4 | 72.5% |
| plugin-off | 29 | 5 | 6 | 72.5% |

Paired: 26 both, 0 ON-only, 0 OFF-only, 14 ungraded.

All twelve bounded-grader `unparseable` cases were inspected against the gold:
they are correct answers in equivalent symbolic forms (`-1/21` vs
`-\frac{1}{21}`, `\frac19`, `3+2\sqrt2`, `\frac{9\sqrt{30}}4`,
`\sqrt e` vs `e^{1/2}`, `\frac{2\sqrt6}{3}`, `\frac{737}{39}`, and the
trigonometric `\frac{1}{2\sin(\pi/26)}`). The SymPy fallback resolves all eight
supplied equivalence examples. The model was **not re-run**; only grading changed.

### Tool use and timeouts (same captures, offline analysis)

| Condition | Episodes with math-tool use | Tool call sites |
|---|---:|---|
| plugin-on | **11 / 40** | `math_compute` 20, `math_lean_check` 10 |
| plugin-off | 0 / 40 | none observed |

- 29/40 ON episodes used no math tool. The condition comparison is therefore
  mostly a **no-tool comparison**, not a full-toolkit test.
- Timeouts: ON 4 (`aime-2026-30`, `hmmt-feb-2026-33`, `smt-2025-30`,
  `smt-2025-53`); OFF 6 (`aime-2026-11`, `hmmt-feb-2026-19`,
  `hmmt-feb-2026-33`, `smt-2025-30`, `smt-2025-41`, `smt-2025-53`).
  Common: `hmmt-feb-2026-33`, `smt-2025-30`, `smt-2025-53`.
- Completion pairs: **33 both, 3 ON-only** (`aime-2026-11`,
  `hmmt-feb-2026-19`, `smt-2025-41`), **1 OFF-only** (`aime-2026-30`),
  **3 neither**. Matched-slot ON−OFF completion: **+2 (5.0%)**.
- Correctness pairs: 33 both, 0 discordant; paired difference **0.00%**;
  task-clustered bootstrap 95% **[0.00%, 0.00%]** over 33 tasks (descriptive,
  not confirmatory).
- **Three of the four ON timeouts had tool use** (`aime-2026-30` and
  `hmmt-feb-2026-33` `math_lean_check`; `smt-2025-30` `math_compute`);
  `smt-2025-53` had none. This is correlation, not proof that tool calls caused
  the timeouts, but it is the opposite of a timeout-reduction signal.
- Tool counts are static call sites (direct events plus nested `execute` input),
  not verified successful execution. Missing raw logs mean unknown, not no use.

### What the pilot supports

- On jointly completed tasks, both conditions answered every one correctly:
  **no condition-only correctness win**.
- The ON arm used a math tool on only 11/40 episodes; most of the comparison is
  model-only. The two extra ON completions are paired against OFF timeouts and
  therefore ungraded; they are not correctness wins.
- A 40-task, one-repeat, one-model pilot cannot establish a completion benefit,
  and the tool-use/timeout correlation cautions against claiming one. It is a
  feasibility and grading-sensitivity result, not efficacy evidence.
- The corrected grader is clearly better than the bounded one for symbolic
  answers; the conservative result is retained rather than overwritten.

### Cost

CLI-reported, not reconciled billing. ON: known subtotal **$0.085251078** for
11/40 episodes; OFF: **$0** known for 0/40. Coverage is incomplete, so these are
not comparable totals or provider invoices.

## IMO-AnswerBench v2 — 40-task pilot

Tasks: 10 each from Algebra, Combinatorics, Geometry, Number theory (the
deterministic 40-task pilot). Same model/conditions/300 s protocol as MathArena.
All 80 episodes were attempted and captured.

### Strict deterministic grader

| Condition | Scheduled | Completed | Correct | Incorrect | Unparseable | Missing (timeout) | Correct/completed | Correct/scheduled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| plugin-on | 40 | 20 | 11 | 5 | 4 | 20 | 55.0% | **27.5%** |
| plugin-off | 40 | 20 | 11 | 5 | 4 | 20 | 55.0% | **27.5%** |

Paired: **10 both, 0 ON-only, 0 OFF-only, 4 neither, 26 ungraded**;
graded-pair difference **0.00%**; task-clustered bootstrap 95% **[0.00%, 0.00%]**
over 14 tasks (descriptive). Completion: 18 both, 2 ON-only, 2 OFF-only,
18 neither; matched-slot completion difference **0**.

### Audited unparseable sensitivity

All four `unparseable` answers in **each** arm are correct in equivalent forms:

| Task | Gold | Answer |
|---|---|---|
| `imo-bench-algebra-067` | `(2, 1/2, 9/4)` | `(n,x,y)=(2,1/2,9/4)` |
| `imo-bench-geometry-034` | `50A/39` | `50A/39` (free symbol `A` rejected) |
| `imo-bench-geometry-089` | `96\sqrt{10}/13` | `\dfrac{96\sqrt{10}}{13}` |
| `imo-bench-number_theory-078` | `0,2,6` | `n\in\{0,2,6\}` |

If those are counted, both arms become **15 correct / 20 completed** (75.0%)
and **15/40 scheduled (37.5%)**; paired becomes **14 both, 0 condition-only,
4 neither, 22 ungraded**. The ON/OFF difference remains **0**; the strict
result is retained as the primary, the audit as a grader-sensitivity check.

### Timeouts, completion, and tool use

- Timeouts: **20 ON and 20 OFF**; overlap 18. ON-only timeouts:
  `combinatorics-045`, `number_theory-023`; OFF-only:
  `algebra-056`, `number_theory-001`. These are exact 2-for-2 swaps, so the
  matched-slot completion difference is zero.
- The 300 s budget is the binding constraint: half of each arm timed out.
- Tool use: **ON 10/40 episodes** — `math_compute` 16 call sites,
  `math_grep` 9, `math_lean_check` 4, `math_pdf_index_search` 2,
  `math_search` 3, `math_status` 1. OFF used **0** math tools (2 `question`,
  2 `skill` calls). Tools were used on a minority of tasks and produced neither
  a correctness nor a completion difference.
- Cost: CLI-reported, incomplete. ON **$0.07986582** known for 10/40;
  OFF **$0.01594791** known for 1/40. Not comparable totals.

### IMO interpretation

A perfect null on this sample: identical correctness and completion, no
condition-only win, and 50% timeouts in both arms. The benchmark is too slow or
too hard for this model/budget at 300 s; the plugin neither helps nor harms on
the 20 completed tasks. A future IMO run needs a larger timeout or a
completion-aware protocol before it can test the plugin.

## Cross-benchmark: tool use × outcome

| Benchmark | Condition | Math tool used | Episodes | Correct | Incorrect | Unparseable | Missing |
|---|---|---:|---:|---:|---:|---:|---:|
| MathArena | ON | yes | 11 | 8 | 0 | 0 | 3 |
| MathArena | ON | no | 29 | 28 | 0 | 0 | 1 |
| MathArena | OFF | no | 40 | 34 | 0 | 0 | 6 |
| IMO | ON | yes | 10 | 2 | 1 | 1 | 6 |
| IMO | ON | no | 30 | 9 | 4 | 3 | 14 |
| IMO | OFF | no | 40 | 11 | 5 | 4 | 20 |

- Tool-using episodes are disproportionately **timeouts**: MathArena 3/11
  tool-using vs 1/29 no-tool; IMO 6/10 vs 14/30.
- Correct rate among tool-using vs no-tool episodes: MathArena 8/11 (72.7%)
  vs 28/29 (96.6%); IMO 2/10 (20%) vs 9/30 (30%). Tool use did not produce a
  higher correct rate in either benchmark.
- This is **confounded by task selection**: the model may choose tools on
  harder or longer tasks. It is not proof that tool calls caused the timeouts.
  But under a 300 s budget, tool overhead is a plausible risk, and the data
  provide no timeout-reduction signal.
- The ON arm used tools on a minority of tasks (11/40 and 10/40), so both
  benchmarks are mostly no-tool comparisons.

## Other tracks

| Track | State |
|---|---|
| Clean two-task smoke | 2/2 both; ON used `math_compute`; OFF used no tools |
| IMO-AnswerBench v2 | 400 tasks, 40-task pilot complete; see above |
| MathConstruct | 121 tasks, 20-task pilot running with validator receipts; bridge controls 2 positive / 2 negative |
| ProofNet-Verified | 367 Lean 4.34.0 tasks, 20-task pilot, 367 unverified controls; checker not bound |
| ArXivMath | 103 closed-book tasks, 20-task pilot queued after MathConstruct |
| Comparator | 8 tasks; real run blocked (Comparator/landrun/lean4export absent) |
| Tool tests | `v5:test` 245 tests, 222 pass, 0 fail, 23 skipped; syntax 160 files |

## MathConstruct format correction

The first MathConstruct pilot was stopped after two episodes. The runner sent
only the problem text, while the pack stores the required upstream answer
format in `grading.answer_format` (for example, `FINAL: \boxed{[vertices,
edges]}`). Both answers were prose and correctly classified `unparseable`. The
two episodes are preserved as **format-invalid** and are not pooled with any
corrected run. The runner now appends `grading.answer_format` to the prompt and
the parser accepts `\boxed{...}` JSON; a corrected 20-task pilot is the next
run.

## Caveats

- Exploratory, one model/seed/repeat; no confirmatory claim.
- Plugin-off disables this toolkit only, not built-in tools; the clean workspace
  denies the other channels, but Lean/Docker process execution is not a sandbox.
- The corpus contains research proofs and Comparator challenges; retrieval-assisted
  reproduction is not separated unless a task says so.
- External baselines are absent for this exact model/version; the paired off arm
  is the primary baseline. No external leaderboard score is pooled.
- MathConstruct validators validate constructions, not informal proof quality.
- ProofNet/ArXivMath/Comparator have no model results yet.
