# V5 bounded tool-gap tests

Run from the repository root (Node 24+, built-in test runner only):

```powershell
node --test bench/v5/tool-tests/*.test.mjs
```

No models, network, packages, corpus, Python, Lean or Docker are required by the
default run. Test sources are confined to this new directory. Runtime fixtures
are tiny, created under the OS temporary directory (`opencode/` when present),
and removed after each test. Nothing writes to the corpus or existing suites.
`helpers.mjs` uses scoped Node module hooks to substitute dependencies, never
rewriting the implementation being tested. No assertions contain actual host
paths or credentials; diagnostic paths and private canaries are synthetic.

## Capability map

| Suite | Capability / evidence |
| --- | --- |
| `compute-policy.test.mjs` | Actual JS compute wrapper with fake executable/process dependencies: dispatch for nine previously uncovered operations, fixed-field JSON transport, validation boundaries, oversized input, timeout vs process/output/worker-error classification. Fake results are **not** mathematical evidence. |
| `compute-worker.test.mjs` | Opt-in actual Python worker: exact factor, expand, solve, diff, integrate, limit, series, evalf and eigenvalue/multiplicity fixtures; complex roots/logarithms, unknown symbol sign, unsplit logarithm and right-sided pole limit; syntax, exponent/digit/expression budgets, invalid variable. |
| `diagnostics.test.mjs` | Actual registered status/doctor handlers with synthetic filesystem/tool/index dependencies: closed field inventory, no unrelated environment or subprocess-output dumps, bounded read-only inspection, advertised status-path fields, doctor corpus-path field. Includes one known-failing TODO for the requested stricter path sanitation. |
| `retrieval.test.mjs` | Four-document BM25 index, five labeled queries with macro recall@2 = 1 target (fixture regression only, not corpus recall); case folding, limits and no matches. Actual Node text fallback and manuscript reader on a six-line temporary TeX fixture: exact relative one-based line/section locators, case-sensitive literal/regex search, context deduplication and truncation. No PDF extraction. |
| `checker-coverage.test.mjs` | Two explicit coverage skips, pointing to existing v4 independent-checker controls rather than copying them. |

## Optional real SymPy

```powershell
$env:V5_TOOL_TEST_SYMPY = '1'
node --test bench/v5/tool-tests/compute-worker.test.mjs
Remove-Item Env:V5_TOOL_TEST_SYMPY
```

Without opt-in, all 19 real-worker cases skip without probing Python. With
opt-in, absence of Python or a failed bounded isolated SymPy probe skips with
a clear reason; nothing is installed. Actual invocations use `-B -I`, no shell,
a minimal environment, a temporary working directory, a 10-second deadline and
a bounded output buffer. A hung available worker fails rather than becoming a
skip. Timeout classification is deterministic fault injection in the policy
suite, not an expensive/nondeterministic live symbolic-computation stress test.
No real Docker/Lean tests are added: the requested cases already exist in v4.

## Diagnostics discrepancy (not a sanitation guarantee)

The current `math_status` tool description explicitly advertises **root paths**
and executable availability. Its public output includes `Math root`, `Index`
and executable path fields; the tests permit these advertised fields and check
that paths do not spill elsewhere. It is **not** a sanitized interface.

`math_doctor` has an existing `Corpus clone path` contract, which is asserted
using a synthetic path. Beyond this exception it currently emits the PDF cache
path, host executable paths, Docker executable, and workspace/corpus paths in
disk-space labels (`lib/doctor.js:29-30,53,61,71,76,87`). Its broad health
description does not document a sanitized public-field contract. The stricter
“only the documented corpus-path exception” test is deliberately marked TODO:
it fails today without failing the suite, exposing rather than blessing this
gap. The field-inventory test characterizes current fields, not their approval
as a safe public interface. No production changes are made. Synthetic tests
do not establish protection against arbitrary secrets embedded in configured
paths or labels, nor sanitize error paths that are outside these fixtures.

## Intentionally not duplicated

- Existing `scripts/test-tools.mjs:153-237`: theorem mismatch/missing,
  unauthorized axioms, sorryAx, malformed/forged reports, timeout/missing tools.
- Existing `scripts/test-tools.mjs:103-151`: Comparator timeout forwarding and
  Docker timeout cleanup.
- Existing `scripts/test-tools.mjs:316-455`: PDF cache staleness, malformed
  documents, exact locators, no matches, bounds and page caps.
- Existing simplify, determinant and forbidden-input compute examples.
- V4 `bench/v4/real-use/tests/checker.test.mjs:159-176`: compiled/exported
  negative controls must still be rejected by independent Comparator checking.
- V4 same file `:136-148`: genuine issued receipt verifies once; replay denied.
  Those are existing opt-in real controls, **not executed or newly verified**
  here. Compilation, a mock report, and a trusted acceptance receipt remain
  distinct claims.
