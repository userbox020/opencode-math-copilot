import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
export const PINS = freeze({ comparator: 'd03acab154d269c06e60e4de7e4cc85deebff94b', exporter: '076e8e57707e813375e8f9da8bf989799ace9680', lean: '4.34.1', mathlib: 'd13f23b723b8a846827a245b89c10fc7d3f11612' });
export const PRIMITIVES = freeze(['Nat.add', 'Nat.sub', 'Nat.mul', 'Nat.pow', 'Nat.gcd', 'Nat.div', 'Nat.mod', 'Nat.beq', 'Nat.ble', 'Nat.land', 'Nat.lor', 'Nat.xor', 'Nat.shiftLeft', 'Nat.shiftRight', 'String.ofList', 'Char.ofNat', 'List', 'eagerReduce', 'Nat', 'String', 'String.mk', 'Char', 'optParam', 'autoParam', 'semiOutParam', 'outParam']);
export const LIMITS = freeze({ sourceBytes: 131072, artifactBytes: 67108864, diagnosticBytes: 131072, wallMs: 120000, controlMs: 15000, exportMemory: '2g', checkerMemory: '4g', pids: '128', cpus: '2' });
export const PROTOCOL = freeze({ schema: 'comparator-check-only/v1', keys: ['schema', 'status', 'task_id'], acceptedExit: 0, rejectedExit: 1 });
const gold = JSON.parse(readFileSync(new URL('../grader-data/gold.json', import.meta.url), 'utf8'));
const closed = [['lean-cancellation-repair', 'real_use_cancel', '∀ a b c : ℝ, a ≠ 0 → a * b = a * c → b = c'], ['lean-rational-odd-sum', 'real_use_odd_sum', '∀ n : Nat, (Finset.sum (Finset.range n) (fun k => (2 * (k : ℚ) + 1))) = (n : ℚ) ^ 2']];
if (gold.filter(g => g.lean).length !== 2) throw new Error('closed_lean_registry_changed');
export const POLICIES = freeze(closed.map(([task_id, theorem, expected_type]) => {
  const lean = gold.find(g => g.task_id === task_id)?.lean;
  if (!lean || lean.theorem !== theorem || lean.expected_type !== expected_type || canonical(lean.imports) !== '["Mathlib"]' || canonical(lean.allowed_axioms) !== '["propext","Quot.sound","Classical.choice"]') throw new Error('frozen_gold_mismatch');
  const policy = { schema: 'real-use-checker-policy/v1', theorem, expected_type, imports: lean.imports, allowed_axioms: lean.allowed_axioms, positive_control_sha256: hash(lean.positive_control), isolation: 'independent A compile/export then B fixed-target comparison, closed-axiom audit and kernel replay; network disabled; no corpus mount; evaluator-fixed target' };
  const challenge_source = `import Mathlib\n\ntheorem ${theorem} : ${expected_type} := by sorry\n`;
  return { task_id, policy, policy_sha256: hash(policy), challenge_source, challenge_source_sha256: hash(challenge_source), roots: ['Quot', 'Quot.mk', 'Quot.lift', 'Quot.ind', theorem, ...lean.allowed_axioms, ...PRIMITIVES], positive_control: lean.positive_control };
}));
export function resolveRequest(request) {
  if (!request || request.schema !== 'real-use-checker-request/v1' || typeof request.code !== 'string' || !request.code.trim() || Buffer.byteLength(request.code) > LIMITS.sourceBytes || hash(request.code) !== request.code_sha256 || hash(request.policy) !== request.policy_sha256) throw new Error('request_binding_invalid');
  const entry = POLICIES.find(p => p.policy_sha256 === request.policy_sha256 && canonical(p.policy) === canonical(request.policy));
  if (!entry) throw new Error('unregistered_policy');
  return entry;
}

// Only Dockerfile and CheckOnly.lean are local source inputs to checker_core.
// All upstream pins (including exact Lean), the base and original helper identity
// remain those of the ORIGINAL build, not whichever helper is doing reuse today.
export function validateCoreReceipt(prior, inputs) {
  if (prior?.schema !== 'eval-checker-build/v1' || prior.status !== 'core_built' || prior.cleanup_unconfirmed?.length || canonical(prior.pins) !== canonical(PINS) || !/^sha256:[a-f0-9]{64}$/.test(prior.core_image_id ?? '') || !/^ubuntu@sha256:[a-f0-9]{64}$/.test(prior.base_reference ?? '') || prior.primitive_list_sha256 !== hash(PRIMITIVES) || prior.protocol_sha256 !== hash(PROTOCOL)) throw new Error('core_receipt_pin_mismatch');
  if (prior.source_hashes?.['docker/eval-checker.Dockerfile'] !== inputs.dockerfile || prior.source_hashes?.['bench/v4/real-use/checker/CheckOnly.lean'] !== inputs.checkonly || !/^[a-f0-9]{64}$/.test(prior.source_hashes?.['scripts/build-eval-checker.ps1'] ?? '')) throw new Error('core_receipt_input_mismatch');
  return prior;
}
export function validateCoreProvenance(origin, inputs) {
  if (!origin || typeof origin.receipt_text !== 'string' || hash(origin.receipt_text) !== origin.receipt_sha256 || typeof origin.dockerfile_text !== 'string' || hash(origin.dockerfile_text) !== inputs.dockerfile || typeof origin.checkonly_text !== 'string' || hash(origin.checkonly_text) !== inputs.checkonly || typeof origin.build_driver_text !== 'string' || hash(origin.build_driver_text) !== origin.build_driver_sha256) throw new Error('core_provenance_invalid');
  const prior = validateCoreReceipt(JSON.parse(origin.receipt_text), inputs);
  if (origin.original_build_script_sha256 !== prior.source_hashes['scripts/build-eval-checker.ps1']) throw new Error('core_provenance_helper_mismatch');
  return prior;
}
