import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BASELINES, GRADING_NOTE, INPUT_SHA256, INSTRUCTION, REVIEW_NOTE,
  buildTasks, explicitDisclosure, gradingType, normalize, selectPilot, serialize, sha256,
} from '../build.mjs';
import { readTasks } from '../../../external/schema.mjs';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url));
const tasks = JSON.parse(read('tasks.json'));
const pilot = JSON.parse(read('pilot.json'));
const review = JSON.parse(read('review.json'));
const rows = tasks.map(task => ({
  competition: task.metadata.contest,
  problem_idx: task.metadata.problem_number,
  problem: task.prompt.slice(0, -(`\n\n${INSTRUCTION}`).length),
  answer: task.answer,
  problem_type: task.metadata.problem_type,
  source: task.metadata.arxiv_id,
}));

test('103 unique competition-scoped tasks with valid shared schema', () => {
  assert.equal(tasks.length, 103);
  assert.equal(new Set(tasks.map(task => task.id)).size, 103);
  assert.deepEqual(readTasks(new URL('../tasks.json', import.meta.url)).tasks, tasks);
  for (const task of tasks) {
    assert.equal(task.id, `arxivmath-${task.metadata.contest.split('/')[1]}-${String(task.metadata.problem_number).padStart(3, '0')}`);
    assert.equal(task.metadata.arxiv_id, task.metadata.source);
    assert.equal(task.metadata.retrieval_assisted, false);
    assert.deepEqual(task.metadata.problem_type, ['unspecified']);
  }
});

test('20-task pilot: count-descending competitions, five evenly spaced rows each', () => {
  assert.equal(pilot.length, 20);
  assert.equal(new Set(pilot.map(task => task.id)).size, 20);
  const expected = [
    ['february', [1, 9, 17, 24, 32]],
    ['march', [1, 9, 16, 24, 31]],
    ['january', [1, 7, 12, 18, 23]],
    ['december', [1, 5, 9, 13, 17]],
  ].flatMap(([competition, numbers]) => numbers.map(n => `arxivmath-${competition}-${String(n).padStart(3, '0')}`));
  assert.deepEqual(pilot.map(task => task.id), expected);
  assert.deepEqual(readTasks(new URL('../pilot.json', import.meta.url)).tasks, pilot);
  for (const task of pilot) assert.deepEqual(task, tasks.find(item => item.id === task.id));
});

test('prompt instruction present, source metadata not appended, no explicit disclosure', () => {
  for (let i = 0; i < tasks.length; i++) {
    assert.equal(tasks[i].prompt, `${rows[i].problem}\n\n${INSTRUCTION}`);
    assert.equal(explicitDisclosure(rows[i].problem, tasks[i].answer), false);
    assert.equal(rows[i].problem.includes(tasks[i].metadata.arxiv_id), false);
  }
});

test('trimmed answers and exact/symbolic grading rule', () => {
  for (const task of tasks) {
    assert.equal(task.answer, task.answer.trim());
    assert.ok(['exact', 'symbolic'].includes(task.grading.type));
    assert.equal(task.grading.answer, task.answer);
    assert.equal(task.grading.type, gradingType(task.answer));
    assert.equal(task.grading.note, GRADING_NOTE);
  }
  for (const answer of ['\\frac{1}{2}', '\\sqrt{2}', 'x^2', 'x=y=2', '1, 2']) {
    assert.equal(gradingType(answer), 'symbolic');
  }
  for (const answer of ['5', '-1', 'x=2', '0.5']) assert.equal(gradingType(answer), 'exact');
});

test('answer-in-prompt flags agree with review, including normalized long matches', () => {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i], problem = rows[i].problem, normalized = normalize(task.answer);
    const flagged = (normalized.length >= 8 && normalize(problem).includes(normalized)) ||
      (task.answer.length >= 8 && problem.toLowerCase().includes(task.answer.toLowerCase()));
    assert.equal(task.metadata.answer_in_prompt === true, flagged);
    if (flagged) assert.equal(task.metadata.review_note, REVIEW_NOTE);
  }
  assert.deepEqual(review.flagged.map(item => item.id),
    tasks.filter(task => task.metadata.answer_in_prompt).map(task => task.id));
  const row = { ...rows[0], answer: '\\frac{123}{456}', problem: 'Given $\\frac{123} {456}$, compute a quantity.' };
  const [task] = buildTasks([row]);
  assert.equal(task.metadata.answer_in_prompt, true);
  assert.equal(task.metadata.review_note, REVIEW_NOTE);
  assert.equal(buildTasks([{ ...row, answer: '5', problem: 'Given 5 objects, compute a quantity.' }])[0].metadata.answer_in_prompt, undefined);
});

test('reject explicit disclosures, not incidental answer text or solution terminology', () => {
  for (const problem of ['FINAL: 5', 'The answer is $5$.', '## Solution\nThe calculation gives $5$.', '\\section{Solution}\n5']) {
    assert.equal(explicitDisclosure(problem, '5'), true, problem);
    assert.throws(() => buildTasks([{ ...rows[0], answer: '5', problem }]), /explicit disclosure/);
  }
  assert.equal(explicitDisclosure('Find a solution for 5 objects.', '5'), false);
  assert.equal(explicitDisclosure('The answer is 50.', '5'), false);
});

test('deterministic conversion, pilot selection, and output serialization', () => {
  assert.deepEqual(buildTasks(rows), tasks);
  assert.equal(serialize(buildTasks(rows)), read('tasks.json').toString());
  assert.equal(serialize(buildTasks(rows)), serialize(buildTasks(rows)));
  assert.deepEqual(selectPilot(tasks), pilot);
  assert.deepEqual(selectPilot([...tasks].reverse()), pilot);
  assert.equal(serialize(selectPilot(tasks)), read('pilot.json').toString());
});

test('snapshot and output SHA-256 receipts match; closed-book review counts are accurate', () => {
  assert.equal(review.input_sha256, INPUT_SHA256);
  assert.equal(review.tasks_sha256, sha256(read('tasks.json')));
  assert.equal(review.pilot_sha256, sha256(read('pilot.json')));
  assert.equal(review.track, 'declared-closed-book');
  assert.equal(review.retrieval_assisted, false);
  assert.equal(review.task_count, tasks.length);
  assert.equal(review.pilot_count, pilot.length);
  for (const type of ['exact', 'symbolic']) {
    assert.equal(review.grading_distribution[type], tasks.filter(task => task.grading.type === type).length);
  }
});

test('baselines contain only the specified model and caveat, without invented scores', () => {
  const baseline = JSON.parse(read('baselines.json'));
  assert.deepEqual(baseline, BASELINES);
  assert.equal(baseline.model, 'opencode-go/deepseek-v4.1-flash');
  assert.deepEqual(baseline.external, []);
  assert.ok(Object.values(baseline).every(value => typeof value !== 'number'));
  assert.match(baseline.note, /declared closed-book run, not a retrieval-assisted run/);
});
