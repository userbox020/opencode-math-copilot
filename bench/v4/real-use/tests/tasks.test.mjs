import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const tasks = JSON.parse(readFileSync(path.join(root, 'tasks/public.json'), 'utf8'));
const gold = JSON.parse(readFileSync(path.join(root, 'grader-data/gold.json'), 'utf8'));
const result = id => gold.find(entry => entry.task_id === id).expected_result;
const corpus = path.resolve(process.env.REAL_USE_CORPUS_ROOT || path.join(root, '../../../math'));
const corpusPresent = existsSync(path.join(corpus, 'CONTENTS.md'));

test('ten public workflows have unique IDs and only solver-facing fields', () => {
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map(task => task.id)).size, 10);
  for (const task of tasks) {
    assert.deepEqual(Object.keys(task).sort(), ['category', 'family', 'id', 'prompt', 'schema']);
    assert.equal(task.schema, 'real-use-task/v1');
    for (const field of ['id', 'category', 'family', 'prompt']) assert.ok(task[field].trim());
    assert.doesNotMatch(task.prompt, /[a-f0-9]{64}|grader-data|positive_control/);
  }
  const datePrompt = tasks.find(task => task.id === 'metadata-characteristic-two').prompt;
  assert.doesNotMatch(datePrompt, /September 23|September-23|2026/);
  assert.match(datePrompt, /Kaplansky's Direct-Finiteness/);
  assert.deepEqual(tasks.reduce((counts, task) => {
    counts[task.category] = (counts[task.category] || 0) + 1;
    return counts;
  }, {}), { retrieval: 3, computation: 3, formal: 2, evidence: 2 });
});

test('gold is one-to-one with structured condition-independent correctness/evidence rubrics', () => {
  assert.equal(gold.length, 10);
  assert.equal(new Set(gold.map(entry => entry.task_id)).size, 10);
  assert.deepEqual(gold.map(entry => entry.task_id).sort(), tasks.map(task => task.id).sort());
  for (const entry of gold) {
    assert.equal(entry.schema, 'real-use-gold/v1');
    assert.ok(Object.keys(entry).every(key => ['schema', 'task_id', 'rubric', 'reference_sources', 'expected_result', 'lean'].includes(key)));
    assert.deepEqual(Object.keys(entry.rubric).sort(), ['correctness', 'evidence']);
    for (const rubric of Object.values(entry.rubric)) {
      assert.equal(rubric.max_score, 1);
      assert.ok(rubric.criteria.length > 0);
      assert.ok(rubric.criteria.every(criterion => typeof criterion === 'string' && criterion.trim()));
    }
    assert.ok(Array.isArray(entry.reference_sources));
    for (const ref of entry.reference_sources) {
      assert.deepEqual(Object.keys(ref).sort(), ['locator', 'path', 'quote', 'sha256']);
      assert.match(ref.sha256, /^[a-f0-9]{64}$/);
      assert.ok(ref.quote && ref.locator);
      assert.ok(!path.isAbsolute(ref.path) && !/^[A-Za-z]:/.test(ref.path));
      assert.ok(!ref.path.includes('\\') && !ref.path.split('/').includes('..'));
      assert.ok(!ref.path.startsWith('math/'), 'sources are corpus-relative');
    }
    assert.ok(!Object.hasOwn(entry, 'condition'));
    assert.ok(!Object.hasOwn(entry.expected_result, 'expected_score'));
  }
});

test('Lean policies and prepared controls have fixed public targets; no verification claimed', () => {
  const entries = gold.filter(entry => entry.lean);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const { theorem, expected_type, imports, allowed_axioms, positive_control } = entry.lean;
    assert.deepEqual(imports, ['Mathlib']);
    assert.deepEqual(allowed_axioms, ['propext', 'Quot.sound', 'Classical.choice']);
    assert.equal(entry.expected_result.status, 'prepared_unverified');
    assert.ok(positive_control.includes(`theorem ${theorem} : ${expected_type} := by`));
    assert.ok(tasks.find(task => task.id === entry.task_id).prompt.includes(`theorem ${theorem} : ${expected_type} := by`));
    assert.doesNotMatch(positive_control, /\b(?:sorry|admit|axiom|native_decide|unsafe)\b|#eval|IO\.Process/);
  }
});

// Independent exact arithmetic checks: no SymPy or Lean dependency in CI.
function determinant(matrix) {
  if (matrix.length === 1) return BigInt(matrix[0][0]);
  return matrix[0].reduce((sum, value, column) => {
    const minor = matrix.slice(1).map(row => row.filter((_, index) => index !== column));
    return sum + (column % 2 ? -1n : 1n) * BigInt(value) * determinant(minor);
  }, 0n);
}
function multiplyPolynomials(a, b) {
  const product = Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => { product[i + j] += x * y; }));
  return product;
}
const evaluatePolynomial = (coefficients, x) => coefficients.reduceRight((value, coefficient) => value * x + coefficient, 0);

test('determinant and adjugate gold are exactly self-consistent', () => {
  const { matrix, adjugate, determinant: expected, invertible_over_reals } = result('matrix-determinant');
  assert.deepEqual(matrix, [[3, -2, 5, 1], [4, 0, -1, 2], [-3, 6, 2, -4], [1, 5, -2, 3]]);
  assert.equal(determinant(matrix), BigInt(expected));
  assert.equal(invertible_over_reals, expected !== 0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const product = matrix[i].reduce((sum, a, k) => sum + BigInt(a) * BigInt(adjugate[k][j]), 0n);
    assert.equal(product, i === j ? BigInt(expected) : 0n);
  }
});

test('rational-equation polynomial, domain exclusions and original-root checks agree', () => {
  const expected = result('rational-equation');
  assert.deepEqual(expected.excluded_values, [-1, 2]);
  // (x^2-4)(x+1) - 6(x-2), computed from the public equation.
  const cleared = multiplyPolynomials([-4, 0, 1], [1, 1]);
  cleared[0] += 12;
  cleared[1] -= 6;
  assert.deepEqual(cleared, expected.cleared_polynomial_coefficients_ascending);
  assert.deepEqual(multiplyPolynomials(multiplyPolynomials([-2, 1], [-1, 1]), [4, 1]), cleared);
  assert.deepEqual(expected.extraneous_roots, [2]);
  assert.deepEqual(expected.real_solutions, [-4, 1]);
  for (const x of [...expected.real_solutions, ...expected.extraneous_roots]) assert.equal(evaluatePolynomial(cleared, x), 0);
  assert.deepEqual(expected.substitution_checks.map(check => check.x), expected.real_solutions);
  for (const { x, lhs, rhs } of expected.substitution_checks) {
    assert.ok(!expected.excluded_values.includes(x));
    assert.equal((x * x - 4) / (x - 2), lhs);
    assert.equal(6 / (x + 1), rhs);
    assert.equal(lhs, rhs);
  }
});

test('rational-integral derivative coefficients recover the original numerator and domain', () => {
  const expected = result('rational-integral');
  assert.deepEqual(expected.denominator_factors_coefficients_ascending, [[-1, 1], [1, 0, 1]]);
  assert.deepEqual(expected.excluded_real_values, [1]);
  const { log_abs_coefficient: a, atan_coefficient: b } = expected.partial_fractions;
  // d[a log|x-1| + b atan(x)] = a/(x-1) + b/(x^2+1).
  assert.deepEqual([a - b, b, a], expected.numerator_coefficients_ascending);
  assert.deepEqual(expected.numerator_coefficients_ascending, [1, 2, 3]);
  assert.equal(expected.antiderivative, `${a}*log(abs(x-1)) + ${b}*atan(x) + C`);
  assert.match(expected.constant_scope, /Independent/);
});

test('corpus source byte hashes and exact line quotes match', {
  skip: !corpusPresent && 'corpus absent; set REAL_USE_CORPUS_ROOT to check frozen source bytes',
}, () => {
  for (const ref of gold.flatMap(entry => entry.reference_sources)) {
    const bytes = readFileSync(path.join(corpus, ref.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256, ref.path);
    if (ref.path.endsWith('.pdf')) continue;
    const text = bytes.toString('utf8');
    assert.ok(text.includes(ref.quote), `${ref.path}: exact quote`);
    const line = Number(/^L(\d+)/.exec(ref.locator)?.[1]);
    assert.ok(Number.isSafeInteger(line) && line > 0);
    assert.ok(text.split(/\r?\n/)[line - 1].includes(ref.quote), `${ref.path}:${ref.locator}`);
  }
});

test('released PDF quote, physical/printed page and supplied miss scope match', {
  skip: !corpusPresent && 'corpus absent; PDF source validation is optional in portable CI',
}, async () => {
  const { getDocumentProxy } = await import('unpdf');
  const entry = gold.find(item => item.task_id === 'hanner-released-pdf');
  const [ref] = entry.reference_sources;
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path.join(corpus, ref.path))));
  try {
    assert.equal(pdf.numPages, 26);
    for (const number of [1, 2, entry.expected_result.physical_page]) {
      const page = await pdf.getPage(number);
      try {
        const { items } = await page.getTextContent();
        const text = items.filter(item => 'str' in item).map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
        if (number < 3) {
          assert.ok(!text.includes(ref.quote), `supplied literal miss on physical page ${number}`);
          continue;
        }
        assert.ok(text.includes(ref.quote), 'exact sentence in extracted released artifact');
        const lemmaStart = text.indexOf('Lemma 2.2');
        const quoteStart = text.indexOf(ref.quote, lemmaStart);
        assert.ok(lemmaStart >= 0 && quoteStart > lemmaStart);
        assert.ok(text.indexOf('Proof.', lemmaStart) > quoteStart);
        assert.match(text.slice(lemmaStart, quoteStart).replace(/\s+/g, ' '), /The Hanner volume product/);
        assert.equal(items.filter(item => 'str' in item && item.str.trim()).at(-1).str.trim(), entry.expected_result.printed_page);
      } finally { page.cleanup(); }
    }
  } finally {
    if (typeof pdf.destroy === 'function') await pdf.destroy();
    else await pdf.loadingTask?.destroy();
  }
});
