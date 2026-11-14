#!/usr/bin/env node
// Summarize ArXivLean runs and Comparator grades.
//
// Usage:
//   node bench/v3/arxivlean/build-arxivlean-report.mjs \
//     --run on=<run-dir> --run off=<run-dir> --out <report-dir>
//
// Each run directory must contain episodes/*.json (from run-arxivlean.mjs)
// and may contain grades/*.json (from grade-arxivlean.mjs).

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { runs: [], out: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--run') {
      const value = next();
      const eq = value.indexOf('=');
      if (eq < 1) throw new Error('--run must be label=path');
      args.runs.push({ label: value.slice(0, eq), dir: path.resolve(value.slice(eq + 1)) });
    } else if (arg === '--out') args.out = path.resolve(next());
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node build-arxivlean-report.mjs --run <label>=<dir> [--run ...] [--out <dir>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.runs.length) throw new Error('at least one --run label=dir is required');
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readDir(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(suffix)).sort();
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mean(values) {
  const usable = values.filter((value) => number(value) !== null);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function fmt(value, digits = 1) {
  return value === null ? '-' : Number(value).toFixed(digits);
}

function clean(value, limit = 160) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function loadRun(run) {
  const episodesDir = path.join(run.dir, 'episodes');
  const gradesDir = path.join(run.dir, 'grades');
  const grades = new Map();
  for (const name of readDir(gradesDir, '.json')) {
    grades.set(name, readJson(path.join(gradesDir, name)));
  }
  const episodes = readDir(episodesDir, '.json').map((name) => {
    const episode = readJson(path.join(episodesDir, name));
    return { ...episode, episode_name: name, grade: grades.get(name) ?? null };
  });
  return { ...run, episodes };
}

function summarize(run) {
  const byCondition = new Map();
  for (const episode of run.episodes) {
    const condition = episode.condition ?? 'unknown';
    const row = byCondition.get(condition) ?? {
      condition, episodes: 0, completed: 0, timeout: 0, failed: 0,
      verified: 0, rejected: 0, unverified: 0, incomplete: 0, ungraded: 0,
      durations: [], tokens: [], costs: [], mathToolCalls: 0, leanBlocks: 0,
    };
    row.episodes += 1;
    row[episode.status] = (row[episode.status] ?? 0) + 1;
    if (episode.lean_block_found) row.leanBlocks += 1;
    row.durations.push(number(episode.duration_ms));
    row.tokens.push(number(episode.usage?.tokens));
    row.costs.push(number(episode.usage?.cost));
    row.mathToolCalls += Array.isArray(episode.math_tools) ? episode.math_tools.length : 0;
    const status = episode.grade?.status;
    if (status) row[status] = (row[status] ?? 0) + 1;
    else row.ungraded += 1;
    byCondition.set(condition, row);
  }
  return [...byCondition.values()].map((row) => ({
    ...row,
    mean_duration_ms: mean(row.durations),
    total_tokens: row.tokens.some((value) => value !== null) ? row.tokens.reduce((sum, value) => sum + (value ?? 0), 0) : null,
    total_cost: row.costs.some((value) => value !== null) ? row.costs.reduce((sum, value) => sum + (value ?? 0), 0) : null,
  }));
}

function markdown(runs) {
  const lines = ['# ArXivLean smoke report', '', `Generated: ${new Date().toISOString()}`, ''];
  lines.push('Comparator is the acceptance boundary. `incomplete` means the model run timed out or failed before a final submission; it is not a mathematical rejection.', '');
  lines.push('## Summary', '');
  lines.push('| Run | Condition | Episodes | Completed | Timeout | Failed | Verified | Rejected | Unverified | Incomplete | Ungraded | Lean blocks | Mean s | Tokens | Cost | Math tool calls |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const run of runs) {
    for (const row of summarize(run)) {
      lines.push(`| ${run.label} | ${row.condition} | ${row.episodes} | ${row.completed} | ${row.timeout} | ${row.failed} | ${row.verified} | ${row.rejected} | ${row.unverified} | ${row.incomplete} | ${row.ungraded} | ${row.leanBlocks} | ${fmt(row.mean_duration_ms === null ? null : row.mean_duration_ms / 1000)} | ${row.total_tokens ?? '-'} | ${row.total_cost === null ? '-' : row.total_cost.toFixed(6)} | ${row.mathToolCalls} |`);
    }
  }
  lines.push('', '## Per episode', '');
  lines.push('| Run | Task | Condition | Episode | Lean block | Grade | Verdict | Duration s | Tools | Math tools | Reason |');
  lines.push('|---|---|---|---|---|---|---|---:|---:|---:|---|');
  for (const run of runs) {
    for (const episode of run.episodes.slice().sort((a, b) => `${a.task_id}.${a.condition}`.localeCompare(`${b.task_id}.${b.condition}`))) {
      const grade = episode.grade;
      lines.push(`| ${run.label} | ${episode.task_id ?? '-'} | ${episode.condition ?? '-'} | ${episode.episode_name} | ${episode.lean_block_found ? 'yes' : 'no'} | ${grade?.status ?? 'not graded'} | ${grade?.verdict ?? '-'} | ${fmt((number(episode.duration_ms) ?? 0) / 1000)} | ${Array.isArray(episode.tools) ? episode.tools.length : 0} | ${Array.isArray(episode.math_tools) ? episode.math_tools.length : 0} | ${clean(grade?.reason)} |`);
    }
  }
  lines.push('', '## Caveats', '');
  lines.push('- Model text alone is not proof; only a `verified` Comparator result counts.');
  lines.push('- Timeouts and missing final submissions are `incomplete`, not `rejected`.');
  lines.push('- Recorded tokens and costs are incomplete subtotals when the provider omits usage.');
  lines.push('- `math_tools` counts tool references; it does not prove the tool succeeded.');
  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  const runs = args.runs.map(loadRun);
  const payload = {
    generated_at: new Date().toISOString(),
    runs: runs.map((run) => ({
      label: run.label,
      dir: run.dir,
      summary: summarize(run),
      episodes: run.episodes.map((episode) => ({
        task_id: episode.task_id,
        condition: episode.condition,
        status: episode.status,
        duration_ms: episode.duration_ms,
        tools: episode.tools ?? [],
        math_tools: episode.math_tools ?? [],
        lean_block_found: Boolean(episode.lean_block_found),
        usage: episode.usage ?? null,
        grade: episode.grade,
      })),
    })),
  };
  const text = markdown(runs);
  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(args.out, 'report.md'), text, 'utf8');
    console.log(`wrote ${path.join(args.out, 'report.md')}`);
  } else {
    process.stdout.write(text);
  }
}

main();
