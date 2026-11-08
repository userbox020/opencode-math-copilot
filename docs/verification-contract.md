# Lean verification contract

## Compilation versus a verified proof

`math_lean_check` and `math_lean_build` retain their existing compilation semantics.
Lean accepts declarations using `sorry` and arbitrary axioms; a successful process
exit is not, by itself, proof verification. The new `math_lean_verify` checks a
**named user solution against an independently supplied trusted target type** and
an explicit axiom policy. It does not assess correspondence to an informal claim.

Supply exactly one of `code` (Lean source) or `file` (a `.lean` file contained in
`math/lean`), plus `theorem` (fully qualified name, without `_root_.`) and
`expectedType` (trusted Lean type text). Defaults:

- `imports`: `["Mathlib"]`; an explicit empty list imports no additional modules.
- `allowedAxioms`: `["propext", "Quot.sound", "Classical.choice"]`; `[]` allows none.
- `docker`: `false`; `true` uses the existing Linux image/volume machinery.
- `timeoutMs`: `60000`, with a valid range of `1000`–`120000` ms.

The generated checker contains the requested imports, the user source, and:

```lean
theorem _root_.<uniqueCheckedName> : (<expectedType>) := _root_.<theorem>
#print axioms _root_.<uniqueCheckedName>
```

The audit is on this uniquely named **elaborated checked declaration**, not the
original theorem. Its dependencies include synthesized instances, implicit
arguments and coercions introduced when applying the theorem to the trusted
expected proposition. Auditing the original theorem alone would miss those
dependencies. The receipt's `target.theorem` remains the requested user theorem;
`proof.axioms` describes the generated checked declaration.

Unique begin/end markers delimit the checker output and detect missing checker
execution. Native execution uses a temporary file under `math/lean/.lake/math-toolkit`;
Docker uses a unique read-only `/check` mount. Temporary files are removed afterward.
The runner uses `shell: false` and bounded process output, with the same toolchain
and dependency assumptions as the other Lean tools. Docker preflight/cleanup calls
have their own bounded timeouts; `timeoutMs` bounds the main Lean invocation, not
the total receipt duration. Cleanup targets only that invocation's named container.

## JSON receipt

The tool returns a JSON **string**, not a Markdown PASS/FAIL. Example shape for an
axiom-free successful check (illustrative duration, not measured evidence):

```json
{
  "version": "math-lean-verify/v1",
  "execution": { "status": "completed", "mode": "native", "exitCode": 0, "durationMs": 100 },
  "compilation": { "status": "compiled" },
  "target": { "theorem": "answer", "expectedType": "True", "status": "identified" },
  "proof": {
    "status": "verified", "axioms": [],
    "allowedAxioms": ["propext", "Quot.sound", "Classical.choice"],
    "unauthorizedAxioms": [], "sorryAx": false
  },
  "checker": { "tool": "lake env lean" },
  "note": "Informal correspondence is not assessed. This receipt checks a user solution against the supplied trusted type, not the meaning of an informal claim."
}
```

| Field | Statuses / meaning |
| --- | --- |
| `execution.status` | `completed` (including nonzero compiler exits), `timeout`, `error`, `missing-tool` |
| `compilation.status` | `compiled`, `failed`, `not-run` (validation or prerequisite failure) |
| `target.status` | `identified`, `missing`, `mismatch`, `not-requested` (no target check established) |
| `proof.status` | `verified`, `incomplete` (`sorryAx` observed), `rejected` (unauthorized axioms), `unverified` (insufficient/failed evidence), `not-requested` (invalid request) |

`exitCode` can be null; `durationMs` measures the entire tool invocation.
`execution.error`, bounded `compilation.diagnostics`, and `proof.reason` may explain
failures. `checker.version` is optional and currently omitted: no extra toolchain
probe is run and the version is not guessed. `identified` alone is not success;
it can coexist with a compilation failure elsewhere in the source.

Examples of non-verification:

- Missing declaration: `completed / failed / missing / unverified`.
- Wrong expected type: `completed / failed / mismatch / unverified`.
- Compiling a custom axiom: `completed / compiled / identified / rejected`.
- Compiling a proof using `sorry`: `completed / compiled / identified / incomplete`.
- Timeout: execution `timeout`, proof never `verified`.
- Absent executable: `missing-tool / not-run / not-requested / unverified`.
- Null, non-object or otherwise invalid request: `error / not-run / not-requested /
  not-requested`, with `execution.error` explaining the validation failure. No Lean
  invocation occurs; null returns a receipt rather than throwing.

A runner reporting `notRun: true` always produces `compilation.status: "not-run"`
and cannot verify, even if it also reports exit code zero and valid marked output.
Verification requires `compilation.status === "compiled"`, not merely a successful
exit code or a recognized axiom report.

## Axiom policy and fail-closed parsing

The combined stdout/stderr must contain exactly one candidate report for the
generated checked declaration between the unique markers. All lines beginning
with that declaration's name (including malformed or unrecognized forms) are
counted **before** parsing; exactly one candidate must parse completely. Supported forms are
`'<name>' depends on axioms: [a, b, ...]` (including wrapped lists) and
`'<name>' does not depend on any axioms`. A missing, malformed, duplicate or
unrecognized report never verifies, even with exit code zero. A valid empty report
plus a malformed or unrecognized report fails closed in either order; an original
theorem's report cannot substitute for the generated declaration's report. Full bounded output
is analyzed before diagnostic tails are shortened; buffer overflow is an execution
error, not a success. The verifier also scans combined output for `sorryAx`.

`sorryAx` always means `incomplete`, even if someone puts it in `allowedAxioms`.
Other axioms outside the allowlist mean `rejected`. A custom allowlist explicitly
changes what is trusted; including an arbitrary assumption does not prove it.
`verified` requires completed successful compilation, an identified type-compatible
target, recognized axiom evidence, no `sorryAx`, and no unauthorized axioms.

## Comparator challenge exception

A `sorry` placeholder in `ComparatorChallenges/*.lean` specifies the **challenge
statement**, not the solution. Use `math_comparator` on its challenge JSON to
validate the designated solution through Comparator. Do not globally ban those
challenge files, treat their placeholders as proofs, or infer that their warnings
invalidate an independently checked solution. This new verifier checks user
solutions against supplied trusted types; it does not replace Comparator.

## Limits and trust boundary

- The expected type, imports, elaboration environment and Lean installation must
  be trusted. Type checking is Lean compatibility/elaboration, not textual equality
  or an audit of the informal mathematical statement.
- This is a local compiler-output receipt, not a signed artifact or an independent
  kernel export/recheck. Arbitrary Lean source can execute metaprograms and IO;
  neither this verifier nor its markers are a security sandbox against hostile
  code, forged diagnostics, modified compiler binaries or malicious macros. Do not
  run untrusted source with sensitive host/volume access. For independent exported
  challenge checks use Comparator and its own trust/sandbox requirements.
- Parsing targets ordinary qualified Lean names (Unicode letters are supported,
  quoted `«names»` are not) and the documented English Lean diagnostic forms.
  Unknown diagnostic formats may produce `unverified`/`not-requested` rather than
  a more specific missing/mismatch classification. Unknown axiom names/formats
  fail closed; compatibility with every Lean release is not asserted.
- The default Mathlib import requires a prepared cache. Native Windows may still
  encounter the corpus's NTFS-invalid dependency path. Docker uses dependencies in
  its volume, not arbitrary host edits; copied files may lose relative-import
  context. Missing images/volumes are execution errors, never proof success.
- Verification applies only to the checked application of the named target and axiom policy. Unused axioms
  or `sorry` declarations elsewhere are not a proof of, nor necessarily dependencies
  of, that target. Seeing `sorryAx` anywhere in output conservatively prevents success.
- No whole-corpus verification, informal peer review, model inference or challenge
  benchmark is performed by this contract's portable runner-fixture tests.
- When the existing Lean Docker image/volume is available, real regression tests
  cover a theorem whose original proof has no axioms but whose synthesized instance
  adds an unauthorized axiom, and the analogous instance proved using `sorry`.
  The checked declaration must report that axiom (`rejected`) or `sorryAx`
  (`incomplete`). These tests skip with the Docker integrations if prerequisites
  are unavailable; the portable parsing/request/runner fixtures still run.
