import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] || 'C:/Users/MiPC/AppData/Local/Temp/opencode/normal-use-v1');
const readJsonl = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const parseCsv = text => {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
};
const episodes = readJsonl(path.join(out, 'episodes.jsonl'));
const manifest = existsSync(path.join(out, 'manifest.json')) ? JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) : {};
const reviewPath = path.join(out, 'review.csv');
const reviewRows = existsSync(reviewPath) ? parseCsv(readFileSync(reviewPath, 'utf8')) : [];
const reviewHeader = reviewRows.shift() ?? [];
const scoreIndex = reviewHeader.indexOf('score');
const notesIndex = reviewHeader.indexOf('notes');
const scores = new Map();
for (const row of reviewRows) {
  if (!row.length) continue;
  const key = `${row[0]}\u0000${row[1]}`;
  scores.set(key, { score: scoreIndex >= 0 && row[scoreIndex] !== '' ? Number(row[scoreIndex]) : null, notes: notesIndex >= 0 ? row[notesIndex] : '' });
}
const conditions = [...new Set(episodes.map(episode => episode.condition))];
const summarize = condition => {
  const list = episodes.filter(episode => episode.condition === condition);
  const scored = list.map(episode => scores.get(`${episode.task_id}\u0000${episode.condition}`)?.score).filter(score => Number.isFinite(score));
  return {
    episodes: list.length,
    completed: list.filter(episode => episode.status === 'completed').length,
    operational_failures: list.filter(episode => episode.status === 'operational_failure').length,
    extraction_failures: list.filter(episode => episode.status === 'extraction_failure').length,
    duration_ms_mean: list.length ? Math.round(list.reduce((sum, episode) => sum + episode.duration_ms, 0) / list.length) : null,
    tokens: list.reduce((sum, episode) => sum + (Number(episode.usage?.tokens) || 0), 0),
    cost_usd: Number(list.reduce((sum, episode) => sum + (Number(episode.usage?.cost) || 0), 0).toFixed(6)),
    tool_calls: list.reduce((sum, episode) => sum + episode.tools.length, 0),
    math_tool_calls: list.reduce((sum, episode) => sum + (episode.math_tools?.length ?? 0), 0),
    human_scored: scored.length,
    human_correct: scored.filter(score => score === 1).length,
    human_score_rate: scored.length ? Number((scored.filter(score => score === 1).length / scored.length * 100).toFixed(1)) : null,
  };
};
const report = {
  schema: 'normal-use-report/v1',
  generated_at: new Date().toISOString(),
  study_id: manifest.study_id ?? null,
  model: manifest.model ?? null,
  review_required: true,
  conditions: Object.fromEntries(conditions.map(condition => [condition, summarize(condition)])),
  tasks: [...new Set(episodes.map(episode => episode.task_id))].map(taskID => {
    const byCondition = Object.fromEntries(conditions.map(condition => {
      const episode = episodes.find(item => item.task_id === taskID && item.condition === condition);
      const review = scores.get(`${taskID}\u0000${condition}`);
      return [condition, episode ? { status: episode.status, duration_ms: episode.duration_ms, tokens: episode.usage?.tokens ?? null, cost_usd: episode.usage?.cost ?? null, math_tools: episode.math_tools ?? [], score: review?.score ?? null, notes: review?.notes ?? '' } : null];
    }));
    return { task_id: taskID, conditions: byCondition };
  }),
};
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const lines = [
  '# Normal-use report', '',
  `Study: ${report.study_id ?? '-'}`,
  `Model: ${report.model ?? '-'}`,
  `Generated: ${report.generated_at}`,
  '',
  '## Condition summary', '',
  '| Condition | Episodes | Completed | Operational | Extraction | Mean time | Tokens | Cost | Tool calls | Math calls | Human score |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...Object.entries(report.conditions).map(([condition, c]) => `| ${condition} | ${c.episodes} | ${c.completed} | ${c.operational_failures} | ${c.extraction_failures} | ${c.duration_ms_mean == null ? '-' : Math.round(c.duration_ms_mean / 1000) + 's'} | ${c.tokens} | $${c.cost_usd.toFixed(5)} | ${c.tool_calls} | ${c.math_tool_calls} | ${c.human_scored ? `${c.human_correct}/${c.human_scored} (${c.human_score_rate}%)` : 'pending'} |`),
  '',
  'Human scores come only from `review.csv`; mechanical metrics are not correctness scores.',
  '',
  '## Per task', '',
  '| Task | Condition | Status | Time | Tokens | Math calls | Score |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: |',
  ...report.tasks.flatMap(task => Object.entries(task.conditions).map(([condition, c]) => c ? `| ${task.task_id} | ${condition} | ${c.status} | ${Math.round(c.duration_ms / 1000)}s | ${c.tokens ?? '-'} | ${c.math_tools.length} | ${c.score ?? 'pending'} |` : `| ${task.task_id} | ${condition} | missing | - | - | - | - |`)),
];
writeFileSync(path.join(out, 'report.md'), lines.join('\n') + '\n');
console.log(JSON.stringify(report.conditions, null, 2));
console.log(`report ${path.join(out, 'report.md')}`);
