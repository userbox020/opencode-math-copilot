import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from './bridge.mjs';

const request = { task_id: 'dutch-2019-2', answer: [] };
const receipt = {
  schema: 'mathconstruct-validator/v1', task_id: request.task_id,
  status: 'accepted', tag: 'CORRECT', reason: 'OK',
};
const fake = output => () => ({ status: 0, stdout: JSON.stringify(output) });

for (const status of ['accepted', 'rejected', 'unavailable']) {
  test(`preserves ${status} receipt`, () => {
    const expected = { ...receipt, status };
    assert.deepEqual(validate(request, { python: 'fake-python', run: fake(expected) }), expected);
  });
}

test('sends JSON on stdin without a shell and with a timeout', () => {
  const run = (python, args, options) => {
    assert.equal(python, 'fake-python');
    assert.equal(args[0], '-B');
    assert.match(args[1], /validate\.py$/);
    assert.deepEqual(JSON.parse(options.input), request);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 60_000);
    return { status: 0, stdout: JSON.stringify(receipt) };
  };
  assert.equal(validate(request, { python: 'fake-python', run }).status, 'accepted');
});

for (const [name, output] of [
  ['wrong schema', { ...receipt, schema: 'wrong/v1' }],
  ['wrong task', { ...receipt, task_id: 'other' }],
  ['unknown status', { ...receipt, status: 'passed' }],
  ['missing tag', { ...receipt, tag: undefined }],
  ['missing reason', { ...receipt, reason: undefined }],
  ['null', null],
]) {
  test(`fails closed on ${name}`, () => {
    const result = validate(request, { python: 'fake-python', run: fake(output) });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.tag, 'BRIDGE_ERROR');
  });
}

for (const [name, run] of [
  ['non-JSON stdout', () => ({ status: 0, stdout: 'not JSON' })],
  ['extra stdout', () => ({ status: 0, stdout: `log\n${JSON.stringify(receipt)}` })],
  ['nonzero exit', () => ({ status: 1, stdout: JSON.stringify(receipt) })],
  ['timeout', () => ({ status: null, error: new Error('timeout') })],
  ['exception', () => { throw new Error('spawn failed'); }],
]) {
  test(`fails closed on ${name}`, () => {
    assert.equal(validate(request, { python: 'fake-python', run }).status, 'unavailable');
  });
}

test('missing Python is unavailable without invoking anything', () => {
  assert.equal(validate(request, {
    run() { assert.fail('must not run'); },
  }).status, 'unavailable');
});
