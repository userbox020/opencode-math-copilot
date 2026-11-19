import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPack, packDirectory, serialize } from '../build.mjs';
import { decode, hash, loadPack, promptLeaks, verifyPack, words } from '../verify.mjs';

const pack = loadPack();

test('20 unique schema-v1 tasks, with one task per manuscript', () => {
  assert.equal(pack.tasks.length, 20);
  assert.equal(new Set(pack.tasks.map(task => task.id)).size, 20);
  assert.equal(new Set(pack.tasks.map(task => task.metadata.manuscript_path.split('/')[1])).size, 20);
  for (const task of pack.tasks) {
    assert.equal(task.schema, 'math-bench-task/v1');
    assert.equal(task.metadata.kind, 'text');
    assert.ok(words(task.answer).length >= 12);
  }
});

test('prompts contain neither the quote nor any normalized eight-word window', () => {
  for (const task of pack.tasks) assert.equal(promptLeaks(task.prompt, task.answer), false, task.id);
  const quote = pack.tasks[0].answer;
  const leak = words(quote).slice(0, 8).join(' ').toUpperCase();
  assert.equal(promptLeaks(`Please quote ${leak}`, quote), true);
});

test('all locators, unique quotes, sections and source rehashes verify against the actual corpus', () => {
  assert.equal(verifyPack(pack).status, 'verified');
});

test('at least six manuscript families are represented, including in the deterministic pilot', () => {
  const result = verifyPack(pack);
  assert.ok(result.families.length >= 6);
  assert.ok(new Set(pack.baselines.metadata.files.slice(0, 10).map(file => file.family)).size >= 6);
  assert.deepEqual(pack.pilot, pack.tasks.slice(0, 10));
});

test('build is deterministic on disk and uses two-space JSON plus a trailing newline', () => {
  const before = Object.fromEntries(['tasks', 'pilot', 'baselines'].map(name => [name, readFileSync(path.join(packDirectory, `${name}.json`))]));
  for (let run = 0; run < 2; run++) {
    execFileSync(process.execPath, [path.join(packDirectory, 'build.mjs')], { stdio: 'pipe' });
    const rebuilt = buildPack();
    for (const name of Object.keys(before)) {
      const after = readFileSync(path.join(packDirectory, `${name}.json`));
      assert.equal(hash(after), hash(before[name]));
      assert.equal(after.toString('utf8'), serialize(rebuilt[name]));
    }
  }
});

function rejectsViaCLI(change, expected) {
  const tampered = structuredClone(pack);
  change(tampered);
  const result = spawnSync(process.execPath, [path.join(packDirectory, 'verify.mjs'), '--stdin'], {
    input: JSON.stringify(tampered), encoding: 'utf8'
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, expected);
}

test('verify.mjs fails closed on a tampered quote, even when its hash is updated', () => {
  rejectsViaCLI(tampered => {
    const task = tampered.tasks[0];
    task.answer = task.answer.replace('elementary', 'invented');
    task.grading.answer = task.answer;
    task.metadata.quote_sha256 = hash(task.answer);
    tampered.pilot[0] = structuredClone(task);
  }, /quote absent/);
});

test('verify.mjs fails closed on a tampered line', () => {
  rejectsViaCLI(tampered => { tampered.tasks[0].metadata.line++; }, /line mismatch/);
});

test('verify.mjs fails closed on a tampered quote hash', () => {
  rejectsViaCLI(tampered => { tampered.tasks[0].metadata.quote_sha256 = '0'.repeat(64); }, /quote hash mismatch/);
});

test('verify.mjs fails closed on a tampered source hash', () => {
  rejectsViaCLI(tampered => {
    tampered.baselines.metadata.files[0].source_sha256 = '0'.repeat(64);
    tampered.baselines.metadata.selected_sources_sha256 = hash(JSON.stringify(tampered.baselines.metadata.files));
  }, /source hash mismatch/);
});

test('verify.mjs fails closed on a leaked prompt', () => {
  rejectsViaCLI(tampered => {
    tampered.tasks[0].prompt += ` ${words(tampered.tasks[0].answer).slice(0, 8).join(' ')}`;
  }, /prompt leaks/);
});

test('invalid UTF-8, NUL and lone surrogate quotes are rejected', () => {
  assert.throws(() => decode(Buffer.from([0xc3, 0x28])));
  assert.throws(() => decode(Buffer.from('source\0text')), /NUL/);
  rejectsViaCLI(tampered => { tampered.tasks[0].answer += '\ud800'; }, /Invalid UTF-8/);
  rejectsViaCLI(tampered => { tampered.tasks[0].answer += '\0'; }, /NUL/);
});
