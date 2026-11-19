# v5 external math benchmarks — exploratory

**Status: first paired pilots launched. Exploratory, not confirmatory.** These
tracks exist to test whether the math toolkit helps on external benchmarks. They
are separate from the completed v4 real-use studies and do not replace them.

## Tracks

| Track | Path | What it measures | Status |
|---|---|---|---|
| External runner | `bench/v5/external/` | Paired ON/OFF execution, deterministic grading, reporting | 28 tests passing |
| Analysis | `bench/v5/external/analyze.mjs` | Tool attribution, paired correctness/completion, bootstrap, timeout overlap | 7 tests passing |
| MathArena 2026 pack | `bench/v5/packs/matharena-2026/` | AIME/HMMT/BRUMO/SMT exact answers | 146 tasks; 40-task pilot |
| IMO-AnswerBench v2 pack | `bench/v5/packs/imo-answerbench-v2/` | 400 short-answer olympiad problems | 400 tasks; 40-task pilot |
| MathConstruct pack | `bench/v5/packs/mathconstruct/` | Construction problems with executable validators | 121 tasks; 20-task pilot; validator bridge + capture/parse runner (50 tests); 2 positives accepted, 2 negatives rejected |
| Tool-necessity retrieval pack | `bench/v5/packs/tool-necessity/` | Verbatim quote retrieval from 20 manuscripts; tool-necessary | 20 tasks; 10-task pilot running; 1/1 smoke ON-only |
| ProofNet-Verified pack | `bench/v5/packs/proofnet-verified/` | Lean proving (367 tasks, Lean 4.34.0) | 367 tasks; 20-task pilot; 367 unverified controls; checker not yet bound |
| ArXivMath pack | `bench/v5/packs/arxivmath/` | Paper-derived exact answers (closed-book) | 103 tasks; 20-task pilot |
| Comparator pack | `bench/v5/comparator/` | Retrieval-assisted reproduction with Comparator | 8 tasks; real run blocked (Comparator/landrun/lean4export absent) |
| Tool conformance | `bench/v5/tool-tests/` | SymPy, diagnostics, retrieval, checker coverage | 299 tests in `v5:test`, 276 pass, 23 skipped |

## Clean benchmark workspace

The main workspace exposes `execute` Code Mode, which includes `fetch`; running
benchmarks there would allow web/answer retrieval. The first two-task smoke in
the main workspace was therefore discarded as a measurement of the plugin.

The completed pilots used
`C:\Users\MiPC\AppData\Local\Temp\opencode\math-bench-env-20261117`. That copy
later lost its plugin entry wrapper and corpus junction; it was rebuilt as
`...\math-bench-env-v2-20261118` with the same plugin/config. The tool-necessity
run uses v2; older manifests record the old path and their tool events stand.

- copied math-toolkit plugin; `codemode: true` → `false` so tools are direct;
- `math` junction to the corpus;
- `oh-my-opencode-slim` added only to register the `opencode-go` model route;
- permissions deny `webfetch`, `websearch`, `execute`, `bash`, `shell`, `edit`,
  `write`, `read`, `grep`, `glob`, `ast_grep_*`, `list`, `find`, `lsp`, `task_*`,
  `external_directory`.

Probes:

- ON: direct `math_status` completed; no `execute`.
- Denied: `webfetch`, `shell`, `execute` reported unavailable; no tool events.
- v2 ON: direct `math_status` completed; the tool-necessity smoke used only math tools.
- v2 tool inventory: math tools plus `question`/`wait_for_user`/`skill`; these
  could not be denied without invalidating the config and hiding the math plugin.
- OFF (`MATH_TOOLKIT_DISABLE=1`): `math_status` → `TOOLS_UNAVAILABLE`; no tool event.

Residual risks: `math_status` prints host/index paths; the corpus junction is
writable; `math_reindex`/`math_lean_build` can write; Lean/Docker process
execution is not an OS sandbox. The clean workspace is a leakage control for
web/filesystem tools, not a security boundary.

## Run protocol

- Model: `opencode-go/deepseek-v4.1-flash`.
- Conditions: `plugin-on` (toolkit enabled) and `plugin-off`
  (`MATH_TOOLKIT_DISABLE=1`), same prompt/model/timeout/workspace.
- 40 tasks per pack, one repeat, 300 s per episode, sequential, no retries.
- Grading: deterministic integer/exact/bounded-symbolic; unparseable and missing
  reported separately; no LLM judge for primary correctness.
- External baselines: separate and not pooled; no published score for this exact
  model/version was found.

Commands:

```text
node bench/v5/external/run.mjs --tasks <pilot.json> --model opencode-go/deepseek-v4.1-flash \
  --condition plugin-on|plugin-off --out <fresh absolute dir> --timeout-ms 300000

node bench/v5/external/grade.mjs --run <run-dir> --tasks <pilot.json> --out <fresh absolute dir>

node bench/v5/external/report.mjs --grades <on/grades.json> --grades <off/grades.json> \
  --out <fresh absolute dir> [--baseline <baselines.json>]
```

Set `EXTERNAL_BENCH_WORKSPACE` to the clean workspace.

## Caveats

- Exploratory: one model, one repeat, deterministic graders, no causal claim.
- The plugin-off arm disables this toolkit only, not built-in tools.
- External leaderboard scores are not apples-to-apples; the paired off arm is the
  primary baseline.
- Retrieval-assisted reproduction is not separated unless a task says so; the
  corpus contains research proofs and Comparator challenges.
- MathConstruct validators are not executed; no correctness is claimed.
- Comparator challenges are retrieval-assisted and were not run.
- `math_status`/`math_doctor` expose host paths; a known diagnostics-hygiene gap.
