import fs from 'node:fs';
import path from 'node:path';
import {
  CONDITIONS, REPO, claimOutput, closedKeys, episodeKey, isMain, nonempty, parseOptions, writeJSON,
} from './schema.mjs';

export const CAVEATS = Object.freeze([
  'Exploratory, not confirmatory; no causal or general mathematical-accuracy claim.',
  'One repeat by default; repeated attempts are not independent tasks or pass@k.',
  'Model/version drift and condition ordering are uncontrolled; a model identifier does not freeze provider weights.',
  'External baseline is not apples-to-apples and is never pooled with the paired results.',
  'Retrieval-assisted reproduction is not distinguished unless the task says so; this runner does not audit retrieval.',
  'Plugin-off disables this toolkit only, not built-in tools or other plugins. Environment flags are not isolation evidence.',
  'Usage/cost is CLI-reported, not reconciled billing; missing usage is unknown, not free.',
  'Bounded symbolic normalization is not a general equivalence prover; unparseable and missing remain separate.',
]);

export function validateBaselines(baselines) {
  if (!Array.isArray(baselines)) throw new Error('baseline must be an array');
  for (const row of baselines) {
    closedKeys(row, ['benchmark', 'model', 'score', 'source', 'notes'], 'baseline');
    if (!['benchmark', 'model', 'source'].every(key => nonempty(row[key])) ||
        !(nonempty(row.score) || (typeof row.score === 'number' && Number.isFinite(row.score))) ||
        (row.notes !== undefined && typeof row.notes !== 'string')) throw new Error('invalid baseline');
  }
  return baselines.map(row => ({ ...row, label: 'external_baseline' }));
}

function usageSummary(rows) {
  const result = {};
  for (const field of ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost']) {
    const values = rows.map(row => row.usage?.[field]).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const sum = values.reduce((a, b) => a + b, 0);
    result[field] = { total: values.length === rows.length && rows.length > 0 ? sum : null,
      known_subtotal: sum, known: values.length, unknown: rows.length - values.length };
  }
  return result;
}

export function buildReport(summaries, baselines = []) {
  const external = validateBaselines(baselines);
  const groups = new Map(), pairs = new Map();
  for (const summary of summaries) {
    const manifest = summary.manifest;
    if (summary.schema !== 'math-bench-grades/v1' || !manifest ||
        !CONDITIONS.includes(manifest.condition) || summary.rows.length !== manifest.schedule.length) throw new Error('invalid grade summary');
    const scheduled = new Map(manifest.schedule.map(row => [episodeKey(row), row]));
    if (scheduled.size !== manifest.schedule.length) throw new Error('duplicate schedule');
    for (const row of summary.rows) {
      const schedule = scheduled.get(episodeKey(row));
      if (!schedule || row.model !== manifest.model || row.condition !== manifest.condition ||
          schedule.prompt_sha256 !== row.prompt_sha256 ||
          !['correct', 'incorrect', 'unparseable', 'missing'].includes(row.grade?.status)) throw new Error('invalid grade row');
      scheduled.delete(episodeKey(row));
      const groupKey = JSON.stringify([row.benchmark, row.model]);
      if (!groups.has(groupKey)) groups.set(groupKey, { benchmark: row.benchmark, model: row.model, rows: [] });
      groups.get(groupKey).rows.push(row);
      const key = JSON.stringify([row.model, row.benchmark, row.task_id, row.repeat]);
      const binding = JSON.stringify([manifest.task_file_sha256, manifest.workspace, manifest.timeout_ms,
        manifest.repeat, row.prompt_sha256, summary.grading_rules]);
      if (!pairs.has(key)) pairs.set(key, { groupKey, binding, conditions: {} });
      const pair = pairs.get(key);
      if (pair.binding !== binding) throw new Error('paired protocol mismatch: task hash/workspace/timeout/repeat/prompt/grader');
      if (pair.conditions[row.condition]) throw new Error('duplicate paired condition; runs are not pooled');
      pair.conditions[row.condition] = row;
    }
  }
  const benchmarks = [];
  for (const [key, group] of groups) {
    const conditions = {};
    for (const condition of CONDITIONS) {
      const rows = group.rows.filter(row => row.condition === condition);
      if (!rows.length) continue;
      const counts = Object.fromEntries(['correct', 'incorrect', 'unparseable', 'missing'].map(status =>
        [status, rows.filter(row => row.grade.status === status).length]));
      const graded = counts.correct + counts.incorrect;
      conditions[condition] = {
        scheduled: rows.length, attempted: rows.filter(row => row.attempted).length,
        completed: rows.filter(row => row.completed).length, ...counts,
        accuracy_among_graded: graded ? counts.correct / graded : null,
        pass_rate_all_scheduled: counts.correct / rows.length,
        duration_ms_known_subtotal: rows.reduce((sum, row) => sum + (row.duration_ms ?? 0), 0),
        usage: usageSummary(rows),
      };
    }
    const paired = { matched: 0, both: 0, on_only: 0, off_only: 0, neither: 0, ungraded: 0, unmatched: 0 };
    for (const pair of pairs.values()) {
      if (pair.groupKey !== key) continue;
      const on = pair.conditions['plugin-on'], off = pair.conditions['plugin-off'];
      if (!on || !off) { paired.unmatched++; continue; }
      paired.matched++;
      if ([on, off].some(row => !['correct', 'incorrect'].includes(row.grade.status))) paired.ungraded++;
      else if (on.grade.status === 'correct' && off.grade.status === 'correct') paired.both++;
      else if (on.grade.status === 'correct') paired.on_only++;
      else if (off.grade.status === 'correct') paired.off_only++;
      else paired.neither++;
    }
    benchmarks.push({ benchmark: group.benchmark, model: group.model, conditions, paired,
      external_baseline: external.filter(row => row.benchmark === group.benchmark) });
  }
  return { schema: 'math-bench-report/v1', exploratory: true, not_confirmatory: true,
    caveats: [...CAVEATS], benchmarks, external_baseline: external };
}

const cell = value => String(value ?? 'unknown').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const percent = value => value === null ? 'unknown' : `${(value * 100).toFixed(2)}%`;

export function markdown(report) {
  const lines = ['# External math benchmarks — exploratory', '', ...report.caveats.map(text => `- ${text}`), '',
    '| Benchmark | Model | Condition | Scheduled | Attempted | Completed | Correct | Incorrect | Unparseable | Missing | Accuracy (graded) | Pass (scheduled) | CLI cost (coverage) | external_baseline |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|'];
  for (const benchmark of report.benchmarks) {
    for (const [condition, row] of Object.entries(benchmark.conditions)) {
      const cost = row.usage.cost;
      lines.push(`| ${[benchmark.benchmark, benchmark.model, condition, row.scheduled, row.attempted, row.completed,
        row.correct, row.incorrect, row.unparseable, row.missing, percent(row.accuracy_among_graded),
        percent(row.pass_rate_all_scheduled), `${cost.total ?? 'unknown'} (${cost.known}/${row.scheduled}; known subtotal ${cost.known_subtotal})`,
        benchmark.external_baseline.map(item => `${item.model}: ${item.score} (${item.source}; ${item.notes ?? ''})`).join('; ') || 'none',
      ].map(cell).join(' | ')} |`);
    }
  }
  lines.push('', '## Paired outcomes (matched task/repeat slots)', '',
    '| Benchmark | Model | Matched | Both | ON-only | OFF-only | Neither | Ungraded | Unmatched |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.benchmarks) {
    const p = row.paired;
    lines.push(`| ${[row.benchmark, row.model, p.matched, p.both, p.on_only, p.off_only, p.neither, p.ungraded, p.unmatched].map(cell).join(' | ')} |`);
  }
  lines.push('', '## CLI usage (known subtotals; unknown coverage retained)', '',
    '| Benchmark | Model | Condition | Field | Total | Known subtotal | Known / scheduled |',
    '|---|---|---|---|---:|---:|---|');
  for (const row of report.benchmarks) for (const [condition, counts] of Object.entries(row.conditions)) {
    for (const [field, usage] of Object.entries(counts.usage)) {
      lines.push(`| ${[row.benchmark, row.model, condition, field, usage.total, usage.known_subtotal, `${usage.known}/${counts.scheduled}`].map(cell).join(' | ')} |`);
    }
  }
  lines.push('', '## external_baseline (separate, not pooled)', '',
    '| Benchmark | Model | Score (as supplied) | Source | Notes |', '|---|---|---|---|---|');
  for (const row of report.external_baseline) lines.push(`| ${[row.benchmark, row.model, row.score, row.source, row.notes ?? ''].map(cell).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

export function writeReport({ grades, baseline, out }, { io = fs, repo = REPO } = {}) {
  const summaries = grades.map(file => JSON.parse(io.readFileSync(file, 'utf8')));
  const baselines = baseline ? JSON.parse(io.readFileSync(baseline, 'utf8')) : [];
  const report = buildReport(summaries, baselines);
  const output = claimOutput(out, { io, repo });
  writeJSON(io, path.join(output, 'report.json'), report);
  io.writeFileSync(path.join(output, 'report.md'), markdown(report), { encoding: 'utf8', flag: 'wx' });
  return report;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseOptions(argv, ['--grades', '--baseline', '--out'], ['--grades']);
  if (!args['--grades']?.length || !args['--out']) throw new Error('--grades and --out required');
  writeReport({ grades: args['--grades'], baseline: args['--baseline'], out: args['--out'] });
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
