# MathConstruct pack

Offline extraction of the **current source checkout**, not `data/all.json` (a
results log). No model is invoked. No network, package installation, Docker, or
source-checkout writes are needed.

## Reproduce

From this directory:

```powershell
$env:MATHCONSTRUCT_SOURCE = 'C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\mathconstruct'
node build.mjs
node --check build.mjs
```

From the harness repository root:

```powershell
node --test bench/v5/packs/mathconstruct/tests/mathconstruct-pack.test.mjs
```

Python 3 is required for the standard-library AST worker. Override its executable
with `MATHCONSTRUCT_PYTHON`. Build outputs are confined to this pack. Default
builds preserve separately recorded validator evidence only while the source
bundle hash is unchanged. There are no timestamps or random selections.

## Extraction and scope

`tasks.json` and `pilot.json` are arrays of `math-bench-task/v1` records.
`validators.json` is a closed map keyed by task id. `baselines.json` is the
specified empty exact-model baseline; no external score was inferred or searched
for during this offline task.

The builder enumerates `src/math_construct/problems/**/*.py`, excluding
`backups/`, package initializers, and helpers. Only classes with an actual
`config = ProblemConfig(...)` and checker are admitted. Config constants,
`Tag` values, shared statement templates, and formatting instructions are parsed
as AST data. An explicit evaluator supports literals, named constants,
arithmetic, simple initializer attributes, and formatting-only statements.
It does **not** evaluate source Python, import problem modules, call solutions,
or run validators during extraction. Unsupported statement derivations remain
templates with `needs_parameters: true`, explanatory errors, and pilot exclusion.
Original values are never filled from a generated variant or a results log.

The stored `task.prompt` is only the resolved statement plus the requested
`FINAL:` suffix. Upstream answer-format instructions remain in
`grading.answer_format`; the validator runner appends them at dispatch, including
their formatting examples. Sending a pack prompt without its required format is
**format-invalid**. Source URLs, original solutions, and validator bodies are not
appended. Published statement examples are retained in the full
pack but conservatively excluded from the pilot. Literal original answers are
checked for overlap without executing solution-generating expressions; such
overlaps are also pilot-ineligible. This is a provenance/leakage safeguard, not
a mathematical proof that an upstream statement gives away no information.

The 20-task pilot uses equal category round-robin in the fixed order Algebra,
Combinatorics, Geometry, Number Theory, Puzzle. Within each category it favors
less-represented tags, then lexical id. Exhausted/absent categories are skipped;
multi-tag tasks appear once. Output is sorted by id. Every pilot task has all
declared parameters explicitly present in `original_parameters`, a resolved
statement, and no flagged literal-answer/example overlap.

SHA-256 hashes cover each problem source and shared templates, config/checker
base, utilities, parser, and README. Per-entry `source_hashes` record its module
and shared inputs; the union is the full source manifest. The bundle digest is
SHA-256 of that sorted manifest, pretty-printed with two spaces and a final LF.

The September 2025 README reports five removed problems and five corrected
checkers but names none. The supplied shallow checkout has no historical removal
manifest. We do not guess their identities: all backups are excluded, coverage
is checked against the current active modules, and the named-five historical
test is explicitly skipped. Existing corrected checkers are referenced in place;
no stale checker copies or result-log tasks are used.

## Validator status and optional execution

All checkers are **unverified until a real acceptance receipt is recorded**.
AST extraction/import alone is not acceptance. `runs` contains separate receipts;
`executed` requires a checker call and `verified` requires a boolean acceptance.
Acceptance checks a construction, not the entire informal proof, and is not a
claim of independent checker correctness.

```powershell
node build.mjs --smoke
node build.mjs --validate <task-id> --answer <response.txt>
```

Smoke mode considers only the first two sorted pilot tasks. It requires `uv`
and available checker dependencies; it never installs or downloads anything.
The recorded attempt in this environment is `not_run`: `uv` is not on PATH
(`ENOENT`), and Python lacks `pydantic`, `loguru`, `scipy`, and `antlr4`.
There is no original-solution acceptance result.

If available, smoke mode runs the selected source's `original_solution` through
its actual checker in a separate Python process with a 60-second timeout and
records only status, not the solution. Candidate mode reads the last nonempty
`FINAL:` line, wraps an unboxed payload in `\boxed{...}`, uses the upstream
parser, and calls the original-parameter instance's checker. A parse/import
failure is an error, not acceptance.

The runner bypasses the upstream eager-import-all package initializer, disables
bytecode writes, and rejects network/process/file-write audit events. This is
**not a security sandbox**; use only the trusted checked-out benchmark source.
Model output is never passed to `eval` or treated as Python code. The upstream
parser and dependencies still need independent hardening before untrusted
large-scale evaluation. The project declares Python >=3.12; extraction works
with the available Python 3.11 because it does not import the benchmark.

## Capture → JSON parse → validator runner

`run-validator.mjs` is an opt-in **exploratory, not confirmatory** model runner.
It submits `task.prompt` plus, when `grading.answer_format` is a nonempty string,
exactly `\n\nRequired answer format:\n${answer_format}`, identically in both
conditions. Answers, validation data, parameters, and validator references are
not appended; the answer-format instructions and their examples are. Plugin-off
sets `MATH_TOOLKIT_DISABLE=1`; plugin-on clears inherited disable/toolset switches
case-insensitively. This is the external runner's condition mechanism, not a
guarantee that all other plugins or retrieval paths are absent.

The existing two episodes from the first pilot omitted these required format
instructions. They are **format-invalid and must not be pooled** with corrected
runs. They have not been rerun or modified by this fix.

CLI:

```text
node bench/v5/packs/mathconstruct/run-validator.mjs --tasks <pilot.json> --model <provider/model> --condition plugin-on|plugin-off --out <fresh-absolute-directory> [--limit N] [--timeout-ms 300000]
```

Future 20-task pilot commands, from the harness root (these were **not run**):
first separately provision the clean workspace named below with the intended
OpenCode/plugin configuration. The runner requires `EXTERNAL_BENCH_WORKSPACE`;
it does not create or certify a clean workspace. Set the Python executable to
the existing validator venv. The output parent must exist, and both leaf
directories must be new; existing directories, even empty ones, and repository
paths (including symlink/junction aliases) are refused.

```powershell
$env:EXTERNAL_BENCH_WORKSPACE = 'C:\Users\MiPC\AppData\Local\Temp\opencode\mathconstruct-clean-workspace'
$env:MATHCONSTRUCT_PYTHON = 'C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\mathconstruct\.venv\Scripts\python.exe'
node bench/v5/packs/mathconstruct/run-validator.mjs --tasks bench/v5/packs/mathconstruct/pilot.json --model openai/gpt-6-astra --condition plugin-on --out 'C:\Users\MiPC\AppData\Local\Temp\opencode\mathconstruct-pilot20-on-01' --limit 20 --timeout-ms 300000
node bench/v5/packs/mathconstruct/run-validator.mjs --tasks bench/v5/packs/mathconstruct/pilot.json --model openai/gpt-6-astra --condition plugin-off --out 'C:\Users\MiPC\AppData\Local\Temp\opencode\mathconstruct-pilot20-off-01' --limit 20 --timeout-ms 300000
```

The model transport is `opencode run --model ... --format json --standalone --
<effective-prompt>` without a shell. The existing `validator/bridge.mjs` calls
`validator/validate.py` after capture, with a 10-second process timeout. Python
defaults to `python` unless `MATHCONSTRUCT_PYTHON` is set. No dependencies are
installed automatically. Validators execute trusted local Python, not a sandbox.

`parseFinalAnswer(text, {answerFormat})` returns `{status, value, reason}`.
It accepts JSON from the last explicit `FINAL:` line, the last JSON/unlabelled
code fence, or a complete trailing array/object. Whole `$...$`, `$$...$$`,
`\(...\)`, `\[...\]`, balanced `\boxed{...}`, `\fbox{...}`, and `\text{...}`
wrappers are stripped, along with leading `\displaystyle` and array-delimiter
`\left`/`\right` sizing outside JSON strings.
Nested arrays, objects, numbers, and strings retain their JSON structure.
An explicit malformed `FINAL:` is not replaced with an earlier example.
Format metadata is not used as an answer source. Tuples, bare comma lists,
symbolic expressions, malformed JSON, unsafe integer values, and non-finite
numbers are not repaired or guessed.

**Free-form constructions can be unparseable; never count unparseable as
incorrect.** The stored prompts are unchanged, but the runner now supplies their
required answer formats. Non-JSON constructions remain unsupported. Exact fraction strings
can pass through to the bridge; LaTeX fractions and arbitrary-size JSON integers
cannot be safely interpreted by this parser.

Outputs include a pre-dispatch `plan.json`, final `manifest.json`, and
`episodes/*.json` with raw capture, effective prompt hash, final text, usage, duration,
capture status, parsed value, and typed validator receipt. Validation counts
remain separate:

- `accepted` / `rejected`: a well-formed bridge receipt after successful capture.
- `unparseable`: no supported JSON construction, or bridge `MALFORMED_ANSWER`.
  The original bridge receipt is retained even when its status is `rejected`.
- `unavailable`: missing/import-failing/timed-out validator, invalid receipt,
  or bridge request/protocol failure.
- `missing`: empty answer or failed/incomplete model capture. Partial output
  from failed capture is preserved but never validated as acceptance.

There are no automatic retries, resumes, or fallback models. These counts
measure construction-checker outcomes, not proof quality or mathematical accuracy
improvement from the plugin.

### Runner verification (2026-11-18)

```powershell
node --test bench/v5/packs/mathconstruct/tests/validator-runner.test.mjs
node --check bench/v5/packs/mathconstruct/parse-answer.mjs
node --check bench/v5/packs/mathconstruct/run-validator.mjs
```

**62 passed, 0 failed, 0 skipped**; both syntax checks passed. Default tests use
in-memory filesystems and injected model/bridge processes: no Python or model
is required, and no real benchmark episode is dispatched.

Separately, the existing venv ran exactly two real bridge controls for
`dutch-2019-2`, each with a 10-second timeout and bytecode writes disabled:

| Control | Bridge result | Runner classification |
| --- | --- | --- |
| Upstream `config.original_solution` | `accepted / CORRECT / OK` | `accepted` |
| JSON string `"not-a-construction"` | `rejected / MALFORMED_ANSWER / ValueError: Expected a JSON array` | `unparseable` |

This was reference-solution reproduction, not fresh reasoning or a model score.
No additional direct checker call, model, network, Docker, or benchmark episode
was run. Earlier extraction-only smoke notes above describe a different,
historical dependency state; the current bridge venv is documented in
`validator/README.md`.
