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

The prompt is only the resolved statement plus the requested `FINAL:` suffix.
Source URLs, original solutions, formatting examples, and validator bodies are
not appended. Upstream answer-format instructions remain in `grading`, outside
the prompt; callers should not blindly append them as task text because some
contain worked examples. Published statement examples are retained in the full
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
