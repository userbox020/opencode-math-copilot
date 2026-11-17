import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { createSearch } from '../../../.opencode/plugins/math-toolkit/lib/search.js';
import { createMaskPolicy } from './mask-policy.mjs';

const PATHS = Object.freeze(['formal-statement.lean', 'problem.md']);
const CONTEXTS = new WeakMap();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('arxiv_snapshot_invalid');
}
function filesystem(action) {
  try { return action(); } catch (error) {
    if (error.code?.startsWith('arxiv_snapshot_')) throw error;
    fail(['ENOENT', 'ENOTDIR'].includes(error.code) ? 'arxiv_snapshot_missing' : 'arxiv_snapshot_unsafe');
  }
}
function logicalPath(value) {
  // Exact matching also rejects Windows aliases, globs, case changes and ADS.
  if (typeof value !== 'string' || !PATHS.includes(value)) fail('arxiv_snapshot_unsafe');
  return value;
}
function readRegular(root, name) {
  const filename = join(root, name), stat = filesystem(() => lstatSync(filename));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('arxiv_snapshot_unsafe');
  return filesystem(() => readFileSync(filename));
}
function decode(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('arxiv_snapshot_binary'); }
  if (text.includes('\0')) fail('arxiv_snapshot_binary');
  return text;
}
function load(root, expectedHash) {
  const directory = filesystem(() => lstatSync(root));
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('arxiv_snapshot_unsafe');
  const names = filesystem(() => readdirSync(root));
  if (names.some(name => ![...PATHS, 'manifest.json'].includes(name))) fail('arxiv_snapshot_unexpected_file');
  if ([...PATHS, 'manifest.json'].some(name => !names.includes(name))) fail('arxiv_snapshot_missing');
  const manifestBytes = readRegular(root, 'manifest.json');
  if (hash(manifestBytes) !== expectedHash) fail('arxiv_snapshot_hash_mismatch');
  let manifest;
  try { manifest = JSON.parse(decode(manifestBytes)); }
  catch (error) {
    if (error.code === 'arxiv_snapshot_binary') throw error;
    fail('arxiv_snapshot_invalid');
  }
  keys(manifest, ['schema', 'taskId', 'files', 'manifestSha256']);
  if (manifest.schema !== 'real-use-arxiv-snapshot/v1'
    || typeof manifest.taskId !== 'string' || !/^arxivlean-[0-9]{2}$/.test(manifest.taskId)
    || !Array.isArray(manifest.files) || manifest.files.length !== PATHS.length
    || !isHash(manifest.manifestSha256)) fail('arxiv_snapshot_invalid');
  const files = manifest.files.map((file, i) => {
    keys(file, ['path', 'bytes', 'sha256']);
    logicalPath(file.path);
    if (file.path !== PATHS[i] || !integer(file.bytes, 1, Number.MAX_SAFE_INTEGER) || !isHash(file.sha256)) {
      fail('arxiv_snapshot_invalid');
    }
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  if (hash(JSON.stringify(files)) !== manifest.manifestSha256) fail('arxiv_snapshot_hash_mismatch');
  const contents = files.map(file => {
    const bytes = readRegular(root, file.path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('arxiv_snapshot_hash_mismatch');
    return bytes;
  });
  const texts = contents.map(bytes => {
    const text = decode(bytes);
    if (!text.trim()) fail('arxiv_snapshot_invalid');
    return text;
  });
  return { manifest: freeze(manifest), texts };
}

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pathSchema = { type: 'string', enum: PATHS };
const querySchema = { type: 'string', minLength: 1, maxLength: 1024 };
const queryInput = schema({ query: querySchema, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']);
const DEFINITIONS = freeze({
  list_sources: { description: 'List exactly the two public-input sources.', inputSchema: schema({}) },
  read_source: { description: 'Read public-input text lines; imports are text, never executed.',
    inputSchema: schema({ path: pathSchema, offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['path']) },
  search_source: { description: 'Literal search of the same two public inputs only.', inputSchema: queryInput },
  math_search: { description: 'BM25 search over the two public inputs only; no corpus index.', inputSchema: queryInput },
  math_manuscript: { description: 'Read one public input by exact path or public-input BM25 query.',
    inputSchema: { ...schema({ path: pathSchema, query: querySchema }),
      oneOf: [{ required: ['path'], not: { required: ['query'] } }, { required: ['query'], not: { required: ['path'] } }] } },
});

export function createArxivSnapshotTools(config) {
  keys(config, ['snapshotRoot', 'expectedManifestHash', 'condition', 'callBudget'],
    ['snapshotRoot', 'expectedManifestHash', 'condition']);
  const { snapshotRoot, expectedManifestHash, condition } = config;
  if (typeof snapshotRoot !== 'string' || snapshotRoot.includes('\0') || !isAbsolute(snapshotRoot)
    || !isHash(expectedManifestHash) || !['plugin-on', 'plugin-off'].includes(condition)
    || (config.callBudget !== undefined && !integer(config.callBudget, 1, 10000))) fail('arxiv_snapshot_invalid');
  if (filesystem(() => lstatSync(snapshotRoot)).isSymbolicLink()) fail('arxiv_snapshot_unsafe');
  const root = filesystem(() => realpathSync(snapshotRoot));
  const initial = load(root, expectedManifestHash), { manifest, texts } = initial;
  const policy = createMaskPolicy(PATHS.map((logicalPath, i) => ({ logicalPath, text: texts[i], approval: 'public' })));
  // No persisted index, source ids, title, or paper metadata. The only indexed
  // text is the already-hash-checked public input, indexed separately per file.
  const search = condition === 'plugin-on' ? createSearch({
    manuscripts: PATHS.map((path, i) => ({ id: path, title: '', family: '', familyTitle: '',
      sections: [], leanTitle: '', formalized: path === 'formal-statement.lean', abstract: texts[i] })),
  }) : null;
  let remaining = config.callBudget ?? 200;
  const invoke = handler => (args = {}) => {
    // Integrity is checked even for invalid requests and exhausted budgets.
    load(root, expectedManifestHash);
    if (remaining-- <= 0) fail('arxiv_snapshot_invalid');
    if (args && Object.hasOwn(args, 'path')) logicalPath(args.path);
    const result = handler(args);
    return structuredClone({ ...result, manifestSha256: manifest.manifestSha256 });
  };
  function queryArgs(args) {
    keys(args, ['query', 'limit'], ['query']);
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.includes('\0')
      || args.query.length > 1024 || !integer(args.limit ?? 20, 1, 100)) fail('arxiv_snapshot_invalid');
    return { query: args.query, limit: args.limit ?? 20 };
  }
  const source = path => ({ taskId: manifest.taskId, ...manifest.files.find(file => file.path === path) });
  const handlers = {
    list_sources: invoke(args => { keys(args, []); return { sources: PATHS.map(source) }; }),
    read_source: invoke(args => {
      keys(args, ['path', 'offset', 'limit'], ['path']);
      const path = logicalPath(args.path), offset = args.offset ?? 1, limit = args.limit ?? 100;
      if (!integer(offset, 1, Number.MAX_SAFE_INTEGER) || !integer(limit, 1, 100)) fail('arxiv_snapshot_invalid');
      const all = policy.read(path).split(/\r\n?|\n/);
      const lines = all.slice(offset - 1, offset - 1 + limit).map((text, i) => ({ line: offset + i, text }));
      return { path, lines, total_lines: all.length, truncated: offset - 1 + lines.length < all.length };
    }),
    search_source: invoke(args => {
      const { query, limit } = queryArgs(args);
      return { matches: policy.search(query).slice(0, limit).map(({ logicalPath: path, line, preview }) =>
        ({ path, line, text: preview })) };
    }),
  };
  if (condition === 'plugin-on') {
    handlers.math_search = invoke(args => ({
      results: search(queryArgs(args)).map(({ manuscript, score }) => ({ ...source(manuscript.id), score })),
    }));
    handlers.math_manuscript = invoke(args => {
      keys(args, ['path', 'query'], []);
      if (Object.hasOwn(args, 'path') === Object.hasOwn(args, 'query')) fail('arxiv_snapshot_invalid');
      const path = Object.hasOwn(args, 'path') ? logicalPath(args.path)
        : search({ ...queryArgs({ query: args.query }), limit: 1 })[0]?.manuscript.id;
      return path ? { source: source(path), excerpt: { text: policy.read(path) } } : { source: null };
    });
  }
  const tools = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, { ...DEFINITIONS[name], handler }]));
  const result = freeze({
    manifestSha256: manifest.manifestSha256, taskId: manifest.taskId, condition, tools,
    inventory: Object.keys(tools).sort(), canAuthorizeModelRun: false, admission: 'not_assessed',
  });
  CONTEXTS.set(result, { root, expectedManifestHash, texts });
  return result;
}

/**
 * Evaluator-only controls, not exposed as tools. The mutation probe temporarily
 * changes one approved file and restores its verified original bytes in finally.
 * Run exclusively, with a stable filesystem and sufficient remaining call budget.
 * This checks reader behavior, not process isolation or execution admission.
 */
export function runArxivSnapshotControls(runtime) {
  const controls = [], context = CONTEXTS.get(runtime);
  if (!context) fail('arxiv_snapshot_invalid');
  const call = (name, args) => {
    if (!Object.hasOwn(runtime.tools, name)) fail('arxiv_snapshot_unsafe');
    return runtime.tools[name].handler(args);
  };
  const rejection = action => {
    try { action(); return 'accepted'; } catch (error) { return error.code ?? 'unexpected_error'; }
  };
  const check = (name, expected, action) => {
    let observed;
    try { observed = action(); } catch (error) { observed = error.code ?? 'unexpected_error'; }
    controls.push({ name, expected, observed, pass: JSON.stringify(observed) === JSON.stringify(expected) });
  };
  check('excluded_source_read', ['arxiv_snapshot_unsafe', 'arxiv_snapshot_unsafe'], () =>
    ['proof.lean', 'paper.tex'].map(path => rejection(() => call('read_source', { path }))));
  // Fresh evaluator-local sentinel: never stored in either source or the index.
  const sentinel = `EVALUATOR_ONLY_${randomUUID()}`;
  check('excluded_sentinel_search', 0, () => call('search_source', { query: sentinel }).matches.length);
  check('pdf_read_request', ['arxiv_snapshot_unsafe', 'arxiv_snapshot_unsafe'], () => [
    rejection(() => call('read_pdf', { path: 'paper.pdf' })),
    rejection(() => call('read_source', { path: 'paper.pdf' })),
  ]);
  check('old_index_cache_transcript_read', Array(3).fill('arxiv_snapshot_unsafe'), () =>
    ['source-index.json', '.cache/old-index.json', 'transcript.json'].map(path =>
      rejection(() => call('read_source', { path }))));
  check('mutated_excerpt_read', 'arxiv_snapshot_hash_mismatch', () => {
    load(context.root, context.expectedManifestHash);
    const filename = join(context.root, 'problem.md'), original = readRegular(context.root, 'problem.md');
    try {
      filesystem(() => writeFileSync(filename, Buffer.concat([original, Buffer.from('\nMUTATION_PROBE\n')])));
      return rejection(() => call('read_source', { path: 'problem.md' }));
    } finally {
      filesystem(() => writeFileSync(filename, original));
    }
  });
  check('process_or_lean_import_request', Array(2).fill('arxiv_snapshot_unsafe'), () =>
    ['import Mathlib', 'IO.Process.spawn'].map(path => rejection(() => call('read_source', { path }))));
  check('list_exact_two_sources', PATHS, () => call('list_sources', {}).sources.map(source => source.path));
  check('read_exact_first_line', context.texts[1].split(/\r\n?|\n/)[0], () =>
    call('read_source', { path: 'problem.md', offset: 1, limit: 1 }).lines[0]?.text);
  const phrase = context.texts[1].split(/\r\n?|\n/).find(line => line.trim())?.trim().slice(0, 80);
  check('search_public_phrase', true, () =>
    call('search_source', { query: phrase }).matches.some(match => match.path === 'problem.md'));
  check('math_search_formal_task', runtime.condition === 'plugin-on' ? true : 'not_exposed', () => {
    if (runtime.condition === 'plugin-off') return Object.hasOwn(runtime.tools, 'math_search') ? 'exposed' : 'not_exposed';
    const term = context.texts[0].match(/[\p{L}\p{N}]+/u)?.[0] ?? context.texts[0].trim().slice(0, 80);
    return call('math_search', { query: term }).results.some(result =>
      result.path === 'formal-statement.lean' && result.taskId === runtime.taskId);
  });
  return { pass: controls.every(control => control.pass), controls };
}
