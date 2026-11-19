import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readTasks, sha256 } from '../../../external/schema.mjs';
import {
  DIR, FINAL_QUESTION, FIXTURES, PILOT_IDS, assertCanonicalTasks, makeTasks, serialize,
} from '../build.mjs';
import { assess, checkSource, validateEvidence, verify } from '../verify.mjs';

const tasks = readTasks(path.join(DIR, 'tasks.json')).tasks;
const goldPath = path.join(DIR, 'gold.json');
const evidence = fs.existsSync(goldPath) ? JSON.parse(fs.readFileSync(goldPath, 'utf8')) : null;

test('ten schema-valid tasks, unique IDs, five of each verdict', () => {
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map(t => t.id)).size, 10);
  assert.equal(tasks.filter(t => t.answer === 'VALID').length, 5);
  assert.equal(tasks.filter(t => t.answer === 'INVALID').length, 5);
  assertCanonicalTasks(tasks);
});

test('prompts contain complete code and neutral metadata, not evaluator verdicts/reasons', () => {
  const metadata = serialize(tasks[0].metadata);
  for (const [i, task] of tasks.entries()) {
    assert.equal(serialize(task.metadata), metadata);
    assert.ok(task.prompt.endsWith(FINAL_QUESTION));
    const context = task.prompt.slice(0, -FINAL_QUESTION.length);
    assert.doesNotMatch(context, /\b(?:VALID|INVALID)\b/);
    assert.doesNotMatch(context, /lean-(?:valid|invalid)-\d+/);
    assert.ok(context.includes(FIXTURES[i].code));
    assert.ok(context.includes(FIXTURES[i].expectedType));
    assert.ok(!context.includes(task.grading.note));
  }
});

test('generation and checked-in JSON are byte-deterministic', () => {
  const first = serialize(makeTasks());
  assert.equal(first, serialize(makeTasks()));
  assert.equal(first, fs.readFileSync(path.join(DIR, 'tasks.json'), 'utf8'));
  const pilot = PILOT_IDS.map(id => tasks.find(t => t.id === id));
  assert.equal(serialize(pilot), fs.readFileSync(path.join(DIR, 'pilot.json'), 'utf8'));
});

test('pilot contains five deterministic mixed tasks; external baselines empty', () => {
  const pilot = readTasks(path.join(DIR, 'pilot.json')).tasks;
  assert.equal(pilot.length, 5);
  assert.deepEqual(pilot.map(t => t.id), PILOT_IDS);
  assert.deepEqual([...new Set(pilot.map(t => t.answer))].sort(), ['INVALID', 'VALID']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DIR, 'baselines.json'))).external, []);
});

test('trusted target is elaborated before submitted code (including shadowing)', () => {
  for (const f of FIXTURES) {
    const { source, witnessLine } = checkSource(f);
    assert.ok(source.indexOf('def GoldExpected') < source.indexOf('namespace Submission'));
    assert.equal(source.split('\n')[witnessLine - 1],
      'theorem GoldWitness : GoldExpected := Submission.claim');
  }
});

test('tampered task verdict is rejected before execution', () => {
  const changed = structuredClone(tasks);
  changed[0].answer = changed[0].grading.answer = 'INVALID';
  assert.throws(() => assertCanonicalTasks(changed), /differs/);
});

test('tampered code in prompt is rejected before execution', () => {
  const changed = structuredClone(tasks);
  changed[0].prompt = changed[0].prompt.replace('norm_num', 'sorry');
  assert.throws(() => assertCanonicalTasks(changed), /differs/);
});

test('execution failures and missing axiom output fail closed', () => {
  const f = FIXTURES[0];
  assert.throws(() => assess(f, { status: 125, stderr: 'Docker unavailable' }), /execution failure/);
  assert.throws(() => assess(f, { status: null, error: 'timeout' }), /execution failure/);
  assert.throws(() => assess(f, { status: 0, stdout: '', stderr: '' }), /axioms output/);
  assert.throws(() => assess(f, {
    status: 1, stdout: '/check/Check.lean:1:0: error: unknown module Mathlib', stderr: '',
  }), /environment failure/);
});

test('all ten recorded real Docker checks confirm expected verdicts and exact reasons', {
  skip: evidence ? false : 'Prerequisite: run node verify.mjs with initialized Docker image/volume; no verified gold exists.',
}, () => {
  assert.equal(validateEvidence(tasks, evidence), true);
  assert.equal(evidence.tasks_sha256, sha256(serialize(tasks)));
  assert.match(evidence.environment.image_id, /^sha256:[a-f0-9]{64}$/);
  assert.match(evidence.environment.mathlib_commit, /^[a-f0-9]{40}$/);
  assert.equal(evidence.environment.network, 'none');
  assert.equal(evidence.checks.filter(c => c.assessment.verdict === 'VALID').length, 5);
  assert.equal(evidence.checks.filter(c => c.assessment.verdict === 'INVALID').length, 5);
});

test('tampered gold verdict, code, and missing evidence fail', {
  skip: evidence ? false : 'Prerequisite: recorded Docker gold from node verify.mjs.',
}, () => {
  const verdict = structuredClone(evidence);
  verdict.checks[0].assessment.verdict = 'INVALID';
  assert.throws(() => validateEvidence(tasks, verdict), /Tampered/);
  const code = structuredClone(evidence);
  code.checks[0].code = code.checks[0].code.replace('norm_num', 'sorry');
  assert.throws(() => validateEvidence(tasks, code), /Tampered/);
  assert.throws(() => validateEvidence(tasks, { ...evidence, checks: [] }), /incomplete/);
});

test('optional fresh Docker integration (ten actual checks, never a mock)', {
  skip: process.env.LEAN_NECESSITY_LIVE === '1' ? false
    : 'Not rerun: node verify.mjs owns the ten-check budget; tests above validate its recorded evidence. Set LEAN_NECESSITY_LIVE=1 only for a separately authorized fresh run.',
}, () => {
  assert.equal(verify().check_count, 10);
});
