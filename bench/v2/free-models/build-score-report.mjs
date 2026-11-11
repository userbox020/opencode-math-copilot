import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'C:/_Work/opencode-math-copilot';
const ROOT = path.join(REPO, 'bench/v2/free-models');
const OUT = process.argv[2] || 'C:/Users/MiPC/AppData/Local/Temp/opencode';
const readJsonl = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const summarize = episodes => {
  const by = {};
  for (const episode of episodes) {
    const condition = episode.condition_id ?? episode.condition;
    if (!condition) continue;
    const c = by[condition] ??= { n: 0, correct: 0, completed: 0, extraction: 0, operational: 0, tokens: 0, cost: 0 };
    c.n++;
    if (episode.correct === true || episode.grade?.correct === true) c.correct++;
    if (episode.status === 'completed') c.completed++;
    if (episode.status === 'extraction_failure') c.extraction++;
    if (episode.status === 'operational_failure') c.operational++;
    c.tokens += Number(episode.usage?.tokens) || 0;
    c.cost += Number(episode.cost?.observed_usd) || 0;
  }
  return by;
};
const pct = (correct, n) => n ? Number((correct / n * 100).toFixed(1)) : null;
const clean = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const historical = {
  title: 'Historical keyword benchmark (with vs without math-toolkit)',
  source: 'bench/RESULTS.md',
  total: {
    with: { correct: 83, n: 90, rate: 92.2, ci: [84.8, 96.2], errors: 0 },
    without: { correct: 62, n: 90, rate: 68.9, ci: [58.7, 77.5], errors: 17 },
    diff_pp: 23.3,
  },
  models: [
    { model: 'opencode-go/deepseek-v4.1-flash', with: { correct: 30, n: 30 }, without: { correct: 19, n: 30 } },
    { model: 'opencode-go/glm-5.3-flash', with: { correct: 26, n: 30 }, without: { correct: 20, n: 30 } },
    { model: 'opencode-go/gpt-6-luna', with: { correct: 27, n: 30 }, without: { correct: 23, n: 30 } },
  ],
  caveats: [
    'Keyword scoring is heuristic, not mathematical accuracy.',
    'The without-plugin condition still had global OpenCode plugins; only math-toolkit was removed.',
    'Repeats are not independent tasks.',
    'Timing comparisons are confounded by timeouts and provider conditions.',
  ],
};

const pilotPath = `${REPO}/bench/v2/real/pilot-2026-11-09-opencode-go-deepseek-v4.1-flash/episodes.jsonl`;
const pilotEpisodes = readJsonl(pilotPath);
const pilot = summarize(pilotEpisodes);
const families = {};
for (const episode of pilotEpisodes) {
  const family = episode.family ?? 'unknown';
  const condition = episode.condition_id ?? episode.condition;
  if (!condition) continue;
  const c = families[family] ??= {};
  const entry = c[condition] ??= { n: 0, correct: 0 };
  entry.n++;
  if (episode.correct === true || episode.grade?.correct === true) entry.correct++;
}

const matrices = [];
for (const [matrix, statePath] of [
  ['free', 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix/state.json'],
  ['other', 'C:/Users/MiPC/AppData/Local/Temp/opencode/other-matrix/state.json'],
]) {
  if (!existsSync(statePath)) continue;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const [model, entry] of Object.entries(state.models ?? {})) {
    if (entry.status !== 'full_complete') continue;
    const by = summarize(entry.full?.episodes ?? []);
    matrices.push({
      matrix,
      model,
      A: by.A ?? null,
      B: by.B ?? null,
      F: by.F ?? null,
      fMinusBpp: by.F && by.B ? Number(((by.F.correct - by.B.correct) / Math.max(1, by.B.n) * 100).toFixed(1)) : null,
      clean: Boolean(by.A && by.B && by.F && [by.A, by.B, by.F].every(c => c.completed === c.n && c.n === 30)),
    });
  }
}
const aggregate = (rows, id) => {
  const present = rows.map(row => row[id]).filter(Boolean);
  return present.length ? {
    models: present.length,
    n: present.reduce((sum, c) => sum + c.n, 0),
    correct: present.reduce((sum, c) => sum + c.correct, 0),
    completed: present.reduce((sum, c) => sum + c.completed, 0),
  } : null;
};

const report = {
  schema: 'math-copilot-scores/v1',
  generated_at: new Date().toISOString(),
  definitions: {
    A: 'No tools',
    B: 'Generic tools (four-tool plugin + execute)',
    F: 'Full math-toolkit plugin',
  },
  historical,
  pilot: {
    A: pilot.A ?? null,
    B: pilot.B ?? null,
    F: pilot.F ?? null,
    fMinusBpp: pilot.F && pilot.B ? pct(pilot.F.correct - pilot.B.correct, pilot.B.n) : null,
    fMinusApp: pilot.F && pilot.A ? pct(pilot.F.correct - pilot.A.correct, pilot.A.n) : null,
    families,
    caveats: [
      'Exploratory real-model pilot; not confirmatory evidence.',
      '30 provisional tasks, one repeat, three conditions.',
      'Contract success is not mathematical accuracy.',
      'F−B family-bootstrap 95% interval was [−10, 0] in the recorded pilot.',
      'B only had supplied excerpts; F had corpus/index access, so the comparison is not fully resource-matched.',
    ],
  },
  matrix: {
    models: matrices.sort((a, b) => a.matrix.localeCompare(b.matrix) || a.model.localeCompare(b.model)),
    free: { A: aggregate(matrices.filter(row => row.matrix === 'free'), 'A'), B: aggregate(matrices.filter(row => row.matrix === 'free'), 'B'), F: aggregate(matrices.filter(row => row.matrix === 'free'), 'F') },
    other: { A: aggregate(matrices.filter(row => row.matrix === 'other'), 'A'), B: aggregate(matrices.filter(row => row.matrix === 'other'), 'B'), F: aggregate(matrices.filter(row => row.matrix === 'other'), 'F') },
    all: { A: aggregate(matrices, 'A'), B: aggregate(matrices, 'B'), F: aggregate(matrices, 'F') },
    caveats: [
      'Only full_complete models are included.',
      'Models differ; this is not a controlled paired comparison.',
      'Several full runs have incomplete episodes; completed counts are shown per condition.',
      'Some models appear in both free and direct matrices through different routes.',
      'F−B is descriptive and should not be read as a causal tool effect.',
    ],
  },
};

const json = JSON.stringify(report, null, 2) + '\n';
writeFileSync(path.join(OUT, 'score-report.json'), json);
writeFileSync(path.join(ROOT, 'scores-data.json'), json);
writeFileSync(path.join(ROOT, 'scores-data.js'), `window.SCORES_DATA = ${JSON.stringify(report)};\n`);

const lines = [
  '# Score report', '',
  `Generated: ${report.generated_at}`,
  '',
  '## Historical keyword benchmark',
  '',
  '| Condition | Correct | Rate | Wilson 95% CI | Errors |',
  '| --- | ---: | ---: | --- | ---: |',
  `| With plugin | ${historical.total.with.correct}/${historical.total.with.n} | ${historical.total.with.rate}% | ${historical.total.with.ci.join('–')}% | ${historical.total.with.errors} |`,
  `| Without plugin | ${historical.total.without.correct}/${historical.total.without.n} | ${historical.total.without.rate}% | ${historical.total.without.ci.join('–')}% | ${historical.total.without.errors} |`,
  '',
  `Descriptive difference: +${historical.total.diff_pp} pp.`,
  '',
  ...historical.caveats.map(c => `- ${c}`),
  '',
  '## Real pilot A/B/F',
  '',
  '| Condition | Correct | Completed | Extraction | Tokens | Cost |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...['A', 'B', 'F'].map(id => {
    const c = report.pilot[id];
    return c ? `| ${id} | ${c.correct}/${c.n} (${pct(c.correct, c.n)}%) | ${c.completed}/${c.n} | ${c.extraction} | ${c.tokens} | $${c.cost.toFixed(4)} |` : '';
  }),
  '',
  `F−B: ${report.pilot.fMinusBpp} pp; F−A: ${report.pilot.fMinusApp} pp`,
  '',
  '### By family',
  '',
  '| Family | A | B | F |',
  '| --- | ---: | ---: | ---: |',
  ...Object.entries(families).sort(([a], [b]) => a.localeCompare(b)).map(([family, c]) => `| ${family} | ${c.A ? `${c.A.correct}/${c.A.n}` : '-'} | ${c.B ? `${c.B.correct}/${c.B.n}` : '-'} | ${c.F ? `${c.F.correct}/${c.F.n}` : '-'} |`),
  '',
  '## Matrix full-complete models',
  '',
  '| Matrix | Model | A | B | F | F−B | Clean |',
  '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ...matrices.map(row => `| ${row.matrix} | \`${row.model}\` | ${row.A ? `${row.A.correct}/${row.A.n} (${row.A.completed})` : '-'} | ${row.B ? `${row.B.correct}/${row.B.n} (${row.B.completed})` : '-'} | ${row.F ? `${row.F.correct}/${row.F.n} (${row.F.completed})` : '-'} | ${row.fMinusBpp ?? '-'} pp | ${row.clean ? 'yes' : 'no'} |`),
  '',
  '## Aggregates',
  '',
  '| Subset | A | B | F |',
  '| --- | ---: | ---: | ---: |',
  ...['free', 'other', 'all'].map(id => {
    const s = report.matrix[id];
    const value = c => c ? `${c.correct}/${c.n}` : '-';
    return `| ${id} | ${value(s.A)} | ${value(s.B)} | ${value(s.F)} |`;
  }),
  '',
  'Matrix aggregates are descriptive and not a controlled paired comparison.',
  '',
  ...report.matrix.caveats.map(c => `- ${c}`),
];
writeFileSync(path.join(OUT, 'score-report.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ generated_at: report.generated_at, pilot: report.pilot, matrix_models: matrices.length, aggregates: report.matrix.all, scores_data: path.join(ROOT, 'scores-data.js') }, null, 2));
console.log(`json ${path.join(OUT, 'score-report.json')}`);
console.log(`md   ${path.join(OUT, 'score-report.md')}`);
