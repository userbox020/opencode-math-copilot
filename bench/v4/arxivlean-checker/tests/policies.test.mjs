import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  POLICIES, canonical, hash, selectPolicy, validateRequest, challengeSource, challengeSha256,
} from '../policies.mjs';

const taskBytes = readFileSync(new URL('../../../v3/arxivlean/tasks/arxivlean-smoke5.json', import.meta.url));
const tasks = JSON.parse(taskBytes);
const manifest = JSON.parse(readFileSync(new URL('../controls/manifest.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const directions = ['proof', 'disproof'];
function requestFor(policy = POLICIES[0], direction = 'proof', code) {
  const target = policy.targets[direction];
  code ??= `theorem ${target.declaration} : ${target.expected_type} := by sorry\n`;
  return {
    schema: 'arxivlean-checker-request/v1', task_id: policy.task_id, direction,
    code, code_sha256: digest(code), policy_sha256: policy.policy_sha256,
  };
}
const rejects = (request, code) => assert.throws(() => validateRequest(request), { message: code });

test('closed registry has exactly five tasks and ten selectors', () => {
  assert.deepEqual(POLICIES.map(p => p.task_id), Array.from({ length: 5 }, (_, i) => `arxivlean-0${i + 1}`));
  const selectors = POLICIES.flatMap(p => p.direction_selectors);
  assert.equal(selectors.length, 10);
  assert.equal(new Set(selectors).size, 10);
  for (const policy of POLICIES) {
    assert.deepEqual(policy.imports, ['Mathlib']);
    assert.deepEqual(policy.allowed_axioms, ['propext', 'Quot.sound', 'Classical.choice']);
    assert.deepEqual(policy.direction_selectors, directions.map(d => `${policy.task_id}.${d}`));
    for (const direction of directions) {
      const selection = selectPolicy(policy.task_id, direction);
      assert.equal(selection.policy, policy);
      assert.equal(selection.target, policy.targets[direction]);
      assert.ok(Object.isFrozen(selection));
      assert.equal(selection.target.declaration, `arxivlean_${direction}`);
      assert.equal(selection.target.expected_type, direction === 'proof' ? 'arxivleanConjecture' : '¬ arxivleanConjecture');
    }
  }
});

test('exact UTF-8 statement and task-file hashes match', () => {
  assert.equal(manifest.task_file_sha256, digest(taskBytes));
  for (const policy of POLICIES) {
    const statement = tasks.find(t => t.id === policy.task_id).formal_statement;
    assert.equal(policy.formal_statement_sha256, digest(Buffer.from(statement, 'utf8')));
    assert.notEqual(policy.formal_statement_sha256, digest(statement.trim()));
  }
});

test('protected declarations explicitly cover the supplied declarations', () => {
  const expected = [
    ['graphIndependentSet', 'graphStabilityNumber', 'graphCertificateMatrix', 'graphQuarticPolynomial', 'graphCertificatePolynomial', 'polynomialIsSumOfSquares', 'arxivleanConjecture'],
    ['benchmarkRamseyProperty', 'benchmarkRamseyThreshold', 'benchmarkInducedDegree', 'benchmarkInducedMaxDegree', 'benchmarkHasMaximumRepetitions', 'arxivleanConjecture'],
    ['integerFoldSum', 'integerFoldSum_card_le', 'integerCardinalitySpectrum', 'integerCardinalitySpectrum_finite', 'integerSpectrumSize', 'arxivleanConjecture'],
    ['conjectureVertexDegree', 'conjectureConnected', 'conjectureCliqueFree', 'conjectureDiameterBound', 'arxivleanConjecture'],
    ['NNSquareMatrix', 'nnElementaryStrongShiftEquivalent', 'nnStrongShiftEquivalent', 'nnEightMatrix', 'nnOneMatrix', 'arxivleanConjecture'],
  ];
  assert.deepEqual(POLICIES.map(p => p.protected_declarations), expected);
});

test('policy hash is canonical policy JSON excluding its hash field', () => {
  for (const policy of POLICIES) {
    const { policy_sha256, ...payload } = policy;
    assert.equal(policy_sha256, digest(canonical(payload)));
    assert.equal(hash(payload), policy_sha256);
    assert.equal(hash(Object.fromEntries(Object.entries(payload).reverse())), policy_sha256);
  }
});

test('unknown or inexact tasks and directions are rejected', () => {
  for (const taskId of ['arxivlean-00', 'arxivlean-01.proof', 'arxivlean-01 ', null, 1]) {
    assert.throws(() => selectPolicy(taskId, 'proof'), { message: 'arxiv_policy_unknown_selector' });
  }
  for (const direction of ['Proof', 'proof ', 'both', '__proto__', null]) {
    assert.throws(() => selectPolicy('arxivlean-01', direction), { message: 'arxiv_policy_unknown_selector' });
  }
  rejects({ ...requestFor(), task_id: 'arxivlean-06' }, 'arxiv_policy_unknown_selector');
  rejects({ ...requestFor(), direction: 'both' }, 'arxiv_policy_unknown_selector');
});

test('requests require exact fields and schema', () => {
  for (const request of [null, [], {}, { ...requestFor(), extra: true },
    { ...requestFor(), schema: 'other' }, { ...requestFor(), code: 12 },
    { ...requestFor(), [Symbol('extra')]: true }]) {
    rejects(request, 'arxiv_policy_request_invalid');
  }
  const missing = requestFor();
  delete missing.direction;
  rejects(missing, 'arxiv_policy_request_invalid');
});

test('wrong policy hash or another task policy cannot bind', () => {
  rejects({ ...requestFor(), policy_sha256: '0'.repeat(64) }, 'arxiv_policy_binding_mismatch');
  rejects({ ...requestFor(), policy_sha256: POLICIES[1].policy_sha256 }, 'arxiv_policy_binding_mismatch');
});

test('wrong code hash is rejected', () => {
  rejects({ ...requestFor(), code_sha256: '0'.repeat(64) }, 'arxiv_policy_code_hash_mismatch');
});

test('empty, whitespace-only, oversized, and malformed UTF-8 code is rejected', () => {
  for (const code of ['', ' \n\t', 'a'.repeat(131073), 'é'.repeat(65537), '\ud800']) {
    rejects(requestFor(POLICIES[0], 'proof', code), 'arxiv_policy_request_invalid');
  }
});

test('code byte limit includes its exact boundary', () => {
  const base = requestFor().code;
  const code = base + ' '.repeat(131072 - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(code), 131072);
  assert.equal(validateRequest(requestFor(POLICIES[0], 'proof', code)).code_sha256, digest(code));
});

test('missing, opposite, duplicate, and non-exact target names are rejected', () => {
  for (const code of [
    'def helper := 1\n',
    'theorem arxivlean_disproof : ¬ arxivleanConjecture := by sorry\n',
    'theorem arxivlean_proof_extra : True := by trivial\n',
    'theorem arxivlean_proof.other : True := by trivial\n',
    requestFor().code.repeat(2),
    requestFor().code + requestFor(POLICIES[0], 'disproof').code,
  ]) rejects(requestFor(POLICIES[0], 'proof', code), 'arxiv_policy_target_missing');
});

test('correct-looking requests bind all ten selections without proving anything', () => {
  for (const policy of POLICIES) {
    for (const direction of directions) {
      const request = requestFor(policy, direction);
      const binding = validateRequest(request);
      assert.deepEqual(binding, {
        task_id: policy.task_id, direction, selector: `${policy.task_id}.${direction}`,
        code_sha256: request.code_sha256, policy_sha256: policy.policy_sha256,
      });
      assert.ok(Object.isFrozen(binding));
      const lemma = request.code.replace('theorem', 'lemma');
      assert.equal(validateRequest(requestFor(policy, direction, lemma)).selector, binding.selector);
    }
  }
});

test('each challenge preserves its statement and appends only its selected placeholder', () => {
  for (const policy of POLICIES) {
    const statement = tasks.find(t => t.id === policy.task_id).formal_statement;
    for (const direction of directions) {
      const target = policy.targets[direction];
      const opposite = policy.targets[direction === 'proof' ? 'disproof' : 'proof'];
      const source = challengeSource(policy, direction);
      assert.equal(source, `${statement}\ntheorem ${target.declaration} : ${target.expected_type} := by sorry\n`);
      assert.equal((source.match(/\bsorry\b/g) ?? []).length, 1);
      assert.equal(source.split(target.declaration).length - 1, 1);
      assert.ok(!source.includes(opposite.declaration));
      assert.ok(source.endsWith('\n'));
      assert.equal(challengeSha256(policy, direction), digest(source));
    }
    assert.notEqual(challengeSha256(policy, 'proof'), challengeSha256(policy, 'disproof'));
  }
});

test('challenge generation rejects unregistered policies and directions', () => {
  assert.throws(() => challengeSource({ ...POLICIES[0] }, 'proof'), { message: 'arxiv_policy_binding_mismatch' });
  assert.throws(() => challengeSource(POLICIES[0], 'other'), { message: 'arxiv_policy_unknown_selector' });
});

test('policies and controls contain no source metadata or paper paths', () => {
  const serialized = JSON.stringify([POLICIES, manifest]);
  assert.doesNotMatch(serialized, /"(?:answer|title|arxiv_id)"|\.pdf\b|(?:paper|manuscript)[/\\]|https?:\/\//i);
  for (const task of tasks) {
    assert.ok(!serialized.includes(task.title));
    assert.ok(!serialized.includes(task.arxiv_id));
  }
});

test('manifest remains not admitted and all controls are unstaged', () => {
  assert.equal(manifest.schema, 'arxivlean-controls/v1');
  assert.equal(manifest.admission, 'not_admitted');
  assert.match(manifest.reason, /Missing task-bound positive proof/);
  assert.deepEqual(manifest.entries.map(e => e.task_id), POLICIES.map(p => p.task_id));
  for (const [index, entry] of manifest.entries.entries()) {
    assert.equal(entry.formal_statement_sha256, POLICIES[index].formal_statement_sha256);
    assert.deepEqual(entry.selected_directions, directions);
    assert.deepEqual(entry.controls, {
      positive: { status: 'pending_missing_gold_proof', artifact: null },
      wrong_direction: { expected: 'rejected', artifact: null },
      redefinition: { expected: 'rejected', artifact: null },
    });
    assert.equal(POLICIES[index].positive_control, null);
    assert.equal(POLICIES[index].positive_status, 'pending_missing_gold_proof');
  }
});

test('registry and all nested policy fields are frozen against mutation', () => {
  function assertFrozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(assertFrozen);
  }
  assertFrozen(POLICIES);
  assert.throws(() => POLICIES.push({}), TypeError);
  assert.throws(() => { POLICIES[0].task_id = 'changed'; }, TypeError);
  assert.throws(() => POLICIES[0].protected_declarations.push('changed'), TypeError);
  assert.throws(() => { POLICIES[0].targets.proof.expected_type = 'True'; }, TypeError);
});
