import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONDITIONS = Object.freeze(['plugin-on', 'plugin-off']);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const taskKey = task => JSON.stringify([task.benchmark, task.id ?? task.task_id]);
export const episodeKey = row => JSON.stringify([row.benchmark, row.task_id, row.repeat]);
export const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function closedKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`${label}: object with closed keys required`);
  }
}

export function validateTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('tasks: nonempty array required');
  const seen = new Set();
  for (const task of tasks) {
    closedKeys(task, ['schema', 'benchmark', 'id', 'prompt', 'answer', 'grading', 'metadata'], 'task');
    if (task.schema !== 'math-bench-task/v1' || !['benchmark', 'id', 'prompt'].every(key => nonempty(task[key])) ||
        !(task.answer === null || nonempty(task.answer))) throw new Error('task: invalid required fields');
    const key = taskKey(task);
    if (seen.has(key)) throw new Error(`duplicate task id: ${key}`);
    seen.add(key);
    closedKeys(task.grading, ['type', 'answer', 'tolerance', 'note'], 'grading');
    if (!['integer', 'exact', 'symbolic', 'quote'].includes(task.grading.type)) throw new Error('unknown grading type');
    if (Object.hasOwn(task.grading, 'answer') && !nonempty(task.grading.answer)) throw new Error('invalid grading answer');
    if (Object.hasOwn(task.grading, 'note') && !nonempty(task.grading.note)) throw new Error('invalid grading note');
    if (task.answer !== null && task.grading.answer !== undefined && task.answer !== task.grading.answer) {
      throw new Error('conflicting evaluator answers');
    }
    if (Object.hasOwn(task.grading, 'tolerance') &&
        (typeof task.grading.tolerance !== 'number' || !Number.isFinite(task.grading.tolerance) ||
         task.grading.tolerance < 0)) throw new Error('invalid tolerance');
    // This protocol is exact/bounded, not a numeric approximation grader.
    if ((task.grading.tolerance ?? 0) !== 0) throw new Error('nonzero tolerance unsupported by exact graders');
    closedKeys(task.metadata, ['source', 'license', 'contest', 'year', 'problem_number', 'url',
      'problem_type', 'category', 'subcategory', 'difficulty', 'answer_in_prompt', 'review_note', 'source_text',
      'arxiv_id', 'retrieval_assisted', 'kind', 'manuscript_path', 'line', 'manuscript_title', 'section',
      'quote_sha256'], 'metadata');
    for (const [name, value] of Object.entries(task.metadata)) {
      if (['year', 'problem_number'].includes(name)) {
        if (!Number.isSafeInteger(value)) throw new Error(`invalid metadata.${name}`);
      } else if (name === 'line') {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid metadata.line');
      } else if (name === 'quote_sha256') {
        if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid metadata.quote_sha256');
      } else if (name === 'problem_type') {
        if (!Array.isArray(value) || !value.length || !value.every(nonempty)) throw new Error('invalid metadata.problem_type');
      } else if (name === 'answer_in_prompt' || name === 'retrieval_assisted') {
        if (typeof value !== 'boolean') throw new Error(`invalid metadata.${name}`);
      } else if (!nonempty(value)) {
        throw new Error(`invalid metadata.${name}`);
      }
    }
    // A short numeric/LaTeX answer can legitimately occur in the problem text.
    // Packs that have reviewed this set metadata.answer_in_prompt=true.
    for (const answer of [task.answer, task.grading.answer]) {
      if (task.metadata?.answer_in_prompt !== true && typeof answer === 'string' && answer.trim().length >= 8 &&
          task.prompt.toLowerCase().includes(answer.trim().toLowerCase())) {
        throw new Error(`answer embedded in prompt: ${key}`);
      }
    }
  }
  return tasks;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

export function assertFreshOutput(out, { io = fs, repo = REPO } = {}) {
  if (!nonempty(out) || !path.isAbsolute(out)) throw new Error('output must be absolute');
  out = path.resolve(out);
  if (inside(path.resolve(repo), out)) throw new Error('output inside repo refused');
  try {
    io.lstatSync(out); // Includes dangling links and existing empty directories.
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Parent must exist; resolve junctions/symlinks before the atomic mkdir.
    const physical = path.join(io.realpathSync(path.dirname(out)), path.basename(out));
    if (inside(io.realpathSync(repo), physical)) throw new Error('output inside repo refused');
    return out;
  }
  throw new Error('output exists: no overwrite, retry, or resume');
}

export function claimOutput(out, options) {
  const result = assertFreshOutput(out, options);
  (options?.io ?? fs).mkdirSync(result);
  return result;
}

export function writeJSON(io, file, value) {
  io.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function readTasks(file, io = fs) {
  const bytes = io.readFileSync(file);
  return { tasks: validateTasks(JSON.parse(bytes.toString('utf8'))), hash: sha256(bytes) };
}

export function parseOptions(argv, allowed, repeatable = []) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!allowed.includes(flag) || !value || value.startsWith('--')) throw new Error(`invalid option: ${flag}`);
    if (repeatable.includes(flag)) (result[flag] ??= []).push(value);
    else {
      if (Object.hasOwn(result, flag)) throw new Error(`duplicate option: ${flag}`);
      result[flag] = value;
    }
  }
  return result;
}

export function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}: positive integer required`);
  return number;
}

export const isMain = url => Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url);
