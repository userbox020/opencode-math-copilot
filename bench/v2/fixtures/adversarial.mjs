import { sha256 } from '../lib.mjs';
import { receiptHash, RECEIPT_SCHEMA_VERSION } from '../graders/formal.mjs';

export const explanationText = 'Dividing by x requires x to be nonzero; on that domain x/x equals 1.';
export const negatedExplanation = 'Dividing by x requires no restriction, and x/x never equals 1.';
export const explanationTask = {
  id: 'explanation-cancel', type: 'explanation',
  grading: {
    rubric: ['identifies_nonzero_domain', 'valid_cancellation'],
    labels: {
      [sha256(explanationText)]: { identifies_nonzero_domain: true, valid_cancellation: true },
      [sha256(negatedExplanation)]: { identifies_nonzero_domain: false, valid_cancellation: false }
    }
  }
};
export const solutionSetTask = { type: 'symbolic', grading: { kind: 'solution-set', solutions: [2], domain: 'real', assumptions: ['x is real'], conditions: ['x >= 0'] } };
export const formalTarget = 'theorem eval_target : (1 : Nat) = 1';
export const formalSolution = 'by rfl';
export const formalTask = { id: 'formal-reflexivity', type: 'formal', grading: { theorem: 'eval_target', expected_type: '(1 : Nat) = 1', target_sha256: sha256(formalTarget), toolchain: 'simulated-lean-fixture-v1', policy: { allowed_axioms: [], fixed_target: true, no_reference_access: true, restricted_execution: true } } };
// The nested v1 payload is simulated data, never an invocation of the verifier.
export const simulatedV1Receipt = {
  version: 'math-lean-verify/v1',
  execution: { status: 'completed', mode: 'native', exitCode: 0, durationMs: 0 },
  compilation: { status: 'compiled' },
  target: { theorem: formalTask.grading.theorem, expectedType: formalTask.grading.expected_type, status: 'identified' },
  proof: { status: 'verified', axioms: [], allowedAxioms: [], unauthorizedAxioms: [], sorryAx: false },
  checker: { tool: 'lake env lean' },
  note: 'SIMULATED fixture only. Informal correspondence is not assessed; no Lean execution occurred.'
};
const body = {
  schema_version: RECEIPT_SCHEMA_VERSION, format: 'math-study-verification/v1', simulated: true, issuer: 'simulated-verifier',
  target_sha256: sha256(formalTarget), solution_sha256: sha256(formalSolution), policy_sha256: sha256(formalTask.grading.policy),
  verifier: simulatedV1Receipt,
  provenance: { issuance: 'evaluator-controlled', evidence: 'simulated-fixture', source_receipt_sha256: sha256(simulatedV1Receipt), independent_kernel_check: false },
  correspondence: { status: 'not-assessed', scope: 'fixed-lean-target-only' },
  toolchain: formalTask.grading.toolchain
};
export const formalReceipt = { ...body, receipt_sha256: receiptHash(body) };
export const formalFinal = { type: 'formal', solution: formalSolution, target_sha256: sha256(formalTarget), receipt_sha256: formalReceipt.receipt_sha256 };
export const formalContext = { allow_simulated: true, trusted_receipts: { [formalReceipt.receipt_sha256]: formalReceipt } };
