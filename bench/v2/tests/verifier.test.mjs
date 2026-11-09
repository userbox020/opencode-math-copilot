import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLeanVerifier, leanTargetHash, normalizeLeanSolution, verifyLeanSubmission } from '../verifiers/lean.mjs';
import { validateNamed } from '../lib.mjs';
import { receiptHash } from '../graders/formal.mjs';
import { gradeFinal } from '../graders/index.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const request = {
  code: 'theorem answer : True := True.intro', theorem: 'answer', expectedType: 'True',
  imports: ['Init'], allowedAxioms: [], toolchain: 'leanprover/lean4:v4.34.1'
};
function grading(receipt, input = request) {
  const task = { type: 'formal', grading: {
    theorem: input.theorem, expected_type: input.expectedType,
    target_sha256: leanTargetHash(input), policy: { allowed_axioms: input.allowedAxioms }, toolchain: input.toolchain
  } };
  const final = { type: 'formal', solution: normalizeLeanSolution(input.code), target_sha256: task.grading.target_sha256, receipt_sha256: receipt.receipt_sha256 };
  const context = { trusted_receipts: { [receipt.receipt_sha256]: receipt } };
  return { task, final, context };
}
function score(receipt, input = request) {
  const { task, final, context } = grading(receipt, input);
  return gradeFinal(task, final, context);
}
function runnerOutput(source, axioms = []) {
  const marker = source.match(/#eval IO.println "(math_verify_[a-f0-9]+)_begin"/)[1];
  return { status: 0, stdout: `${marker}_begin\n'${marker}_checked' depends on axioms: [${axioms.join(', ')}]\n${marker}_end\n`, stderr: '' };
}
const verified = createLeanVerifier({ runner: (_roots, source) => runnerOutput(source) });

test('bridge exports the production entry point and issues a hashed schema-valid study envelope', async () => {
  assert.equal(typeof verifyLeanSubmission, 'function');
  const receipt = await verified(request);
  validateNamed('verification-receipt', receipt);
  assert.equal(receipt.schema_version, '2.1.0');
  assert.equal(receipt.format, 'math-study-verification/v1');
  assert.equal(receipt.simulated, false);
  assert.equal(receipt.issuer, 'restricted-verifier');
  assert.equal(receipt.toolchain, request.toolchain);
  assert.equal(receipt.verifier.version, 'math-lean-verify/v1');
  assert.equal(receipt.verifier.proof.status, 'verified');
  assert.equal(receipt.verifier.execution.mode, 'docker');
  assert.equal(receipt.target_sha256, hash({ theorem: 'answer', expectedType: 'True', imports: ['Init'], allowedAxioms: [] }));
  assert.equal(receipt.solution_sha256, hash(request.code + '\n'));
  assert.equal(receipt.policy_sha256, hash({ allowed_axioms: [] }));
  assert.deepEqual(receipt.provenance, {
    issuance: 'evaluator-controlled', evidence: 'verifier-output',
    source_receipt_sha256: hash(receipt.verifier), independent_kernel_check: false
  });
  assert.deepEqual(receipt.correspondence, { status: 'not-assessed', scope: 'fixed-lean-target-only' });
  const { receipt_sha256, ...body } = receipt;
  assert.equal(receipt_sha256, hash(body));
  assert.equal(receipt_sha256, receiptHash(receipt));
  assert.equal(score(receipt).grade.correct, true);
});

test('normalization and evaluator imports control precisely what reaches the strict runner', async () => {
  let calls = 0;
  const verify = createLeanVerifier({ runner: (_roots, source, options) => {
    calls++;
    assert.equal(options.docker, true);
    assert.match(source, /^import Init\n\ntheorem answer : True := True.intro\n/);
    assert.doesNotMatch(source, /Mathlib|Untrusted/);
    return runnerOutput(source);
  } });
  const code = '\uFEFF\r\n import Mathlib\r\nimport Untrusted\r\n\r\ntheorem answer : True := True.intro\r\n';
  assert.equal(normalizeLeanSolution(code), request.code + '\n');
  const receipt = await verify({ ...request, code });
  assert.equal(calls, 1);
  assert.equal(score(receipt).grade.correct, true);
  const emptyImports = createLeanVerifier({ runner: (_roots, source) => {
    assert.doesNotMatch(source, /\bimport\b/);
    return runnerOutput(source);
  } });
  assert.equal((await emptyImports({ ...request, imports: [] })).verifier.proof.status, 'verified');
  const rejected = await verify({ ...request, code: '-- hidden header\nimport Mathlib\n' + request.code });
  assert.equal(calls, 1);
  assert.equal(rejected.verifier.execution.status, 'error');
  assert.equal(score(rejected).grade.correct, false);
  await assert.rejects(verify({ ...request, imports: undefined }), /explicit evaluator-supplied/);
  await assert.rejects(verify({ ...request, allowedAxioms: undefined }), /explicit evaluator-supplied/);
});

for (const [label, runner, expected] of [
  ['rejected', (_roots, source) => runnerOutput(source, ['forbidden']), ['completed', 'compiled', 'identified', 'rejected']],
  ['incomplete', (_roots, source) => runnerOutput(source, ['sorryAx']), ['completed', 'compiled', 'identified', 'incomplete']],
  ['timeout', () => ({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }), ['timeout', 'failed', 'not-requested', 'unverified']],
  ['missing-tool', () => ({ status: null, missingTool: true, notRun: true, error: Object.assign(new Error('docker missing'), { code: 'ENOENT' }) }), ['missing-tool', 'not-run', 'not-requested', 'unverified']],
  ['missing image', () => ({ status: 1, notRun: true, error: new Error('Docker image is not available') }), ['error', 'not-run', 'not-requested', 'unverified']],
  ['missing checker output', () => ({ status: 0, stdout: '', stderr: '' }), ['completed', 'compiled', 'not-requested', 'unverified']],
  ['missing target', () => ({ status: 1, stdout: "Check.lean:3:0: error: unknown identifier 'answer'" }), ['completed', 'failed', 'missing', 'unverified']],
  ['target type mismatch', (_roots, source) => {
    const line = source.split('\n').findIndex(text => text.startsWith('theorem _root_.math_verify_')) + 1;
    return { status: 1, stdout: `Check.lean:${line}:0: error: type mismatch` };
  }, ['completed', 'failed', 'mismatch', 'unverified']]
]) {
  test(`strict runner ${label} retains actual failure statuses and cannot pass`, async () => {
    const receipt = await createLeanVerifier({ runner })(request);
    validateNamed('verification-receipt', receipt);
    assert.deepEqual(['execution', 'compilation', 'target', 'proof'].map(key => receipt.verifier[key].status), expected);
    assert.equal(receipt.provenance.source_receipt_sha256, hash(receipt.verifier));
    assert.equal(receipt.receipt_sha256, receiptHash(receipt));
    assert.equal(score(receipt).grade.correct, false);
  });
}

test('verifier results are preserved; malformed output and thrown failures fail closed', async () => {
  const original = (await verified(request)).verifier;
  const receipt = await createLeanVerifier({ verifier: () => JSON.stringify(original) })(request);
  assert.deepEqual(receipt.verifier, original);
  for (const verifier of [() => 'not JSON', () => null, () => ({ ...original, proof: { status: 'verified' } }), () => { throw new Error('executor unavailable'); }]) {
    const failed = await createLeanVerifier({ verifier })(request);
    validateNamed('verification-receipt', failed);
    assert.equal(failed.verifier.execution.status, 'error');
    assert.equal(failed.verifier.proof.status, 'unverified');
    assert.equal(score(failed).grade.correct, false);
  }
});

test('target, imports, policy, source and toolchain mismatches cannot reuse a receipt', async () => {
  const receipt = await verified(request);
  for (const patch of [
    { theorem: 'other' }, { expectedType: 'False' }, { imports: ['Mathlib'] },
    { allowedAxioms: ['propext'] }, { code: 'theorem answer : False := by sorry' }, { toolchain: 'different' }
  ]) assert.equal(score(receipt, { ...request, ...patch }).grade.correct, false);
  for (const patch of [
    { target: { ...receipt.verifier.target, theorem: 'other' } },
    { target: { ...receipt.verifier.target, expectedType: 'False' } },
    { proof: { ...receipt.verifier.proof, allowedAxioms: ['propext'] } },
    { proof: { ...receipt.verifier.proof, axioms: ['forbidden'] } }
  ]) {
    const mismatch = await createLeanVerifier({ verifier: () => ({ ...receipt.verifier, ...patch }) })(request);
    assert.equal(score(mismatch).grade.correct, false);
  }
});

test('agent receipts, tool logs and missing finals never substitute for the trusted side-channel', async () => {
  const receipt = await verified(request);
  const { task, final, context } = grading(receipt);
  assert.equal(gradeFinal(task, { ...final, receipt }, {}).grade.correct, false);
  for (const missing of [null, undefined, {}, { type: 'formal', receipt }]) {
    const result = gradeFinal(task, missing, { ...context, stdout: JSON.stringify(receipt), events: [{ result: receipt }] });
    assert.equal(result.status, 'extraction_failure');
    assert.equal(result.grade.correct, false);
  }
  const tampered = structuredClone(receipt);
  tampered.toolchain = 'tampered';
  assert.equal(gradeFinal(task, final, { trusted_receipts: { [receipt.receipt_sha256]: tampered } }).grade.correct, false);
});
