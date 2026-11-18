import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim());
const proofBearing = text => /:=|=>|\bbegin\b[\s\S]*\bend\b|\bby\s+(?:\n|\r|exact\b|simp\b|rfl\b|aesop\b|omega\b|intro\b|apply\b|decide\b|native_decide\b)|```|\b(?:q\.?e\.?d\.?|sorry|admit)\b|^\s*(?:exact|intro|apply|have|show|fun|rfl|simp)\b/im.test(text);

export function validateConfig(config, filename) {
  if (!object(config)) throw new Error(`Invalid config: ${filename}`);
  for (const key of ['challenge_module', 'solution_module']) {
    if (typeof config[key] !== 'string' || !config[key].trim() || /[/\\\s]/.test(config[key])) {
      throw new Error(`Invalid ${key}: ${filename}`);
    }
  }
  for (const key of ['theorem_names', 'permitted_axioms']) {
    if (!strings(config[key])) throw new Error(`Invalid ${key}: ${filename}`);
  }
  for (const key of ['definition_names', 'solution_imports']) {
    if (config[key] !== undefined && !strings(config[key])) throw new Error(`Invalid ${key}: ${filename}`);
  }
  if (config.enable_nanoda !== undefined && typeof config.enable_nanoda !== 'boolean') {
    throw new Error(`Invalid enable_nanoda: ${filename}`);
  }
  // Prompt fields can contain arbitrary term proofs, which cannot reliably be
  // recognized lexically. Fail closed; generate our own request instead.
  if (config.prompt !== undefined && config.prompt !== '') {
    throw new Error(`Refusing proof-bearing or untrusted prompt: ${filename}`);
  }
  for (const key of ['formal_statement', 'description']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || proofBearing(config[key]))) {
      throw new Error(`Refusing proof-bearing or invalid ${key}: ${filename}`);
    }
  }
  return config;
}

export function readChallenge(corpus, relative) {
  if (typeof relative !== 'string' || !/^lean\/ComparatorChallenges\/[^/\\]+\.json$/.test(relative)) {
    throw new Error(`Invalid challenge path: ${relative}`);
  }
  const root = fs.realpathSync(corpus);
  const filename = fs.realpathSync(path.join(root, relative)); // Missing configs fail closed.
  const rel = path.relative(root, filename);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Challenge escapes corpus');
  const bytes = fs.readFileSync(filename);
  return { config: validateConfig(JSON.parse(bytes), relative), hash: sha256(bytes), filename };
}

function taskFor(filename, config, hash) {
  const id = `comparator-${filename.slice(0, -5)}`;
  const description = config.formal_statement || config.description ||
    `Reproduce the declarations ${config.theorem_names.join(', ') || '(definitions only)'} from ${config.challenge_module}.`;
  return {
    id,
    benchmark: 'comparator-challenges',
    challenge_path: `lean/ComparatorChallenges/${filename}`,
    challenge_sha256: hash,
    formal_statement: description,
    prompt: `Provide a Lean proof of the challenge specified by ${config.challenge_module}: ${description} Use the challenge statements and the permitted axioms in its JSON config. This is retrieval-assisted reproduction of the local corpus, not fresh proof discovery. The proof body is intentionally not included here.`,
    grading: { type: 'comparator', task_id: id, challenge_sha256: hash },
    metadata: { source: 'local corpus', retrieval_assisted: true, license: 'verify' },
  };
}

export function generatePack(corpus, count = 8) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid task count');
  const directory = path.join(corpus, 'lean', 'ComparatorChallenges');
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort(compare);
  const ids = new Set();
  const tasks = files.map(filename => {
    const { config, hash } = readChallenge(corpus, `lean/ComparatorChallenges/${filename}`);
    const task = taskFor(filename, config, hash);
    const normalized = task.id.toLowerCase();
    if (ids.has(normalized)) throw new Error(`Duplicate id: ${task.id}`);
    ids.add(normalized);
    // Only explicit statement/description length is a complexity proxy.
    const statement = config.formal_statement || config.description;
    return { task, size: statement ? statement.length : Infinity, order: sha256(filename) };
  });
  if (tasks.length < count) throw new Error(`Missing configs: need ${count}, found ${tasks.length}`);
  tasks.sort((a, b) => (a.size === b.size ? 0 : a.size < b.size ? -1 : 1) || compare(a.order, b.order));
  const pack = {
    schema: 'comparator-pack/v1',
    retrieval_assisted: true,
    selection: 'Explicit statement/description length first; filename SHA-256 tie-break and fallback.',
    tasks: tasks.slice(0, count).map(x => x.task),
  };
  validatePack(pack, corpus);
  return pack;
}

export function validatePack(pack, corpus) {
  if (pack?.schema !== 'comparator-pack/v1' || pack.retrieval_assisted !== true ||
      !Array.isArray(pack.tasks) || !pack.tasks.length) throw new Error('Invalid pack');
  const ids = new Set();
  const paths = new Set();
  for (const task of pack.tasks) {
    if (typeof task?.id !== 'string' || ids.has(task.id.toLowerCase()) || paths.has(task.challenge_path)) {
      throw new Error(`Duplicate or invalid id/path: ${task?.id}`);
    }
    ids.add(task.id.toLowerCase());
    paths.add(task.challenge_path);
    const { config, hash } = readChallenge(corpus, task.challenge_path);
    if (task.challenge_sha256 !== hash || task.grading?.challenge_sha256 !== hash) {
      throw new Error(`Hash mismatch: ${task.id}`);
    }
    const expected = taskFor(path.posix.basename(task.challenge_path), config, hash);
    for (const key of ['id', 'benchmark', 'formal_statement', 'prompt']) {
      if (task[key] !== expected[key]) throw new Error(`Invalid or proof-bearing ${key}: ${task.id}`);
    }
    if (task.grading.type !== 'comparator' || task.grading.task_id !== task.id ||
        task.metadata?.source !== 'local corpus' || task.metadata.retrieval_assisted !== true ||
        task.metadata.license !== 'verify') throw new Error(`Invalid task binding: ${task.id}`);
  }
  return pack;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--corpus' || !path.isAbsolute(args[1])) {
      throw new Error('Usage: node pack.mjs --corpus <absolute-corpus-directory>');
    }
    const pack = generatePack(args[1]);
    fs.writeFileSync(new URL('./tasks.json', import.meta.url), `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx' });
    console.log(`Generated ${pack.tasks.length} retrieval-assisted tasks.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
