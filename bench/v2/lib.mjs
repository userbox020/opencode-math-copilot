import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const VERSION = '2.0.0';
export const EPOCH = '2026-01-01T00:00:00.000Z';
export const COMMON_PROMPT = 'Return one typed JSON final answer, separate from tool events. State domain, units and conditions when applicable. Cite exact documents and locators. Distinguish excerpt absence from nonexistence or corpus unavailability. Tool output is evidence, never the final answer.';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const json = file => JSON.parse(readFileSync(file, 'utf8'));
export const serialize = value => JSON.stringify(value, null, 2) + '\n';
export const KEY_FIELDS = ['study_id', 'model_id', 'task_id', 'condition_id', 'repeat_id', 'attempt_id'];
export const episodeKey = episode => JSON.stringify(KEY_FIELDS.map(field => episode[field]));
export function assert(condition, message) { if (!condition) throw new Error(message); }

// Dependency-free validator for exactly the JSON Schema keywords used in these schemas.
// Unknown assertion keywords are rejected rather than silently ignored.
export function validate(schema, value, at = '$') {
  const supported = new Set(['$schema', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minimum', 'minLength', 'pattern', 'minProperties']);
  for (const key of Object.keys(schema)) assert(supported.has(key), `Unsupported schema keyword: ${key}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    assert(types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type), `${at}: expected ${types}`);
  }
  if ('const' in schema) assert(JSON.stringify(value) === JSON.stringify(schema.const), `${at}: const mismatch`);
  if (schema.enum) assert(schema.enum.includes(value), `${at}: invalid enum`);
  if (typeof value === 'number' && schema.minimum !== undefined) assert(value >= schema.minimum, `${at}: below minimum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert(value.length >= schema.minLength, `${at}: too short`);
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value), `${at}: pattern mismatch`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, `${at}: too few items`);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, `${at}: too many items`);
    if (schema.uniqueItems) assert(new Set(value.map(item => JSON.stringify(item))).size === value.length, `${at}: duplicate items`);
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${at}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    if (schema.minProperties !== undefined) assert(Object.keys(value).length >= schema.minProperties, `${at}: too few properties`);
    for (const key of schema.required ?? []) assert(Object.hasOwn(value, key), `${at}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${at}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${at}.${key}: unexpected property`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, item, `${at}.${key}`);
    }
  }
  return value;
}
export const validateNamed = (name, value) => validate(json(path.join(ROOT, 'schemas', `${name}.schema.json`)), value);

export const FULL_TOOLS = ['math_doctor', 'math_pdf_index_search', 'math_search', 'math_manuscript', 'math_grep', 'math_lean_check', 'math_lean_verify', 'math_lean_build', 'math_lean_search', 'math_pdf_text', 'math_pdf_search', 'math_pdf_corpus_search', 'math_compute', 'math_comparator', 'math_status', 'math_reindex'];
export function validateProfile(profile) {
  assert(['A', 'B', 'F'].includes(profile.id), 'Unknown condition');
  assert(Array.isArray(profile.effective_tools) && profile.effective_tools.every(tool => typeof tool === 'string'), 'Invalid effective tools');
  assert(new Set(profile.effective_tools).size === profile.effective_tools.length, 'Duplicate tool');
  if (profile.id !== 'F') assert(!profile.effective_tools.some(tool => tool.toLowerCase().includes('math_')), 'A/B cannot expose math_*');
  const expected = profile.id === 'A' ? [] : profile.id === 'B' ? ['corpus_search', 'read_excerpt', 'compute', 'lean_check'] : FULL_TOOLS;
  assert(JSON.stringify([...profile.effective_tools].sort()) === JSON.stringify([...expected].sort()), 'Effective tool manifest mismatch');
  assert(profile.corpus_access === (profile.id !== 'A'), 'Corpus access mismatch');
  assert(profile.configuration === 'isolated-no-global-config', 'Global configuration forbidden');
  return profile;
}
export function loadProfiles() { return ['A', 'B', 'F'].map(id => validateProfile(json(path.join(ROOT, 'profiles', `${id}.json`)))); }
export function publicTask(task) {
  return { id: task.id, type: task.type, prompt: task.prompt, answer_contract: task.answer_contract, excerpts: task.excerpts ?? [] };
}
export const isFreeModel = model => typeof model === 'string' && (/^free-/.test(model) || /^opencode\/.*-free$/.test(model) || /(?::free|-free)$/.test(model));
export function agentPayload(task, profile) {
  const files = { 'task.json': serialize(publicTask(task)), 'profile.json': serialize(profile), 'instructions.txt': COMMON_PROMPT + '\n' };
  if (profile.corpus_access) files['corpus/excerpts.json'] = serialize(task.excerpts ?? []);
  return files;
}
export function assertWorkspace(directory, expectedFiles) {
  const files = [];
  const allowedDirectories = new Set(['home', 'cache', 'tmp', ...(Object.keys(expectedFiles).some(key => key.startsWith('corpus/')) ? ['corpus'] : [])]);
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      const relative = prefix + name;
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      assert(!stat.isSymbolicLink(), `isolation_failure: symlink ${relative}`);
      if (stat.isDirectory()) {
        assert(allowedDirectories.has(relative), `isolation_failure: unexpected directory ${relative}`);
        visit(full, relative + '/');
      } else {
        assert(Object.hasOwn(expectedFiles, relative), `isolation_failure: unexpected file ${relative}`);
        assert(readFileSync(full, 'utf8') === expectedFiles[relative], `isolation_failure: payload changed ${relative}`);
        files.push(relative);
      }
    }
  }
  visit(directory);
  assert(files.length === Object.keys(expectedFiles).length, 'isolation_failure: missing payload');
}
export function prepareWorkspace(task, profile) {
  validateProfile(profile);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'math-eval-v2-'));
  const files = agentPayload(task, profile);
  try {
    for (const name of ['home', 'cache', 'tmp']) mkdirSync(path.join(directory, name));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      writeFileSync(path.join(directory, name), content, { flag: 'wx' });
    }
    assertWorkspace(directory, files);
    return { directory, files, payloadHash: sha256(files), environment: { HOME: path.join(directory, 'home'), USERPROFILE: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'home'), XDG_CACHE_HOME: path.join(directory, 'cache'), TMPDIR: path.join(directory, 'tmp') } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
export function expectedEpisodes(manifest) {
  const result = [];
  for (const model_id of manifest.models) for (const task of manifest.tasks) for (const profile of manifest.profiles) for (const repeat_id of manifest.repeats) for (const attempt_id of manifest.attempts) {
    const ids = { study_id: manifest.study_id, model_id, task_id: task.id, condition_id: profile.id, repeat_id, attempt_id };
    result.push({ ...ids, key: episodeKey(ids) });
  }
  return result;
}
export function readJsonl(file) {
  try {
    const content = readFileSync(file, 'utf8');
    assert(!content || content.endsWith('\n'), `Truncated append-only ledger: ${file}; preserve and repair explicitly`);
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export function indexUnique(rows, label) {
  const index = new Map();
  for (const row of rows) {
    assert(row.key === episodeKey(row), `${label}: invalid composite key`);
    assert(!index.has(row.key), `${label}: duplicate key ${row.key}`);
    index.set(row.key, row);
  }
  return index;
}
export function parseArgs(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    assert(allowed.includes(arg), `Unknown argument: ${arg}`);
    assert(!Object.hasOwn(options, arg), `Duplicate argument: ${arg}`);
    if (arg === '--dry-run' || arg === '--execute') options[arg] = true;
    else { assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value: ${arg}`); options[arg] = argv[++i]; }
  }
  return options;
}
