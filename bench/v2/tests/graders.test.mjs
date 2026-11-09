import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeFinal } from '../graders/index.mjs';
import { sha256, validateNamed } from '../lib.mjs';

// Self-contained fixtures: no concurrent task-file dependency.
const symbolic = { type: 'symbolic', grading: { numerator: [0, 1], denominator: [0, 1], allowed_denominators: [[0, 1]], domain: 'real', conditions: ['x != 0'], assumptions: ['x is real'], units: 'm' } };
const symbolicAnswer = { type: 'symbolic', numerator: [0, 2], denominator: [0, 2], domain: 'real', conditions: ['x != 0'], assumptions: ['x is real'], units: 'm' };
const absence = { type: 'absence', grading: { status: 'not_found_in_consulted_excerpts', consulted: ['doc#1'], exhaustive_inventory: false } };
const absenceAnswer = { type: 'absence', status: 'not_found_in_consulted_excerpts', consulted: ['doc#1'], prose: 'No matching theorem was found in the consulted excerpts.' };
const absenceContext = { consulted: ['doc#1'], corpus_available: true };
const score = (task, answer, context) => gradeFinal(task, answer, context).grade.correct;
const without = (object, key) => { const result = { ...object }; delete result[key]; return result; };

test('symbolic units must be present and exact despite equivalent rational polynomials', () => {
  assert.equal(score(symbolic, symbolicAnswer), true);
  assert.equal(score(symbolic, without(symbolicAnswer, 'units')), false);
  for (const units of ['cm', 'M', 'm ', '', null]) assert.equal(score(symbolic, { ...symbolicAnswer, units }), false);
});

test('symbolic units also constrain exact solution sets; unspecified units remain unconstrained', () => {
  const task = { type: 'symbolic', grading: { ...symbolic.grading, kind: 'solution-set', solutions: [2] } };
  const answer = { ...symbolicAnswer, solutions: [2] };
  assert.equal(score(task, answer), true);
  for (const invalid of [without(answer, 'units'), { ...answer, units: 'cm' }, { ...answer, solutions: [-2, 2] }]) assert.equal(score(task, invalid), false);
  for (const fixture of [symbolic, task]) {
    const unitFree = { ...fixture, grading: without(fixture.grading, 'units') };
    const final = fixture === task ? answer : symbolicAnswer;
    assert.equal(score(unitFree, without(final, 'units')), true);
    assert.equal(score(unitFree, { ...final, units: 'unregistered' }), true);
  }
});

test('symbolic units do not bypass domain, assumptions, conditions or pole restrictions', () => {
  for (const patch of [{ domain: 'complex' }, { assumptions: [] }, { conditions: [] }, { numerator: [-2, 1], denominator: [-2, 1] }, { numerator: [2] }, { denominator: [0] }]) {
    assert.equal(score(symbolic, { ...symbolicAnswer, ...patch }), false);
  }
});

test('absence schema and extraction require nonempty prose, status and consulted IDs', () => {
  validateNamed('absence-final', absenceAnswer);
  assert.equal(score(absence, absenceAnswer, absenceContext), true);
  for (const field of ['status', 'consulted', 'prose']) {
    const incomplete = without(absenceAnswer, field);
    assert.throws(() => validateNamed('absence-final', incomplete));
    assert.equal(gradeFinal(absence, incomplete, absenceContext).status, 'extraction_failure');
  }
  for (const prose of ['', ' \n\t ', null, 42]) {
    const invalid = { ...absenceAnswer, prose };
    assert.throws(() => validateNamed('absence-final', invalid));
    assert.equal(gradeFinal(absence, invalid, absenceContext).status, 'extraction_failure');
  }
});

test('absence accepts documented excerpt-scope phrases and rejects same-status wrong prose', () => {
  for (const prose of ['Not found in CONSULTED EXCERPTS.', 'Not found in the consulted-excerpt scope.', 'No match in the excerpts consulted.', 'No match in the excerpt consulted.']) {
    assert.equal(score(absence, { ...absenceAnswer, prose }, absenceContext), true, prose);
  }
  for (const prose of ['No theorem was found.', 'Search completed.', 'The evidence proves nonexistence.']) {
    assert.equal(score(absence, { ...absenceAnswer, prose }, absenceContext), false, prose);
  }
});

test('absence rejects corpus-wide claims even alongside the required scope phrase', () => {
  for (const claim of ['It does not exist anywhere.', 'It does not exist.', 'It doesn’t exist.', 'The entire corpus has no such theorem.', 'The whole corpus lacks it.', 'The full corpus lacks it.', 'Corpus-wide nonexistence is established.', 'It is nowhere to be found.', 'No such theorem exists.', 'No paper in the corpus supports it.', 'The corpus contains no matching result.', 'There are no matches in the corpus.', 'It is nonexistent.']) {
    const prose = `${absenceAnswer.prose} ${claim}`;
    assert.equal(score(absence, { ...absenceAnswer, prose }, absenceContext), false, claim);
  }
});

test('absence prose cannot replace exact consulted IDs, status or observed evidence', () => {
  assert.equal(score(absence, absenceAnswer, {}), false);
  assert.equal(score(absence, absenceAnswer, { consulted: ['other'] }), false);
  for (const patch of [{ status: 'nonexistent' }, { status: 'corpus_unavailable' }, { consulted: [] }, { consulted: ['doc#1', 'doc#1'] }]) {
    assert.equal(score(absence, { ...absenceAnswer, ...patch }, absenceContext), false);
  }
});

test('absence exhaustive and unavailable statuses still require prose and their evidence', () => {
  const exhaustive = { type: 'absence', grading: { status: 'nonexistent', consulted: ['inventory'], exhaustive_inventory: true } };
  const final = { type: 'absence', status: 'nonexistent', consulted: ['inventory'], prose: 'The consulted excerpts are the exhaustive inventory; the entire corpus contains no matching theorem.' };
  assert.equal(score(exhaustive, final, { exhaustive_inventory: true }), true);
  assert.equal(score(exhaustive, final, {}), false);
  assert.equal(score(exhaustive, without(final, 'prose'), { exhaustive_inventory: true }), false);
  const unavailable = { type: 'absence', grading: { status: 'corpus_unavailable', consulted: [] } };
  const unavailableFinal = { type: 'absence', status: 'corpus_unavailable', consulted: [], prose: 'There are no consulted excerpts because the corpus is unavailable.' };
  assert.equal(score(unavailable, unavailableFinal, { corpus_available: false }), true);
  assert.equal(score(unavailable, unavailableFinal, { corpus_available: true }), false);
  assert.equal(score(unavailable, without(unavailableFinal, 'prose'), { corpus_available: false }), false);
});

test('explanation and error detection validate exact fixture hashes, rejecting correct unregistered paraphrases', () => {
  for (const [text, paraphrase, wrong] of [
    ['For nonzero x, x/x = 1.', 'Dividing any nonzero number by itself gives one.', 'For all x, x/x = 1.'],
    ['The error is division by zero at x = 0.', 'The invalid step divides by x when x is zero.', 'There is no error at x = 0.']
  ]) {
    const task = { type: 'explanation', grading: { rubric: ['correct', 'scope'], labels: { [sha256(text)]: { correct: true, scope: true }, [sha256(wrong)]: { correct: false, scope: true } } } };
    assert.equal(score(task, { type: 'explanation', text }), true);
    for (const answer of [paraphrase, wrong, `${text} `, 'Unregistered wrong control']) assert.equal(score(task, { type: 'explanation', text: answer }), false);
    task.grading.labels[sha256(text)].scope = false;
    assert.equal(score(task, { type: 'explanation', text }), false);
  }
});

test('citation requires exact registered locator, including when a narrower locator seems correct', () => {
  const task = { type: 'citation', grading: { document: 'doc', locator: 'section-1', supported_claim: 'A triangle has three sides.' } };
  const answer = { type: 'citation', document: 'doc', locator: 'section-1', claim: 'A triangle has three sides.', supported: true };
  assert.equal(score(task, answer), true);
  for (const patch of [{ document: 'other' }, { locator: 'section-1/paragraph-1' }, { locator: 'section-2' }, { claim: 'A triangle does not have three sides.' }, { supported: false }]) assert.equal(score(task, { ...answer, ...patch }), false);
});

test('numeric enforces units, domain and condition sets and rejects missing units', () => {
  const task = { type: 'numeric', grading: { value: 3, tolerance: { absolute: 0.001, relative: 0 }, domain: 'real', units: 'm/s', conditions: ['t > 0', 'constant speed'] } };
  const answer = { type: 'numeric', value: 3, domain: 'real', units: 'm/s', conditions: ['constant speed', 't > 0'] };
  assert.equal(score(task, answer), true);
  assert.equal(score(task, { ...answer, value: 3.0005 }), true);
  for (const patch of [{ value: 3.002 }, { units: 'km/h' }, { units: 'm/s ' }, { domain: 'complex' }, { conditions: [] }, { conditions: ['t > 0', 't > 0'] }]) assert.equal(score(task, { ...answer, ...patch }), false);
  for (const field of ['units', 'domain', 'conditions']) {
    const result = gradeFinal(task, without(answer, field));
    assert.equal(result.status, 'extraction_failure');
    assert.equal(result.grade.correct, false);
  }
});
