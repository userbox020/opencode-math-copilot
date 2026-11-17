import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExcerptSnapshot, assertNoAnswerBearing } from '../excerpt-snapshots.mjs';
import { assertLogicalPath, validateManifest } from '../mask-policy.mjs';

const PRIVATE = 'EXCLUDED_PROOF_SENTINEL';
const PUBLIC = 'Approved α background NEEDLE.';
const TEXT = `${PUBLIC}\r\n${PRIVATE}\rReviewed lemma.\nUnapproved derivation.`;
const APPROVED = `${PUBLIC}\nReviewed lemma.`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const CODES = new Set([
  'excerpt_source_unsafe', 'excerpt_source_missing', 'excerpt_source_binary',
  'excerpt_source_hash_mismatch', 'excerpt_span_invalid', 'excerpt_span_overlap',
  'excerpt_span_unapproved', 'excerpt_empty', 'excerpt_arguments_invalid',
  'mask_path_not_approved', 'mask_path_unsafe', 'mask_manifest_hash_mismatch', 'mask_sentinel_present',
]);
const span = (startLine, endLine = startLine, approval = 'reviewed-span') => ({
  startLine, endLine, approval,
});

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'excerpt-snapshots-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const corpusRoot = join(base, 'corpus');
  mkdirSync(join(corpusRoot, 'notes'), { recursive: true });
  writeFileSync(join(corpusRoot, 'notes', 'source.txt'), TEXT);
  writeFileSync(join(corpusRoot, 'unapproved.txt'), PRIVATE);
  const options = {
    taskId: 'fixture-task.1', corpusRoot,
    sources: [{
      path: 'notes/source.txt', expectedSha256: hash(TEXT),
      spans: [span(1, 1, 'public'), span(3)],
    }],
  };
  return { base, options, source: options.sources[0] };
}

function rejectsClosed(fn, code) {
  assert.throws(fn, error => {
    assert.ok(CODES.has(error.code));
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(Object.keys(error), ['code']);
    for (const bytes of [TEXT, PUBLIC, PRIVATE, 'Reviewed lemma.', 'Unapproved derivation.']) {
      assert.ok(!String(error).includes(bytes));
      assert.ok(!JSON.stringify(error).includes(bytes));
    }
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('valid build exposes exactly approved lines through manifest, reads and search', t => {
  const { options } = fixture(t);
  const snapshot = buildExcerptSnapshot(options);
  assert.equal(snapshot.taskId, options.taskId);
  assert.equal(snapshot.manifest, snapshot.policy.manifest);
  assert.deepEqual(snapshot.manifest.files.map(file => file.logicalPath), ['notes/source.txt']);
  assert.equal(snapshot.policy.read('notes/source.txt'), APPROVED);
  assert.equal(Buffer.from(snapshot.manifest.files[0].bytes).toString('utf8'), APPROVED);
  assert.equal(snapshot.manifest.files[0].sha256, hash(APPROVED));
  assert.deepEqual(snapshot.policy.search('needle'), [
    { logicalPath: 'notes/source.txt', line: 1, preview: PUBLIC },
  ]);
  assert.deepEqual(snapshot.policy.search('Unapproved'), []);
  assert.deepEqual(snapshot.policy.search(PRIVATE), []);
  assert.equal(assertNoAnswerBearing(snapshot, [PRIVATE, 'ABSENT_SENTINEL']), 2);
  assert.equal(assertNoAnswerBearing(snapshot, []), 0);
  assert.equal(validateManifest(snapshot.manifest), true);
  rejectsClosed(() => snapshot.policy.read('unapproved.txt'), 'mask_path_not_approved');
});

for (const [index, path] of [
  '../unapproved.txt', '/absolute.txt', 'notes\\source.txt', 'notes/*', 'notes/?',
  'notes/[x]', 'notes/{x}', 'C:/source.txt', 'C:source.txt', 'notes/x:stream',
  'notes/\0source.txt', 'notes/../source.txt', 'notes//source.txt', '.', '', null,
].entries()) {
  test(`unsafe source path ${index + 1} fails closed before content reads`, t => {
    const { options, source } = fixture(t);
    // Even a missing first file must not conceal invalid metadata later in the list.
    options.sources = [{ ...source, path: 'missing.txt' }, { ...source, path }];
    rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_source_unsafe');
  });
}

test('exported logical-path validator retains mask errors', () => {
  assert.equal(assertLogicalPath('notes/source.txt'), undefined);
  rejectsClosed(() => assertLogicalPath('../secret'), 'mask_path_unsafe');
});

test('sentinels in approved content (including joined span boundaries) fail closed', t => {
  const { options, source } = fixture(t);
  source.spans = [span(1, 3)];
  const snapshot = buildExcerptSnapshot(options);
  rejectsClosed(() => assertNoAnswerBearing(snapshot, [PRIVATE]), 'mask_sentinel_present');
  source.spans = [span(1), span(3)];
  rejectsClosed(() => assertNoAnswerBearing(buildExcerptSnapshot(options), [APPROVED]), 'mask_sentinel_present');
});

test('mutated excerpt hashes, bytes and manifest hashes fail closed', t => {
  const { options } = fixture(t);
  for (const mutate of [
    manifest => { manifest.files[0].sha256 = '0'.repeat(64); },
    manifest => { manifest.files[0].bytes[0] ^= 1; },
    manifest => { manifest.manifestSha256 = '0'.repeat(64); },
  ]) {
    const manifest = clone(buildExcerptSnapshot(options).manifest);
    mutate(manifest);
    rejectsClosed(() => validateManifest(manifest), 'mask_manifest_hash_mismatch');
  }
});

for (const [name, bytes] of [
  ['NUL', Buffer.from(`${PUBLIC}\0${PRIVATE}`)],
  ['malformed UTF-8', Buffer.from([0xff, 0xfe, 0x80])],
  ['binary controls', Buffer.from([1, 2, 3])],
]) {
  test(`binary source: ${name}`, t => {
    const { options, source } = fixture(t);
    writeFileSync(join(options.corpusRoot, source.path), bytes);
    source.expectedSha256 = hash(bytes);
    rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_source_binary');
  });
}

test('source hash mismatch rejects before extraction/range checks', t => {
  const { options, source } = fixture(t);
  source.expectedSha256 = '0'.repeat(64);
  source.spans = [span(999)];
  rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_source_hash_mismatch');
});

for (const [name, spans, code] of [
  ['out of range', [span(5)], 'excerpt_span_invalid'],
  ['zero based', [span(0)], 'excerpt_span_invalid'],
  ['reversed', [span(3, 1)], 'excerpt_span_invalid'],
  ['fractional', [span(1.5)], 'excerpt_span_invalid'],
  ['non-integer', [span('1')], 'excerpt_span_invalid'],
  ['overlapping', [span(1, 3), span(3, 4)], 'excerpt_span_overlap'],
  ['duplicate', [span(1), span(1)], 'excerpt_span_overlap'],
  ['unsorted', [span(3), span(1)], 'excerpt_span_invalid'],
  ['unapproved', [span(1, 1, 'unreviewed')], 'excerpt_span_unapproved'],
  ['approval case', [span(1, 1, 'Public')], 'excerpt_span_unapproved'],
  ['approval missing', [{ startLine: 1, endLine: 1 }], 'excerpt_span_unapproved'],
  ['zero spans', [], 'excerpt_span_invalid'],
  ['missing spans', undefined, 'excerpt_span_invalid'],
  ['null span', [null], 'excerpt_span_invalid'],
  ['sparse spans', Array(1), 'excerpt_span_invalid'],
]) {
  test(`span validation: ${name}`, t => {
    const { options, source } = fixture(t);
    source.spans = spans;
    rejectsClosed(() => buildExcerptSnapshot(options), code);
  });
}

test('adjacent spans and exact last line are valid; uppercase source hash accepted', t => {
  const { options, source } = fixture(t);
  source.expectedSha256 = source.expectedSha256.toUpperCase();
  source.spans = [span(3), span(4)];
  assert.equal(buildExcerptSnapshot(options).policy.read(source.path),
    'Reviewed lemma.\nUnapproved derivation.');
});

test('empty or whitespace-only selected text fails closed', t => {
  const { options, source } = fixture(t);
  for (const text of ['', ' \t\n', `${PUBLIC}\n`]) {
    writeFileSync(join(options.corpusRoot, source.path), text);
    source.expectedSha256 = hash(text);
    source.spans = [span(text.startsWith(PUBLIC) ? 2 : 1)];
    rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_empty');
  }
});

test('arguments are validated before filesystem access', t => {
  const { options, source } = fixture(t);
  for (const changes of [
    { taskId: '../task' }, { taskId: '/task' }, { taskId: '' }, { taskId: 1 },
    { taskId: 'task\0id' }, { corpusRoot: '.' }, { corpusRoot: null },
    { sources: [] }, { sources: null }, { sources: [null] }, { sources: Array(1) },
    { sources: [{ ...source, expectedSha256: 'bad' }] },
    { sources: [{ ...source, expectedSha256: null }] },
    { sources: [source, source] },
  ]) {
    rejectsClosed(() => buildExcerptSnapshot({ ...options, ...changes }), 'excerpt_arguments_invalid');
  }
  for (const value of [undefined, null, [], 42]) {
    rejectsClosed(() => buildExcerptSnapshot(value), 'excerpt_arguments_invalid');
  }
});

test('missing sources/roots and non-file sources fail closed', t => {
  const { options, source, base } = fixture(t);
  rejectsClosed(() => buildExcerptSnapshot({ ...options, corpusRoot: join(base, 'missing') }),
    'excerpt_source_missing');
  rejectsClosed(() => buildExcerptSnapshot({ ...options, corpusRoot: join(options.corpusRoot, source.path) }),
    'excerpt_arguments_invalid');
  source.path = 'missing.txt';
  rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_source_missing');
  source.path = 'notes';
  rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_source_unsafe');
});

test('all filesystem containment checks precede any source content read', t => {
  const { options, source } = fixture(t);
  writeFileSync(join(options.corpusRoot, source.path), Buffer.from([0]));
  options.sources.push({ ...source, path: 'missing.txt' });
  rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_source_missing');
});

test('symlink/junction escape into a sibling with the same root prefix is rejected', t => {
  const { options, source, base } = fixture(t);
  const outside = join(base, 'corpus-outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), PRIVATE);
  try {
    symlinkSync(outside, join(options.corpusRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  source.path = 'escape/secret.txt';
  source.expectedSha256 = hash(PRIVATE);
  source.spans = [span(1)];
  rejectsClosed(() => buildExcerptSnapshot(options), 'excerpt_source_unsafe');
});

test('manifest and provenance are deterministic, frozen, detached and omit source text', t => {
  const { options, source } = fixture(t);
  writeFileSync(join(options.corpusRoot, 'second.txt'), 'Public second\nHidden second');
  options.sources.push({
    path: 'second.txt', expectedSha256: hash('Public second\nHidden second'), spans: [span(1)],
  });
  const first = buildExcerptSnapshot(options);
  const second = buildExcerptSnapshot({ ...options, sources: [...options.sources].reverse() });
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.provenance, second.provenance);
  assert.deepEqual(first.provenance[0], {
    path: source.path, sha256: hash(TEXT), spans: source.spans, excerptSha256: hash(APPROVED),
  });
  assert.ok(!JSON.stringify(first.provenance).includes(TEXT));
  assert.ok(!JSON.stringify(first.provenance).includes(PRIVATE));
  assert.ok(!JSON.stringify(first.provenance).includes(PUBLIC));
  for (const value of [first, first.policy, first.manifest, first.provenance,
    ...first.provenance, ...first.provenance.map(item => item.spans),
    ...first.provenance.flatMap(item => item.spans)]) {
    assert.equal(Object.isFrozen(value), true);
  }
  source.spans[0].startLine = 2;
  source.path = 'changed.txt';
  assert.equal(first.policy.read('notes/source.txt'), APPROVED);
  assert.equal(first.provenance[0].spans[0].startLine, 1);
});

test('sentinel helper rejects malformed arguments without leaking content', t => {
  const { options } = fixture(t);
  const snapshot = buildExcerptSnapshot(options);
  for (const sentinels of [null, PRIVATE, [null], ['short'], Array(1), [PRIVATE, 3]]) {
    rejectsClosed(() => assertNoAnswerBearing(snapshot, sentinels), 'excerpt_arguments_invalid');
  }
  for (const invalid of [null, {}, { policy: {} }]) {
    rejectsClosed(() => assertNoAnswerBearing(invalid, [PRIVATE]), 'excerpt_arguments_invalid');
  }
});
