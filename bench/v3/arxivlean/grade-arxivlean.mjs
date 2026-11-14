#!/usr/bin/env node
// Archived-run diagnostics only. Independent proof checking is unavailable.
// Never execute submitted Lean or trust success markers in mixed source output.
//
// Usage:
//   node bench/v3/arxivlean/grade-arxivlean.mjs --out <run-dir> --report-out <fresh-dir>
//
// Expected input:
//   <out>/episodes/<taskid>.<condition>.json  (from run-arxivlean.mjs)
//   <out>/manifest.json
//   --tasks <arxivlean task JSON>             (default: tasks/arxivlean-smoke5.json)
//
// Output:
//   <report-out>/grades/<episode>.json
//   <report-out>/grade-summary.json (the original archive is read-only)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS = path.join(SCRIPT_DIR, 'tasks', 'arxivlean-smoke5.json');
const DEFAULT_IMAGE = 'opencode-math-comparator';
const DEFAULT_LEAN_VOLUME = 'opencode-math-lean';
const DEFAULT_TOOLS_VOLUME = 'opencode-comparator-tools';
// Historical structural heuristics, NOT a sandbox or proof acceptance boundary.
const FORBIDDEN = /\b(sorry|admit|axiom|constant|opaque|unsafe|native_decide|implemented_by)\b/;

function parseArgs(argv) {
  const args = { out: '', reportOut: '', tasks: DEFAULT_TASKS, image: DEFAULT_IMAGE, leanVolume: DEFAULT_LEAN_VOLUME, toolsVolume: DEFAULT_TOOLS_VOLUME, timeoutMs: 1800000, keep: false, only: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--out') args.out = next();
    else if (arg === '--report-out') args.reportOut = next();
    else if (arg === '--tasks') args.tasks = next();
    else if (arg === '--image') args.image = next();
    else if (arg === '--lean-volume') args.leanVolume = next();
    else if (arg === '--tools-volume') args.toolsVolume = next();
    else if (arg === '--timeout-ms') args.timeoutMs = Math.max(1000, Number(next()) || 0);
    else if (arg === '--only') args.only = next();
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node grade-arxivlean.mjs --out <archive-dir> --report-out <fresh-dir> [--tasks <file>] [--only <substring>]. Diagnostic only; legacy image/volume flags are inert metadata.');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.out) throw new Error('--out is required');
  if (!args.reportOut) throw new Error('--report-out is required: preserve archived grades in a fresh diagnostic directory');
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Node writes UTF-8 without a BOM. Lean and Comparator reject a BOM at byte 0.
  fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
}

// Port of MathArena lean_conjecture.lean_tokens: mask comments and strings so
// structural checks do not mistake prose for a theorem/placeholder.
function leanTokens(code) {
  const result = [];
  let i = 0;
  let depth = 0;
  while (i < code.length) {
    if (code.startsWith('/-', i)) {
      depth += 1;
      result.push('  ');
      i += 2;
    } else if (depth > 0 && code.startsWith('-/', i)) {
      depth -= 1;
      result.push('  ');
      i += 2;
    } else if (depth > 0) {
      result.push(code[i] === '\n' ? '\n' : ' ');
      i += 1;
    } else if (code.startsWith('--', i)) {
      let end = code.indexOf('\n', i);
      if (end < 0) end = code.length;
      result.push(' '.repeat(end - i));
      i = end;
    } else if (code[i] === '"') {
      result.push(' ');
      i += 1;
      while (i < code.length) {
        const ch = code[i];
        result.push(ch === '\n' ? '\n' : ' ');
        i += 1;
        if (ch === '\\' && i < code.length) {
          result.push(' ');
          i += 1;
        } else if (ch === '"') {
          break;
        }
      }
    } else {
      result.push(code[i]);
      i += 1;
    }
  }
  if (depth > 0) throw new Error('Unterminated Lean comment');
  return result.join('');
}

function extractSubmission(text) {
  const blocks = [...String(text ?? '').matchAll(/```lean\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  if (String(text ?? '').includes('```') && blocks.length !== 1) {
    throw new Error('Return exactly one complete Lean code block');
  }
  return (blocks.length === 1 ? blocks[0] : String(text ?? '')).trim();
}

function verdictOf(code) {
  const tokens = leanTokens(code);
  const proofs = [...tokens.matchAll(/^\s*theorem\s+arxivlean_proof\s*:/gm)].length;
  const disproofs = [...tokens.matchAll(/^\s*theorem\s+arxivlean_disproof\s*:/gm)].length;
  if (proofs + disproofs !== 1) {
    throw new Error('Declare exactly one theorem arxivlean_proof or arxivlean_disproof');
  }
  return proofs === 1 ? 'prove' : 'disprove';
}

function validateSubmission(code) {
  const tokens = leanTokens(code);
  if (FORBIDDEN.test(tokens)) {
    throw new Error('Submission contains a placeholder or forbidden trusted declaration');
  }
}

function safeModuleId(taskId, condition) {
  const task = String(taskId).replace(/[^A-Za-z0-9_]/g, '_');
  const cond = String(condition).replace(/[^A-Za-z0-9_]/g, '_');
  return `T_${task}__${cond}`;
}

function targetStatement(formal, verdict) {
  const name = verdict === 'prove' ? 'arxivlean_proof' : 'arxivlean_disproof';
  const target = verdict === 'prove' ? 'arxivleanConjecture' : 'Not arxivleanConjecture';
  return `${String(formal).trimEnd()}\n\ntheorem ${name} : ${target} := by\n  sorry\n`;
}

export function classify(output, exitCode, processResult = {}) {
  if (processResult.error || processResult.signal || processResult.truncated || processResult.timedOut || exitCode !== 0) {
    return { status: 'unverified', reason: 'Process failure/timeout/signal/truncation is not proof evidence' };
  }
  return { status: 'unverified', reason: 'Independent checker unavailable; mixed stdout markers are untrusted' };
}

export function runComparator() {
  // Deliberately no staging, Docker, corpus wrapper, or stdout acceptance path.
  return { status: 'unverified', reason: 'Independent checker unavailable', comparator_rc: null, output: '' };
}

export function gradeEpisode(episode, task, configurationError = '') {
  if (configurationError || !task || typeof task.formal_statement !== 'string') return { status: 'unverified', reason: configurationError || `Unknown task or invalid task configuration: ${episode.task_id}`, output: '', verdict: null };
  if (episode.status !== 'completed') return { status: 'incomplete', reason: `episode ${episode.status ?? 'unknown'}: ${String(episode.stderr ?? '').slice(0, 500)}`, output: '', verdict: null };
  if (episode.error || episode.error_code || episode.signal || episode.truncated || episode.stdout_truncated || (episode.exit_code != null && episode.exit_code !== 0)) return { ...classify('', -1), output: '', verdict: null };
  if (/[｜|]DSML[｜|]/.test(String(episode.text ?? ''))) return { status: 'unverified', reason: 'Malformed text tool-call artifact (DSML); not a mathematical submission', output: '', verdict: null };
  let verdict;
  try {
    const submission = extractSubmission(episode.text ?? '');
    if (!submission) throw new Error('Empty Lean submission');
    validateSubmission(submission);
    verdict = verdictOf(submission);
  } catch (error) {
    return { status: 'rejected', reason: `Structural diagnostic only: ${error.message}`, output: '', verdict: null };
  }
  return { ...runComparator(), verdict };
}

function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.out);
  const reportDir = path.resolve(args.reportOut);
  const episodesDir = path.join(outDir, 'episodes');
  if (!fs.existsSync(episodesDir)) throw new Error(`missing episodes directory: ${episodesDir}`);
  // Atomic fresh-directory claim; never overwrite captured artifacts or old grades.
  fs.mkdirSync(reportDir);

  let taskById = new Map(), configurationError = '';
  try {
    const tasks = readJson(args.tasks);
    if (!Array.isArray(tasks)) throw new Error('task manifest must be an array');
    taskById = new Map(tasks.map(task => [String(task.id), task]));
  } catch (error) { configurationError = `Task configuration unavailable: ${error.message}`; }
  const episodes = fs.readdirSync(episodesDir)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !args.only || name.includes(args.only))
    .sort();

  const results = [];
  for (const name of episodes) {
    const episodePath = path.join(episodesDir, name);
    let episode, episodeError = '';
    try { episode = readJson(episodePath); if (!episode || typeof episode !== 'object') throw new Error('invalid episode'); }
    catch (error) { episode = {}; episodeError = `Episode configuration unavailable: ${error.message}`; }
    const task = taskById.get(String(episode.task_id));
    const base = {
      episode: name,
      task_id: episode.task_id,
      problem_idx: episode.problem_idx,
      condition: episode.condition,
      model: episode.model,
      verdict: null,
    };

    const record = { ...base, ...gradeEpisode(episode, task, episodeError || configurationError) };
    writeText(path.join(reportDir, 'grades', name), JSON.stringify(record, null, 2) + '\n');
    results.push(record);
    console.log(`[${record.condition}] ${record.task_id} -> ${record.status} (${record.reason})`);
  }

  const counts = {};
  for (const result of results) {
    counts[result.condition] ??= { verified: 0, rejected: 0, unverified: 0, incomplete: 0 };
    counts[result.condition][result.status] = (counts[result.condition][result.status] ?? 0) + 1;
  }
  const summary = {
    generated_at: new Date().toISOString(),
    out: outDir,
    report_out: reportDir,
    mode: 'diagnostic-only-independent-checker-unavailable',
    tasks: args.tasks,
    image: args.image,
    counts,
    results: results.map(({ output, ...rest }) => rest),
  };
  writeText(path.join(reportDir, 'grade-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`summary: ${JSON.stringify(counts)}`);
}

export { leanTokens, extractSubmission, verdictOf, validateSubmission, safeModuleId, targetStatement };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
