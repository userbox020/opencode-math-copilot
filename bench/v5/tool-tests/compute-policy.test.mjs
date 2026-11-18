import test from 'node:test';
import assert from 'node:assert/strict';
import { importWithStubs } from './helpers.mjs';

let response, calls;
const { compute } = await importWithStubs('lib/compute.js', [
  { from: ['lib/compute.js'], specifier: './paths.js', exports: { findExecutable: () => 'fixture-python' } },
  { from: ['lib/compute.js'], specifier: 'node:child_process', exports: {
    spawnSync(executable, argv, options) { calls.push({ executable, argv, options }); return response; },
  } },
]);
const run = args => { calls = []; return compute(undefined, args); };

for (const operation of ['factor', 'expand', 'solve', 'diff', 'integrate', 'limit', 'series', 'evalf', 'eigenvalues']) {
  test(`policy permits ${operation}, sends fixed JSON fields and a bounded non-shell call`, () => {
    response = { status: 0, stdout: '{"ok":true,"result":"fixture-result"}' };
    const args = { operation, ...(operation === 'eigenvalues' ? { matrix: [[2, 0], [0, 3]] } : { expression: 'x^2' }),
      variable: 'x', timeoutMs: 4200, unrecognized: 'must-not-be-forwarded' };
    assert.match(run(args), /Result: fixture-result/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.timeout, 4200);
    assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
    assert.deepEqual(JSON.parse(calls[0].argv[1]), {
      operation, ...(operation === 'eigenvalues' ? { matrix: args.matrix } : { expression: args.expression }), variable: 'x',
    });
  });
}

const invalid = [
  ['unknown operation', { operation: 'unknown' }, /Unsupported operation/],
  ['empty expression', { expression: ' ' }, /expression must contain/],
  ['oversized expression', { expression: 'x'.repeat(2001) }, /expression must contain/],
  ['nonfinite point', { point: Infinity }, /point must be/],
  ['oversized point', { point: 'x'.repeat(2001) }, /point must be/],
  ['nonsymbol variable type', { variable: {} }, /variable must be/],
  ['zero order', { order: 0 }, /order must be/],
  ['oversized order', { order: 51 }, /order must be/],
  ['fractional order', { order: 1.5 }, /order must be/],
  ['short timeout', { timeoutMs: 999 }, /timeoutMs must be/],
  ['oversized timeout', { timeoutMs: 120001 }, /timeoutMs must be/],
  ['fractional timeout', { timeoutMs: 1000.5 }, /timeoutMs must be/],
  ['ragged matrix', { operation: 'eigenvalues', matrix: [[1, 2], [3]] }, /matrix must be/],
  ['oversized matrix', { operation: 'eigenvalues', matrix: Array.from({ length: 11 }, () => Array(11).fill(0)) }, /matrix must be/],
  ['nonfinite matrix', { operation: 'eigenvalues', matrix: [[NaN]] }, /matrix must be/],
];
for (const [label, override, expected] of invalid) {
  test(`policy rejects ${label} before invoking Python`, () => {
    assert.match(run({ operation: 'series', expression: 'x', ...override }), expected);
    assert.equal(calls.length, 0);
  });
}

for (const [label, child, expected] of [
  ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }, /^SymPy timed out:/],
  ['output overflow', { status: null, error: { code: 'ENOBUFS' } }, /^SymPy process failed:/],
  ['nonzero exit', { status: 1 }, /^SymPy process failed:/],
  ['invalid JSON', { status: 0, stdout: 'not JSON' }, /^SymPy error: Python returned invalid JSON/],
  ['invalid result shape', { status: 0, stdout: '{"ok":true,"result":5}' }, /^SymPy error: Python returned an invalid result/],
  ['worker input error', { status: 0, stdout: '{"ok":false,"error":"Invalid expression syntax."}' }, /^SymPy error: Invalid expression syntax/],
]) {
  test(`classifies ${label}, never a successful result`, () => {
    response = child;
    const output = run({ operation: 'factor', expression: 'x^2-1' });
    assert.match(output, expected);
    assert.doesNotMatch(output, /Result:|### SymPy:/);
  });
}
