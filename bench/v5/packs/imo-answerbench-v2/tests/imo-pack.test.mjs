import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  answerInPrompt, BASELINES, BENCHMARK, createTasks, CSV_SHA256, DEFAULT_CSV,
  explicitLeakage, gradingType, GRADING_NOTE, INSTRUCTION, json, normalize,
  parseCSV, repairCSV, REPAIRED_ROW, REPAIR_ID, REVIEW_NOTE, selectPilot, sha256,
} from '../build.mjs';

const load = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));
const tasks = await load('tasks.json');
const pilot = await load('pilot.json');
const baselines = await load('baselines.json');
const repairs = await load('repairs.json');
const review = await load('review.json');
const fixture = (problem, answer) => [
  'Problem ID,Problem,Short Answer,Category,Subcategory,Source',
  ['test-id', problem, answer, 'category-only', 'subcategory-only', 'source-only']
    .map((field) => `"${field.replaceAll('"', '""')}"`).join(','),
].join('\n');

test('400 unique tasks with exactly the required schema and non-empty answers', () => {
  assert.equal(tasks.length, 400);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 400);
  for (const task of tasks) {
    assert.deepEqual(Object.keys(task).sort(),
      ['schema', 'benchmark', 'id', 'prompt', 'answer', 'grading', 'metadata'].sort());
    assert.equal(task.schema, 'math-bench-task/v1');
    assert.equal(task.benchmark, BENCHMARK);
    assert.ok(task.id.trim());
    assert.ok(task.answer.trim());
    assert.equal(task.answer, task.answer.trim());
    assert.ok(task.prompt.endsWith(`\n\n${INSTRUCTION}`));
    assert.ok(task.prompt.slice(0, -INSTRUCTION.length).trim());
    assert.deepEqual(Object.keys(task.metadata).sort(), [
      'source', 'license', 'category', 'subcategory', 'source_text',
      ...(task.metadata.answer_in_prompt ? ['answer_in_prompt', 'review_note'] : []),
    ].sort());
    assert.equal(task.metadata.license, 'CC-BY-4.0 (data); Apache-2.0 (software)');
  }
});

test('overlap of length >= 8 is flagged for review, not rejected', () => {
  for (const task of tasks) {
    const problem = task.prompt.slice(0, -(`\n\n${INSTRUCTION}`).length);
    assert.equal(explicitLeakage(problem, task.answer), false, task.id);
    assert.equal(Boolean(task.metadata.answer_in_prompt), answerInPrompt(problem, task.answer), task.id);
    if (task.metadata.answer_in_prompt) assert.equal(task.metadata.review_note, REVIEW_NOTE);
  }
  assert.deepEqual(review.entries, tasks.filter((task) => task.metadata.answer_in_prompt)
    .map((task) => ({ id: task.id, answer: task.answer, note: REVIEW_NOTE })));
  assert.deepEqual(review.entries.map((entry) => entry.id), ['imo-bench-number_theory-005', 'imo-bench-number_theory-079']);
  assert.equal(normalize('  Ａ \r\n B  '), 'A B');
  assert.equal(answerInPrompt('Here is abcdefgh.', 'abcdefgh'), true);
  assert.equal(answerInPrompt('Here is abcdefg.', 'abcdefg'), false);
  assert.equal(answerInPrompt('Here is alpha \n beta.', 'alpha beta'), true);
});

test('grading types, answers and notes match the specified rule', () => {
  for (const task of tasks) {
    assert.deepEqual(task.grading, {
      type: gradingType(task.answer), answer: task.answer, note: GRADING_NOTE,
    });
    assert.ok(['exact', 'symbolic'].includes(task.grading.type));
  }
  for (const value of ['\\frac{1}{2}', 'x^2', 'a_1', 'x=1, y=2', 'x=y=1', '1, 2']) {
    assert.equal(gradingType(value), 'symbolic');
  }
  for (const value of ['42', '1/2', 'x=1', 'No solutions']) assert.equal(gradingType(value), 'exact');
});

test('pilot is exactly 40 deterministic, evenly spaced tasks across the four largest categories', () => {
  assert.equal(pilot.length, 40);
  assert.equal(new Set(pilot.map((task) => task.id)).size, 40);
  assert.ok(new Set(pilot.map((task) => task.metadata.category)).size >= 4);
  assert.deepEqual(pilot, selectPilot(tasks));
  assert.deepEqual(selectPilot(tasks), selectPilot(structuredClone(tasks)));
  const categories = [...new Set(tasks.map((task) => task.metadata.category))].sort((a, b) => {
    const delta = tasks.filter((task) => task.metadata.category === b).length
      - tasks.filter((task) => task.metadata.category === a).length;
    return delta || (a < b ? -1 : a > b ? 1 : 0);
  }).slice(0, 4);
  for (const category of categories) {
    const members = tasks.filter((task) => task.metadata.category === category);
    const selected = pilot.filter((task) => task.metadata.category === category);
    assert.equal(selected.length, 10);
    assert.deepEqual(selected, Array.from({ length: 10 }, (_, i) =>
      members[Math.floor(i * (members.length - 1) / 9)]));
  }
});

test('CSV parser handles quoted commas, newlines, escaped quotes, BOM and empty fields', () => {
  assert.deepEqual(parseCSV('\uFEFFa,b,c\r\n"x,y","line 1\r\nline 2","a ""quote"""\r\n,,\r\n'),
    [['a', 'b', 'c'], ['x,y', 'line 1\r\nline 2', 'a "quote"'], ['', '', '']]);
  assert.deepEqual(parseCSV('"one\nline",last,'), [['one\nline', 'last', '']]);
  assert.deepEqual(parseCSV('""'), [['']]);
  assert.throws(() => parseCSV('"unterminated'), /Unterminated/);
  assert.throws(() => parseCSV('"closed"garbage'), /Invalid CSV/);
});

test('conversion preserves Problem exactly, trims answers and keeps metadata out of prompts', () => {
  const problem = '  Find x, given:\n"x" is an integer.\r\n';
  const [task] = createTasks(fixture(problem, '  12345  '));
  assert.equal(task.prompt, `${problem}\n\n${INSTRUCTION}`);
  assert.equal(task.answer, '12345');
  assert.equal(task.metadata.category, 'category-only');
  assert.equal(task.metadata.subcategory, 'subcategory-only');
  assert.equal(task.metadata.source_text, 'source-only');
  for (const value of ['12345', 'category-only', 'subcategory-only', 'source-only']) {
    assert.equal(task.prompt.includes(value), false);
  }
});

test('conversion rejects only explicit leakage, empty inputs and duplicate ids', () => {
  for (const problem of ['The answer is 12345.', 'Find x.\nFINAL: 12345',
    'Find x.\n## Solution\nWe obtain 12345.', 'Find x.\nAnswer: 12345',
    'Find x.\n\\section{Solution}\n12345']) {
    assert.throws(() => createTasks(fixture(problem, '12345')), /Explicit answer leakage/);
  }
  assert.throws(() => createTasks(fixture('The answer is alpha\nbeta.', 'alpha beta')), /Explicit answer leakage/);
  assert.equal(createTasks(fixture('What divides 12345?', '12345')).length, 1);
  assert.equal(createTasks(fixture('Given $x^2$, find x.', '$x^2$')).length, 1);
  const [flagged] = createTasks(fixture('Given abcdefgh, solve for x.', 'abcdefgh'));
  assert.equal(flagged.metadata.answer_in_prompt, true);
  assert.equal(flagged.metadata.review_note, REVIEW_NOTE);
  assert.throws(() => createTasks(fixture(' \n ', '42')), /Empty prompt or answer/);
  assert.throws(() => createTasks(fixture('Find x.', '  ')), /Empty prompt or answer/);
  const csv = fixture('Find x.', '42');
  assert.throws(() => createTasks(`${csv}\n${csv.split('\n')[1]}`), /duplicate Problem ID/);
});

test('baselines is the exact requested object and contains no numeric scores', () => {
  assert.deepEqual(baselines, BASELINES);
  assert.equal(baselines.model, 'opencode-go/deepseek-v4.1-flash');
  assert.deepEqual(baselines.external, []);
  assert.equal(Object.values(baselines).some((value) => typeof value === 'number'), false);
  assert.match(baselines.note, /No published score for this exact model\/version was found/);
});

test('all generated JSON uses deterministic two-space formatting and a trailing newline', async () => {
  for (const [name, data] of [
    ['tasks.json', tasks], ['pilot.json', pilot], ['baselines.json', baselines],
    ['repairs.json', repairs], ['review.json', review],
  ]) {
    assert.equal(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'), json(data));
  }
});

test('one authorized in-memory repair; 400 rows, non-empty answers, six repaired fields and 399 unchanged rows', async () => {
  const source = await readFile(DEFAULT_CSV);
  assert.equal(sha256(source), CSV_SHA256);
  const original = source.toString('utf8');
  const result = repairCSV(original);
  assert.equal(result.unchangedRows, 399);
  assert.deepEqual(result.repairs, repairs);
  assert.equal(repairs.schema, 'math-bench-repairs/v1');
  assert.equal(repairs.source_csv_sha256, CSV_SHA256);
  assert.equal(repairs.entries.length, 1);
  const [entry] = repairs.entries;
  assert.equal(entry.id, REPAIR_ID);
  assert.deepEqual(entry.line_range, [150, 154]);
  assert.equal(entry.repaired_excerpt, entry.original_excerpt.replace('\\]\n,', '\\]"\n,'));
  assert.equal(result.csv, original.replace(entry.original_excerpt, entry.repaired_excerpt));
  assert.equal(result.csv.length, original.length + 1);
  const rows = parseCSV(result.csv, { repairedRowContinuation: true }).slice(1);
  assert.equal(rows.length, 400);
  assert.ok(rows.every((row) => row.length === 6 && row[2].trim()));
  assert.deepEqual(rows.find((row) => row[0] === REPAIR_ID), REPAIRED_ROW);
  assert.equal(REPAIRED_ROW[1], String.raw`Find all functions $Y: \mathbb{R} \backslash\{0\} \rightarrow \mathbb{R}$ such that for any non-zero real numbers $a, b$ with $ab \neq -1$, the following equation holds:
\[
a Y\left(a+\frac{1}{b}\right)+b Y(b)+\frac{a}{b}=b Y\left(b+\frac{1}{a}\right)+a Y(a)+\frac{b}{a}
\]`);
  assert.deepEqual(REPAIRED_ROW.slice(2), [
    String.raw`$Y(x)=A+\frac{B}{x}-x$`, 'Algebra', 'Functional Equation', 'Iran 2002',
  ]);
  // A strict whole-file "before" parse is impossible; exclude only the bad
  // record and parse the remaining original bytes for a 399-row comparison.
  const before = parseCSV(original.replace(`${entry.original_excerpt}\n`, '')).slice(1);
  assert.equal(before.length, 399);
  assert.deepEqual(rows.filter((row) => row[0] !== REPAIR_ID), before);
  assert.deepEqual(await readFile(DEFAULT_CSV), source);
});

test('regenerating from the pinned source reproduces all tasks and pilot in order', async () => {
  const original = await readFile(DEFAULT_CSV, 'utf8');
  const first = repairCSV(original);
  const second = repairCSV(original);
  assert.deepEqual(first, second);
  const rebuilt = createTasks(first.csv, { repairedRowContinuation: true });
  assert.deepEqual(rebuilt, tasks);
  assert.equal(json(rebuilt), await readFile(new URL('../tasks.json', import.meta.url), 'utf8'));
  assert.equal(json(selectPilot(rebuilt)), await readFile(new URL('../pilot.json', import.meta.url), 'utf8'));
});
