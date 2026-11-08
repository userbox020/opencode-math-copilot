import { sha256, validateNamed } from '../lib.mjs';
import { sameSet, verdict } from './shared.mjs';

export const RECEIPT_SCHEMA_VERSION = '2.1.0';

export function receiptHash(receipt) {
  const { receipt_sha256, ...body } = receipt;
  return sha256(body);
}
export default function formal(answer, spec, context = {}) {
  // Receipts are delivered by the verifier side-channel, NOT trusted from final
  // answer JSON. A hash alone is integrity, not verifier authentication.
  // "Independent receipt" means evaluator-controlled issuance, NOT an
  // automatically independent kernel check or informal correspondence check.
  const receipt = context.trusted_receipts?.[answer.receipt_sha256];
  if (!receipt) return verdict(false, 'missing trusted verifier receipt');
  try { validateNamed('verification-receipt', receipt); } catch { return verdict(false, 'invalid verifier receipt schema'); }
  const verifier = receipt.verifier;
  const valid = receiptHash(receipt) === receipt.receipt_sha256
    && receipt.receipt_sha256 === answer.receipt_sha256
    && answer.target_sha256 === spec.target_sha256
    && receipt.target_sha256 === spec.target_sha256
    && receipt.solution_sha256 === sha256(answer.solution)
    && receipt.policy_sha256 === sha256(spec.policy)
    && receipt.provenance.source_receipt_sha256 === sha256(verifier)
    && receipt.provenance.evidence === (receipt.simulated ? 'simulated-fixture' : 'verifier-output')
    && verifier.execution.status === 'completed' && verifier.execution.exitCode === 0
    && verifier.compilation.status === 'compiled'
    && verifier.target.status === 'identified'
    && typeof spec.theorem === 'string' && verifier.target.theorem === spec.theorem
    && typeof spec.expected_type === 'string' && verifier.target.expectedType === spec.expected_type
    && verifier.proof.status === 'verified' && verifier.proof.sorryAx === false
    && verifier.proof.unauthorizedAxioms.length === 0
    && sameSet(verifier.proof.allowedAxioms, spec.policy.allowed_axioms)
    && receipt.toolchain === spec.toolchain
    && verifier.proof.axioms.every(axiom => spec.policy.allowed_axioms.includes(axiom))
    && (receipt.simulated ? context.allow_simulated === true && receipt.issuer === 'simulated-verifier' : receipt.issuer === 'restricted-verifier')
    && !/\b(sorry|admit|axiom|unsafe)\b/.test(answer.solution);
  return verdict(valid, receipt.simulated ? 'SIMULATED v1-status fixed-target receipt (no kernel check; correspondence not assessed)' : 'v1-status fixed-target receipt (no independent kernel check claimed; correspondence not assessed)');
}
