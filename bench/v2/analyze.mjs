import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, serialize, parseArgs, sha256 } from './lib.mjs';
import { DEFAULT_OUTPUT, loadStudy } from './run.mjs';

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export const success = episode => Boolean(episode && episode.status === 'completed' && episode.grade.correct && episode.under_budget);
function metrics(rows) {
  const conditions = {};
  for (const condition of ['A', 'B', 'F']) {
    const selected = rows.filter(row => row.condition_id === condition);
    const correct = selected.filter(row => success(row.episode)).length;
    conditions[condition] = { started: selected.length, correct_under_budget: correct, rate: selected.length ? correct / selected.length : null, operational_failures: selected.filter(row => !row.episode || row.episode.status === 'operational_failure').length, extraction_failures: selected.filter(row => row.episode?.status === 'extraction_failure').length, over_budget: selected.filter(row => row.episode && !row.episode.under_budget).length, negative_cases: selected.filter(row => row.negative).length };
  }
  return conditions;
}
export function pairedBootstrap(rows, { seed, resamples }) {
  assert(Number.isInteger(seed) && Number.isInteger(resamples) && resamples > 0, 'Invalid bootstrap preregistration');
  const pairs = new Map();
  for (const row of rows.filter(row => ['B', 'F'].includes(row.condition_id))) {
    const key = JSON.stringify([row.model_id, row.task_id, row.repeat_id, row.attempt_id]);
    if (!pairs.has(key)) pairs.set(key, { family: row.family });
    pairs.get(key)[row.condition_id] = row;
  }
  const complete = [...pairs.values()].filter(pair => pair.B && pair.F);
  const families = [...new Set(complete.map(pair => pair.family))].sort();
  const clusters = families.map(family => complete.filter(pair => pair.family === family));
  const delta = pairs => pairs.length ? pairs.reduce((sum, pair) => sum + Number(success(pair.F.episode)) - Number(success(pair.B.episode)), 0) / pairs.length : null;
  const random = seededRandom(seed), samples = [];
  if (families.length) for (let i = 0; i < resamples; i++) {
    const sampledPairs = [];
    for (let j = 0; j < families.length; j++) sampledPairs.push(...clusters[Math.floor(random() * families.length)]);
    samples.push(delta(sampledPairs));
  }
  samples.sort((a, b) => a - b);
  const quantile = p => samples.length ? samples[Math.floor((samples.length - 1) * p)] : null;
  return { contrast: 'F-B', estimate: delta(complete), exploratory_ci_95: [quantile(0.025), quantile(0.975)], seed, resamples, families: families.length, paired_episode_cells: complete.length, unique_tasks: new Set(complete.map(pair => pair.B.task_id)).size, unpaired_cells_excluded_from_contrast_only: pairs.size - complete.length, cluster: 'task-family; all tasks/models/conditions/repeats/attempts in each sampled family stay together', caveat: 'Exploratory percentile CI. Very few families; repetitions are not independent tasks. No real-model or mathematical-validity inference.' };
}
export function analyzeStudy(output = DEFAULT_OUTPUT) {
  const { manifest, episodes, starts, ledger } = loadStudy(output);
  const rows = starts.map(start => ({ ...start, ...manifest.tasks.find(task => task.id === start.task_id), episode: ledger.completed.get(start.key) }));
  const byModel = Object.fromEntries(manifest.models.map(model => {
    const selected = rows.filter(row => row.model_id === model);
    return [model, { conditions: metrics(selected), contrast: pairedBootstrap(selected, manifest.analysis) }];
  }));
  const byDomain = Object.fromEntries([...new Set(manifest.tasks.map(task => task.domain))].map(domain => {
    const selected = rows.filter(row => row.domain === domain);
    return [domain, { conditions: metrics(selected), contrast: pairedBootstrap(selected, manifest.analysis) }];
  }));
  const byModelDomain = Object.fromEntries(manifest.models.map(model => [model, Object.fromEntries(Object.keys(byDomain).map(domain => [domain, metrics(rows.filter(row => row.model_id === model && row.domain === domain))]))]));
  const report = {
    simulated: manifest.simulated, study_id: manifest.study_id, protocol_hash: manifest.protocol_hash,
    input_hashes: { manifest: sha256(manifest), episodes: sha256(episodes), starts: sha256(starts) },
    primary_metric: 'correct episodes under every preregistered budget / all started episodes',
    started: starts.length, completed_records: episodes.length, expected: manifest.expected_episode_count,
    missing_expected_keys: ledger.missing, pending_started_keys: ledger.pending,
    conditions: metrics(rows), contrast: pairedBootstrap(rows, manifest.analysis),
    per_model: byModel, per_domain: byDomain, per_model_domain: byModelDomain,
    exclusions: { all_started_metric: 'None. Negative cases, extraction failures, operational failures and pending started episodes remain in the denominator; unknown monetary cost is not under budget.', not_started: manifest.expected_episode_count - starts.length, paired_contrast: 'Only B/F cells with both starts are paired. Pending starts score zero; unpaired cells are enumerated as excluded from contrast only.' },
    limitations: [...(manifest.simulated ? ['SIMULATED fixture outcomes only; no inference, real corpus, Lean compilation or Docker execution.', 'Three task families and four pilot tasks. Formal and explanation graders are exercised by tests, not this pilot.', 'Simulation durations, clock and estimated zero cost are fixture accounting, not measured performance or price estimates.'] : []), 'Blind explanation scoring recognizes only pre-scored fixture texts; symbolic checking is a bounded registered integer-polynomial/solution-set checker.', 'Bootstrap resamples whole task families, retaining repetitions and paired conditions; CIs are exploratory, especially with few families.']
  };
  const lines = [manifest.simulated ? '# SIMULATED pilot — no real-model results' : '# Evaluation report', '', `Study: ${manifest.study_id}`, `Started: ${report.started}; terminal records: ${report.completed_records}; expected: ${report.expected}.`, `Missing expected: ${ledger.missing.length}; pending started: ${ledger.pending.length}.`, '', 'Primary: correct under budget / all started (no failure or negative-case exclusions).', '', '| Condition | Correct / started | Rate |', '|---|---:|---:|'];
  for (const [condition, metric] of Object.entries(report.conditions)) lines.push(`| ${condition} | ${metric.correct_under_budget} / ${metric.started} | ${metric.rate === null ? 'n/a' : (100 * metric.rate).toFixed(2) + '%'} |`);
  lines.push('', `Main paired contrast F−B: ${report.contrast.estimate}; exploratory 95% family-bootstrap CI: [${report.contrast.exploratory_ci_95.join(', ')}].`, `Seed ${report.contrast.seed}; ${report.contrast.resamples} resamples; ${report.contrast.families} families. Repetitions are not independent tasks.`, '', '## Per-model and per-domain rates', '', '| Breakdown | A | B | F |', '|---|---:|---:|---:|');
  for (const [label, group] of [...Object.entries(byModel), ...Object.entries(byDomain)]) lines.push(`| ${label} | ${['A', 'B', 'F'].map(c => `${group.conditions[c].correct_under_budget}/${group.conditions[c].started}`).join(' | ')} |`);
  lines.push('', '## Exclusions and limitations', '', ...Object.entries(report.exclusions).map(([key, value]) => `- ${key}: ${value}`), ...report.limitations.map(value => `- ${value}`), '', 'Full model × domain breakdown, missing composite keys, and provenance hashes are in report.json.', '');
  writeFileSync(path.join(output, 'report.json'), serialize(report));
  writeFileSync(path.join(output, 'report.md'), lines.join('\n'));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2), ['--out']);
    const output = args['--out'] ? path.resolve(args['--out']) : DEFAULT_OUTPUT;
    const report = analyzeStudy(output);
    console.log(JSON.stringify({ simulated: report.simulated, episodes: report.completed_records, started: report.started, missing: report.missing_expected_keys.length, conditions: report.conditions, contrast: report.contrast, reports: [path.join(output, 'report.json'), path.join(output, 'report.md')] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
