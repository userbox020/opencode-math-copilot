# MathConstruct local validator bridge

Recorded on 2026-11-17, Windows, Python **3.11.9**, pip **24.0**, Node
**v24.21.0**. Upstream clone commit:
`3e51d847547a6586237ae55b83131b0e31b8476d`.

No model, Docker container, or benchmark episode was run. `tasks.json`,
`pilot.json`, and upstream source were not edited. These are reference-solution
reproduction controls, not fresh mathematical reasoning or model scores.

## Installation commands

The upstream `pyproject.toml` requires Python >=3.12, so `pip install -e .` was
not attempted with Python 3.11.9. The authorized validator-only dependency
fallback succeeded. ANTLR retains upstream's `==4.11` constraint.

Run from PowerShell:

```powershell
Set-Location 'C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\mathconstruct'
python --version
python -m venv .venv
New-Item -ItemType Directory -Force '.venv\install-tmp' | Out-Null
$env:TEMP = Join-Path $PWD '.venv\install-tmp'
$env:TMP = $env:TEMP
.\.venv\Scripts\python.exe -m pip install --no-cache-dir pydantic loguru scipy antlr4-python3-runtime==4.11 numpy sympy
.\.venv\Scripts\python.exe -m pip freeze
.\.venv\Scripts\python.exe -m pip --version
git rev-parse HEAD
```

The execution used stop-on-error checks after venv creation and installation.
Installation temp files were confined to `.venv/install-tmp`; pip caching was
disabled. Full installed dependency versions:

```text
annotated-types==0.8.0
antlr4-python3-runtime==4.11.0
colorama==0.4.6
loguru==0.8.0
mpmath==1.3.0
numpy==2.4.6
pydantic==2.14.3
pydantic_core==2.50.4
scipy==1.17.1
sympy==1.14.0
typing-inspection==0.4.5
typing_extensions==4.16.0
win32_setctime==1.2.1
```

This is not a full installation of upstream's training/model stack.

## Contract and invocation

`validate.py` consumes one JSON document on stdin:

```json
{"task_id":"emc-2021-1","answer":[0]}
```

It emits one JSON document on stdout:

```json
{"schema":"mathconstruct-validator/v1","task_id":"emc-2021-1","status":"rejected","tag":"INCORRECT_LENGTH","reason":"Expected 20 elements, got 1"}
```

`status` is `accepted`, `rejected`, or `unavailable`. Upstream tags are preserved
as enum **names**, e.g. `CORRECT` (upstream value `"Correct"`) and
`INCORRECT_LENGTH` (value `"Incorrect number of objects"`). Legacy upstream
boolean/two-item results use `UNKNOWN`, consistent with upstream's wrapper.
The exit code alone is not an acceptance signal.

```powershell
Set-Location 'C:\_Work\opencode-math-copilot'
$python = 'C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\mathconstruct\.venv\Scripts\python.exe'
'{"task_id":"emc-2021-1","answer":[0]}' | & $python -B bench/v5/packs/mathconstruct/validator/validate.py
```

The answer must already be a parsed JSON value, **not** a full assistant
message, `FINAL:` line, LaTeX, Python expression, or code block. Arrays restore
upstream list/tuple structure using the original solution as a type exemplar;
integer/real/string leaves are type-checked without evaluating them. Exact
fractions use integer values or strings such as `"1/2"` when the upstream
primitive type is `Fraction`. Booleans, objects, nulls, non-finite numbers, and
unsupported/mismatched types fail closed. Original-solution values are never
substituted for a submitted answer. Length constraints remain the checker's job.
Unsupported valid-answer representations may be rejected; this is not a
universal natural-language answer parser.

Task IDs resolve only through the sibling authoritative `tasks.json`. Module,
class, source path/hash, name, and original parameters are checked against that
manifest before checking an answer. No user-supplied import path is accepted.
The upstream registry normally eagerly imports all problems; the bridge instead
creates package shells and imports only the selected problem and its
dependencies. Its in-memory `__file__` uses forward slashes for upstream's
Windows-incompatible name splitter. No upstream source is rewritten, and
bytecode writes are disabled.

Failures:

| Failure | Status | Tag |
| --- | --- | --- |
| Invalid JSON | rejected | INVALID_JSON |
| Missing/non-string task ID or missing answer | rejected | INVALID_REQUEST |
| Unknown task | unavailable | UNKNOWN_TASK |
| Import, source/hash, configuration failure | unavailable | LOAD_ERROR |
| Unsupported/malformed answer type | rejected | MALFORMED_ANSWER |
| Checker exception or invalid return contract | unavailable | VALIDATOR_EXCEPTION |

Unrecoverable process crashes are handled by the caller, not by a Python
receipt. `bridge.mjs` is an optional Node caller: `validate(request, {python})`.
It invokes Python without a shell, enforces a 60-second timeout and 1 MiB output
limit, validates the receipt/task ID, and returns `unavailable/BRIDGE_ERROR` for
process/protocol failures. Direct Python callers must supply their own process
timeout. This runs trusted upstream validators locally; it is not a security
sandbox or a resource-isolated grader.

## Recorded checks

```powershell
Set-Location 'C:\_Work\opencode-math-copilot'
node --test bench/v5/packs/mathconstruct/validator/validator.test.mjs
& 'C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\mathconstruct\.venv\Scripts\python.exe' -B bench/v5/packs/mathconstruct/validator/real_smoke.py
Get-FileHash -Algorithm SHA256 'bench\v5\packs\mathconstruct\validator\validate.py', 'bench\v5\packs\mathconstruct\validator\validator.test.mjs'
node --version
```

The Node tests use **only injected fake Python output**: **16 passed, 0 failed,
0 skipped**. They check all three statuses, invocation arguments, task/schema
matching, required tag/reason, malformed or polluted stdout, process failure,
timeout, thrown exceptions, and missing Python. They do not prove that the
Python checker implementation works.

The separate real smoke script confirms both tasks belong to `pilot.json`,
instantiates their original parameters, directly checks
`config.original_solution`, then sends JSON through the actual Python bridge.
Both direct checks returned `(True, "OK", CheckerTag.CORRECT)`.

| Task | Bridge input | Status | Exact tag | Reason |
| --- | --- | --- | --- | --- |
| dutch-2019-2 | config.original_solution | accepted | CORRECT | OK |
| emc-2021-1 | config.original_solution | accepted | CORRECT | OK |
| dutch-2019-2 | `[]` | rejected | INCORRECT_LENGTH | There should be 3 different configurations. |
| emc-2021-1 | `[0]` | rejected | INCORRECT_LENGTH | Expected 20 elements, got 1 |

**4/4 real bridge controls passed; 2/2 direct reference checks passed.** Neither
negative control was `unavailable`. Only these two pilot validators were run;
this does not establish coverage/correctness for all 121 tasks or all 20 pilot
tasks. Checks validate **constructions, not informal proof quality**.

SHA-256:

```text
validate.py
793c5ea77d5601ade9415828440fd48dbb10d954045e2b164f2a5aaa959c4b7c

validator.test.mjs
d874001233e1d90c5c4587e460e11bf3d137ab225a23877f38f0efa1cce0d76f
```
