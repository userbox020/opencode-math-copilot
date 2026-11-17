import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
export const hash = value => createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value), 'utf8').digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const fail = code => { throw new Error(code); };

const registry = [
  ['arxivlean-01', 'e2164399ef4a88eb555877a9eb052ce245284716e3917926844c6d909ebcdc51', [
    'graphIndependentSet', 'graphStabilityNumber', 'graphCertificateMatrix',
    'graphQuarticPolynomial', 'graphCertificatePolynomial', 'polynomialIsSumOfSquares',
    'arxivleanConjecture',
  ]],
  ['arxivlean-02', '0eff8cb153501489fa96281fd0ee88f5ef164623ab4cf2a312b3d76138ebcb5f', [
    'benchmarkRamseyProperty', 'benchmarkRamseyThreshold', 'benchmarkInducedDegree',
    'benchmarkInducedMaxDegree', 'benchmarkHasMaximumRepetitions', 'arxivleanConjecture',
  ]],
  ['arxivlean-03', '02b309599298190e5cf3b88683243abcd02ad7a338e0740014f8aaab43150730', [
    'integerFoldSum', 'integerFoldSum_card_le', 'integerCardinalitySpectrum',
    'integerCardinalitySpectrum_finite', 'integerSpectrumSize', 'arxivleanConjecture',
  ]],
  ['arxivlean-04', '550fe9b9b2b4356d1a7ce5a281335b5f2d08397e59415e501d27bac1b884c571', [
    'conjectureVertexDegree', 'conjectureConnected', 'conjectureCliqueFree',
    'conjectureDiameterBound', 'arxivleanConjecture',
  ]],
  ['arxivlean-05', 'a447944b984ceaadc20dae53ae05ea839084b35b418c1a84c62b24958bf6c745', [
    'NNSquareMatrix', 'nnElementaryStrongShiftEquivalent', 'nnStrongShiftEquivalent',
    'nnEightMatrix', 'nnOneMatrix', 'arxivleanConjecture',
  ]],
];

// Retain only hash-checked statements, not task metadata. No normalization.
const statements = (() => {
  try {
    const tasks = JSON.parse(readFileSync(new URL('../../v3/arxivlean/tasks/arxivlean-smoke5.json', import.meta.url), 'utf8'));
    if (!Array.isArray(tasks) || tasks.length !== registry.length) fail('arxiv_policy_statement_mismatch');
    return Object.freeze(Object.fromEntries(registry.map(([taskId, statementHash]) => {
      const matches = tasks.filter(task => task?.id === taskId);
      const statement = matches[0]?.formal_statement;
      if (matches.length !== 1 || typeof statement !== 'string' || hash(statement) !== statementHash) {
        fail('arxiv_policy_statement_mismatch');
      }
      return [taskId, statement];
    })));
  } catch {
    fail('arxiv_policy_statement_mismatch');
  }
})();

export const POLICIES = freeze(registry.map(([task_id, formal_statement_sha256, protected_declarations]) => {
  const targets = {
    proof: { selector: `${task_id}.proof`, declaration: 'arxivlean_proof', expected_type: 'arxivleanConjecture' },
    disproof: { selector: `${task_id}.disproof`, declaration: 'arxivlean_disproof', expected_type: '¬ arxivleanConjecture' },
  };
  const policy = {
    task_id, formal_statement_sha256,
    imports: ['Mathlib'],
    allowed_axioms: ['propext', 'Quot.sound', 'Classical.choice'],
    protected_declarations, targets,
    direction_selectors: [targets.proof.selector, targets.disproof.selector],
    positive_control: null,
    positive_status: 'pending_missing_gold_proof',
  };
  // SHA-256 of canonical JSON of all policy fields except policy_sha256 itself.
  return { ...policy, policy_sha256: hash(policy) };
}));

export function selectPolicy(taskId, direction) {
  const policy = POLICIES.find(entry => entry.task_id === taskId);
  if (!policy || (direction !== 'proof' && direction !== 'disproof')) fail('arxiv_policy_unknown_selector');
  return Object.freeze({ policy, target: policy.targets[direction] });
}

const requestFields = ['schema', 'task_id', 'direction', 'code', 'code_sha256', 'policy_sha256'];
export function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Reflect.ownKeys(request).length !== requestFields.length
    || !requestFields.every(key => Object.hasOwn(request, key) && typeof request[key] === 'string')
    || request.schema !== 'arxivlean-checker-request/v1'
    || !request.code.trim() || Buffer.byteLength(request.code, 'utf8') > 131072
    || Buffer.from(request.code, 'utf8').toString('utf8') !== request.code) {
    fail('arxiv_policy_request_invalid');
  }
  const { policy, target } = selectPolicy(request.task_id, request.direction);
  if (hash(request.code) !== request.code_sha256) fail('arxiv_policy_code_hash_mismatch');
  if (request.policy_sha256 !== policy.policy_sha256) fail('arxiv_policy_binding_mismatch');

  // Occurrence check only: not a Lean parser, proof checker, or acceptance gate.
  // Helpers are permitted, but exactly one of the two target names must occur.
  const declarations = [...request.code.matchAll(/\b(?:theorem|lemma)\s+(arxivlean_proof|arxivlean_disproof)(?=\s|[:({\[])/g)];
  if (declarations.length !== 1 || declarations[0][1] !== target.declaration) fail('arxiv_policy_target_missing');
  return Object.freeze({
    task_id: policy.task_id, direction: request.direction, selector: target.selector,
    code_sha256: request.code_sha256, policy_sha256: policy.policy_sha256,
  });
}

export function challengeSource(policy, direction) {
  const selected = selectPolicy(policy?.task_id, direction);
  if (selected.policy !== policy) fail('arxiv_policy_binding_mismatch');
  const { declaration, expected_type } = selected.target;
  return `${statements[policy.task_id]}\ntheorem ${declaration} : ${expected_type} := by sorry\n`;
}

export const challengeSha256 = (policy, direction) => hash(challengeSource(policy, direction));
