import { createHash } from 'node:crypto';

const SCHEMA = 'real-use-mask-manifest/v1';
const MAX_TERM_LENGTH = 1024;
const MAX_RESULTS = 100;
const MAX_PREVIEW_LENGTH = 120;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function assertPath(logicalPath) {
  if (typeof logicalPath !== 'string' || !logicalPath.length || logicalPath.length > 256
    || logicalPath !== logicalPath.normalize('NFC')
    || logicalPath.startsWith('/') || /^[a-z]:/i.test(logicalPath)
    || /[\\*?[\]{}]|\p{Cc}/u.test(logicalPath)
    || logicalPath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    fail('mask_path_unsafe');
  }
}

export { assertPath as assertLogicalPath };

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestHash(files) {
  return hash(JSON.stringify({ schema: SCHEMA, files }));
}

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

/**
 * Validate a self-contained, data-only manifest. `bytes` contains UTF-8 octets,
 * not a byte count: this permits recomputation without filesystem access,
 * hidden registries, or an unapproved source fallback.
 * Integrity is not authentication; callers must separately bind the trusted hash.
 */
export function validateManifest(manifest) {
  try {
    if (!hasKeys(manifest, ['schema', 'files', 'manifestSha256'])
      || manifest.schema !== SCHEMA || !Array.isArray(manifest.files)) {
      fail('mask_manifest_hash_mismatch');
    }
    const files = [];
    let previousPath;
    for (const file of manifest.files) {
      if (!hasKeys(file, ['logicalPath', 'bytes', 'sha256'])) {
        fail('mask_manifest_hash_mismatch');
      }
      assertPath(file.logicalPath);
      if (previousPath !== undefined && previousPath >= file.logicalPath) {
        fail('mask_manifest_hash_mismatch');
      }
      previousPath = file.logicalPath;
      if (!Array.isArray(file.bytes)) fail('mask_manifest_hash_mismatch');
      for (const byte of file.bytes) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
          fail('mask_manifest_hash_mismatch');
        }
      }
      if (hash(Buffer.from(file.bytes)) !== file.sha256) {
        fail('mask_manifest_hash_mismatch');
      }
      files.push({ logicalPath: file.logicalPath, bytes: [...file.bytes], sha256: file.sha256 });
    }
    if (manifestHash(files) !== manifest.manifestSha256) {
      fail('mask_manifest_hash_mismatch');
    }
    return true;
  } catch {
    fail('mask_manifest_hash_mismatch');
  }
}

/** In-memory approved excerpts only; no paths are ever resolved or opened. */
export function createMaskPolicy(excerpts) {
  if (!Array.isArray(excerpts)) fail('mask_excerpt_invalid');
  const texts = new Map();
  for (const excerpt of excerpts) {
    if (!excerpt || typeof excerpt !== 'object' || Array.isArray(excerpt)) {
      fail('mask_excerpt_invalid');
    }
    const { logicalPath, text, approval } = excerpt;
    assertPath(logicalPath);
    if (approval !== 'public' && approval !== 'reviewed-span') {
      fail('mask_approval_invalid');
    }
    if (typeof text !== 'string') fail('mask_excerpt_invalid');
    if (texts.has(logicalPath)) fail('mask_duplicate_path');
    texts.set(logicalPath, text);
  }
  const paths = [...texts.keys()].sort();
  const files = Object.freeze(paths.map(logicalPath => {
    const bytes = Object.freeze([...Buffer.from(texts.get(logicalPath), 'utf8')]);
    return Object.freeze({ logicalPath, bytes, sha256: hash(Buffer.from(bytes)) });
  }));
  const manifest = Object.freeze({ schema: SCHEMA, files, manifestSha256: manifestHash(files) });

  return Object.freeze({
    manifest,
    read(logicalPath) {
      assertPath(logicalPath);
      if (!texts.has(logicalPath)) fail('mask_path_not_approved');
      return texts.get(logicalPath);
    },
    search(term) {
      if (typeof term !== 'string' || !term.length || term.length > MAX_TERM_LENGTH) {
        fail('mask_term_invalid');
      }
      const needle = term.toLowerCase();
      const results = [];
      for (const logicalPath of paths) {
        const lines = texts.get(logicalPath).split(/\r\n|\r|\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          results.push(Object.freeze({
            logicalPath,
            line: i + 1,
            preview: lines[i].slice(0, MAX_PREVIEW_LENGTH),
          }));
          if (results.length === MAX_RESULTS) return Object.freeze(results);
        }
      }
      return Object.freeze(results);
    },
    assertNoSentinel(sentinel) {
      if (typeof sentinel !== 'string' || sentinel.length < 8) fail('mask_term_invalid');
      for (const text of texts.values()) {
        if (text.includes(sentinel)) fail('mask_sentinel_present');
      }
      return true;
    },
  });
}
