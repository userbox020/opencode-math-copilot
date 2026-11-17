import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertLogicalPath, createMaskPolicy } from './mask-policy.mjs';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function filesystem(action) {
  try {
    return action();
  } catch (error) {
    fail(error.code === 'ENOENT' || error.code === 'ENOTDIR'
      ? 'excerpt_source_missing' : 'excerpt_source_unsafe');
  }
}

function assertContained(root, target) {
  const child = relative(root, target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail('excerpt_source_unsafe');
  }
}

/**
 * Build an in-memory snapshot from a trusted, reviewed span list. All input and
 * filesystem metadata validation precedes content reads. Source hashes bind the
 * review to exact bytes; the corpus must remain stable during this synchronous
 * build (this is not a sandbox against concurrent filesystem replacement).
 */
export function buildExcerptSnapshot(options) {
  if (!record(options)) fail('excerpt_arguments_invalid');
  const { taskId, corpusRoot, sources } = options;
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)
    || typeof corpusRoot !== 'string' || corpusRoot.includes('\0') || !isAbsolute(corpusRoot)
    || !Array.isArray(sources) || !sources.length) {
    fail('excerpt_arguments_invalid');
  }

  // Copy only validated fields; later caller mutations cannot change provenance.
  const seen = new Set();
  const reviewed = Array.from(sources, source => {
    if (!record(source)) fail('excerpt_arguments_invalid');
    const { path, expectedSha256, spans } = source;
    try {
      assertLogicalPath(path);
    } catch {
      fail('excerpt_source_unsafe');
    }
    // Also exclude Windows alternate data streams / drive syntax in any segment.
    if (path.includes(':')) fail('excerpt_source_unsafe');
    if (seen.has(path) || typeof expectedSha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(expectedSha256)) fail('excerpt_arguments_invalid');
    seen.add(path);
    if (!Array.isArray(spans) || !spans.length) fail('excerpt_span_invalid');
    let previous;
    const approvedSpans = Array.from(spans, span => {
      if (!record(span) || !Number.isSafeInteger(span.startLine)
        || !Number.isSafeInteger(span.endLine) || span.startLine < 1
        || span.startLine > span.endLine) fail('excerpt_span_invalid');
      if (span.approval !== 'public' && span.approval !== 'reviewed-span') {
        fail('excerpt_span_unapproved');
      }
      if (previous && span.startLine < previous.startLine) fail('excerpt_span_invalid');
      if (previous && span.startLine <= previous.endLine) fail('excerpt_span_overlap');
      previous = Object.freeze({
        startLine: span.startLine, endLine: span.endLine, approval: span.approval,
      });
      return previous;
    });
    return { path, expectedSha256: expectedSha256.toLowerCase(), spans: Object.freeze(approvedSpans) };
  });
  const root = filesystem(() => realpathSync(corpusRoot));
  if (!filesystem(() => statSync(root)).isDirectory()) fail('excerpt_arguments_invalid');
  const resolved = reviewed.map(source => {
    const candidate = resolve(root, source.path);
    assertContained(root, candidate);
    const filename = filesystem(() => realpathSync(candidate));
    assertContained(root, filename);
    if (!filesystem(() => statSync(filename)).isFile()) fail('excerpt_source_unsafe');
    return { ...source, filename };
  });

  const excerpts = [];
  const provenance = [];
  for (const source of resolved) {
    const bytes = filesystem(() => readFileSync(source.filename));
    let text;
    try {
      // Preserve a UTF-8 BOM as text, and reject malformed UTF-8 rather than replace it.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail('excerpt_source_binary');
    }
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/u.test(text)) {
      fail('excerpt_source_binary');
    }
    const sha256 = hash(bytes);
    if (sha256 !== source.expectedSha256) fail('excerpt_source_hash_mismatch');
    const lines = text.split(/\r\n|\r|\n/);
    const approved = [];
    for (const { startLine, endLine } of source.spans) {
      if (endLine > lines.length) fail('excerpt_span_invalid');
      approved.push(lines.slice(startLine - 1, endLine).join('\n'));
    }
    const excerpt = approved.join('\n');
    if (!excerpt.trim().length) fail('excerpt_empty');
    excerpts.push({
      logicalPath: source.path, text: excerpt,
      approval: source.spans.every(span => span.approval === 'public') ? 'public' : 'reviewed-span',
    });
    provenance.push(Object.freeze({
      path: source.path, sha256, spans: source.spans, excerptSha256: hash(excerpt),
    }));
  }
  const policy = createMaskPolicy(excerpts);
  provenance.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({
    taskId, policy, manifest: policy.manifest, provenance: Object.freeze(provenance),
  });
}

/** Check all sentinel arguments before consulting the approved-only policy. */
export function assertNoAnswerBearing(snapshot, sentinels) {
  if (!record(snapshot) || typeof snapshot.policy?.assertNoSentinel !== 'function'
    || !Array.isArray(sentinels)) fail('excerpt_arguments_invalid');
  for (const sentinel of sentinels) {
    if (typeof sentinel !== 'string' || sentinel.length < 8) fail('excerpt_arguments_invalid');
  }
  for (const sentinel of sentinels) {
    try {
      snapshot.policy.assertNoSentinel(sentinel);
    } catch (error) {
      fail(error.code === 'mask_sentinel_present' ? 'mask_sentinel_present' : 'excerpt_arguments_invalid');
    }
  }
  return sentinels.length;
}
