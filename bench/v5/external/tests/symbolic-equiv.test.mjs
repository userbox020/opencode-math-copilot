import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gradeEpisode, symbolicEquivalent } from '../grade.mjs';

const cases = [
  [String.raw`-\frac{1}{21}`, '-1/21'],
  [String.raw`\frac{1}{9}`, String.raw`\(\frac19\)`],
  [String.raw`3+2\sqrt{2}`, String.raw`\(3+2\sqrt2\)`],
  [String.raw`\frac{9\sqrt{30}}{4}`, String.raw`\(\displaystyle \frac{9\sqrt{30}}4\)`],
  [String.raw`e^{\frac{1}{2}}`, String.raw`\(\sqrt{e}\)`],
  [String.raw`\frac{2\sqrt{6}}{3}`, String.raw`\(\frac{2\sqrt6}{3}\)`],
  [String.raw`\frac{737}{39}`, '737/39'],
  [String.raw`\frac{\sin(6\pi/13)}{\sin(\pi/13)}`, String.raw`\frac{1}{2\sin(\pi/26)}`],
];
const grade = (expected, extracted, options) => gradeEpisode(
  { status: 'completed', exit_code: 0, text: extracted },
  { answer: expected, grading: { type: 'symbolic' } }, options,
);

for (const [expected, extracted] of cases) {
  test(`symbolic equivalence: ${expected} vs ${extracted}`, () => {
    const result = symbolicEquivalent(expected, extracted);
    assert.equal(result.status, 'equivalent', result.reason);
    assert.equal(grade(expected, extracted).status, 'correct');
  });
}

test('wrong numeric and symbolic answers remain incorrect', () => {
  for (const [expected, extracted] of [['5', '7'], ['1/2', '2/3'], ['1', '1+1/10^20']]) {
    const result = symbolicEquivalent(expected, extracted);
    assert.equal(result.status, 'different', result.reason);
    assert.equal(grade(expected, extracted).status, 'incorrect');
  }
});

test('unsupported text, free symbols and nonfinite values remain unparseable', () => {
  for (const extracted of [String.raw`\text{foo}`, 'x+x', '1/0', 'sin(', 'sqrt', '1;2']) {
    const result = symbolicEquivalent('1/2', extracted);
    assert.equal(result.status, 'unparseable', extracted);
  }
});

test('injection is rejected before evaluation, with no command output', () => {
  const result = spawnSync('python', ['-B', fileURLToPath(new URL('../symbolic_equiv.py', import.meta.url))], {
    input: JSON.stringify({ expected: '1', extracted: "__import__('os').system('echo x')" }),
    encoding: 'utf8', timeout: 5000, shell: false,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { status: 'unparseable', reason: 'Restricted symbolic comparison: ValueError: Forbidden input' });
});

test('normalization supports delimiters, spacing, products, trig and unbraced fractions', () => {
  for (const [expected, extracted] of [
    ['1/2', String.raw`$$\left(\frac 1 2\right)$$`],
    ['6', String.raw`\[2\,\cdot\;3\!\ \]`],
    ['6', String.raw`2\times3`],
    ['1', String.raw`\cos(0)+\tan(0)`],
  ]) assert.equal(symbolicEquivalent(expected, extracted).status, 'equivalent');
});

test('bounded definitive comparisons and other grading types never invoke Python', () => {
  const options = { symbolic: () => assert.fail('unexpected symbolic fallback') };
  assert.equal(grade('(x+1)', '(x+1)', options).status, 'correct');
  assert.equal(grade('5', '7', options).status, 'incorrect');
  for (const type of ['integer', 'exact']) {
    assert.equal(gradeEpisode({ status: 'completed', exit_code: 0, text: '5' },
      { answer: '5', grading: { type } }, options).status, 'correct');
  }
});

test('timeout and missing Python fail closed and use a module-relative script with no shell', () => {
  for (const code of ['ETIMEDOUT', 'ENOENT']) {
    const symbolic = (expected, extracted) => symbolicEquivalent(expected, extracted, {
      runner: (executable, args, options) => {
        assert.equal(executable, 'python');
        assert.deepEqual(args, ['-B', fileURLToPath(new URL('../symbolic_equiv.py', import.meta.url))]);
        assert.equal(options.timeout, 5000);
        assert.equal(options.killSignal, 'SIGKILL');
        assert.equal(options.shell, false);
        assert.deepEqual(JSON.parse(options.input), { expected, extracted });
        return { error: Object.assign(new Error(code), { code }) };
      },
    });
    const result = grade('1/2', '2/4', { symbolic });
    assert.equal(result.status, 'unparseable');
    assert.match(result.reason, code === 'ETIMEDOUT' ? /timed out/ : /unavailable.*ENOENT/);
  }
  assert.equal(symbolicEquivalent('1/2', '2/4', { python: 'nonexistent-symbolic-python-executable' }).status, 'unparseable');
});

test('missing SymPy, subprocess failures and malformed results fail closed', () => {
  for (const result of [
    { status: 0, stdout: JSON.stringify({ status: 'unparseable', reason: 'SymPy is unavailable' }) },
    { status: 1, stderr: 'No module named sympy' },
    { status: null, signal: 'SIGKILL' },
    { status: 0, stdout: 'invalid JSON' },
    { status: 0, stdout: '{"status":"correct","reason":"invalid status"}' },
  ]) {
    const symbolic = (a, b) => symbolicEquivalent(a, b, { runner: () => result });
    assert.equal(grade('1/2', '2/4', { symbolic }).status, 'unparseable');
  }
  assert.equal(symbolicEquivalent('1', '2', { runner: () => { throw new Error('unavailable'); } }).status, 'unparseable');
});
