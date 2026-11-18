import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPack, DEFAULT_INPUT_DIR, INSTRUCTION, normalizeAnswer, normalizeRow,
  PACK_DIR, REVIEW_NOTE, selectPilot, serialize, SOURCES,
} from '../build.mjs';

const load = (name) => JSON.parse(readFileSync(join(PACK_DIR, `${name}.json`), 'utf8'));
const tasks = load('tasks');
const pilot = load('pilot');
const review = load('review');
const source = SOURCES[0];
const synthetic = (problem, answer) => normalizeRow({ problem_idx: 1, problem, answer }, source);

test('146 unique, ordered tasks with exact per-contest counts and ids', () => {
  assert.equal(tasks.length, 146);
  assert.equal(new Set(tasks.map(({ id }) => id)).size, 146);
  const expected = SOURCES.flatMap(({ contest, count }) =>
    Array.from({ length: count }, (_, i) => `${contest}-${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(tasks.map(({ id }) => id), expected);
  for (const { contest, count } of SOURCES) {
    assert.equal(tasks.filter((task) => task.metadata.contest === contest).length, count);
  }
});

test('schema, preserved source problem/answer/type, and final-answer instruction', () => {
  for (const source of SOURCES) {
    const { rows } = JSON.parse(readFileSync(join(DEFAULT_INPUT_DIR, source.file), 'utf8'));
    for (const { row } of rows) {
      const task = tasks.find(({ id }) => id === `${source.contest}-${String(row.problem_idx).padStart(2, '0')}`);
      assert.deepEqual(Object.keys(task), ['schema', 'benchmark', 'id', 'prompt', 'answer', 'grading', 'metadata']);
      assert.equal(task.schema, 'math-bench-task/v1');
      assert.equal(task.benchmark, 'matharena-2026');
      assert.equal(task.prompt, `${row.problem}\n\n${INSTRUCTION}`);
      assert.ok(row.problem.trim());
      assert.equal(task.answer, String(row.answer).trim());
      assert.ok(task.grading.answer);
      assert.ok(['integer', 'exact', 'symbolic'].includes(task.grading.type));
      assert.deepEqual(task.grading, normalizeAnswer(row.answer).grading);
      assert.ok(task.metadata.source);
      assert.ok(task.metadata.license);
      assert.equal(task.metadata.year, source.year);
      assert.equal(task.metadata.problem_number, row.problem_idx);
      assert.deepEqual(task.metadata.problem_type, row.problem_type);
    }
  }
});

test('answer normalization distinguishes integer commas, expressions, lists, and exact strings', () => {
  for (const [value, type, normalized] of [
    [42, 'integer', '42'], [' -1,234 ', 'integer', '-1234'],
    ['13,14,18', 'symbolic', '13,14,18'], ['2^{99}', 'symbolic', '2^{99}'],
    ['\\frac{1}{3}', 'symbolic', '\\frac{1}{3}'], ['\\sqrt{2}', 'symbolic', '\\sqrt{2}'],
    ['x=1=y', 'symbolic', 'x=1=y'], ['20\\pi', 'exact', '20\\pi'],
    ['-1013 \\ln (2026)', 'exact', '-1013 \\ln (2026)'],
  ]) {
    assert.deepEqual(normalizeAnswer(value), {
      answer: String(value).trim(), grading: { type, answer: normalized },
    });
  }
});

test('answer occurrence flags rather than rejects; short matches are allowed', () => {
  const flagged = synthetic('Use the bound $\\frac{1}{3}$ to compute the probability.', '\\frac{1}{3}');
  assert.equal(flagged.metadata.answer_in_prompt, true);
  assert.equal(flagged.metadata.review_note, REVIEW_NOTE);
  assert.equal(synthetic('Use ABCDEFGH as a label.', 'abcdefgh').metadata.answer_in_prompt, true);
  assert.equal(synthetic('Start with 3 objects.', '3').metadata.answer_in_prompt, undefined);
  assert.equal(synthetic('Consider 2^{99} objects.', '2^{99}').metadata.answer_in_prompt, undefined);
  assert.equal(synthetic('Use 12345678 as a bound.', '12,345,678').metadata.answer_in_prompt, true);
  assert.equal(synthetic('Find the probability.', '\\frac{1}{3}').metadata.answer_in_prompt, undefined);
  assert.equal(tasks.find(({ id }) => id === 'brumo-2025-13').metadata.answer_in_prompt, true);
});

test('review lists precisely the retained long-answer matches', () => {
  const flagged = [];
  for (const task of tasks) {
    const problem = task.prompt.slice(0, -(INSTRUCTION.length + 2));
    const matches = task.grading.answer.length >= 8
      && problem.toLowerCase().includes(task.grading.answer.toLowerCase());
    assert.equal(task.metadata.answer_in_prompt === true, matches, task.id);
    if (matches) {
      assert.equal(task.metadata.review_note, REVIEW_NOTE);
      flagged.push({ id: task.id, reason: REVIEW_NOTE });
    } else assert.equal(task.metadata.review_note, undefined);
  }
  assert.deepEqual(review, flagged);
  assert.deepEqual(review.map(({ id }) => id), ['brumo-2025-13']);
});

test('explicit answer disclosures and empty source problems are rejected', () => {
  for (const problem of [
    'Find x.\nFINAL: 42', 'Find x.\nfinal: 42',
    'Find x. The answer is 42.', 'Find x. The answer is $42$.',
    'Find x.\nAnswer: 42', 'Find x.\n## Solution\nComputing gives 42.',
    'Find x.\n**Answer:** 42',
  ]) assert.throws(() => synthetic(problem, '42'), /Explicit|section/);
  assert.throws(() => synthetic('The answer is $\\frac{1}{3}$.', '\\frac{1}{3}'), /Explicit/);
  assert.throws(() => synthetic(' \n ', '42'), /Empty problem/);
  assert.throws(() => synthetic('Find x.', ''), /Empty answer/);
  assert.throws(() => synthetic('Find x.', null), /Missing/);
});

test('40-task pilot has ten evenly spaced entries per contest, including endpoints', () => {
  assert.equal(pilot.length, 40);
  assert.equal(new Set(pilot.map(({ id }) => id)).size, 40);
  for (const { contest, count } of SOURCES) {
    const group = pilot.filter((task) => task.metadata.contest === contest);
    assert.equal(group.length, 10);
    assert.deepEqual(group.map((task) => task.metadata.problem_number),
      Array.from({ length: 10 }, (_, i) => Math.round(i * (count - 1) / 9) + 1));
    for (const task of group) assert.deepEqual(task, tasks.find(({ id }) => id === task.id));
  }
  assert.deepEqual(pilot, selectPilot([...tasks].reverse()));
});

test('two builds from checksum-pinned raw inputs are byte-identical to committed JSON', () => {
  const first = buildPack();
  const second = buildPack();
  for (const name of ['tasks', 'pilot', 'review']) {
    const expected = readFileSync(join(PACK_DIR, `${name}.json`), 'utf8');
    assert.equal(serialize(first[name]), expected, name);
    assert.equal(serialize(second[name]), expected, name);
    assert.ok(expected.endsWith('\n'));
  }
});

test('baselines contain no invented numeric scores', () => {
  const baselines = load('baselines');
  assert.deepEqual(baselines, {
    schema: 'math-bench-baselines/v1',
    benchmark: 'matharena-2026',
    model: 'opencode-go/deepseek-v4.1-flash',
    external: [],
    note: 'No published score for this exact model/version was found; use the paired plugin-off arm. External leaderboard scores are not apples-to-apples.',
  });
  const hasNumber = (value) => typeof value === 'number'
    || (value !== null && typeof value === 'object' && Object.values(value).some(hasNumber));
  assert.equal(hasNumber(baselines), false);
});
