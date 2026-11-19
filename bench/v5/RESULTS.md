# v5 external math benchmarks — results

**Status: MathArena, IMO, MathConstruct and ArXivMath pilots complete;
tool-necessity 10/10 vs no-tools but 6/10 vs 9/10 with generic tools. ProofNet
and Comparator are pack-only or blocked. Exploratory, not confirmatory.** One
model, one repeat, one seed, deterministic graders. No causal or general
mathematical-accuracy claim follows.

## Clean benchmark workspace

The main workspace exposes Code Mode `execute` (including `fetch`), so the first
two-task smoke there was discarded as a plugin measurement.

The completed MathArena/IMO/MathConstruct/ArXivMath pilots used
`C:\Users\MiPC\AppData\Local\Temp\opencode\math-bench-env-20261117`: copied math
toolkit with `codemode:false`, corpus junction, slim plugin only for the
`opencode-go` route, and denials for web/execute/shell/read/write/ast-grep/list/
find/lsp/task/external-directory.

**Workspace note:** that copy later lost its plugin entry wrapper and corpus
junction, and the model then saw only `question`/`skill`/`wait_for_user`. It was
rebuilt as `...\math-bench-env-v2-20261118` with the same plugin/config and a
verified `math_status` direct call. The tool-necessity run uses v2. Earlier
manifests record the original workspace; their recorded tool events stand and no
result is rewritten. Invalid `question`/`wait_for_user`/`skill` permission keys
were also removed: they caused the config to fall back and the math plugin to
disappear.

Probes (v2): ON `math_status` completes directly; OFF returns
`TOOLS_UNAVAILABLE`; web/shell/execute are absent. Residual risks: diagnostics
print host paths; the corpus junction is writable; `math_reindex`/`math_lean_build`
can write; Lean/Docker process execution is not an OS sandbox.

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

## ArXivMath — 20-task closed-book pilot

Tasks: 20 (five per competition), closed-book; no source papers supplied. Same
model/conditions/300 s protocol.

| Condition | Scheduled | Completed | Correct | Incorrect | Unparseable | Missing (timeout) | Correct/completed | Correct/scheduled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| plugin-on | 20 | 3 | 2 | 0 | 1 | 17 | 66.7% | **10.0%** |
| plugin-off | 20 | 3 | 2 | 0 | 1 | 17 | 66.7% | **10.0%** |

Paired: **2 both, 0 ON-only, 0 OFF-only, 0 neither, 18 ungraded**;
graded-pair difference **0.00%**; bootstrap 95% **[0.00%, 0.00%]** over 2 tasks.
Completion: 2 both (`february-001`, `march-001`), 1 ON-only (`december-001`),
1 OFF-only (`march-031`), 16 neither; matched-slot completion **0**.

Tool use: **ON 17/20 episodes** — `math_search` 43, `math_grep` 38,
`math_compute` 27, `math_pdf_index_search` 23, `math_pdf_corpus_search` 9,
`math_lean_check` 7, `math_manuscript` 3, `math_status` 4, plus
`math_pdf_search`/`math_lean_search`/`math_doctor`. OFF: 0 math tools
(1 `question`). The ON arm used retrieval/PDF tools heavily, yet 17/20 episodes
timed out in both arms; the 300 s budget is the binding constraint.

- This is consistent with tool overhead consuming the budget, but task
  difficulty and selection are confounded; it is not causal.
- ON cost **$0.167888244** known for 17/20; OFF **$0.004735764** known for 1/20;
  coverage differs, so these are not comparable totals.
- Correct tasks: `february-001`, `march-001` in both arms. The unparseable
  completion swaps are `december-001` (ON) and `march-031` (OFF).

## Tool-necessity retrieval — no plugin-specific win

This is the first benchmark where the answer is not derivable from the model's
knowledge: a specific sentence in an obscure manuscript, with quote/locator
gold. 20 tasks are built; the 10-task pilot was run in both conditions.

| Condition | Scheduled | Completed | Correct | Incorrect | Missing | Pass/scheduled |
|---|---:|---:|---:|---:|---:|---:|
| plugin-on | 10 | 10 | 10 | 0 | 0 | **100%** |
| plugin-off | 10 | 10 | 0 | 10 | 0 | **0%** |

Paired: **10 ON-only, 0 both, 0 OFF-only, 0 neither, 0 ungraded**. The ON share
among discordant pairs is 100%; exact 95% binomial interval **69.15%–100%**.
There were no timeouts; 300 s was sufficient.

Tool use: **ON 10/10 episodes** — `math_grep` 68 call sites,
`math_manuscript` 21, `math_search` 10, `math_status` 5, `math_lean_check` 2,
`math_pdf_text` 1. OFF used **0** math tools (6 `skill` calls). The one-task
smoke was consistent: ON correct, OFF incorrect.

This was a strong ON-only win **against a no-tools baseline**; the generic
control below removes the plugin-specific interpretation. It is a
retrieval-utility comparison, not a general math-reasoning result: 10 tasks, one
model, one repeat, local-corpus tasks, whitespace-normalized quote grading, and
locator correctness audited separately.

### Generic-tool control (decisive)

Both arms get `read`, `grep`, `glob`, `list`, `find`; ON adds the math toolkit.

| Condition | Correct | Incorrect | Pass/scheduled |
|---|---:|---:|---:|
| plugin-on | 6 | 4 | **60%** |
| plugin-off | 9 | 1 | **90%** |

Paired: **6 both, 0 ON-only, 3 OFF-only, 1 neither, 0 ungraded**
(OFF-only: `tool-text-01`, `tool-text-09`, `tool-text-10`; neither:
`tool-text-08`). ON−OFF correctness is **−30.00%**; task-clustered bootstrap 95%
**[−60.00%, 0.00%]**; discordant-pair ON share 0% (exact 95% binomial
0%–70.76%). Tool use: ON 10/10 math use plus 14 `glob`, 23 `grep`, 16 `read`;
OFF 45 `glob`, 55 `grep`, 54 `read`.

The 10/10 vs 0/10 above was **tools vs no tools**. Against ordinary file tools,
the plugin does not add text-retrieval value and is 30 pp worse. The ON arm's
extra manuscript/search calls did not improve exact-quote retrieval;
`math_manuscript` returns bounded excerpts, and the model may rely on them
instead of reading the source. This is a **negative** result for
plugin-specific text retrieval. One model, one repeat, 10 tasks; the interval
includes zero, but the point estimate is negative and there is no ON-only win.

## Other tracks

| Track | State |
|---|---|
| Clean two-task smoke | 2/2 both; ON used `math_compute`; OFF used no tools |
| IMO-AnswerBench v2 | 400 tasks, 40-task pilot complete; see above |
| MathConstruct | 20-task pilot complete; 4 accepted both, 12/13 unparseable, 4/3 timeouts; format-limited |
| Tool-necessity retrieval | 20 tasks; 10/10 vs no-tools; **6/10 vs 9/10 generic**; negative |
| ProofNet-Verified | 367 Lean 4.34.0 tasks, 20-task pilot, 367 unverified controls; checker not bound |
| ArXivMath | 20-task pilot complete; 2 correct both, 17 timeouts each; 10% pass scheduled |
| Comparator | 8 tasks; real run blocked (Comparator/landrun/lean4export absent) |
| Tool tests | `v5:test` 299 tests, 276 pass, 0 fail, 23 skipped; syntax 166 files |

## MathConstruct validator pilot

The first MathConstruct attempt was stopped after two episodes: the runner sent
only the problem text, the pack stores the required answer format in
`grading.answer_format`, and both answers were prose and correctly
`unparseable`. Those two episodes are preserved as **format-invalid** and are
not pooled. The runner now appends the format, the parser accepts JSON and flat
comma-separated `\boxed{...}` lists with exact big integers, and a one-task smoke
parsed and the validator **accepted** it (`CORRECT`).

Corrected 20-task pilot, both arms:

| Condition | Scheduled | Attempted | Completed | Accepted | Rejected | Unparseable | Missing (timeout) |
|---|---:|---:|---:|---:|---:|---:|---:|
| plugin-on | 20 | 20 | 16 | 4 | 0 | 12 | 4 |
| plugin-off | 20 | 20 | 17 | 4 | 0 | 13 | 3 |

Paired: **4 both accepted, 0 ON-only, 0 OFF-only, 0 neither, 16 ungraded**.
The same four tasks were accepted in both arms: `bulgarian-ifym-2015-p7-d4-8th`,
`bulgarian-pms-10-4`, `emc-2021-1`, `konhauser-2021-10`.

The 12/13 `unparseable` are a **format-coverage** result, not wrong
constructions: tuple/LaTeX-array/symbolic formats are outside the current
parser, and some tasks timed out. Validator coverage is 4/20 per arm; this is a
feasibility result, not an accuracy estimate. Tool use (ON): `math_compute` 5,
`math_lean_check` 5, `math_lean_build` 2, `math_search` 3, `math_grep` 1,
`math_pdf_corpus_search` 1, `math_doctor` 1 call sites; OFF 0.

## Bottom line

- Contest/reasoning pilots: zero condition-only wins.
- Text retrieval: 10/10 vs no tools, but **6/10 vs 9/10 with generic
  grep/read**; the plugin is worse on the fair baseline and has no ON-only win.
- No measured plugin-specific improvement so far.
- Untested unique capabilities: PDF extraction (generic read cannot extract PDF
  text), Lean verification (generic tools cannot check proofs), and Comparator.
  Test those next against generic baselines; stop adding redundant text-retrieval
  tools and stop claiming general math gains.

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
