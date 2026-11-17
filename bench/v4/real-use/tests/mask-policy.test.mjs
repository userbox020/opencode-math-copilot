import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMaskPolicy, validateManifest } from '../mask-policy.mjs';

const PRIVATE = 'EXCLUDED_PROOF_SENTINEL';
const TEXT = '  Approved α e\u0301.\r\nBackground NEEDLE.\r\nLiteral *?[x]{y}.\n';
const CODES = new Set([
  'mask_path_unsafe', 'mask_path_not_approved', 'mask_approval_invalid',
  'mask_duplicate_path', 'mask_excerpt_invalid', 'mask_term_invalid',
  'mask_manifest_hash_mismatch', 'mask_sentinel_present',
]);
const excerpt = (changes = {}) => ({ logicalPath: 'notes/001.txt', text: TEXT, approval: 'reviewed-span', ...changes });
const policy = () => createMaskPolicy([excerpt()]);
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function rejectsClosed(fn, code) {
  assert.throws(fn, error => {
    assert.ok(CODES.has(error.code));
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.ok(!error.message.includes(TEXT));
    assert.ok(!error.message.includes(PRIVATE));
    return true;
  });
}

test('reads exact text and hashes exact UTF-8 bytes; search serves only approved excerpts', () => {
  const approved = policy();
  assert.equal(approved.read('notes/001.txt'), TEXT);
  assert.deepEqual(approved.manifest.files[0].bytes, [...Buffer.from(TEXT)]);
  assert.equal(approved.manifest.files[0].sha256, sha256(Buffer.from(TEXT)));
  assert.equal(approved.manifest.schema, 'real-use-mask-manifest/v1');
  assert.equal(approved.manifest.manifestSha256, sha256(JSON.stringify({
    schema: approved.manifest.schema, files: approved.manifest.files,
  })));
  assert.deepEqual(approved.search('needle'), [
    { logicalPath: 'notes/001.txt', line: 2, preview: 'Background NEEDLE.' },
  ]);
  assert.deepEqual(approved.search(PRIVATE), []);
  assert.equal(validateManifest(approved.manifest), true);
  assert.equal(validateManifest(clone(approved.manifest)), true);
});

const unsafePaths = [
  '../secret', '/absolute', 'notes\\secret', 'notes/\0secret',
  'notes/*', 'notes/?', 'notes/[x]', 'notes/]', 'notes/{x}', 'notes/}',
  '', '.', '..', 'notes/./x', 'notes/../x', '//server/share', '\\\\server\\share',
  'C:/secret', 'c:secret', 'notes/\nsecret', 'notes/\u007fsecret', 'notes/\u0085secret',
  'e\u0301.txt', 'a'.repeat(257), 'notes//x', 'notes/', null, 42,
];
for (const [index, logicalPath] of unsafePaths.entries()) {
  test(`rejects unsafe path ${index + 1} at creation and read with closed errors`, () => {
    rejectsClosed(() => createMaskPolicy([excerpt({ logicalPath })]), 'mask_path_unsafe');
    rejectsClosed(() => policy().read(logicalPath), 'mask_path_unsafe');
  });
}

test('accepts canonical NFC paths and the path length boundary', () => {
  const approved = createMaskPolicy([
    excerpt({ logicalPath: 'é.txt', approval: 'public' }),
    excerpt({ logicalPath: 'a'.repeat(256) }),
  ]);
  assert.equal(approved.read('é.txt'), TEXT);
  assert.equal(approved.read('a'.repeat(256)), TEXT);
});

test('rejects duplicate paths, invalid approvals and non-string text', () => {
  rejectsClosed(() => createMaskPolicy([excerpt(), excerpt()]), 'mask_duplicate_path');
  for (const approval of [undefined, null, 'Public', 'public ', 'unreviewed', true, PRIVATE]) {
    rejectsClosed(() => createMaskPolicy([excerpt({ approval })]), 'mask_approval_invalid');
  }
  for (const text of [undefined, null, 1, {}, Buffer.from(PRIVATE)]) {
    rejectsClosed(() => createMaskPolicy([excerpt({ text })]), 'mask_excerpt_invalid');
  }
  for (const excerpts of [undefined, null, {}, 'text', [null], [undefined], [[]]]) {
    rejectsClosed(() => createMaskPolicy(excerpts), 'mask_excerpt_invalid');
  }
});

test('rejects safe unapproved paths without disclosing any input', () => {
  rejectsClosed(() => policy().read(`${PRIVATE}.txt`), 'mask_path_not_approved');
});

test('detects mutated excerpt bytes, file hash and manifest hash', () => {
  for (const mutate of [
    manifest => { manifest.files[0].bytes[0] ^= 1; },
    manifest => { manifest.files[0].sha256 = '0'.repeat(64); },
    manifest => { manifest.manifestSha256 = '0'.repeat(64); },
    manifest => { manifest.files[0].logicalPath = 'other.txt'; },
    manifest => { manifest.files[0].bytes.push(0); },
    manifest => { manifest.files = []; },
    manifest => { manifest.schema = 'other'; },
    manifest => { manifest.files[0].bytes[0] ^= 1; manifest.files[0].sha256 = sha256(Buffer.from(manifest.files[0].bytes)); },
  ]) {
    const manifest = clone(policy().manifest);
    mutate(manifest);
    rejectsClosed(() => validateManifest(manifest), 'mask_manifest_hash_mismatch');
  }
});

test('malformed manifests fail closed', () => {
  for (const manifest of [null, {}, [], { ...clone(policy().manifest), extra: PRIVATE }]) {
    rejectsClosed(() => validateManifest(manifest), 'mask_manifest_hash_mismatch');
  }
  for (const mutate of [
    manifest => { manifest.files[0].bytes = TEXT; },
    manifest => { manifest.files[0].bytes[0] = 256; },
    manifest => { delete manifest.files[0].bytes[0]; },
    manifest => { manifest.files[0].logicalPath = '../secret'; },
    manifest => { manifest.files.push(manifest.files[0]); },
  ]) {
    const manifest = clone(policy().manifest);
    mutate(manifest);
    rejectsClosed(() => validateManifest(manifest), 'mask_manifest_hash_mismatch');
  }
});

test('sentinel checks find exact content, including across line boundaries', () => {
  assert.equal(policy().assertNoSentinel(PRIVATE), true);
  const approved = createMaskPolicy([excerpt({ text: `before\n${PRIVATE}\nafter` })]);
  rejectsClosed(() => approved.assertNoSentinel(PRIVATE), 'mask_sentinel_present');
  rejectsClosed(() => approved.assertNoSentinel(`before\n${PRIVATE}`), 'mask_sentinel_present');
  for (const sentinel of ['', 'short', '1234567', null, 12]) {
    rejectsClosed(() => approved.assertNoSentinel(sentinel), 'mask_term_invalid');
  }
  assert.equal(approved.assertNoSentinel('12345678'), true);
});

test('search is literal and case-insensitive with bounded terms', () => {
  assert.equal(policy().search('*?[x]{y}').length, 1);
  assert.deepEqual(policy().search('.*'), []);
  for (const term of ['', 'a'.repeat(1025), null, undefined, 42, /needle/]) {
    rejectsClosed(() => policy().search(term), 'mask_term_invalid');
  }
  assert.deepEqual(policy().search('a'.repeat(1024)), []);
  assert.equal(policy().search(' ').length, 3);
});

test('caps previews at 120 characters and results at 100; line numbers are one-based', () => {
  const approved = createMaskPolicy([excerpt({ text: Array.from(
    { length: 150 }, () => `needle ${'α'.repeat(200)}`,
  ).join('\r\n') })]);
  const results = approved.search('NEEDLE');
  assert.equal(results.length, 100);
  for (const [index, result] of results.entries()) {
    assert.equal(result.preview, `needle ${'α'.repeat(113)}`);
    assert.equal(result.preview.length, 120);
    assert.equal(result.line, index + 1);
  }
});

test('manifest and result ordering are deterministic across builds and input order', () => {
  const excerpts = [excerpt({ logicalPath: 'b.txt' }), excerpt({ logicalPath: 'a.txt', approval: 'public' })];
  const first = createMaskPolicy(excerpts);
  const second = createMaskPolicy([...excerpts].reverse());
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.search('needle'), second.search('needle'));
  assert.equal(validateManifest(second.manifest), true);
});

test('all returned data are frozen and input mutations cannot change approved content', () => {
  const input = [excerpt()];
  const approved = createMaskPolicy(input);
  input[0].text = PRIVATE;
  input[0].logicalPath = 'changed.txt';
  input.push(excerpt({ logicalPath: 'extra.txt', text: PRIVATE }));
  assert.equal(approved.read('notes/001.txt'), TEXT);
  assert.deepEqual(approved.search(PRIVATE), []);
  for (const value of [approved, approved.manifest, approved.manifest.files,
    approved.manifest.files[0], approved.manifest.files[0].bytes,
    approved.search('needle'), approved.search('needle')[0], approved.search(PRIVATE)]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(validateManifest(approved.manifest), true);
});

test('empty snapshots and empty approved text are valid without exposing other sources', () => {
  const empty = createMaskPolicy([]);
  assert.equal(validateManifest(empty.manifest), true);
  assert.deepEqual(empty.search('anything'), []);
  assert.equal(empty.assertNoSentinel(PRIVATE), true);
  rejectsClosed(() => empty.read('notes/001.txt'), 'mask_path_not_approved');
  const approved = createMaskPolicy([excerpt({ text: '' })]);
  assert.equal(approved.read('notes/001.txt'), '');
  assert.equal(validateManifest(approved.manifest), true);
});
