import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildPublicInputSnapshot, stagePublicInput, writeStagedSnapshot } from '../arxiv-snapshot.mjs';
import { createArxivSnapshotTools, runArxivSnapshotControls } from '../arxiv-snapshot-runtime.mjs';

const PATHS = ['formal-statement.lean', 'problem.md'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const task = Object.freeze({
  id: 'arxivlean-01', title: 'EXCLUDED_TITLE_MARKER', abstract: 'EXCLUDED_ABSTRACT_MARKER',
  arxiv_id: 'EXCLUDED_ID_MARKER', answer: 'EVALUATOR_SECRET_PROOF_MARKER',
  problem: 'Public graph phrase with α.\r\nSecond public line.\r',
  formal_statement: 'import Mathlib\r\n\r\ndef publicStatement : Prop := True\r\n',
});
const normalized = text => text.replace(/\r\n?/g, '\n');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'arxiv-snapshot-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function staged(t) {
  const root = fixture(t), stage = stagePublicInput(task, { root: join(root, 'inputs') });
  const snapshot = buildPublicInputSnapshot(stage);
  const written = writeStagedSnapshot(snapshot, { out: join(root, 'runtime') });
  const runtime = condition => createArxivSnapshotTools({ ...runtimeConfig(written), condition });
  return { root, stage, snapshot, written, runtime };
}
const runtimeConfig = written => ({ snapshotRoot: written.snapshotRoot, expectedManifestHash: written.expectedManifestHash });
function closed(action, code) {
  assert.throws(action, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(Object.keys(error), ['code']);
    return true;
  });
}

test('stage/build/round-trip contains exactly the two public inputs and deterministic metadata', t => {
  const { stage, snapshot, written, runtime } = staged(t);
  assert.deepEqual(readdirSync(stage.directory).sort(), PATHS);
  assert.deepEqual(readdirSync(written.snapshotRoot).sort(), [...PATHS, 'manifest.json'].sort());
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.files) && Object.isFrozen(snapshot.policy));
  assert.deepEqual(Object.keys(snapshot), ['schema', 'taskId', 'files', 'manifestSha256', 'policy']);
  const expectedTexts = [normalized(task.formal_statement), normalized(task.problem)];
  for (const [i, file] of snapshot.files.entries()) {
    assert.ok(Object.isFrozen(file));
    assert.equal(file.text, expectedTexts[i]);
    assert.equal(file.bytes, Buffer.byteLength(expectedTexts[i]));
    assert.equal(file.sha256, hash(expectedTexts[i]));
    assert.equal(snapshot.policy.read(file.path), file.text);
    assert.deepEqual(readFileSync(join(written.snapshotRoot, file.path)), Buffer.from(file.text));
    if (process.platform !== 'win32') assert.equal(lstatSync(join(stage.directory, file.path)).mode & 0o777, 0o600);
  }
  const manifestBytes = readFileSync(join(written.snapshotRoot, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.deepEqual(Object.keys(manifest), ['schema', 'taskId', 'files', 'manifestSha256']);
  assert.equal(hash(JSON.stringify(manifest.files)), snapshot.manifestSha256);
  assert.equal(hash(manifestBytes), written.expectedManifestHash);
  for (const file of manifest.files) assert.deepEqual(Object.keys(file), ['path', 'bytes', 'sha256']);
  for (const secret of [task.title, task.abstract, task.arxiv_id, task.answer]) {
    assert.ok(!JSON.stringify(snapshot).includes(secret));
    for (const path of readdirSync(written.snapshotRoot)) assert.ok(!readFileSync(join(written.snapshotRoot, path), 'utf8').includes(secret));
  }
  assert.ok(!manifestBytes.includes(Buffer.from(expectedTexts[0])));
  assert.ok(!manifestBytes.includes(Buffer.from(expectedTexts[1])));
  assert.equal(snapshot.provenance, undefined);
  const tools = runtime('plugin-on');
  assert.equal(tools.canAuthorizeModelRun, false);
  assert.equal(tools.admission, 'not_assessed');
  assert.equal(tools.taskId, task.id);
  assert.equal(tools.manifestSha256, snapshot.manifestSha256);
  assert.ok(Object.isFrozen(tools) && Object.isFrozen(tools.tools));
  assert.equal(tools.tools.math_manuscript.handler({ path: 'formal-statement.lean' }).excerpt.text, expectedTexts[0]);
});

test('two independent builds and writes are byte-for-byte deterministic', t => {
  const root = fixture(t);
  const builds = [1, 2].map(n => {
    const stage = stagePublicInput(task, { root: join(root, `inputs-${n}`) });
    const snapshot = buildPublicInputSnapshot(stage);
    const written = writeStagedSnapshot(snapshot, { out: join(root, `runtime-${n}`) });
    return { snapshot, written };
  });
  assert.deepEqual(builds[0].snapshot.files, builds[1].snapshot.files);
  assert.equal(builds[0].snapshot.manifestSha256, builds[1].snapshot.manifestSha256);
  assert.equal(builds[0].written.expectedManifestHash, builds[1].written.expectedManifestHash);
  for (const name of [...PATHS, 'manifest.json']) assert.deepEqual(
    readFileSync(join(builds[0].written.snapshotRoot, name)), readFileSync(join(builds[1].written.snapshotRoot, name)));
});

test('stage rejects invalid ids, text, and roots without writing', t => {
  const root = fixture(t);
  for (const id of ['', 'arxivlean-1', 'arxivlean-001', 'arxivlean-01/..', 'ARXIVLEAN-01']) {
    closed(() => stagePublicInput({ ...task, id }, { root }), 'arxiv_snapshot_invalid');
  }
  for (const field of ['problem', 'formal_statement']) for (const value of ['', '  ', null, 1, 'text\0hidden']) {
    closed(() => stagePublicInput({ ...task, [field]: value }, { root }), 'arxiv_snapshot_invalid');
  }
  for (const invalid of ['relative', '', `${root}\0`, undefined]) {
    closed(() => stagePublicInput(task, { root: invalid }), 'arxiv_snapshot_invalid');
  }
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));
  closed(() => stagePublicInput(task, { root: repository }), 'arxiv_snapshot_unsafe');
  closed(() => stagePublicInput(task, { root: join(repository, 'never-create') }), 'arxiv_snapshot_unsafe');
  closed(() => stagePublicInput({ ...task, problem: '\ud800' }, { root }), 'arxiv_snapshot_binary');
  assert.deepEqual(readdirSync(root), []);
});

test('stage and write refuse existing directories, even empty, or existing files', t => {
  const { root, stage, snapshot, written } = staged(t);
  closed(() => stagePublicInput(task, { root: stage.root }), 'arxiv_snapshot_exists');
  closed(() => writeStagedSnapshot(snapshot, { out: written.snapshotRoot }), 'arxiv_snapshot_exists');
  const emptyRoot = join(root, 'empty');
  mkdirSync(join(emptyRoot, task.id), { recursive: true });
  closed(() => stagePublicInput(task, { root: emptyRoot }), 'arxiv_snapshot_exists');
  const fileRoot = join(root, 'file');
  mkdirSync(fileRoot);
  writeFileSync(join(fileRoot, task.id), '');
  closed(() => stagePublicInput(task, { root: fileRoot }), 'arxiv_snapshot_exists');
  const emptyOut = join(root, 'empty-out');
  mkdirSync(emptyOut);
  closed(() => writeStagedSnapshot(snapshot, { out: emptyOut }), 'arxiv_snapshot_exists');
});

for (const extra of ['proof.lean', 'paper.pdf', 'transcript.json', 'old-cache']) {
  test(`extra entry ${extra} fails closed in build, runtime construction and every existing handler`, t => {
    const { stage, written, runtime } = staged(t);
    const tools = runtime('plugin-on');
    writeFileSync(join(stage.directory, extra), 'EXCLUDED BYTES');
    closed(() => buildPublicInputSnapshot(stage), 'arxiv_snapshot_unexpected_file');
    writeFileSync(join(written.snapshotRoot, extra), 'EXCLUDED BYTES');
    closed(() => runtime('plugin-on'), 'arxiv_snapshot_unexpected_file');
    for (const tool of Object.values(tools.tools)) closed(() => tool.handler({}), 'arxiv_snapshot_unexpected_file');
  });
}

test('build verifies all hashes before UTF-8/NUL validation', t => {
  const { stage } = staged(t);
  writeFileSync(join(stage.directory, PATHS[0]), Buffer.from([0xff, 0]));
  closed(() => buildPublicInputSnapshot(stage), 'arxiv_snapshot_hash_mismatch');
  const expected = { ...stage.expected, [PATHS[0]]: hash(Buffer.from([0xff, 0])), [PATHS[1]]: '0'.repeat(64) };
  closed(() => buildPublicInputSnapshot({ ...stage, expected }), 'arxiv_snapshot_hash_mismatch');
  expected[PATHS[1]] = stage.expected[PATHS[1]];
  closed(() => buildPublicInputSnapshot({ ...stage, expected }), 'arxiv_snapshot_binary');
  for (const bytes of [Buffer.from('text\0hidden'), Buffer.from([0xc3, 0x28])]) {
    writeFileSync(join(stage.directory, PATHS[0]), bytes);
    expected[PATHS[0]] = hash(bytes);
    closed(() => buildPublicInputSnapshot({ ...stage, expected }), 'arxiv_snapshot_binary');
  }
});

test('build requires exact expected hashes and both files', t => {
  const { stage } = staged(t);
  for (const expected of [undefined, {}, { ...stage.expected, extra: '0'.repeat(64) },
    { ...stage.expected, 'problem.md': 'not-a-hash' }]) {
    closed(() => buildPublicInputSnapshot({ ...stage, expected }), 'arxiv_snapshot_invalid');
  }
  unlinkSync(join(stage.directory, 'problem.md'));
  closed(() => buildPublicInputSnapshot(stage), 'arxiv_snapshot_missing');
});

test('runtime requires manifest and trusted raw-manifest hash', t => {
  const { written, runtime } = staged(t);
  closed(() => createArxivSnapshotTools({ snapshotRoot: written.snapshotRoot, condition: 'plugin-on' }), 'arxiv_snapshot_invalid');
  closed(() => createArxivSnapshotTools({ ...runtimeConfig(written), condition: 'plugin-on', expectedManifestHash: '0'.repeat(64) }),
    'arxiv_snapshot_hash_mismatch');
  const tools = runtime('plugin-on');
  unlinkSync(join(written.snapshotRoot, 'manifest.json'));
  closed(() => runtime('plugin-on'), 'arxiv_snapshot_missing');
  for (const tool of Object.values(tools.tools)) closed(() => tool.handler({}), 'arxiv_snapshot_missing');
});

test('mutated source is rejected at construction and by every handler after construction', t => {
  const { written, runtime } = staged(t);
  const tools = runtime('plugin-on');
  writeFileSync(join(written.snapshotRoot, 'problem.md'), 'changed');
  closed(() => runtime('plugin-on'), 'arxiv_snapshot_hash_mismatch');
  for (const tool of Object.values(tools.tools)) closed(() => tool.handler({}), 'arxiv_snapshot_hash_mismatch');
});

test('manifest mutation is rejected by every handler', t => {
  const { written, runtime } = staged(t);
  const tools = runtime('plugin-on');
  writeFileSync(join(written.snapshotRoot, 'manifest.json'), '{}');
  for (const tool of Object.values(tools.tools)) closed(() => tool.handler({}), 'arxiv_snapshot_hash_mismatch');
});

test('runtime validates canonical metadata, rejects answer fields and invalid UTF-8 after hash verification', t => {
  const { written } = staged(t), path = join(written.snapshotRoot, 'manifest.json');
  const original = JSON.parse(readFileSync(path));
  const attempt = (manifest, code) => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(path, bytes);
    closed(() => createArxivSnapshotTools({
      snapshotRoot: written.snapshotRoot, expectedManifestHash: hash(bytes), condition: 'plugin-on',
    }), code);
  };
  attempt({ ...original, answer: 'excluded' }, 'arxiv_snapshot_invalid');
  attempt({ ...original, manifestSha256: '0'.repeat(64) }, 'arxiv_snapshot_hash_mismatch');
  const invalidPath = structuredClone(original);
  invalidPath.files[0].path = 'proof.lean';
  attempt(invalidPath, 'arxiv_snapshot_unsafe');
  const badSize = structuredClone(original);
  badSize.files[0].bytes++;
  badSize.manifestSha256 = hash(JSON.stringify(badSize.files));
  attempt(badSize, 'arxiv_snapshot_hash_mismatch');
  const binary = Buffer.from([0xff]), binaryManifest = structuredClone(original);
  writeFileSync(join(written.snapshotRoot, PATHS[0]), binary);
  binaryManifest.files[0].bytes = binary.length;
  binaryManifest.files[0].sha256 = hash(binary);
  binaryManifest.manifestSha256 = hash(JSON.stringify(binaryManifest.files));
  attempt(binaryManifest, 'arxiv_snapshot_binary');
});

const unsafePaths = [
  'paper.tex', 'paper.pdf', 'proof.lean', 'ComparatorChallenges/example.json',
  '/problem.md', 'C:/problem.md', 'C:\\problem.md', '\\\\host\\share\\problem.md',
  'folder\\problem.md', '..', '../problem.md', './problem.md', 'folder/../problem.md',
  'problem.md\0', '*.md', 'problem.?d', '[problem].md', '{problem,proof}.md',
  'Problem.md', 'PROBLEM.MD', 'Formal-statement.lean',
  'problem.md.', 'problem.md ', 'formal-statement.lean.', 'formal-statement.lean ',
  'problem.md:stream', 'problem.md/', 'import Mathlib', 'IO.Process.spawn',
  '.cache/index.json', 'source-index.json', 'transcript.json', '',
];
test('every unsafe path class fails without bytes, across generic and ON path handlers', t => {
  const { runtime } = staged(t), tools = runtime('plugin-on').tools;
  for (const path of unsafePaths) {
    for (const name of ['read_source', 'math_manuscript']) {
      closed(() => tools[name].handler({ path }), 'arxiv_snapshot_unsafe');
    }
    closed(() => tools.search_source.handler({ path, query: 'public' }), 'arxiv_snapshot_unsafe');
  }
});

for (const condition of ['plugin-off', 'plugin-on']) {
  test(`all six negative and four positive controls pass for ${condition}, restoring source bytes`, t => {
    const { written, runtime } = staged(t), tools = runtime(condition);
    const before = PATHS.map(path => readFileSync(join(written.snapshotRoot, path)));
    const result = runArxivSnapshotControls(tools);
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(result.controls.length, 10);
    assert.deepEqual(result.controls.map(control => control.name), [
      'excluded_source_read', 'excluded_sentinel_search', 'pdf_read_request',
      'old_index_cache_transcript_read', 'mutated_excerpt_read', 'process_or_lean_import_request',
      'list_exact_two_sources', 'read_exact_first_line', 'search_public_phrase', 'math_search_formal_task',
    ]);
    for (const control of result.controls) {
      assert.deepEqual(Object.keys(control), ['name', 'expected', 'observed', 'pass']);
      assert.equal(control.pass, true);
    }
    PATHS.forEach((path, i) => assert.deepEqual(readFileSync(join(written.snapshotRoot, path)), before[i]));
    assert.equal(tools.tools.list_sources.handler().sources.length, 2);
  });
}

test('conditions have identical generic definitions and bytes, with ON-only BM25 and manuscript tools', t => {
  const { runtime } = staged(t), off = runtime('plugin-off'), on = runtime('plugin-on');
  assert.deepEqual(off.inventory, ['list_sources', 'read_source', 'search_source']);
  assert.deepEqual(on.inventory, ['list_sources', 'math_manuscript', 'math_search', 'read_source', 'search_source']);
  assert.equal(off.tools.read_pdf, undefined);
  assert.equal(on.tools.read_pdf, undefined);
  for (const name of off.inventory) {
    const { handler: offHandler, ...offDefinition } = off.tools[name];
    const { handler: onHandler, ...onDefinition } = on.tools[name];
    assert.deepEqual(offDefinition, onDefinition);
    const args = name === 'read_source' ? { path: 'problem.md' } : name === 'search_source' ? { query: 'Public graph phrase' } : {};
    assert.deepEqual(offHandler(args), onHandler(args));
  }
  for (const path of PATHS) {
    const offRead = off.tools.read_source.handler({ path });
    const onRead = on.tools.read_source.handler({ path });
    assert.deepEqual(offRead, onRead);
    assert.equal(offRead.lines.map(line => line.text).join('\n'), on.tools.math_manuscript.handler({ path }).excerpt.text);
  }
  assert.equal(on.tools.math_search.handler({ query: 'publicStatement' }).results[0].taskId, task.id);
  assert.equal(on.tools.math_manuscript.handler({ query: 'publicStatement' }).source.path, 'formal-statement.lean');
  assert.deepEqual(on.tools.math_search.handler({ query: task.answer }).results, []);
  assert.deepEqual(on.tools.search_source.handler({ query: task.answer }).matches, []);
});

test('call budget is shared, and invalid requests cannot bypass it', t => {
  const { written } = staged(t);
  const runtime = createArxivSnapshotTools({ ...runtimeConfig(written), condition: 'plugin-on', callBudget: 1 });
  closed(() => runtime.tools.read_source.handler({ path: 'proof.lean' }), 'arxiv_snapshot_unsafe');
  closed(() => runtime.tools.list_sources.handler(), 'arxiv_snapshot_invalid');
});

test('write validates the snapshot before creating output', t => {
  const { root, snapshot } = staged(t);
  const out = join(root, 'invalid-output');
  closed(() => writeStagedSnapshot({ ...snapshot, manifestSha256: '0'.repeat(64) }, { out }), 'arxiv_snapshot_hash_mismatch');
  const files = snapshot.files.map(file => ({ ...file, text: `${file.text}changed` }));
  closed(() => writeStagedSnapshot({ ...snapshot, files }, { out }), 'arxiv_snapshot_hash_mismatch');
  assert.ok(!readdirSync(dirname(out)).includes('invalid-output'));
});
