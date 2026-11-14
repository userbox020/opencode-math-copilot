import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../snapshot.mjs';
import { APPROVED_PATHS, GENERIC_DEFINITIONS, INVENTORY_FINGERPRINTS, ON_ONLY_DEFINITIONS, SNAPSHOT_LIMITS,
  createSnapshotTools, hashBytes } from '../lib/snapshot-tools.mjs';

// Small trusted PDF fixture generated locally; no archive, network, model or Lean.
function pdfFixture(repetitions = 1) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let page = 1; page <= 6; page++) {
    const id = objects.length;
    kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const text = `Snapshot fixture physical page ${page}. Hanner polytopes seeded navigation.`;
    const stream = (`BT /F1 12 Tf 30 700 Td (${text}) Tj ET\n`).repeat(repetitions);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Count 6 /Kids [${kids.join(' ')}] >>`;
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(result));
    result += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'snapshot-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const corpusRoot = path.join(root, 'corpus'), out = path.join(root, 'snapshot');
  const content = [Buffer.from('# Kaplansky fixture\r\nLiteral .* is not regex.\r\nUnicode Jacobsthal’s ∀ α ℝ.\r\n'),
    Buffer.from('# Jacobsthal seeded fixture\n## Scope\n' + Array.from({ length: 130 }, (_, i) => `line ${i + 3} Jacobsthal commonseed ${'α'.repeat(80)}`).join('\n')),
    pdfFixture()];
  for (const [i, logical] of APPROVED_PATHS.entries()) {
    mkdirSync(path.dirname(path.join(corpusRoot, logical)), { recursive: true });
    writeFileSync(path.join(corpusRoot, logical), content[i]);
  }
  for (const logical of ['grader-data/gold.json', 'rollouts/answer.txt', 'state/state.json', 'lean/proof.lean']) {
    mkdirSync(path.dirname(path.join(corpusRoot, logical)), { recursive: true });
    writeFileSync(path.join(corpusRoot, logical), 'EXCLUDED_FIXTURE_CONTENT');
  }
  return { root, corpusRoot, out, content };
}
async function built(t) {
  const f = fixture(t), result = await buildSnapshot({ corpusRoot: f.corpusRoot, out: f.out });
  return { ...f, ...result, tools: createSnapshotTools({ snapshotRoot: f.out, expectedManifestHash: result.manifestHash }) };
}
function inventory(root, prefix = '') {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(item => {
    const logical = prefix ? `${prefix}/${item.name}` : item.name;
    return item.isDirectory() ? inventory(root, logical) : [logical];
  }).sort();
}
function mutate(file, content) { chmodSync(file, 0o644); writeFileSync(file, content); }

test('copies exactly approved bytes plus manifest/index; preserves Unicode, case and hashes; no excluded artifacts', async t => {
  const f = await built(t);
  assert.deepEqual(inventory(f.out), [...APPROVED_PATHS, 'source-manifest.json', 'source-index.json'].sort());
  assert.equal(f.manifestHash, hashBytes(readFileSync(path.join(f.out, 'source-manifest.json'))));
  for (const [i, file] of f.manifest.files.entries()) {
    const bytes = readFileSync(path.join(f.out, file.path));
    assert.deepEqual(bytes, f.content[i]);
    assert.equal(file.sha256, hashBytes(bytes));
    assert.equal(file.bytes, bytes.length);
  }
  const exported = readFileSync(path.join(f.out, 'source-index.json'), 'utf8');
  assert.ok(exported.includes('Jacobsthal’s ∀ α ℝ'));
  assert.ok(!exported.includes('EXCLUDED_FIXTURE_CONTENT'));
  const forbidden = /^(?:rubric|expected_result|score|scoring|quote|proofcode|rollouts|gold)$/;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { assert.doesNotMatch(key, forbidden); visit(child); }
  };
  visit(f.manifest); visit(JSON.parse(exported));
  assert.equal(JSON.stringify(f.manifest).includes(f.root), false);
});

test('fresh output refusal preserves bytes and timestamps; output cannot overlap source, gold, or study', async t => {
  const f = await built(t), file = path.join(f.out, 'source-manifest.json');
  const bytes = readFileSync(file), modified = statSync(file).mtimeMs;
  await assert.rejects(() => buildSnapshot({ corpusRoot: f.corpusRoot, out: f.out }), /output_exists/);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(statSync(file).mtimeMs, modified);
  await assert.rejects(() => buildSnapshot({ corpusRoot: f.corpusRoot, out: path.join(f.corpusRoot, 'new') }), /overlaps_source/);
  for (const name of ['gold', 'grader-data', 'rollouts', 'state', 'study']) {
    const parent = path.join(f.root, name); mkdirSync(parent);
    if (name === 'study') writeFileSync(path.join(parent, 'manifest.json'), '{}');
    const out = path.join(parent, 'new');
    await assert.rejects(() => buildSnapshot({ corpusRoot: f.corpusRoot, out }), /inside_gold_or_study/);
    assert.equal(existsSync(out), false);
  }
  await assert.rejects(() => buildSnapshot({ corpusRoot: f.corpusRoot, out: 'relative' }), /absolute_out/);
  await assert.rejects(() => buildSnapshot({ corpusRoot: f.corpusRoot, out: path.join(f.root, 'new'), extra: true }), /explicit_corpus/);
});

test('source and snapshot directory-link escapes are rejected before copying or returning content', async t => {
  const f = fixture(t), external = path.join(f.root, 'outside'); mkdirSync(external);
  writeFileSync(path.join(external, '021.md'), 'OUTSIDE_SOURCE');
  const docs = path.join(f.corpusRoot, 'lean', 'docs');
  renameSync(docs, `${docs}-original`);
  symlinkSync(external, docs, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => buildSnapshot({ corpusRoot: f.corpusRoot, out: f.out }), /source_path_rejected/);
  assert.equal(existsSync(f.out), false);
  rmSync(docs); renameSync(`${docs}-original`, docs);
  await buildSnapshot({ corpusRoot: f.corpusRoot, out: f.out });
  const tools = createSnapshotTools({ snapshotRoot: f.out });
  const snapshotDocs = path.join(f.out, 'lean', 'docs');
  renameSync(snapshotDocs, `${snapshotDocs}-original`);
  symlinkSync(external, snapshotDocs, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createSnapshotTools({ snapshotRoot: f.out }), /source_path_rejected/);
  assert.throws(() => tools.generic.list_sources.handler({}), /source_path_rejected/);
});

test('logical allowlist rejects traversal, absolutes, URIs, NUL, unknown paths and case changes', async t => {
  const { tools } = await built(t);
  const invalid = ['', '../gold.json', 'math/../lean/docs/021.md', '/lean/docs/021.md', 'C:/lean/docs/021.md',
    'C:\\lean\\docs\\021.md', '\\\\host\\share\\021.md', 'file:///lean/docs/021.md', 'https://example.org/a',
    'lean/docs/021.md\0', 'lean//docs/021.md', 'lean/./docs/021.md', 'lean/docs/%2e%2e/gold.json', 'LEAN/docs/021.md',
    'grader-data/gold.json', 'source-manifest.json', 'source-index.json', 'lean/proof.lean'];
  for (const value of invalid) {
    assert.throws(() => tools.generic.read_source.handler({ path: value }), /path_rejected|path_not_approved/);
    assert.throws(() => tools.onOnly.math_manuscript.handler({ path: value }), /path_rejected|path_not_approved/);
  }
  assert.deepEqual(tools.generic.read_source.handler({ path: `math/${APPROVED_PATHS[0]}` }), tools.generic.read_source.handler({ path: APPROVED_PATHS[0] }));
});

test('source, derived-index and manifest mutations fail on new loads AND existing handlers', async t => {
  const f = await built(t);
  assert.throws(() => createSnapshotTools({ snapshotRoot: f.out, expectedManifestHash: '0'.repeat(64) }), /manifest_hash_mismatch/);
  for (const logical of [APPROVED_PATHS[0], 'source-index.json', 'source-manifest.json']) {
    const file = path.join(f.out, logical), original = readFileSync(file);
    mutate(file, Buffer.concat([original, Buffer.from(' ')]));
    assert.throws(() => createSnapshotTools({ snapshotRoot: f.out, expectedManifestHash: f.manifestHash }), /hash_mismatch/);
    assert.throws(() => f.tools.generic.list_sources.handler({}), /hash_mismatch/);
    mutate(file, original);
  }
  assert.equal(f.tools.generic.list_sources.handler({}).sources.length, 3);
});

test('oversized sources are rejected before extraction/output and manifest config cannot expand the allowlist', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.corpusRoot, APPROVED_PATHS[0]), Buffer.alloc(SNAPSHOT_LIMITS.source_bytes + 1, 65));
  await assert.rejects(() => buildSnapshot({ corpusRoot: f.corpusRoot, out: f.out }), /source_size_rejected/);
  assert.equal(existsSync(f.out), false);
  writeFileSync(path.join(f.corpusRoot, APPROVED_PATHS[0]), f.content[0]);
  await buildSnapshot({ corpusRoot: f.corpusRoot, out: f.out });
  const file = path.join(f.out, 'source-manifest.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  mutate(file, JSON.stringify({ ...original, arbitrary_files: ['grader-data/gold.json'] }));
  assert.throws(() => createSnapshotTools({ snapshotRoot: f.out }), /invalid_keys/);
  original.files[0].path = '../outside';
  mutate(file, JSON.stringify(original));
  assert.throws(() => createSnapshotTools({ snapshotRoot: f.out }), /invalid_manifest_source/);
});

test('strict schemas/config reject unknown keys and bounded argument violations; shared call budget fails clearly', async t => {
  const f = await built(t), tools = f.tools;
  assert.throws(() => createSnapshotTools({ snapshotRoot: f.out, arbitraryRoot: f.corpusRoot }), /invalid_keys/);
  assert.throws(() => createSnapshotTools({ snapshotRoot: f.out, callBudget: 0 }), /invalid_snapshot_config/);
  for (const [name, definition] of Object.entries({ ...GENERIC_DEFINITIONS, ...ON_ONLY_DEFINITIONS })) {
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.throws(() => tools.conditions['plugin-on'][name].handler({ unwanted: true }), /invalid_keys/);
  }
  for (const query of ['', '  ', 'x'.repeat(257), 'α'.repeat(129), '\0', 23]) {
    assert.throws(() => tools.generic.search_source.handler({ query }), /invalid_query/);
    assert.throws(() => tools.onOnly.math_search.handler({ query }), /invalid_query/);
  }
  for (const limit of [0, 21, 2.5, '2', null]) assert.throws(() => tools.generic.search_source.handler({ query: 'fixture', limit }), /invalid_query/);
  for (const offset of [0, -1, 2.5, '1']) assert.throws(() => tools.generic.read_source.handler({ path: APPROVED_PATHS[0], offset }), /invalid_line_range/);
  assert.throws(() => tools.generic.read_source.handler({ path: APPROVED_PATHS[0], limit: 101 }), /invalid_line_range/);
  assert.throws(() => tools.onOnly.math_manuscript.handler({ path: APPROVED_PATHS[0], query: 'x' }), /path_or_query/);
  const budgeted = createSnapshotTools({ snapshotRoot: f.out, callBudget: 2 });
  budgeted.generic.list_sources.handler({}); budgeted.onOnly.math_search.handler({ query: 'fixture' });
  assert.throws(() => budgeted.generic.list_sources.handler({}), /call_budget_exhausted/);
});

test('read/search expose bounded lines, page locators, literal matching, missing scope and truncation', async t => {
  const { tools } = await built(t);
  const read = tools.generic.read_source.handler({ path: APPROVED_PATHS[1], offset: 3, limit: 100 });
  assert.equal(read.lines[0].line, 3); assert.equal(read.truncated, true);
  assert.ok(read.lines.length <= 100);
  assert.ok(read.lines.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) <= SNAPSHOT_LIMITS.returned_text_bytes);
  assert.ok(Buffer.byteLength(JSON.stringify(read)) <= SNAPSHOT_LIMITS.output_bytes);
  assert.equal(read.scope.total_lines, 132);
  const literal = tools.generic.search_source.handler({ query: '.*' });
  assert.equal(literal.total_matching_lines, 1); assert.equal(literal.matches[0].line, 2);
  const result = tools.generic.search_source.handler({ query: 'commonseed', limit: 2 });
  assert.equal(result.matches.length, 2); assert.equal(result.truncated, true);
  assert.equal(result.total_matching_lines, 130);
  const pdf = tools.generic.search_source.handler({ query: 'physical page 4' });
  assert.equal(pdf.matches[0].path, APPROVED_PATHS[2]); assert.equal(pdf.matches[0].page, 4);
  const absent = tools.generic.search_source.handler({ query: 'EXCLUDED_FIXTURE_CONTENT' });
  assert.equal(absent.matches.length, 0); assert.match(absent.scope.text, /no OCR/);
});

test('PDF physical page selections are capped at five with honest extraction scope', async t => {
  const { tools } = await built(t), read = tools.generic.read_pdf.handler;
  const result = read({ path: `math/${APPROVED_PATHS[2]}`, pages: '1-3,5,6' });
  assert.deepEqual(result.pages.map(page => page.page), [1, 2, 3, 5, 6]);
  assert.equal(result.scope.total_pages, 6); assert.equal(result.scope.ocr, false);
  assert.equal(result.truncated, false);
  assert.match(result.pages[0].text, /physical page 1/);
  for (const pages of ['1-6', '1,2,3,4,5,6']) assert.throws(() => read({ path: APPROVED_PATHS[2], pages }), /page_limit/);
  for (const pages of ['', '0', '7', '1-999999999999', '2-1', '1;exec', '1'.repeat(101), null]) {
    assert.throws(() => read({ path: APPROVED_PATHS[2], pages }), /invalid_pages/);
  }
  assert.throws(() => read({ path: APPROVED_PATHS[0], pages: '1' }), /use_read_source/);
  assert.throws(() => tools.generic.read_source.handler({ path: APPROVED_PATHS[2] }), /use_read_pdf/);
});

test('ON/OFF generic definitions and handlers are identical; APIs are frozen, read-only, and return no host paths', async t => {
  const f = await built(t), tools = f.tools;
  const before = inventory(f.out).map(file => [file, hashBytes(readFileSync(path.join(f.out, file))), statSync(path.join(f.out, file)).mtimeMs]);
  for (const name of Object.keys(GENERIC_DEFINITIONS)) assert.equal(tools.conditions['plugin-on'][name], tools.conditions['plugin-off'][name]);
  assert.deepEqual(Object.keys(tools.conditions['plugin-off']), ['list_sources', 'read_source', 'search_source', 'read_pdf']);
  assert.equal(tools.inventoryFingerprints['plugin-off'], INVENTORY_FINGERPRINTS.generic);
  assert.notEqual(tools.inventoryFingerprints['plugin-on'], tools.inventoryFingerprints['plugin-off']);
  assert.throws(() => { tools.generic.extra = {}; }, TypeError);
  assert.throws(() => { GENERIC_DEFINITIONS.read_source.inputSchema.additionalProperties = true; }, TypeError);
  const listed = tools.generic.list_sources.handler({}); listed.sources[0].path = 'changed';
  assert.equal(tools.generic.list_sources.handler({}).sources[0].path, APPROVED_PATHS[0]);
  for (const output of [tools.generic.list_sources.handler({}), tools.generic.search_source.handler({ query: 'fixture' }), tools.onOnly.math_manuscript.handler({ query: 'Jacobsthal' })]) {
    assert.equal(JSON.stringify(output).includes(f.root), false);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= SNAPSHOT_LIMITS.output_bytes);
  }
  assert.deepEqual(inventory(f.out).map(file => [file, hashBytes(readFileSync(path.join(f.out, file))), statSync(path.join(f.out, file)).mtimeMs]), before);
});

test('PDF text output byte cap reports omitted pages/text instead of claiming complete coverage', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.corpusRoot, APPROVED_PATHS[2]), pdfFixture(300));
  await buildSnapshot({ corpusRoot: f.corpusRoot, out: f.out });
  const tools = createSnapshotTools({ snapshotRoot: f.out });
  const result = tools.generic.read_pdf.handler({ path: APPROVED_PATHS[2], pages: '1-5' });
  assert.equal(result.truncated, true);
  assert.ok(result.pages.length < 5);
  assert.equal(result.pages[0].truncated, true);
  assert.ok(result.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0) <= SNAPSHOT_LIMITS.returned_text_bytes);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SNAPSHOT_LIMITS.output_bytes);
  assert.deepEqual(result.scope.requested_physical_pages, [1, 2, 3, 4, 5]);
});

test('seeded approved-content BM25 navigation is deterministic and exposes no extra corpus data', async t => {
  const { tools } = await built(t), search = tools.onOnly.math_search.handler;
  for (const [query, expected] of [['Kaplansky', APPROVED_PATHS[0]], ['Jacobsthal seeded', APPROVED_PATHS[1]], ['Hanner polytopes', APPROVED_PATHS[2]]]) {
    const result = search({ query, limit: 3 });
    assert.equal(result.results[0].path, expected);
    assert.deepEqual(result, search({ query, limit: 3 }));
    assert.ok(result.results.every(item => APPROVED_PATHS.includes(item.path)));
    assert.match(result.scope, /restricted workflow BM25/);
    assert.equal(tools.onOnly.math_manuscript.handler({ query }).source.path, expected);
  }
  assert.equal(search({ query: 'EXCLUDED' }).results.length, 0);
  assert.equal(tools.onOnly.math_manuscript.handler({ query: 'EXCLUDED' }).source, null);
});
