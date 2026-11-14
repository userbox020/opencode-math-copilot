import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createSearch } from '../../../../.opencode/plugins/math-toolkit/lib/search.js';

export const APPROVED_PATHS = Object.freeze([
  'preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md',
  'lean/docs/021.md',
  'preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/paper.pdf',
]);
export const SNAPSHOT_LIMITS = Object.freeze({ source_bytes: 16 * 1024 * 1024, manifest_bytes: 16384,
  index_bytes: 8 * 1024 * 1024, text_bytes: 2 * 1024 * 1024, pdf_pages: 200,
  page_text_bytes: 100000, output_bytes: 32768, returned_text_bytes: 12000,
  query_bytes: 256, calls: 200, lines: 100, results: 20, requested_pages: 5 });
export const hashBytes = value => createHash('sha256').update(value).digest('hex');
const hashJSON = value => hashBytes(JSON.stringify(value));
const fail = code => { throw new Error(code); };
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('invalid_keys');
}
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
export function contained(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function boundedBytes(root, logical, maximum) {
  try {
    const file = path.join(root, logical);
    const resolved = realpathSync(file);
    if (!contained(root, resolved) || lstatSync(file).isSymbolicLink()) fail('source_path_rejected');
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > maximum) fail('source_size_rejected');
    const bytes = readFileSync(resolved);
    if (bytes.length !== stat.size || bytes.length > maximum || realpathSync(file) !== resolved) fail('source_changed');
    return bytes;
  } catch (error) {
    if (/^source_(?:path_rejected|size_rejected|changed)$/.test(error.message)) throw error;
    fail('source_unavailable');
  }
}
export function clipBytes(text, maximum) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return text;
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
function logicalPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\x00-\x1f:]/.test(value) ||
      value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.' || !part)) fail('path_rejected');
  const logical = value.startsWith('math/') ? value.slice(5) : value;
  if (!APPROVED_PATHS.includes(logical)) fail('path_not_approved');
  return logical;
}
const pathSchema = { type: 'string', minLength: 1, maxLength: 1024 };
const querySchema = { type: 'string', minLength: 1, maxLength: SNAPSHOT_LIMITS.query_bytes };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const GENERIC_DEFINITIONS = freeze({
  list_sources: { description: 'List the three approved snapshot sources and their extraction scope. No archive discovery.', inputSchema: schema({}) },
  read_source: { description: 'Read bounded lines of an approved UTF-8 source. Use read_pdf for PDF physical pages.',
    inputSchema: schema({ path: pathSchema, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['path']) },
  search_source: { description: 'Literal case-sensitive search across approved text and extracted PDF pages; no regex, OCR, or archive search.',
    inputSchema: schema({ query: querySchema, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']) },
  read_pdf: { description: 'Read at most five physical pages from approved PDF-derived text, with explicit extraction/truncation scope. No OCR.',
    inputSchema: schema({ path: pathSchema, pages: { type: 'string', minLength: 1, maxLength: 100, pattern: '^\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*$' } }, ['path', 'pages']) },
});
export const ON_ONLY_DEFINITIONS = freeze({
  math_search: { description: 'Restricted three-source workflow BM25 navigation using shipped math-toolkit search logic; not the full corpus/plugin.',
    inputSchema: schema({ query: querySchema, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']) },
  math_manuscript: { description: 'Restricted source metadata/outline and bounded excerpt, from the same approved snapshot bytes. Supply path OR query.',
    inputSchema: { ...schema({ path: pathSchema, query: querySchema }), oneOf: [{ required: ['path'], not: { required: ['query'] } }, { required: ['query'], not: { required: ['path'] } }] } },
});
export const INVENTORY_FINGERPRINTS = freeze({ generic: hashJSON(GENERIC_DEFINITIONS),
  on_only: hashJSON(ON_ONLY_DEFINITIONS),
  'plugin-off': hashJSON(GENERIC_DEFINITIONS), 'plugin-on': hashJSON({ ...GENERIC_DEFINITIONS, ...ON_ONLY_DEFINITIONS }) });

function parseJSON(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_snapshot_json'); } }
function validateManifest(manifest) {
  keys(manifest, ['schema', 'version', 'scope', 'files', 'index']);
  if (manifest.schema !== 'real-use-source-snapshot/v1' || manifest.version !== 1 ||
      manifest.scope !== 'three approved sources only; no full archive, gold, state, or execution' ||
      !Array.isArray(manifest.files) || manifest.files.length !== APPROVED_PATHS.length) fail('invalid_manifest');
  for (const [i, file] of manifest.files.entries()) {
    keys(file, ['path', 'kind', 'bytes', 'sha256']);
    if (file.path !== APPROVED_PATHS[i] || file.kind !== (file.path.endsWith('.pdf') ? 'pdf' : 'text') ||
        !integer(file.bytes, 1, SNAPSHOT_LIMITS.source_bytes) || !isHash(file.sha256)) fail('invalid_manifest_source');
  }
  keys(manifest.index, ['path', 'bytes', 'sha256']);
  if (manifest.index.path !== 'source-index.json' || !integer(manifest.index.bytes, 1, SNAPSHOT_LIMITS.index_bytes) || !isHash(manifest.index.sha256)) fail('invalid_manifest_index');
}
function validateIndex(index, manifest, sources) {
  keys(index, ['schema', 'documents']);
  if (index.schema !== 'real-use-source-index/v1' || !Array.isArray(index.documents) || index.documents.length !== 3) fail('invalid_index');
  for (const [i, document] of index.documents.entries()) {
    keys(document, ['path', 'total_pages', 'segments']);
    const source = manifest.files[i];
    if (document.path !== source.path || !Array.isArray(document.segments)) fail('invalid_index_source');
    const pdf = source.kind === 'pdf';
    if (pdf ? !integer(document.total_pages, 1, SNAPSHOT_LIMITS.pdf_pages) || document.segments.length !== document.total_pages
      : document.total_pages !== null || document.segments.length !== 1) fail('invalid_index_pages');
    for (const [j, segment] of document.segments.entries()) {
      keys(segment, ['page', 'text', 'truncated']);
      if (segment.page !== (pdf ? j + 1 : null) || typeof segment.text !== 'string' || typeof segment.truncated !== 'boolean' ||
          Buffer.byteLength(segment.text) > (pdf ? SNAPSHOT_LIMITS.page_text_bytes : SNAPSHOT_LIMITS.text_bytes)) fail('invalid_index_text');
    }
    if (!pdf && (document.segments[0].truncated || document.segments[0].text !== new TextDecoder('utf-8', { fatal: true }).decode(sources[i]))) fail('text_index_mismatch');
  }
}
function sourceMetadata(file, document) {
  const first = document.segments[0].text;
  const title = file.kind === 'text' ? (first.split(/\r?\n/).find(line => /^#\s/.test(line)) ?? file.path).replace(/^#\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    : file.path.split('/').at(-2).replaceAll('-', ' ');
  return { path: file.path, kind: file.kind, bytes: file.bytes, sha256: file.sha256, title: clipBytes(title, 512),
    scope: { total_pages: document.total_pages, indexed_pages: document.total_pages === null ? [] : document.segments.map(segment => segment.page),
      extraction_truncated: document.segments.some(segment => segment.truncated), ocr: false, corpus: 'approved three-source snapshot only' } };
}

// Read-only construction: no discovery walk, registration, filesystem writes, PDF
// execution, cache, environment lookup, credential access, or full plugin import.
export function createSnapshotTools(config) {
  keys(config, ['snapshotRoot', 'expectedManifestHash', 'callBudget'], ['snapshotRoot']);
  if (typeof config.snapshotRoot !== 'string' || !path.isAbsolute(config.snapshotRoot) ||
      (config.expectedManifestHash !== undefined && !isHash(config.expectedManifestHash)) ||
      (config.callBudget !== undefined && !integer(config.callBudget, 1, 10000))) fail('invalid_snapshot_config');
  let root;
  try { root = realpathSync(config.snapshotRoot); } catch { fail('snapshot_unavailable'); }
  const manifestBytes = boundedBytes(root, 'source-manifest.json', SNAPSHOT_LIMITS.manifest_bytes);
  const manifestHash = hashBytes(manifestBytes);
  if (config.expectedManifestHash && config.expectedManifestHash !== manifestHash) fail('manifest_hash_mismatch');
  const manifest = parseJSON(manifestBytes);
  validateManifest(manifest);
  const sources = manifest.files.map(file => boundedBytes(root, file.path, SNAPSHOT_LIMITS.source_bytes));
  const indexBytes = boundedBytes(root, manifest.index.path, SNAPSHOT_LIMITS.index_bytes);
  const verifyBytes = (file, bytes) => { if (file.bytes !== bytes.length || file.sha256 !== hashBytes(bytes)) fail('source_hash_mismatch'); };
  manifest.files.forEach((file, i) => verifyBytes(file, sources[i]));
  verifyBytes(manifest.index, indexBytes);
  const index = parseJSON(indexBytes);
  validateIndex(index, manifest, sources);
  freeze(manifest); freeze(index);
  const metadata = freeze(manifest.files.map((file, i) => sourceMetadata(file, index.documents[i])));
  const lookup = new Map(index.documents.map((document, i) => [document.path, { document, metadata: metadata[i] }]));
  const search = createSearch({ manuscripts: index.documents.map((document, i) => ({ id: document.path,
    title: metadata[i].title, family: '', familyTitle: document.path, sections: [], leanTitle: '',
    formalized: false, abstract: document.segments.map(segment => segment.text).join('\n') })) });
  let remaining = config.callBudget ?? SNAPSHOT_LIMITS.calls;
  function verify() {
    if (remaining-- <= 0) fail('snapshot_call_budget_exhausted');
    if (hashBytes(boundedBytes(root, 'source-manifest.json', SNAPSHOT_LIMITS.manifest_bytes)) !== manifestHash) fail('manifest_hash_mismatch');
    for (const file of [...manifest.files, manifest.index]) verifyBytes(file, boundedBytes(root, file.path, file === manifest.index ? SNAPSHOT_LIMITS.index_bytes : SNAPSHOT_LIMITS.source_bytes));
  }
  function invoke(handler) {
    return (args = {}) => {
      verify();
      const result = handler(args);
      const output = { ...result, manifest_sha256: manifestHash };
      if (Buffer.byteLength(JSON.stringify(output)) > SNAPSHOT_LIMITS.output_bytes) fail('output_limit');
      return structuredClone(output);
    };
  }
  function queryArgs(args) {
    keys(args, ['query', 'limit'], ['query']);
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.includes('\0') || Buffer.byteLength(args.query) > SNAPSHOT_LIMITS.query_bytes ||
        !integer(args.limit === undefined ? 8 : args.limit, 1, SNAPSHOT_LIMITS.results)) fail('invalid_query');
    return { query: args.query, limit: args.limit === undefined ? 8 : args.limit };
  }
  function locate(value, kind) {
    const found = lookup.get(logicalPath(value));
    if (kind && found.metadata.kind !== kind) fail(`use_${kind === 'pdf' ? 'read_source' : 'read_pdf'}`);
    return found;
  }
  const generic = {
    list_sources: invoke(args => { keys(args, []); return { sources: metadata, scope: 'only these paths are accessible; linked files are not included' }; }),
    read_source: invoke(args => {
      keys(args, ['path', 'offset', 'limit'], ['path']);
      const offset = args.offset === undefined ? 1 : args.offset, limit = args.limit === undefined ? 100 : args.limit;
      if (!integer(offset, 1, Number.MAX_SAFE_INTEGER) || !integer(limit, 1, 100)) fail('invalid_line_range');
      const { document, metadata } = locate(args.path, 'text');
      const all = document.segments[0].text.split(/\r\n?|\n/);
      let budget = SNAPSHOT_LIMITS.returned_text_bytes, clipped = false;
      const lines = [];
      for (let i = offset - 1; i < Math.min(all.length, offset - 1 + limit) && budget > 0; i++) {
        const text = clipBytes(all[i], budget);
        clipped ||= text !== all[i]; budget -= Buffer.byteLength(text);
        lines.push({ line: i + 1, text });
      }
      const next = (lines.at(-1)?.line ?? offset - 1) + 1;
      return { path: metadata.path, lines, scope: { total_lines: all.length, offset, limit, text_bytes_limit: SNAPSHOT_LIMITS.returned_text_bytes },
        truncated: clipped || next <= all.length, next_offset: next <= all.length ? next : null };
    }),
    search_source: invoke(args => {
      const { query, limit } = queryArgs(args), matches = [];
      let total = 0, textTruncated = false;
      for (const document of index.documents) for (const segment of document.segments) {
        for (const [i, text] of segment.text.split(/\r\n?|\n/).entries()) {
          const at = text.indexOf(query);
          if (at < 0) continue;
          total++;
          if (matches.length >= limit) continue;
          const excerpt = clipBytes(text.slice(Math.max(0, at - 80)), 512);
          textTruncated ||= excerpt !== text;
          matches.push({ path: document.path, page: segment.page, line: i + 1, text: excerpt });
        }
      }
      return { matches, total_matching_lines: total, truncated: total > matches.length || textTruncated,
        scope: { match: 'case-sensitive literal', sources: metadata.map(item => ({ path: item.path, ...item.scope })),
          text: 'full UTF-8 text and indexed PDF page text only; no OCR; misses do not cover unextracted content' } };
    }),
    read_pdf: invoke(args => {
      keys(args, ['path', 'pages']);
      const { document, metadata } = locate(args.path, 'pdf');
      if (typeof args.pages !== 'string' || args.pages.length > 100 || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(args.pages)) fail('invalid_pages');
      const selection = new Set();
      for (const part of args.pages.split(',')) {
        const [start, last] = part.split('-').map(Number), end = last ?? start;
        if (!integer(start, 1, document.total_pages) || !integer(end, start, document.total_pages)) fail('invalid_pages');
        if (end - start + 1 > 5) fail('page_limit');
        for (let page = start; page <= end; page++) { selection.add(page); if (selection.size > 5) fail('page_limit'); }
      }
      const pages = []; let budget = SNAPSHOT_LIMITS.returned_text_bytes;
      for (const page of selection) {
        if (!budget) break;
        const segment = document.segments[page - 1], text = clipBytes(segment.text, budget);
        budget -= Buffer.byteLength(text);
        pages.push({ page, text, truncated: segment.truncated || text !== segment.text });
      }
      return { path: metadata.path, pages, truncated: pages.length < selection.size || pages.some(page => page.truncated),
        scope: { ...metadata.scope, requested_physical_pages: [...selection], returned_physical_pages: pages.map(page => page.page),
          text_bytes_limit: SNAPSHOT_LIMITS.returned_text_bytes, extraction: 'unpdf text only; no OCR' } };
    }),
  };
  const onOnly = {
    math_search: invoke(args => {
      const { query, limit } = queryArgs(args);
      return { results: search({ query, limit }).map(({ manuscript, score }) => ({ ...lookup.get(manuscript.id).metadata, score })),
        scope: 'restricted workflow BM25 via shipped createSearch; approved three-source index only; no proof verification' };
    }),
    math_manuscript: invoke(args => {
      keys(args, ['path', 'query'], []);
      if (Object.hasOwn(args, 'path') === Object.hasOwn(args, 'query')) fail('path_or_query_required');
      let found;
      if (Object.hasOwn(args, 'path')) found = locate(args.path);
      else {
        const { query } = queryArgs({ query: args.query });
        const result = search({ query, limit: 1 })[0];
        if (!result) return { source: null, scope: 'no match within approved three-source index' };
        found = lookup.get(result.manuscript.id);
      }
      const { document, metadata } = found;
      const first = document.segments[0];
      const excerpt = clipBytes(first.text, SNAPSHOT_LIMITS.returned_text_bytes);
      const outline = document.total_pages === null ? first.text.split(/\r\n?|\n/).flatMap((line, i) => /^#{1,6}\s/.test(line) ? [{ line: i + 1, title: clipBytes(line, 256) }] : []).slice(0, 20) : [];
      return { source: metadata, outline, excerpt: { page: first.page, line: first.page === null ? 1 : null, text: excerpt },
        truncated: first.truncated || excerpt !== first.text || document.segments.length > 1,
        scope: 'source-derived metadata and first text segment only; links do not expand snapshot access; no proof verification' };
    }),
  };
  const genericTools = freeze(Object.fromEntries(Object.entries(generic).map(([name, handler]) => [name, { ...GENERIC_DEFINITIONS[name], handler }])));
  const onTools = freeze(Object.fromEntries(Object.entries(onOnly).map(([name, handler]) => [name, { ...ON_ONLY_DEFINITIONS[name], handler }])));
  return freeze({ manifestHash, generic: genericTools, onOnly: onTools,
    conditions: { 'plugin-off': genericTools, 'plugin-on': { ...genericTools, ...onTools } },
    inventoryFingerprints: INVENTORY_FINGERPRINTS, implementation: 'restricted-workflow-snapshot/v1' });
}
