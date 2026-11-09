// provisional: true; review_status: owner-review-pending
// Structural/reference consistency checks only. Never runs a model or Lean.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import gradeAbsence from './grade-absence.mjs';

const tracks = ['retrieval', 'computation', 'formal', 'error-detection', 'absence'];
const families = ['geometry', 'algebra', 'analysis', 'number-theory', 'evidence', 'foundations'];
const types = {
  retrieval: ['citation'], computation: ['numeric', 'symbolic'], formal: ['formal'],
  'error-detection': ['explanation'], absence: ['absence'],
};
const required = ['id', 'track', 'family', 'domain', 'type', 'negative', 'prompt',
  'answer_contract', 'excerpts', 'grading', 'correct_final', 'provisional', 'review_status', 'notes'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(text);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const polynomial = value => Array.isArray(value) && value.length > 0 && value.length <= 8
  && value.every(coefficient => Number.isInteger(coefficient) && Math.abs(coefficient) <= 10000);
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const prose = final => final.type === 'absence' ? final.prose : final.text;
const computationUnits = { geometry: 'm^2', algebra: 'dimensionless', analysis: 'dimensionless', 'number-theory': 'dimensionless', evidence: 'dimensionless', foundations: 'subsets' };
const privateTokens = /\b(?:grading|correct_final|plausible_wrong_final|prose_variants|fixture_scores|supported_claim|solution_code|expected_type|allowed_axioms|allowed_denominators|target_sha256|receipt_sha256|labels|rubric)\b/i;

function typedFinal(final, type) {
  assert(object(final) && final.type === type, 'typed final must match task type');
  switch (type) {
    case 'numeric':
      assert(Number.isFinite(final.value), 'finite numeric value');
      assert(text(final.domain) && text(final.units) && strings(final.conditions), 'numeric metadata');
      break;
    case 'symbolic':
      assert(text(final.domain) && text(final.units) && strings(final.conditions) && strings(final.assumptions), 'symbolic metadata');
      if ('solutions' in final) {
        assert(Array.isArray(final.solutions) && final.solutions.every(Number.isFinite), 'finite solution set');
        assert(new Set(final.solutions).size === final.solutions.length, 'unique solutions');
        assert(!('numerator' in final) && !('denominator' in final), 'one symbolic representation');
      } else {
        assert(polynomial(final.numerator) && polynomial(final.denominator) && final.denominator.some(Boolean), 'bounded rational polynomials');
      }
      break;
    case 'citation':
      assert(text(final.document) && text(final.locator) && text(final.claim) && typeof final.supported === 'boolean', 'citation shape');
      break;
    case 'formal':
      assert(text(final.solution), 'formal solution artifact');
      // This intentional draft shape is NOT accepted as a verified final by the current grader.
      assert(final.target_sha256 === null && final.receipt_sha256 === null, 'no fabricated verifier identifiers');
      break;
    case 'explanation':
      assert(text(final.text), 'explanation text');
      break;
    case 'absence':
      assert(['not_found_in_consulted_excerpts', 'nonexistent', 'corpus_unavailable'].includes(final.status), 'absence status');
      assert(strings(final.consulted) && text(final.prose), 'absence scope and required prose');
      assert(new Set(final.consulted).size === final.consulted.length, 'unique consulted identifiers');
      break;
    default: assert.fail(`unknown type ${type}`);
  }
}

function rubric(task) {
  const g = task.grading;
  assert(strings(g.rubric) && g.rubric.length > 0 && new Set(g.rubric).size === g.rubric.length, 'unique rubric criteria');
  assert(object(g.labels) && object(g.fixture_scores), 'pre-scored labels and fixture scores');
  typedFinal(task.plausible_wrong_final, task.type);
  assert(prose(task.correct_final) !== prose(task.plausible_wrong_final), 'distinct correct/wrong prose');
  for (const [role, final] of [['correct', task.correct_final], ['plausible_wrong', task.plausible_wrong_final]]) {
    const score = g.fixture_scores[role];
    assert(object(score), 'fixture score map');
    same(Object.keys(score).sort(), [...g.rubric].sort(), 'exact rubric score keys');
    assert(g.rubric.every(key => typeof score[key] === 'boolean'), 'boolean rubric labels');
    same(g.labels[hash(prose(final))], score, 'frozen exact-text SHA-256 label');
    assert(g.rubric.every(key => score[key]) === (role === 'correct'), 'positive passes / plausible wrong fails reference rubric');
  }
  assert(Object.keys(g.labels).length === 2, 'only two registered prose labels');
}

function validateTask(task) {
  assert(object(task), 'task object');
  for (const key of required) assert(Object.hasOwn(task, key), `missing ${key}`);
  for (const key of ['id', 'domain', 'prompt', 'answer_contract']) assert(text(task[key]), `nonempty ${key}`);
  assert(tracks.includes(task.track) && types[task.track].includes(task.type), 'track/type mapping');
  assert(families.includes(task.family), 'exactly one registered family');
  assert(typeof task.negative === 'boolean', 'negative boolean');
  assert(task.provisional === true && task.review_status === 'owner-review-pending', 'explicit provisional labels');
  assert(strings(task.notes) && task.notes.length > 0, 'review notes');
  assert(Array.isArray(task.excerpts) && object(task.grading), 'excerpts and grading shape');
  assert(!privateTokens.test(task.prompt), 'private grader/answer keys leaked into prompt');
  for (const excerpt of task.excerpts) {
    same(Object.keys(excerpt).sort(), ['document', 'locator', 'text'], 'only public excerpt fields');
    assert(text(excerpt.document) && text(excerpt.locator) && text(excerpt.text), 'nonempty source fields');
    assert(/^math\/[A-Za-z0-9_./-]+$/.test(excerpt.document) && !excerpt.document.split('/').includes('..'), 'bounded corpus-relative path');
    assert(/^L[1-9]\d*-L[1-9]\d*$/.test(excerpt.locator), 'line-range locator');
    assert(!privateTokens.test(excerpt.text), 'private grader/answer keys leaked into excerpt');
  }
  typedFinal(task.correct_final, task.type);
  const final = task.correct_final, g = task.grading;
  if (task.type === 'numeric' || task.type === 'symbolic') {
    assert(/\bunits:string\b/.test(task.answer_contract), 'computation contract requires units');
    same(g.units, computationUnits[task.family], 'intended computation units');
    assert(task.prompt.includes(`units ${g.units}`), 'prompt specifies the same units');
    same(g.tolerance, { absolute: 0, relative: 0 }, 'exact tolerance');
    for (const key of ['domain', 'units', 'conditions']) same(final[key], g[key], `reference ${key}`);
    if (task.type === 'numeric') same(final.value, g.value, 'numeric reference');
    else {
      same(final.assumptions, g.assumptions, 'symbolic assumptions');
      if (g.kind === 'solution-set') same(final.solutions, g.solutions, 'complete reference solution set');
      else {
        assert(g.kind === 'rational-polynomial', 'registered symbolic kind');
        same(final.numerator, g.numerator, 'reference numerator');
        same(final.denominator, g.denominator, 'reference denominator');
        assert(Array.isArray(g.allowed_denominators) && g.allowed_denominators.every(polynomial), 'registered denominator classes');
        assert(g.allowed_denominators.some(d => JSON.stringify(d) === JSON.stringify(final.denominator)), 'reference denominator allowed');
        if (task.id === 'pilot-computation-algebra') {
          same(g.allowed_denominators, [[1], [-1, 1]], 'equivalent expression denominator classes');
          assert(task.prompt.includes('preserving the original domain') && task.prompt.includes('simplification is not required'), 'equivalence, not simplification contract');
        }
      }
    }
  }
  if (task.type === 'citation') {
    assert(task.prompt.includes('Copy the supplied locator unchanged; no narrower locator is allowed.'), 'unambiguous exact locator contract');
    if (task.id === 'pilot-retrieval-number-theory') assert(task.prompt.includes('body paragraph') && task.prompt.includes('excluding the heading'), 'version-note body only');
    same(final.document, g.document, 'citation document');
    same(final.locator, g.locator, 'citation locator');
    same(final.claim, g.supported_claim, 'citation reference claim');
    assert(final.supported === true, 'affirmative citation contract');
    assert(task.excerpts.some(e => e.document === final.document && e.locator === final.locator && e.text.includes(final.claim)), 'claim present in registered excerpt');
  }
  if (task.type === 'formal') {
    const f = task.formal;
    assert(object(f), 'formal reference fields');
    for (const key of ['theorem', 'expected_type', 'solution_code']) assert(text(f[key]), `formal ${key}`);
    assert(strings(f.imports) && f.imports.length > 0 && strings(f.allowed_axioms), 'formal imports and axiom policy');
    same(f.imports, ['Init'], 'self-contained imports');
    same(f.allowed_axioms, [], 'axiom-free reference policy');
    assert(f.verifier_integration === 'pending' && f.verification_status === 'not-run', 'verification pending, not run');
    assert(g.status === 'verifier-integration-pending', 'grader integration pending');
    same(g.theorem, f.theorem, 'fixed theorem');
    same(g.expected_type, f.expected_type, 'fixed type');
    same(g.policy.allowed_axioms, f.allowed_axioms, 'fixed axiom policy');
    same(final.solution, f.solution_code, 'reference solution consistency');
    assert(f.solution_code.startsWith('import Init\n') && f.solution_code.includes(`theorem ${f.theorem} : ${f.expected_type} :=`), 'declared reference target');
    assert(!/\b(sorry|admit|axiom|unsafe)\b/.test(f.solution_code), 'no admitted proof or extra axiom');
    assert(!task.prompt.includes(f.solution_code), 'reference proof not public');
  }
  if (task.type === 'explanation' || task.type === 'absence') {
    rubric(task);
    for (const answer of [final, task.plausible_wrong_final, ...Object.values(task.prose_variants ?? {})]) {
      assert(text(prose(answer)) && !task.prompt.includes(prose(answer)) && !task.excerpts.some(e => e.text.includes(prose(answer))), 'pre-scored explanation not public');
    }
  }
  if (task.type === 'explanation') assert(task.prompt.startsWith('Assess whether the argument is valid; if invalid, identify the specific defect'), 'neutral validity assessment prompt');
  if (task.type === 'absence') {
    assert(/\bprose:string\b/.test(task.answer_contract), 'absence contract requires prose');
    same(final.status, g.status, 'absence status');
    same(final.consulted, g.consulted, 'consulted identifiers');
    same(final.consulted, task.excerpts.map(e => `${e.document}#${e.locator}`), 'consulted scope equals provided excerpts');
    assert(g.exhaustive_inventory === false, 'no claim of exhaustive corpus search');
    assert(g.explanation_integration === 'pending', 'absence runner integration pending');
    assert(g.prose_grader === 'tasks/grade-absence.mjs', 'task-local prose grader declared');
    if (final.status === 'not_found_in_consulted_excerpts') {
      assert(task.excerpts.length > 0 && final.prose.includes('not found in consulted excerpts'), 'explicit bounded absence wording');
      assert(final.prose.includes('The consulted inventory is non-exhaustive.'), 'explicit non-exhaustive scope');
    } else {
      assert(final.status === 'corpus_unavailable' && g.scenario_corpus_available === false && task.excerpts.length === 0, 'explicit hypothetical unavailability');
    }
    assert(object(task.prose_variants), 'absence prose control fixtures');
    same(Object.keys(task.prose_variants), ['same_status_wrong_prose'], 'registered same-status control');
    const wrong = task.prose_variants.same_status_wrong_prose;
    typedFinal(wrong, 'absence');
    same(wrong.status, final.status, 'wrong-prose control retains correct status');
    same(wrong.consulted, final.consulted, 'wrong-prose control retains correct consulted set');
    same(wrong.prose, task.plausible_wrong_final.prose, 'control reuses scored nonexistence overclaim');
    same(g.labels[hash(wrong.prose)], g.fixture_scores.plausible_wrong, 'wrong-prose label');
    const context = final.status === 'corpus_unavailable' ? { corpus_available: false } : { consulted: g.consulted };
    assert(gradeAbsence(final, g, context).correct, 'local absence grader accepts reference');
    assert(!gradeAbsence(task.plausible_wrong_final, g, context).correct, 'local absence grader rejects wrong-status reference');
    const rejected = gradeAbsence(wrong, g, context);
    assert(!rejected.correct && rejected.reason.startsWith('fail: provisional exact-prose rubric'), 'correct-status control rejected specifically for prose');
    const { prose: removed, ...missingProse } = final;
    assert(!gradeAbsence(missingProse, g, context).correct, 'missing prose rejected');
    assert(!gradeAbsence({ ...missingProse, text: removed }, g, context).correct, 'legacy text cannot replace required prose');
    assert(!gradeAbsence(final, g, {}).correct, 'evaluator evidence context still required');
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === '--corpus'), 'Usage: node bench/v2/tasks/validate.mjs [--corpus PATH_TO_MATH]');
  const tasks = JSON.parse(await readFile(new URL('./pilot-v1.json', import.meta.url), 'utf8'));
  assert(Array.isArray(tasks) && tasks.length === 30, 'exactly 30 tasks');
  const ids = new Set(), pairs = new Set();
  const counts = { tracks: Object.fromEntries(tracks.map(t => [t, 0])), families: Object.fromEntries(families.map(f => [f, 0])) };
  for (const task of tasks) {
    try {
      validateTask(task);
      assert(!ids.has(task.id), 'unique task ID');
      assert(!pairs.has(`${task.track}/${task.family}`), 'one task per track/family cell');
      ids.add(task.id); pairs.add(`${task.track}/${task.family}`);
      counts.tracks[task.track]++; counts.families[task.family]++;
    } catch (error) { throw new Error(`${task?.id ?? 'unnamed task'}: ${error.message}`, { cause: error }); }
  }
  for (const track of tracks) assert(counts.tracks[track] === 6, `${track}: exactly six tasks`);
  for (const family of families) assert(counts.families[family] === 5, `${family}: exactly five tasks`);
  assert(tasks.some(t => t.negative) && tasks.some(t => t.type === 'explanation' && !t.negative), 'negative cases and positive error-detection control');
  assert(tasks.filter(t => t.type === 'explanation' && t.negative).length === 5, 'five defective argument fixtures');
  let checked = 0;
  if (args.length) {
    const root = path.resolve(args[1]), seen = new Set();
    for (const task of tasks) for (const excerpt of task.excerpts) {
      const identifier = `${excerpt.document}#${excerpt.locator}`;
      // Repeated occurrences are checked too; report distinct source ranges.
      const lines = (await readFile(path.join(root, excerpt.document.slice('math/'.length)), 'utf8')).replace(/\r\n/g, '\n').split('\n');
      const [, first, last] = /^L(\d+)-L(\d+)$/.exec(excerpt.locator);
      assert(+first <= +last && +last <= lines.length, `${identifier}: valid source range`);
      same(excerpt.text, lines.slice(+first - 1, +last).join('\n'), `${identifier}: exact local source text`);
      seen.add(identifier);
    }
    checked = seen.size;
  }
  console.log('PASS: 30 provisional tasks; unique IDs; all required fields, typed reference finals, public-field leakage guards and frozen rubric labels valid.');
  console.log(`Tracks: ${JSON.stringify(counts.tracks)}`);
  console.log(`Families: ${JSON.stringify(counts.families)}`);
  console.log(`Negative cases: ${tasks.filter(t => t.negative).length}`);
  console.log('Contracts: units checked for all 6 computation tasks; all 6 absence references pass the task-local grader; all 6 same-status/wrong-prose controls fail specifically on prose.');
  console.log(args.length ? `Corpus evidence: ${checked} distinct exact source ranges checked (all repeated occurrences checked).` : 'Corpus evidence: skipped; supply --corpus PATH_TO_MATH for exact local excerpt checks.');
  console.log('LIMITS: exact-text smoke tests, not general explanation grading; owner review pending; the validator itself performs no Lean/model/pilot execution. A separate evaluator-controlled Docker smoke verified the six formal reference solutions (6/6, no axioms); see tasks/README.md.');
}

main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
