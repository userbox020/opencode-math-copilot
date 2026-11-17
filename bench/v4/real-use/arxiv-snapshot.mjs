import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { createMaskPolicy } from './mask-policy.mjs';

const SCHEMA = 'real-use-arxiv-snapshot/v1';
const PATHS = Object.freeze(['formal-statement.lean', 'problem.md']);
const REPOSITORY = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const keys = (value, names) => record(value) && Reflect.ownKeys(value).length === names.length
  && names.every(name => Object.hasOwn(value, name));

function filesystem(action) {
  try { return action(); } catch (error) {
    if (error.code?.startsWith('arxiv_snapshot_')) throw error;
    fail(error.code === 'EEXIST' ? 'arxiv_snapshot_exists'
      : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'arxiv_snapshot_missing' : 'arxiv_snapshot_unsafe');
  }
}

function taskId(value) {
  if (typeof value !== 'string' || !/^arxivlean-[0-9]{2}$/.test(value)) fail('arxiv_snapshot_invalid');
}

function within(root, target) {
  const child = relative(root, target);
  return !child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

// Resolve even a not-yet-created root through its existing ancestors. A junction
// into the repository cannot evade the outside-repository requirement.
function externalDirectory(value) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) fail('arxiv_snapshot_invalid');
  const target = resolve(value);
  if (within(REPOSITORY, target)) fail('arxiv_snapshot_unsafe');
  let ancestor = target;
  for (;;) {
    try {
      const canonical = realpathSync(ancestor);
      const result = resolve(canonical, relative(ancestor, target));
      if (within(REPOSITORY, result)) fail('arxiv_snapshot_unsafe');
      return result;
    } catch (error) {
      if (error.code !== 'ENOENT') return filesystem(() => { throw error; });
      const parent = dirname(ancestor);
      if (parent === ancestor) fail('arxiv_snapshot_missing');
      ancestor = parent;
    }
  }
}

function decode(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('arxiv_snapshot_binary'); }
  if (text.includes('\0')) fail('arxiv_snapshot_binary');
  if (!text.trim()) fail('arxiv_snapshot_invalid');
  return text;
}

function readDirectory(directory) {
  const stat = filesystem(() => lstatSync(directory));
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('arxiv_snapshot_unsafe');
  const names = filesystem(() => readdirSync(directory));
  if (names.some(name => !PATHS.includes(name))) fail('arxiv_snapshot_unexpected_file');
  if (PATHS.some(name => !names.includes(name))) fail('arxiv_snapshot_missing');
}

function readRegularFile(directory, name) {
  const filename = join(directory, name);
  const stat = filesystem(() => lstatSync(filename));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('arxiv_snapshot_unsafe');
  return filesystem(() => readFileSync(filename));
}

function metadata(files) {
  return files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
}

function makeSnapshot(id, files) {
  const policy = createMaskPolicy(files.map(file => ({
    logicalPath: file.path, text: file.text, approval: 'public',
  })));
  return Object.freeze({
    schema: SCHEMA, taskId: id, files: Object.freeze(files.map(Object.freeze)),
    manifestSha256: hash(JSON.stringify(metadata(files))), policy,
  });
}

/**
 * Reserve the task directory with atomic mkdir (no overwrite, including empty
 * directories), then exclusively create its two files. Readers reject partial
 * stages. Callers must keep the external parent stable; this is not an OS sandbox
 * against a concurrent adversary replacing filesystem entries.
 */
export function stagePublicInput(task, { root } = {}) {
  if (!record(task)) fail('arxiv_snapshot_invalid');
  taskId(task.id);
  const texts = [task.formal_statement, task.problem].map(text => {
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) fail('arxiv_snapshot_invalid');
    const normalized = text.replace(/\r\n?/g, '\n');
    // Reject lone UTF-16 surrogates rather than silently replacing public input.
    if (Buffer.from(normalized, 'utf8').toString('utf8') !== normalized) fail('arxiv_snapshot_binary');
    return normalized;
  });
  const base = externalDirectory(root);
  filesystem(() => mkdirSync(base, { recursive: true, mode: 0o700 }));
  const directory = join(base, task.id);
  filesystem(() => mkdirSync(directory, { mode: 0o700 }));
  const expected = {};
  PATHS.forEach((name, i) => {
    const bytes = Buffer.from(texts[i], 'utf8');
    filesystem(() => writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o600 }));
    expected[name] = hash(bytes);
  });
  return Object.freeze({ taskId: task.id, root: base, directory, expected: Object.freeze(expected) });
}

export function buildPublicInputSnapshot({ taskId: id, root, expected } = {}) {
  taskId(id);
  if (!keys(expected, PATHS) || PATHS.some(name => !isHash(expected[name]))) fail('arxiv_snapshot_invalid');
  const directory = join(externalDirectory(root), id);
  readDirectory(directory);
  const contents = PATHS.map(path => {
    const bytes = readRegularFile(directory, path);
    const sha256 = hash(bytes);
    if (sha256 !== expected[path]) fail('arxiv_snapshot_hash_mismatch');
    return { path, bytes, sha256 };
  });
  // Verify ALL hashes before validating any content.
  const files = contents.map(({ path, bytes, sha256 }) => ({
    path, bytes: bytes.length, sha256, text: decode(bytes),
  }));
  return makeSnapshot(id, files);
}

/**
 * manifestSha256 commits to sorted file metadata; expectedManifestHash commits
 * to the complete manifest.json bytes, including schema and taskId. Pass the
 * latter to createArxivSnapshotTools. They are intentionally different hashes.
 */
export function writeStagedSnapshot(snapshot, { out } = {}) {
  if (!record(snapshot) || snapshot.schema !== SCHEMA) fail('arxiv_snapshot_invalid');
  taskId(snapshot.taskId);
  if (!Array.isArray(snapshot.files) || snapshot.files.length !== PATHS.length) fail('arxiv_snapshot_invalid');
  const contents = snapshot.files.map((file, i) => {
    if (!keys(file, ['path', 'bytes', 'sha256', 'text']) || file.path !== PATHS[i]
      || typeof file.text !== 'string' || !Number.isSafeInteger(file.bytes) || !isHash(file.sha256)) {
      fail('arxiv_snapshot_invalid');
    }
    const bytes = Buffer.from(file.text, 'utf8');
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('arxiv_snapshot_hash_mismatch');
    if (decode(bytes) !== file.text) fail('arxiv_snapshot_binary');
    return bytes;
  });
  const files = metadata(snapshot.files);
  const manifestSha256 = hash(JSON.stringify(files));
  if (manifestSha256 !== snapshot.manifestSha256) fail('arxiv_snapshot_hash_mismatch');
  const manifest = { schema: SCHEMA, taskId: snapshot.taskId, files, manifestSha256 };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const directory = externalDirectory(out);
  filesystem(() => mkdirSync(dirname(directory), { recursive: true, mode: 0o700 }));
  filesystem(() => mkdirSync(directory, { mode: 0o700 }));
  PATHS.forEach((name, i) => filesystem(() =>
    writeFileSync(join(directory, name), contents[i], { flag: 'wx', mode: 0o600 })));
  filesystem(() => writeFileSync(join(directory, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 }));
  return Object.freeze({ snapshotRoot: directory, manifestSha256, expectedManifestHash: hash(bytes) });
}
