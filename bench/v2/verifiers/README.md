# Evaluator-controlled Lean receipt bridge

`lean.mjs` wraps the repository's strict `leanVerify` / `runLeanSource` with
`docker: true`. It does not run inference, a study, or a release. Imports resolve
relative to this repository, not the agent workspace or current directory.
The existing Docker image and initialized named Lean volume must be available;
missing tools/images, timeouts, and other execution failures cannot pass.

Run this module in a separate, evaluator-owned process/environment **outside the
agent workspace**. The evaluator supplies the fixed theorem, expected type,
imports, allowed axioms, and toolchain label from the task, not from the agent's
answer. Only the submitted code is agent-controlled. Do not expose this module,
its dependency-injection factory, Docker access, or the trusted receipt store as
agent tools. The bridge is not itself an OS sandbox: the existing Docker runner
executes Lean source, with access to its named volume. Use evaluator-controlled,
disposable execution resources for untrusted source, not a sensitive shared
environment. Docker settings/environment and the supplied toolchain label must
also be controlled and provisioned by the evaluator; the label is not an
independently measured version attestation.

```js
import { verifyLeanSubmission, normalizeLeanSolution, leanTargetHash } from './lean.mjs';

const target = {
  theorem: 'answer', expectedType: 'True', imports: ['Init'],
  allowedAxioms: [], toolchain: 'leanprover/lean4:v4.34.1'
};
const solution = normalizeLeanSolution('theorem answer : True := True.intro');
const receipt = await verifyLeanSubmission({ ...target, code: solution });
const spec = {
  theorem: target.theorem, expected_type: target.expectedType,
  target_sha256: leanTargetHash(target),
  policy: { allowed_axioms: target.allowedAxioms }, toolchain: target.toolchain
};
const context = { trusted_receipts: { [receipt.receipt_sha256]: receipt } };
// A separately extracted typed final must contain this exact normalized solution,
// target_sha256, and receipt_sha256. Do not synthesize a missing agent final.
// Call the existing formal grader with that final, spec, and evaluator context.
```

Normalization removes an initial BOM, converts CRLF/CR to LF, strips contiguous
leading `import ...` lines, trims surrounding whitespace, and appends one LF to
nonempty source. Remaining `import` words are conservatively rejected, including
those in comments or strings; comment-prefixed/nonstandard import headers should
be removed before submission. No Mathlib import or axiom policy is defaulted;
both arrays must be supplied explicitly (empty arrays are valid).

Hashes use the existing `sha256`: UTF-8 strings or `JSON.stringify` objects.
The canonical target has fixed key order `{ theorem, expectedType, imports,
allowedAxioms }`; array order is significant. Policy is exactly
`{ allowed_axioms: allowedAxioms }`. Solution is the normalized code. The source
receipt hash covers the parsed v1 object; the envelope hash covers its body
without `receipt_sha256`. Every returned envelope is schema-validated. Valid v1
failures retain their actual statuses; malformed output or thrown execution
errors become explicit unverified error receipts. Invalid evaluator argument
shapes throw before execution. `createLeanVerifier` is an evaluator-only test
seam; mocked receipts are not real verification evidence.

The trusted side-channel is the authority, **not** the issuer string or hashes:
never load agent-provided envelopes into `trusted_receipts`. Self-asserted final
receipts and tool logs cannot replace an evaluable final. This is evaluator-
controlled issuance, **not an independent kernel check, signed artifact, or
informal correspondence review**. Correspondence remains `not-assessed` and
`independent_kernel_check` remains `false`, even for verified v1 output.
