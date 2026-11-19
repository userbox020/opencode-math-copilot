import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPO, claimOutput, isMain, parseOptions, readTasks, sha256, taskKey, writeJSON,
} from './schema.mjs';

export const GRADING_RULES = 'bounded-final-answer/v1';

export function extractFinal(text) {
  text = String(text ?? '').trim();
  if (!text) return null;
  const candidates = [];
  for (const match of text.matchAll(/\\boxed\s*\{/g)) {
    const start = match.index + match[0].length;
    let depth = 1, i = start;
    for (; i < text.length && depth; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
    }
    if (depth) return null;
    candidates.push({ index: match.index, value: text.slice(start, i - 1) });
  }
  for (const match of text.matchAll(/^(?:final(?: answer)?|answer)\s*:\s*(.+)$/gim)) {
    candidates.push({ index: match.index, value: match[1] });
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.index - b.index);
    return candidates.at(-1).value.trim();
  }
  return text.split(/\r?\n/).filter(line => line.trim()).at(-1).trim();
}

export function normalizeExact(value) {
  return String(value).replace(/\\[()[\]]/g, '').replace(/\$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeSymbolic(value) {
  const result = String(value).replace(/\\[()[\]]/g, '').replace(/\$/g, '')
    .replace(/\\(?:left|right)\b/g, '').replace(/\\[,!]/g, '').replace(/\s+/g, '');
  if (!result || result.length > 512) return null;
  // Small grammar only: numeric literals, single-letter variables, arithmetic,
  // parentheses/braces, and \frac, \sqrt, \pi. No eval or algebraic guessing.
  const tokens = result.match(/\\(?:frac|sqrt|pi)\b|[A-Za-z]|\d+(?:\.\d+)?|[+\-*/^(){}]/g);
  if (!tokens || tokens.join('') !== result) return null;
  let position = 0;
  const group = (open, close) => {
    if (tokens[position++] !== open) throw new Error('group');
    expression();
    if (tokens[position++] !== close) throw new Error('group');
  };
  const atom = () => {
    const token = tokens[position];
    if (token === '(') return group('(', ')');
    if (token === '{') return group('{', '}');
    position++;
    if (token === '\\frac') { group('{', '}'); group('{', '}'); return; }
    if (token === '\\sqrt') { group('{', '}'); return; }
    if (token === '\\pi' || /^[A-Za-z]$/.test(token ?? '') || /^\d+(?:\.\d+)?$/.test(token ?? '')) return;
    throw new Error('atom');
  };
  const factor = () => {
    if (['+', '-'].includes(tokens[position])) position++;
    atom();
    if (tokens[position] === '^') { position++; factor(); }
  };
  const term = () => {
    factor();
    while (['*', '/'].includes(tokens[position])) { position++; factor(); }
  };
  const expression = () => {
    term();
    while (['+', '-'].includes(tokens[position])) { position++; term(); }
  };
  try { expression(); } catch { return null; }
  return position === tokens.length ? result : null;
}

function lastInteger(value) {
  const text = normalizeExact(value);
  // Do not misread parts of decimals, fractions, exponents, or grouped numbers.
  if (/\d[.,/]\d|\d\s*\/\s*\d|\d\s*\^|\d[eE][+-]?\d|\\frac/.test(text)) return null;
  const matches = [...text.matchAll(/(?<![\w.])[+-]?\d+(?![\w.])/g)];
  return matches.length ? BigInt(matches.at(-1)[0]) : null;
}

export function symbolicEquivalent(expected, extracted, { runner = spawnSync, python = 'python' } = {}) {
  const unparseable = reason => ({ status: 'unparseable', reason });
  try {
    const result = runner(python, ['-B', fileURLToPath(new URL('./symbolic_equiv.py', import.meta.url))], {
      input: JSON.stringify({ expected, extracted }), encoding: 'utf8',
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, shell: false, windowsHide: true,
    });
    if (result.error?.code === 'ETIMEDOUT') return unparseable('Symbolic Python comparison timed out after 5 seconds');
    if (result.error) return unparseable(`Symbolic Python unavailable or failed: ${result.error.code ?? result.error.message}`);
    if (result.status !== 0 || result.signal) return unparseable('Symbolic Python failed; Python/SymPy may be unavailable');
    const comparison = JSON.parse(result.stdout);
    if (!['equivalent', 'different', 'unparseable'].includes(comparison?.status) || typeof comparison.reason !== 'string') {
      return unparseable('Invalid symbolic Python result');
    }
    return comparison;
  } catch (error) {
    return unparseable(`Symbolic Python comparison unavailable: ${error.message}`);
  }
}

export function gradeEpisode(episode, task, { symbolic = symbolicEquivalent } = {}) {
  const verdict = (status, reason, extracted = null) => ({ status, reason, extracted, grading_rules: GRADING_RULES });
  if (!episode || episode.status !== 'completed' || episode.exit_code !== 0 ||
      episode.error || episode.error_code || episode.signal || !String(episode.text ?? '').trim()) {
    return verdict('missing', 'No completed, successful answer; partial failure output is not graded');
  }
  const gold = task.grading.answer ?? task.answer;
  if (gold === null || gold === undefined) return verdict('unparseable', 'Evaluator gold unavailable');
  if (task.grading.type === 'quote') {
    // Retrieval tasks answer with a verbatim quote plus a locator. Search the
    // whole answer after whitespace normalization; the locator is a separate
    // audit, not a correctness condition.
    const normalizeQuote = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const expected = normalizeQuote(gold);
    const text = normalizeQuote(episode.text);
    if (!expected) return verdict('unparseable', 'Empty quote');
    if (!text) return verdict('unparseable', 'No answer text');
    const found = text.includes(expected);
    return verdict(found ? 'correct' : 'incorrect',
      found ? 'Whitespace-normalized quote present' : 'Whitespace-normalized quote absent',
      found ? expected.slice(0, 240) : null);
  }
  const extracted = extractFinal(episode.text);
  if (!extracted) return verdict('unparseable', 'Final answer not extractable');
  if (task.grading.type === 'integer') {
    if (!/^[+-]?\d+$/.test(gold.trim())) return verdict('unparseable', 'Gold is not an integer', extracted);
    const actual = lastInteger(extracted);
    return actual === null ? verdict('unparseable', 'Final answer has no unambiguous integer', extracted)
      : verdict(actual === BigInt(gold.trim()) ? 'correct' : 'incorrect', 'Last integer, exact BigInt comparison', extracted);
  }
  if (task.grading.type === 'exact') {
    const actual = normalizeExact(extracted), expected = normalizeExact(gold);
    if (!actual || !expected) return verdict('unparseable', 'Empty normalized answer', extracted);
    return verdict(actual === expected ? 'correct' : 'incorrect', 'Normalized exact-string comparison', extracted);
  }
  if (task.grading.type === 'symbolic') {
    const actual = normalizeSymbolic(extracted), expected = normalizeSymbolic(gold);
    if (actual && expected && actual === expected) return verdict('correct', 'Identical bounded canonical strings', extracted);
    // Different expressions may still be equivalent. Only distinct plain numeric
    // literals are confidently unequal without algebra or sampling.
    if (actual && expected && /^[+-]?\d+$/.test(actual) && /^[+-]?\d+$/.test(expected)) {
      return verdict(BigInt(actual) === BigInt(expected) ? 'correct' : 'incorrect', 'Integer literal comparison', extracted);
    }
    const comparison = symbolic(gold, extracted);
    return verdict(({ equivalent: 'correct', different: 'incorrect' })[comparison.status] ?? 'unparseable', comparison.reason, extracted);
  }
  return verdict('unparseable', 'Unknown grading type', extracted);
}

export function gradeRun({ run, tasksFile, out }, { io = fs, grader = gradeEpisode, repo = REPO } = {}) {
  const { tasks, hash } = readTasks(tasksFile, io);
  // plan.json permits honest missing counts after a killed/interrupted runner.
  const manifestFile = path.join(run, io.existsSync(path.join(run, 'manifest.json')) ? 'manifest.json' : 'plan.json');
  const manifestBytes = io.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== 'math-bench-manifest/v1' || manifest.task_file_sha256 !== hash) throw new Error('task file/manifest mismatch');
  const byTask = new Map(tasks.map(task => [taskKey(task), task]));
  const rows = manifest.schedule.map(row => {
    const task = byTask.get(taskKey(row));
    if (!task || sha256(task.prompt) !== row.prompt_sha256) throw new Error('schedule/prompt mismatch');
    const episodeFile = path.join(run, 'episodes', `${row.episode_id}.json`);
    let episode = null;
    try { episode = JSON.parse(io.readFileSync(episodeFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (episode && (episode.episode_id !== row.episode_id || episode.benchmark !== row.benchmark ||
        episode.task_id !== row.task_id || episode.repeat !== row.repeat || episode.prompt_sha256 !== row.prompt_sha256 ||
        episode.model !== manifest.model || episode.condition !== manifest.condition)) throw new Error('episode identity mismatch');
    const grade = grader(episode, task);
    if (!['correct', 'incorrect', 'unparseable', 'missing'].includes(grade.status)) throw new Error('invalid grader status');
    return {
      ...row, model: manifest.model, condition: manifest.condition,
      attempted: episode?.attempted === true, completed: episode?.status === 'completed',
      run_status: episode?.status ?? 'not_recorded', failure: episode?.failure ?? null,
      duration_ms: episode?.duration_ms ?? null, usage: episode?.usage ?? null, grade,
    };
  });
  const summary = {
    schema: 'math-bench-grades/v1', exploratory: true, not_confirmatory: true,
    run: path.resolve(run), manifest_sha256: sha256(manifestBytes), manifest,
    grading_rules: GRADING_RULES, rows,
  };
  const output = claimOutput(out, { io, repo });
  writeJSON(io, path.join(output, 'grades.json'), summary);
  return summary;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseOptions(argv, ['--run', '--tasks', '--out']);
  for (const name of ['--run', '--tasks', '--out']) if (!args[name]) throw new Error(`${name} required`);
  gradeRun({ run: args['--run'], tasksFile: args['--tasks'], out: args['--out'] });
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
