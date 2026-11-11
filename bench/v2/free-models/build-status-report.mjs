import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'C:/_Work/opencode-math-copilot';
const OUT = process.argv[2] || 'C:/Users/MiPC/AppData/Local/Temp/opencode';
const sources = [
  ['free', path.join(REPO, 'bench/v2/free-models/models.json'), 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix/state.json'],
  ['other', path.join(REPO, 'bench/v2/free-models/models-other.json'), 'C:/Users/MiPC/AppData/Local/Temp/opencode/other-matrix/state.json'],
];
const clean = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const rows = [];
for (const [matrix, modelsFile, stateFile] of sources) {
  const models = JSON.parse(readFileSync(modelsFile, 'utf8')).models ?? [];
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { models: {} };
  for (const model of models) {
    const entry = state.models[model] ?? { status: 'pending' };
    const screen = Array.isArray(entry.screen?.episodes) ? entry.screen.episodes : [];
    const full = Array.isArray(entry.full?.episodes) ? entry.full.episodes : [];
    rows.push({
      matrix,
      provider: model.split('/')[0],
      model,
      status: entry.status ?? 'pending',
      attempts: entry.attempts ?? 0,
      screen: entry.screen?.classification ?? '',
      categories: [...new Set(screen.map(episode => episode.category).filter(Boolean))].join('|'),
      last_error: clean(entry.last_error, 300),
      next_attempt_at: entry.next_attempt_at ?? '',
      full_episodes: full.length,
      full_completed: full.filter(episode => episode.status === 'completed').length,
      full_correct: full.filter(episode => episode.correct === true).length,
    });
  }
}
const statusOrder = ['full_complete', 'screen_passed', 'screening', 'fulling', 'quota_wait', 'auth_error', 'provider_output', 'error', 'not_in_plan', 'unavailable', 'config_error', 'tool_protocol_failure', 'pending', 'skipped'];
const counts = {};
const providers = {};
const matrices = {};
for (const row of rows) {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  matrices[row.matrix] ??= {};
  matrices[row.matrix][row.status] = (matrices[row.matrix][row.status] ?? 0) + 1;
  providers[row.provider] ??= { total: 0 };
  providers[row.provider].total++;
  providers[row.provider][row.status] = (providers[row.provider][row.status] ?? 0) + 1;
}
const header = ['matrix', 'provider', 'model', 'status', 'attempts', 'screen', 'categories', 'last_error', 'next_attempt_at', 'full_episodes', 'full_completed', 'full_correct'];
writeFileSync(path.join(OUT, 'all-model-status.csv'), [
  header.join(','),
  ...rows.map(row => header.map(key => csv(row[key])).join(',')),
].join('\n') + '\n');
const md = [
  '# Model status snapshot', '',
  `Generated: ${new Date().toISOString()}`,
  `Models: ${rows.length}`, '',
  '## Status counts', '', '```json', JSON.stringify(counts, null, 2), '```', '',
  '## Matrix counts', '', '```json', JSON.stringify(matrices, null, 2), '```', '',
  '## Provider counts', '', '```json', JSON.stringify(providers, null, 2), '```', '',
  '## Full list', '',
  '| Matrix | Provider | Model | Status | Attempts | Screen | Full | Correct | Next retry | Last error |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows
    .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || a.matrix.localeCompare(b.matrix) || a.model.localeCompare(b.model))
    .map(row => `| ${row.matrix} | ${row.provider} | \`${row.model}\` | ${row.status} | ${row.attempts} | ${row.screen || ''} | ${row.full_completed}/${row.full_episodes} | ${row.full_correct} | ${row.next_attempt_at || ''} | ${clean(row.last_error, 120).replaceAll('|', '/')} |`),
];
writeFileSync(path.join(OUT, 'all-model-status.md'), md.join('\n') + '\n');
console.log(JSON.stringify({ generated_at: new Date().toISOString(), rows: rows.length, counts, matrices }, null, 2));
console.log(`csv ${path.join(OUT, 'all-model-status.csv')}`);
console.log(`md  ${path.join(OUT, 'all-model-status.md')}`);
