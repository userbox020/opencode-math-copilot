import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocumentProxy } from 'unpdf';
import { APPROVED_PATHS, SNAPSHOT_LIMITS, boundedBytes, clipBytes, contained, hashBytes } from './lib/snapshot-tools.mjs';

function fresh(file) {
  try { lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('snapshot_output_exists');
}
function outputPath(corpusRoot, out) {
  if (typeof out !== 'string' || !path.isAbsolute(out)) throw new Error('explicit_absolute_out_required');
  fresh(out);
  const parent = realpathSync(path.dirname(out));
  const target = path.join(parent, path.basename(out));
  if (target === corpusRoot || contained(corpusRoot, target) || contained(target, corpusRoot)) throw new Error('output_overlaps_source');
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    if (['gold', 'grader-data', 'rollouts', 'state', 'episodes', 'evaluation'].includes(path.basename(ancestor).toLowerCase()) ||
        ['gold.json', 'manifest.json', 'source-manifest.json', 'episodes.jsonl', 'review.csv'].some(marker => existsSync(path.join(ancestor, marker)))) {
      throw new Error('output_inside_gold_or_study');
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  fresh(target);
  return target;
}
async function derive(file, bytes) {
  if (!file.endsWith('.pdf')) {
    if (bytes.length > SNAPSHOT_LIMITS.text_bytes) throw new Error('source_text_limit');
    return { path: file, total_pages: null, segments: [{ page: null, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated: false }] };
  }
  // Trusted, fixed source PDFs only. No user paths/URLs, OCR, external resources,
  // full plugin import, persistent cache, embedded scripts, or execution tools.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    if (pdf.numPages > SNAPSHOT_LIMITS.pdf_pages) throw new Error('source_pdf_page_limit');
    const segments = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const { items } = await page.getTextContent();
        const full = items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
        const text = clipBytes(full, SNAPSHOT_LIMITS.page_text_bytes);
        segments.push({ page: number, text, truncated: text !== full });
      } finally { page.cleanup(); }
    }
    return { path: file, total_pages: pdf.numPages, segments };
  } finally {
    if (typeof pdf.destroy === 'function') await pdf.destroy();
    else await pdf.loadingTask?.destroy();
  }
}

export async function buildSnapshot(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['corpusRoot', 'out'].includes(key)) ||
      typeof config.corpusRoot !== 'string' || !path.isAbsolute(config.corpusRoot)) throw new Error('explicit_corpus_root_and_out_required');
  const corpusRoot = realpathSync(config.corpusRoot);
  const out = outputPath(corpusRoot, config.out);
  const sources = APPROVED_PATHS.map(logical => ({ logical, bytes: boundedBytes(corpusRoot, logical, SNAPSHOT_LIMITS.source_bytes) }));
  const documents = [];
  for (const source of sources) documents.push(await derive(source.logical, source.bytes));
  const indexBytes = Buffer.from(JSON.stringify({ schema: 'real-use-source-index/v1', documents }, null, 2) + '\n');
  if (indexBytes.length > SNAPSHOT_LIMITS.index_bytes) throw new Error('source_index_limit');
  const manifest = { schema: 'real-use-source-snapshot/v1', version: 1,
    scope: 'three approved sources only; no full archive, gold, state, or execution',
    files: sources.map(({ logical, bytes }) => ({ path: logical, kind: logical.endsWith('.pdf') ? 'pdf' : 'text', bytes: bytes.length, sha256: hashBytes(bytes) })),
    index: { path: 'source-index.json', bytes: indexBytes.length, sha256: hashBytes(indexBytes) } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  // All reads/extraction finish before atomically reserving a fresh output.
  mkdirSync(out);
  for (const { logical, bytes } of sources) {
    const target = path.join(out, logical);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o444 });
  }
  writeFileSync(path.join(out, 'source-index.json'), indexBytes, { flag: 'wx', mode: 0o444 });
  writeFileSync(path.join(out, 'source-manifest.json'), manifestBytes, { flag: 'wx', mode: 0o444 });
  return { manifestHash: hashBytes(manifestBytes), manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--corpus-root', '--out'].includes(args[i]) || Object.hasOwn(values, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('use_explicit_corpus_root_and_fresh_out');
      values[args[i]] = args[i + 1];
    }
    console.log(JSON.stringify(await buildSnapshot({ corpusRoot: values['--corpus-root'], out: values['--out'] }), null, 2));
  } catch (error) { console.error(error.code ? 'snapshot_filesystem_error' : error.message); process.exitCode = 1; }
}
