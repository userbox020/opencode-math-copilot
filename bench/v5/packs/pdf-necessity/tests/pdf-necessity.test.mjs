import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readTasks, sha256 } from '../../../external/schema.mjs';
import { buildArtifacts } from '../build.mjs';
import { PACK, verifyPack, verifyTask, extractPage, assertNoLeak, assertUniqueQuote, normalize } from '../verify.mjs';

const tasks = readTasks(path.join(PACK, 'tasks.json')).tasks;
const clone = value => structuredClone(value);

test('ten unique schema-valid tasks from ten distinct released PDFs; deterministic pilot', () => {
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map(task => task.id)).size, 10);
  assert.equal(new Set(tasks.map(task => task.metadata.manuscript_path)).size, 10);
  assert.deepEqual(readTasks(path.join(PACK, 'pilot.json')).tasks, tasks.slice(0, 5));
  for (const task of tasks) {
    assert.equal(task.metadata.kind, 'pdf');
    assert(task.metadata.line >= 3);
    assert(normalize(task.answer).split(' ').length >= 12);
    assert(!task.metadata.manuscript_path.includes('/build/'));
  }
});

test('all prompts avoid full quotes and eight-word leaks, including normalized punctuation/case', () => {
  for (const task of tasks) {
    assertNoLeak(task.prompt, task.answer);
    assert.throws(() => assertNoLeak(`${task.prompt} ${task.answer}`, task.answer), /leaks/);
    const fragment = normalize(task.answer).split(' ').slice(0, 8).join(' ').toUpperCase();
    assert.throws(() => assertNoLeak(`${task.prompt} ${fragment}`, task.answer), /leaks/);
  }
  assert.throws(() => assertNoLeak('ONE, two; three four five six seven eight',
    'One two three four five six seven eight nine ten eleven twelve.'), /eight-word/);
});

test('locators, pages, hashes and unique quotes reverified from real PDFs with cache disabled', async () => {
  process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE = '0';
  const result = await verifyPack();
  assert.equal(result.status, 'passed');
  assert.equal(result.tasks, 10);
  assert.equal(process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE, '1');
});

test('two independent extraction-backed builds are deterministic and match all checked-in artifacts', async () => {
  const first = await buildArtifacts();
  const second = await buildArtifacts();
  assert.deepEqual(first, second);
  for (const [name, content] of Object.entries(first)) {
    assert.equal(content, fs.readFileSync(path.join(PACK, name), 'utf8'), name);
  }
});

test('tampered quote fails even with recomputed evaluator answer and quote hash', async () => {
  const task = clone(tasks[0]);
  task.answer += ' Fabricated continuation that is not part of the extracted sentence.';
  task.grading.answer = task.answer;
  task.metadata.quote_sha256 = sha256(task.answer);
  await assert.rejects(verifyTask(task), /quote absent or nonunique/);
});

test('tampered real page fails even with consistent prompt and section locators', async () => {
  const task = clone(tasks[0]);
  task.prompt = task.prompt.replace('physical page 3', 'physical page 4');
  task.metadata.line = 4;
  task.metadata.section = 'physical page 4';
  await assert.rejects(verifyTask(task), /quote absent or nonunique/);
});

test('hash tampering and non-PDF kind fail closed', async () => {
  const hashTask = clone(tasks[0]);
  hashTask.metadata.quote_sha256 = '0'.repeat(64);
  await assert.rejects(verifyTask(hashTask), /quote hash mismatch/);
  const kindTask = clone(tasks[0]);
  kindTask.metadata.kind = 'tex';
  await assert.rejects(verifyTask(kindTask));
  await assert.rejects(verifyTask(tasks[0], { expectedPdfHash: '0'.repeat(64) }), /PDF source hash/);
});

test('no fabricated extraction fallback: missing PDF, source paths and out-of-range pages fail', async () => {
  await assert.rejects(extractPage('preprints/nonexistent-pdf-necessity-source/missing.pdf', 3), /ENOENT/);
  await assert.rejects(extractPage('preprints/example/build/paper.pdf', 3), /released root PDF/);
  await assert.rejects(extractPage(tasks[0].metadata.manuscript_path, 999999), /PDF extraction failed/);
  await assert.rejects(extractPage(tasks[0].metadata.manuscript_path, 0), /invalid physical page/);
});

test('uniqueness guard rejects an in-memory duplicate of a real extracted sentence', async () => {
  const task = tasks[0];
  const extracted = await extractPage(task.metadata.manuscript_path, task.metadata.line);
  assertUniqueQuote(extracted.text, task.answer);
  // Unit-test the guard, not a fake PDF provider or source for generated tasks.
  assert.throws(() => assertUniqueQuote(`${extracted.text}\n${task.answer}`, task.answer), /nonunique/);
  assert.throws(() => assertUniqueQuote(`${extracted.text}\n${normalize(task.answer)}`, task.answer), /nonunique/);
});
