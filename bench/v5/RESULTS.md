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

### What the pilot supports

- On jointly completed tasks, both conditions answered every one correctly:
  **no condition-only correctness win**.
- The only difference is **completion**: ON finished 36/40, OFF 34/40; the two
  extra ON completions are paired against OFF timeouts and therefore ungraded.
- A 40-task, one-repeat, one-model pilot cannot establish a completion benefit.
  It is a feasibility and grading-sensitivity result, not efficacy evidence.
- The corrected grader is clearly better than the bounded one for symbolic
  answers; the conservative result is retained rather than overwritten.

### Cost

CLI-reported, not reconciled billing. ON: known subtotal **$0.085251078** for
11/40 episodes; OFF: **$0** known for 0/40. Coverage is incomplete, so these are
not comparable totals or provider invoices.

## Other tracks

| Track | State |
|---|---|
| Clean two-task smoke | 2/2 both; ON used `math_compute`; OFF used no tools |
| IMO-AnswerBench v2 | 400 tasks, 40-task pilot; capture running |
| MathConstruct | 121 tasks, 20-task pilot; validator bridge: 2 positives accepted, 2 negatives rejected; no model run |
| ProofNet-Verified | 367 Lean 4.34.0 tasks, 20-task pilot, 367 unverified controls; checker not bound |
| ArXivMath | 103 closed-book tasks, 20-task pilot; no model run |
| Comparator | 8 tasks; real run blocked (Comparator/landrun/lean4export absent) |
| Tool tests | `v5:test` 188 tests, 165 pass, 0 fail, 23 skipped; syntax 155 files |

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
