import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const REPO = 'C:/_Work/opencode-math-copilot';
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

const pilotPath = `${REPO}/bench/v2/real/pilot-2026-11-09-opencode-go-deepseek-v4.1-flash/episodes.jsonl`;
const pilot = summarize(readJsonl(pilotPath));
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
    matrices.push({ matrix, model, A: by.A ?? null, B: by.B ?? null, F: by.F ?? null, fMinusBpp: by.F && by.B ? Number(((by.F.correct - by.B.correct) / Math.max(1, by.B.n) * 100).toFixed(1)) : null });
  }
}
const aggregate = (rows, id) => {
  const present = rows.map(row => row[id]).filter(Boolean);
  return present.length ? { models: present.length, n: present.reduce((sum, c) => sum + c.n, 0), correct: present.reduce((sum, c) => sum + c.correct, 0), completed: present.reduce((sum, c) => sum + c.completed, 0) } : null;
};
const report = {
  generated_at: new Date().toISOString(),
  pilot: {
    A: pilot.A ?? null, B: pilot.B ?? null, F: pilot.F ?? null,
    fMinusBpp: pilot.F && pilot.B ? pct(pilot.F.correct - pilot.B.correct, pilot.B.n) : null,
    fMinusApp: pilot.F && pilot.A ? pct(pilot.F.correct - pilot.A.correct, pilot.A.n) : null,
  },
  matrix: {
    models: matrices,
    free: { A: aggregate(matrices.filter(row => row.matrix === 'free'), 'A'), B: aggregate(matrices.filter(row => row.matrix === 'free'), 'B'), F: aggregate(matrices.filter(row => row.matrix === 'free'), 'F') },
    other: { A: aggregate(matrices.filter(row => row.matrix === 'other'), 'A'), B: aggregate(matrices.filter(row => row.matrix === 'other'), 'B'), F: aggregate(matrices.filter(row => row.matrix === 'other'), 'F') },
    all: { A: aggregate(matrices, 'A'), B: aggregate(matrices, 'B'), F: aggregate(matrices, 'F') },
  },
};
writeFileSync(`${OUT}/score-report.json`, JSON.stringify(report, null, 2) + '\n');
const lines = [
  '# Score report', '',
  `Generated: ${report.generated_at}`,
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
  '## Matrix full-complete models',
  '',
  '| Matrix | Model | A | B | F | F−B |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
  ...matrices.map(row => `| ${row.matrix} | \`${row.model}\` | ${row.A ? `${row.A.correct}/${row.A.n} (${row.A.completed})` : '-'} | ${row.B ? `${row.B.correct}/${row.B.n} (${row.B.completed})` : '-'} | ${row.F ? `${row.F.correct}/${row.F.n} (${row.F.completed})` : '-'} | ${row.fMinusBpp ?? '-'} pp |`),
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
];
writeFileSync(`${OUT}/score-report.md`, lines.join('\n') + '\n');
console.log(JSON.stringify({ generated_at: report.generated_at, pilot: report.pilot, matrix_models: matrices.length, aggregates: report.matrix.all }, null, 2));
console.log(`json ${OUT}/score-report.json`);
console.log(`md   ${OUT}/score-report.md`);
