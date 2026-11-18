import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePack, validatePack, sha256 } from '../pack.mjs';
import { parseArgs, validateOutDir, classify, run } from '../run.mjs';

const base = fileURLToPath(new URL('./', import.meta.url));
const config = name => ({
  challenge_module: `ComparatorChallenges.${name}`,
  solution_module: `Solutions.${name}`,
  theorem_names: [`${name}.main`],
  definition_names: [],
  permitted_axioms: ['propext'],
  enable_nanoda: false,
});
function fixture(t, count = 12) {
  // All temporary writes remain inside the assigned new directory.
  const root = fs.mkdtempSync(path.join(base, '.fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus');
  const directory = path.join(corpus, 'lean', 'ComparatorChallenges');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(repo);
  for (let i = 0; i < count; i++) {
    const name = `Task${i}`;
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(config(name)));
  }
  return { root, corpus, directory, repo };
}
function options(f) {
  const pack = path.join(f.root, 'pack.json');
  fs.writeFileSync(pack, JSON.stringify(generatePack(f.corpus)));
  return { execute: true, corpus: f.corpus, out: path.join(f.root, 'output'), pack, limit: 8, timeoutMs: 600_000 };
}

test('hermetic deterministic eight-task selection uses filename hashes', t => {
  const f = fixture(t);
  const first = generatePack(f.corpus);
  assert.deepEqual(first, generatePack(f.corpus));
  const expected = fs.readdirSync(f.directory).sort((a, b) => sha256(a).localeCompare(sha256(b))).slice(0, 8);
  assert.deepEqual(first.tasks.map(x => path.basename(x.challenge_path)), expected);
  assert.equal(first.retrieval_assisted, true);
  for (const task of first.tasks) {
    assert.equal(task.grading.task_id, task.id);
    assert.equal(task.metadata.license, 'verify');
    assert.ok(!task.prompt.includes('Solutions.'));
  }
});
test('explicit short descriptions rank before filename fallback', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'Task9.json'), JSON.stringify({ ...config('Task9'), description: 'True' }));
  assert.equal(generatePack(f.corpus).tasks[0].id, 'comparator-Task9');
});
test('hash binds exact config bytes and grading binding', t => {
  const f = fixture(t);
  const pack = generatePack(f.corpus);
  const task = pack.tasks[0];
  assert.equal(task.challenge_sha256, sha256(fs.readFileSync(path.join(f.corpus, task.challenge_path))));
  task.grading.challenge_sha256 = '0'.repeat(64);
  assert.throws(() => validatePack(pack, f.corpus), /Hash mismatch/);
});
test('changed config bytes are rejected', t => {
  const f = fixture(t);
  const pack = generatePack(f.corpus);
  fs.appendFileSync(path.join(f.corpus, pack.tasks[0].challenge_path), '\n');
  assert.throws(() => validatePack(pack, f.corpus), /Hash mismatch/);
});
test('duplicate task ids and paths are rejected', t => {
  const f = fixture(t);
  const pack = generatePack(f.corpus);
  pack.tasks.push(structuredClone(pack.tasks[0]));
  assert.throws(() => validatePack(pack, f.corpus), /Duplicate/);
});
test('missing configs and insufficient corpus are rejected', t => {
  const f = fixture(t, 8);
  const pack = generatePack(f.corpus);
  fs.unlinkSync(path.join(f.corpus, pack.tasks[0].challenge_path));
  assert.throws(() => validatePack(pack, f.corpus), /ENOENT/);
  assert.throws(() => generatePack(f.corpus), /Missing configs/);
});
test('all configs are validated, even unselected ones', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'Invalid.json'), '{"theorem_names":[]}');
  assert.throws(() => generatePack(f.corpus), /Invalid challenge_module/);
});
test('proof-bearing config prompts are refused', t => {
  const f = fixture(t);
  for (const prompt of ['theorem answer : True := by trivial', 'by exact True.intro', '```lean\nby simp\n```', 'begin exact True.intro end', 'True.intro', 'by trivial']) {
    fs.writeFileSync(path.join(f.directory, 'Task0.json'), JSON.stringify({ ...config('Task0'), prompt }));
    assert.throws(() => generatePack(f.corpus), /proof-bearing/);
  }
});
test('tampered pack prompts and path traversal are refused', t => {
  const f = fixture(t);
  const pack = generatePack(f.corpus);
  const changed = structuredClone(pack);
  changed.tasks[0].prompt += ' := by trivial';
  assert.throws(() => validatePack(changed, f.corpus), /proof-bearing/);
  pack.tasks[0].challenge_path = '../outside.json';
  assert.throws(() => validatePack(pack, f.corpus), /Invalid challenge path/);
});
test('runner arguments require explicit absolute paths and bounded numbers', t => {
  const f = fixture(t);
  const args = ['--corpus', f.corpus, '--out', path.join(f.root, 'out')];
  assert.equal(parseArgs(args).execute, false);
  assert.equal(parseArgs(args).timeoutMs, 600_000);
  assert.equal(parseArgs([...args, '--execute', '--limit', '2']).limit, 2);
  for (const extra of [['--timeout', '0'], ['--timeout', '1801'], ['--limit', '9'], ['--limit', 'NaN'], ['--other'], ['--execute', '--execute'], ['--pack']]) {
    assert.throws(() => parseArgs([...args, ...extra]));
  }
  assert.throws(() => parseArgs(['--corpus', '.', '--out', f.root]), /absolute/);
  assert.throws(() => parseArgs(['--corpus', f.corpus, '--out', 'relative']), /absolute/);
});
test('runner refuses relative, inside-repo, inside-corpus, file, and nonempty output dirs', t => {
  const f = fixture(t);
  const settings = { repo: f.repo, corpus: f.corpus };
  assert.throws(() => validateOutDir('relative', settings), /absolute/);
  for (const dir of [f.repo, path.join(f.repo, 'new'), path.join(f.corpus, 'new')]) {
    assert.throws(() => validateOutDir(dir, settings), /outside/);
  }
  assert.throws(() => validateOutDir(f.root, settings), /new or empty/);
  const filename = path.join(f.root, 'file');
  fs.writeFileSync(filename, 'x');
  assert.throws(() => validateOutDir(filename, settings), /new or empty/);
  const empty = path.join(f.root, 'empty');
  fs.mkdirSync(empty);
  assert.equal(validateOutDir(empty, settings), fs.realpathSync(empty));
});
test('runner refuses junction/symlink output alias into repo', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateOutDir(path.join(alias, 'new'), { repo: f.repo }), /outside/);
});
test('classification requires Comparator protocol exit, never compiler/stdout success', () => {
  const protocol = 'comparator-process-exit/v1';
  assert.equal(classify({ protocol, exitCode: 0 }), 'accepted');
  assert.equal(classify({ protocol, exitCode: 1, stdout: 'Your solution is okay!' }), 'rejected');
  assert.equal(classify({ exitCode: 0, stdout: 'COMPARATOR_DOCKER_OK' }), 'unavailable');
  assert.equal(classify({ protocol: 'lean-compile', exitCode: 0 }), 'unavailable');
  assert.equal(classify({ protocol, exitCode: 0, error: 'spawn failed' }), 'unavailable');
  assert.equal(classify({ protocol, exitCode: null, signal: 'SIGKILL' }), 'unavailable');
  assert.equal(classify({ timedOut: true, error: 'killed' }), 'timeout');
});
test('without --execute no transport or writes occur', async t => {
  const f = fixture(t);
  const result = await run({ execute: false }, { invoke: () => assert.fail(), checkAvailable: () => assert.fail() });
  assert.equal(result.status, 'not_run');
  assert.equal(fs.existsSync(path.join(f.root, 'output')), false);
});
test('fake transport runs sequentially and records protocol results and cleanup', async t => {
  const f = fixture(t);
  const opts = options(f);
  const outcomes = [
    { exitCode: 0 }, { exitCode: 1 }, { unavailable: true }, { timedOut: true },
  ];
  opts.limit = 4;
  let active = 0, calls = 0;
  const result = await run(opts, {
    repo: f.repo, checkAvailable: () => null,
    invoke: async request => {
      assert.equal(++active, 1);
      assert.equal(request.timeoutMs, 600_000);
      await Promise.resolve();
      active--;
      return { protocol: 'comparator-process-exit/v1', stdout: 'captured', stderr: '', cleanup: { complete: true }, ...outcomes[calls++] };
    },
  });
  assert.deepEqual(result.results.map(x => x.status), ['accepted', 'rejected', 'unavailable', 'timeout']);
  assert.equal(result.retrieval_assisted, true);
  assert.equal(calls, 4);
  for (const row of result.results) {
    assert.equal(row.challenge_sha256, row.post_challenge_sha256);
    assert.equal(row.cleanup.complete, true);
    assert.ok(row.duration_ms >= 0);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(opts.out, 'results.json'), 'utf8')), result);
});
test('missing runtime is unavailable, not rejection, and transport is not invoked', async t => {
  const f = fixture(t);
  const opts = { ...options(f), limit: 1 };
  const result = await run(opts, { repo: f.repo, checkAvailable: () => 'Missing comparator', invoke: () => assert.fail() });
  assert.equal(result.results[0].status, 'unavailable');
  assert.equal(result.results[0].reason, 'Missing comparator');
});
test('hash mismatch prevents transport and output creation', async t => {
  const f = fixture(t);
  const opts = options(f);
  const pack = JSON.parse(fs.readFileSync(opts.pack));
  fs.appendFileSync(path.join(f.corpus, pack.tasks[0].challenge_path), ' ');
  await assert.rejects(run(opts, { repo: f.repo, checkAvailable: () => assert.fail(), invoke: () => assert.fail() }), /Hash mismatch/);
  assert.equal(fs.existsSync(opts.out), false);
});
