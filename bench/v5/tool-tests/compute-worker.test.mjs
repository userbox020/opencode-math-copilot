import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolkit, tempFixture } from './helpers.mjs';
import { findExecutable } from '../../../.opencode/plugins/math-toolkit/lib/paths.js';

// No Python process, discovery or dependency probe unless explicitly enabled.
const enabled = process.env.V5_TOOL_TEST_SYMPY === '1';
const python = enabled ? findExecutable('python') || findExecutable('python3') : null;
const worker = fileURLToPath(new URL('scripts/math_compute.py', toolkit));
let unavailable = !enabled ? 'opt-in required: V5_TOOL_TEST_SYMPY=1; no Python probe performed' :
  !python ? 'Python executable unavailable; policy tests still run' : null;
if (!unavailable) {
  const probe = spawnSync(python, ['-B', '-I', '-c', 'import sympy'], {
    shell: false, timeout: 5000, maxBuffer: 4096, windowsHide: true,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  if (probe.error || probe.status !== 0) unavailable = 'isolated Python/SymPy probe unavailable or timed out; no installation attempted';
}
function invoke(args, directory) {
  const child = spawnSync(python, ['-B', '-I', worker, JSON.stringify(args)], {
    cwd: directory, shell: false, timeout: 10000, encoding: 'utf8', maxBuffer: 65536, windowsHide: true,
    env: { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  assert.equal(Boolean(child.error), false, 'bounded worker must complete');
  assert.equal(child.status, 0, 'worker must return its JSON protocol');
  assert.equal(child.stderr, '', 'worker must not emit traceback or process diagnostics');
  return JSON.parse(child.stdout);
}

const exact = [
  ['factor', { expression: 'x^2-1' }, '(x - 1)*(x + 1)'],
  ['expand', { expression: '(x+1)^3' }, 'x**3 + 3*x**2 + 3*x + 1'],
  ['solve', { expression: 'x^2-4' }, '[-2, 2]'],
  ['diff', { expression: 'x^3+sin(x)' }, '3*x**2 + cos(x)'],
  ['integrate', { expression: '2*x' }, 'x**2'],
  ['limit', { expression: 'sin(x)/x', point: 0 }, '1'],
  ['series', { expression: 'exp(x)', point: 0, order: 4 }, '1 + x + x**2/2 + x**3/6 + O(x**4)'],
  ['evalf', { expression: '1/8' }, '0.125000000000000'],
  ['eigenvalues', { matrix: [[2, 0, 0], [0, 2, 0], [0, 0, 3]] }, '{2: 2, 3: 1}'],
];
for (const [operation, args, result] of exact) {
  test(`real worker exact ${operation}`, { skip: unavailable || false }, t => {
    assert.deepEqual(invoke({ operation, ...args }, tempFixture(t)), { ok: true, result });
  });
}
for (const [label, args, result] of [
  ['unknown symbol sign does not make sqrt(x^2) equal x', { operation: 'factor', expression: 'sqrt(x^2)' }, 'sqrt(x**2)'],
  ['solve uses complex roots, not a real-only domain', { operation: 'solve', expression: 'x^2+1' }, '[-I, I]'],
  ['principal complex logarithm', { operation: 'expand', expression: 'log(-1)' }, 'I*pi'],
  ['limit defaults to the right at a pole', { operation: 'limit', expression: '1/x', point: 0 }, 'oo'],
  ['log product is not split without positivity assumptions', { operation: 'expand', expression: 'log(x*y)' }, 'log(x*y)'],
]) {
  test(`real worker domain: ${label}`, { skip: unavailable || false }, t => {
    assert.deepEqual(invoke(args, tempFixture(t)), { ok: true, result });
  });
}
for (const [label, args, error] of [
  ['syntax', { operation: 'factor', expression: 'x+' }, 'Invalid expression syntax.'],
  ['numeric exponent budget', { operation: 'expand', expression: 'x^1001' }, 'Numeric exponent magnitude is limited to 1000.'],
  ['numeric digit budget', { operation: 'evalf', expression: '9'.repeat(101) }, 'Numeric constants are limited to 100 digits.'],
  ['expression budget', { operation: 'factor', expression: 'x'.repeat(2001) }, 'Expression must contain 1 to 2000 characters.'],
  ['constant variable', { operation: 'diff', expression: 'x', variable: 'pi' }, 'Variable must be an allowed nonconstant symbol.'],
]) {
  test(`real worker rejects ${label}`, { skip: unavailable || false }, t => {
    assert.deepEqual(invoke(args, tempFixture(t)), { ok: false, error });
  });
}
