# Math plugin benchmark

This **indicative, not scientific** benchmark runs every model × problem × repeat
× condition (with/without the project-local math toolkit). It measures keyword
hits, elapsed wall time, and a visible tool-call heuristic, not proof correctness.
`RESULTS.md` records the historical 10-problem, one-repeat, two-model run, the
executed core matrix (4 problems × 3 repeats × 3 models; 36/36 with plugin vs
23/36 without), and the executed full matrix (10 × 3 × 3; 83/90 vs 62/90).
These are keyword scores, not proof verification; the caveats below still apply.

## Running the matrix

From the repository root (Node.js and an authenticated OpenCode CLI required for
real runs):

```sh
node bench/run.mjs --dry-run
node bench/run.mjs --dry-run --models opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash
node bench/run.mjs --models opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash --repeats 2 --timeout 180 --json --md
node bench/run.mjs --standalone --problems bench/problems.json
```

The default is `opencode-go/deepseek-v4.1-flash`, 10 problems, one repeat, and a
180-second timeout per invocation: **20 commands**. The two-model example has
40 commands per repeat (80 with two repeats). Model IDs are supplied directly;
the harness never calls `opencode models`. Availability/authentication must be
checked separately before a real run. Duplicate model IDs are deduplicated.
`--model` remains an alias for `--models`.

Nested runs omit `--standalone` by default; add it to forward that flag to
OpenCode. Each invocation uses `--agent build --format default`. Custom problem
paths are relative to the calling directory; the default resolves relative to
the repository. `--dry-run` prints commands, working directories, executable
resolution, and the matrix count without executing OpenCode or writing files,
even with `--json` or `--md`. Real runs may incur model charges.

The **with plugin** working directory is the repository root. The **without
plugin** project is `os.tmpdir()/opencode-math-bench-no-plugin`, with this config
written to `.opencode/opencode.json` on each real benchmark:

```json
{ "$schema": "https://opencode.ai/config.json", "plugins": [] }
```

The without project still has global plugins, but not this project's
math-toolkit. Do not globally install math-toolkit for this comparison. Global
configuration, inherited environment, and permissions are not reset. The temp
project is reused, not cleaned; avoid putting other files or plugins there.
Corpus reads require the local `math/` clone and computations require SymPy.

On Windows the harness locates `opencode.cmd` on PATH and resolves its native
executable or standard npm JavaScript entry point, because Node cannot execute
a `.cmd` file directly with `shell:false`. Unsupported custom shims are recorded
as run errors. Other systems execute `opencode` directly. Prompts are passed as
single arguments, never interpolated into a shell. Timeout termination applies
to the directly spawned process, not a guaranteed cleanup of all descendants.

## Core repeat matrix

Use `bench/problems-core.json` for a repeatable, high-signal **4-problem ×
3-repeat × 3-model** comparison. With both plugin conditions this is **72
commands**. The models are `opencode-go/deepseek-v4.1-flash`,
`opencode-go/glm-5.3-flash`, and `opencode-go/gpt-6-luna`.

The subset preserves the full set's prompts and keywords unchanged:

- `quasi-riemann`: corpus retrieval, including the previously observed retrieval timeout.
- `landau-siegel`: corpus retrieval and cataloged Lean status/Comparator documentation.
- `pdf-overview`: PDF-only extraction.
- `sympy-determinant`: exact symbolic computation.

From the repository root, run the PowerShell wrapper (no arguments required):

```powershell
.\bench\run-core.ps1
```

It resolves the repository root from its own location, prints the command, and
runs the equivalent of:

```powershell
npm run bench -- `
  --models opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash,opencode-go/gpt-6-luna `
  --problems bench/problems-core.json `
  --repeats 3 `
  --standalone `
  --json --md
```

Extra arguments pass through, for example `.\bench\run-core.ps1 --dry-run` to
preview without inference or report writes, or `--timeout 240` to override the
default timeout. Real runs overwrite `bench/results/latest.json` and
`bench/results/latest.md`; preserve previous reports first if needed.

Use the core set to compare repeat variability and the third model without the
full matrix's cost. Use `bench/problems.json` for broader coverage, including
declaration lookup, theorem explanation, missing-corpus answers, simplification,
and equation solving. The full 10-problem × 3-repeat × 3-model matrix runs
180 commands across both conditions; the recorded run is in `RESULTS.md`.

Expected runtime is long: the core's sequential invocations can consume roughly
3.6 hours at the default 180-second timeout each, plus overhead. Detached
processes may be needed to survive session/server restarts; keep logs and avoid
concurrent runs overwriting the same report files.

## Ten problems

| Category | Problem IDs | Target evidence |
| --- | --- | --- |
| Corpus retrieval | `quasi-riemann`, `landau-siegel`, `family-lookup` | Family numbers, paper titles, bounds, and Comparator filenames from the catalog/scope docs |
| Lean status/declaration | `lean-declaration` | Jacobsthal declaration and implementation path in `lean/formalization.yaml`; no Lean build |
| PDF-only extraction | `pdf-overview` | Cover metadata and final contents heading from page 1 of `overview.pdf`, not TeX/Markdown |
| Symbolic computation | `sympy-simplify`, `sympy-solve`, `sympy-determinant` | Nontrivial exact simplification, cubic roots, and a 3×3 determinant |
| Theorem explanation/citation | `theorem-explanation` | Strengthened Jacobsthal bound and signed interval scope from `lean/docs/021.md` |
| Missing corpus answer | `no-corpus-answer` | Honest absence report for an intentionally invented exact title |

Corpus targets are grounded in `math/CONTENTS.md`, `lean/docs/003.md`,
`lean/docs/021.md`, `lean/formalization.yaml`, and `overview.pdf` (page 1).
These are reported corpus claims, not newly checked proofs. Prompts request
citations and prohibit file changes/installations, but those are instructions,
not a sandbox or automatically validated criteria.

## Scoring and output

Each JSON problem has `id`, `prompt`, and `keywords`, plus optional `anyKeywords`.
All `keywords` must occur case-insensitively in combined stdout and stderr. If
`anyKeywords` is present, at least one of those must also occur (use an empty
`keywords` array for an any-only check). A process error or nonzero exit always
fails; the harness records it and continues through the matrix, including model
availability/authentication errors and timeouts.

`toolCalls` counts visible **`⚙ execute` markers** in combined stdout/stderr after
stripping ANSI CSI sequences; optional emoji variation selectors and whitespace
are allowed. It deliberately does not also count `tools.math_` strings, which
would double-count nested calls or echoed code. This is a Code Mode invocation
heuristic: one execute can contain several math calls or none, hidden/direct
calls can score zero, and duplicated/quoted markers can overcount. It neither
proves math-tool usage nor affects the keyword score.

Example output shape (illustrative, not measured):

```text
model                            problem        condition       repeat seconds exit score toolCalls
opencode-go/deepseek-v4.1-flash    quasi-riemann  with plugin     1      12.34   0    PASS  2
opencode-go/deepseek-v4.1-flash    quasi-riemann  without plugin  1       8.76   0    FAIL  0
opencode-go/glm-5.3-flash          quasi-riemann  with plugin     1      11.23   0    PASS  3
...
opencode-go/deepseek-v4.1-flash | with plugin: 8/10 passed, 0 errors, 10.00s mean, 2.10 mean tool calls
opencode-go/deepseek-v4.1-flash | without plugin: 3/10 passed, 1 errors, 8.00s mean, 0.00 mean tool calls
...
```

Summaries group by **model + condition**: passed/total, errors, mean duration,
and mean tool calls. Means include failed runs. `--json` overwrites
`bench/results/latest.json` with configuration, prompts, summaries, and results
containing `model`, `problem`, `condition`, `repeat`, `seconds`, `exit`, boolean
`score`, `toolCalls`, plus raw output, durations in milliseconds, and error/signal
details. `--md` overwrites `bench/results/latest.md` with model/tool-call columns
and grouped summaries. Neither report is written by default. Review captured
output before sharing it.

Keyword checks can give false positives (including negations, echoed prompts,
tool traces, and incidental digits) and false negatives from alternate wording.
They do not validate citation accuracy, complete explanations, negative-result
search coverage, or use of PDF/SymPy tools. A missing-corpus refusal can also pass
the absence check. The with condition has corpus files, repository instructions,
and other local configuration unavailable in the without project, so this does
not isolate the plugin alone. Small sample size, fixed model/condition order,
caching, network latency, and model variability further limit comparisons.

## Analyze an existing run

From the repository root, analyze the saved full run without model inference or
file writes:

```sh
node bench/analyze.mjs bench/results/latest.json --md
npm run bench:analyze
node bench/analyze.mjs bench/results/latest.json --json
```

The optional JSON path defaults to this repository's `bench/results/latest.json`;
explicit paths are relative to the calling directory. Markdown is the default;
choose either `--md` or `--json` for stdout output, not both. The analyzer validates
the saved result rows and fails with an error if the file is missing or malformed.
It recomputes summaries from those rows rather than trusting saved summaries.

Reports include model × condition pass counts/rates, errors, mean/median/p95
duration in seconds, mean visible tool calls, pooled with/without totals and their
percentage-point difference, and problem × model × condition pass counts.
Duration and tool-call statistics include failures and errors. The median averages
the middle pair for even samples; p95 uses nearest rank (`ceil(0.95 × n)`).
Errors mean a nonempty process error or an exit code other than zero.

Wilson 95% confidence intervals describe binomial sampling uncertainty around
each pass rate, including pooled totals. Under independent, comparable trials,
the interval procedure covers the true rate in approximately 95% of repeated
samples; this is not a 95% probability that this particular interval contains it.
JSON rates and interval bounds are fractions from 0 to 1. Wide intervals indicate
limited precision; even a perfect observed score does not establish a 100% true
pass rate. Repeats of the same problems and pooled models are not independent
random samples, so these intervals are descriptive approximations, not adjusted
for clustering or evidence of general benchmark superiority. Interval overlap is
not a significance test; the reported percentage-point difference is descriptive
and has no confidence interval or causal interpretation.

## Rigor limits

- **Heuristic scoring:** keyword matches are not blind grading, citation checks,
  mathematical correctness checks, or proof verification.
- **Three repeats:** the full run has only 3 repeats per problem/model/condition;
  small samples and correlated prompts limit precision and generalization.
- **Global plugins:** the without condition still inherits global OpenCode
  plugins/configuration. It is not a clean no-tools baseline, and corpus access
  and project instructions also differ between conditions.
- **Overlapping builds/plugin updates:** concurrent builds and plugin updates
  during the run can affect resource contention and environment consistency.
  Recorded durations are not a controlled latency benchmark.
- **Stronger claims require** isolated profiles/environments, frozen plugin and
  model configurations, balanced or randomized execution, more independent
  problems/repeats, and blind grading against a predefined correctness rubric.

The analyzer does not alter `RESULTS.md` or any saved reports.
