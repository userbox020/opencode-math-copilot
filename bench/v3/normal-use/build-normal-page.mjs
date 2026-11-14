import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = 'C:/Users/MiPC/AppData/Local/Temp/opencode';
const sources = [
  ['v1', 'DeepSeek full vs off', 'normal-use-v1'],
  ['v2', 'DeepSeek full / minimal / off', 'normal-use-v2-minimal'],
  ['v3', 'GLM full / minimal / off (disambiguated v3b)', 'normal-use-v3b-glm'],
  ['v3-original', 'GLM original ambiguous run (separate)', 'normal-use-v3-glm'],
  ['v4', 'DeepSeek hard PDF/Lean tasks', 'normal-use-v4-hard'],
  ['v5', 'DeepSeek hard suite (7 tasks)', 'normal-use-v5-hard-deepseek'],
  ['v6', 'GLM hard suite (7 tasks)', 'normal-use-v6-hard-glm'],
];
const num = value => typeof value === 'number' && Number.isFinite(value);
const arr = value => Array.isArray(value) ? value : [];
const json = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const jsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : [];
function csv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
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
}
const key = (task, condition) => `${task}\u0000${condition}`;
const knownUsage = episode => num(episode.usage?.tokens) && num(episode.usage?.cost);

export function buildData({ sourceRoot = OUT, auditRoot } = {}) {
  auditRoot ??= process.env.NORMAL_USE_AUDIT_ROOT ?? path.join(sourceRoot, 'normal-use-evidence-audit-20261111');
  const studies = [];
  for (const [id, label, directory] of sources) {
    const dir = path.join(sourceRoot, directory);
    const auditedFile = auditRoot ? path.join(auditRoot, directory, 'report.json') : null;
    const audited = auditedFile && existsSync(auditedFile) ? json(auditedFile) : null;
    const report = audited ?? json(path.join(dir, 'report.json'));
    const manifest = json(path.join(dir, 'manifest.json')) ?? {};
    const episodeFile = path.join(dir, 'episodes.jsonl');
    const hasEpisodes = existsSync(episodeFile);
    const episodes = jsonl(episodeFile);
    if (!report && !hasEpisodes && !Object.keys(manifest).length) continue;
    const reviewFile = path.join(dir, 'review.csv');
    const hasReview = existsSync(reviewFile);
    const review = new Map();
    if (hasReview) {
      const rows = csv(readFileSync(reviewFile, 'utf8')), header = rows.shift() ?? [];
      for (const row of rows) {
        const raw = row[header.indexOf('score')]?.trim();
        const score = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
        review.set(key(row[header.indexOf('task_id')], row[header.indexOf('condition')]), { score, notes: row[header.indexOf('notes')] ?? '' });
      }
    }
    const cs = [...new Set([...arr(manifest.conditions), ...episodes.map(e => e.condition), ...Object.keys(report?.conditions ?? {})])];
    const taskIDs = [...new Set([...arr(manifest.tasks).map(t => t.id), ...episodes.map(e => e.task_id), ...arr(report?.tasks).map(t => t.task_id)])];
    const tasks = taskIDs.map(task_id => ({ task_id, conditions: Object.fromEntries(cs.map(condition => {
      const episode = episodes.find(e => e.task_id === task_id && e.condition === condition);
      const recorded = arr(report?.tasks).find(t => t.task_id === task_id)?.conditions?.[condition];
      const rating = audited ? recorded : hasReview ? review.get(key(task_id, condition)) : recorded;
      if (!episode && !recorded) return [condition, null];
      return [condition, {
        status: episode?.status ?? recorded?.status,
        duration_ms: episode?.duration_ms ?? recorded?.duration_ms ?? null,
        tokens: episode ? (num(episode.usage?.tokens) ? episode.usage.tokens : null) : (recorded?.tokens ?? null),
        cost_usd: episode ? (num(episode.usage?.cost) ? episode.usage.cost : null) : (recorded?.cost_usd ?? null),
        usage_complete: episode ? knownUsage(episode) : recorded?.usage_complete === true,
        math_tools: episode ? arr(episode.math_tools) : arr(recorded?.math_tools),
        score: num(rating?.score) ? rating.score : null,
        notes: rating?.notes ?? '',
        review_provenance: rating?.review_provenance ?? report?.conditions?.[condition]?.review_provenance ?? 'legacy_unattributed',
      }];
    })) }));
    const conditions = Object.fromEntries(cs.map(condition => {
      const old = report?.conditions?.[condition] ?? {};
      if (!hasEpisodes) {
        const covered = num(old.usage_episodes_known) && num(old.usage_episodes_missing);
        const complete = covered && old.episodes > 0 && old.usage_episodes_missing === 0 && old.usage_episodes_known === old.episodes;
        return [condition, { ...old,
          tokens: complete && num(old.tokens) ? old.tokens : null,
          cost_usd: complete && num(old.cost_usd) ? old.cost_usd : null,
          tokens_known_subtotal: old.tokens_known_subtotal ?? old.tokens ?? null,
          cost_usd_known_subtotal: old.cost_usd_known_subtotal ?? old.cost_usd ?? null,
          usage_episodes_known: covered ? old.usage_episodes_known : null,
          usage_episodes_missing: covered ? old.usage_episodes_missing : null,
          review_scored: old.review_scored ?? old.human_scored ?? null,
          review_correct: old.review_correct ?? old.human_correct ?? null,
          review_provenance: old.review_provenance ?? 'legacy_unattributed',
        }];
      }
      const list = episodes.filter(e => e.condition === condition), known = list.filter(knownUsage).length;
      const tokenSubtotal = list.reduce((sum, e) => sum + (num(e.usage?.tokens) ? e.usage.tokens : 0), 0);
      const costSubtotal = Number(list.reduce((sum, e) => sum + (num(e.usage?.cost) ? e.usage.cost : 0), 0).toFixed(6));
      const scored = tasks.map(t => t.conditions[condition]?.score).filter(num);
      return [condition, {
        episodes: list.length,
        completed: list.filter(e => e.status === 'completed').length,
        operational_failures: list.filter(e => e.status === 'operational_failure').length,
        extraction_failures: list.filter(e => e.status === 'extraction_failure').length,
        duration_ms_mean: list.length && list.every(e => num(e.duration_ms)) ? Math.round(list.reduce((sum, e) => sum + e.duration_ms, 0) / list.length) : null,
        tokens: list.length && known === list.length ? tokenSubtotal : null,
        cost_usd: list.length && known === list.length ? costSubtotal : null,
        tokens_known_subtotal: tokenSubtotal, cost_usd_known_subtotal: costSubtotal,
        usage_episodes_known: known, usage_episodes_missing: list.length - known,
        tool_calls: list.reduce((sum, e) => sum + arr(e.tools).length, 0),
        math_tool_calls: list.reduce((sum, e) => sum + arr(e.math_tools).length, 0),
        review_scored: scored.length, review_correct: scored.filter(score => score === 1).length,
        review_score_rate: scored.length ? Number((scored.filter(score => score === 1).length / scored.length * 100).toFixed(1)) : null,
        review_provenance: old.review_provenance ?? 'legacy_unattributed',
      }];
    }));
    studies.push({ id, label, source_directory: directory, model: manifest.model ?? report?.model ?? episodes[0]?.model,
      generated_at: report?.generated_at ?? manifest.generated_at, report_source: audited ? 'audited corrected report' : report ? 'original report / source artifacts' : 'source artifacts; no report',
      review_status: Object.values(conditions).some(c => c.review_scored > 0) ? 'recorded review; not authenticated human' : 'unreviewed', conditions, tasks });
  }
  return {
    schema: 'normal-use-page/v1', generated_at: new Date().toISOString(), studies,
    caveats: [
      'Exploratory, one repeat, not blind, CLI standalone. Normal OpenCode free-form answers have no typed JSON contract; Desktop/TUI behavior may differ.',
      'Recorded review scores are legacy/unattributed or AI/model inspection, not authenticated human review or mathematical accuracy.',
      'Completed means process/delivery completion, not a correct answer or verified proof.',
      'Tool references are not evidence of successful tool calls. Authentic runtime proof/receipt evidence is unavailable for the hard-suite formal answers; this does not prove verification never happened.',
      'Receipt requirements structurally favor the toolkit. The legacy v5 7/7 full and minimal versus 1/7 off scores are biased receipt scores, not mathematical accuracy.',
      'Saved-answer inspection of v5/v6: all 6 PDF answers reference-match. Of 36 formal answers, 24 assert verification success and 12 say it was unavailable; none has a preserved authentic runtime verifier receipt. This is AI/model inspection, not authenticated human review or fresh proof verification.',
      'Missing usage is unknown, not zero. Known subtotals are not complete totals; incomplete usage cannot support cost-savings or superiority claims.',
      'Task sets differ: v1/v2/v3b have 6 tasks, v4 has 2, and v5/v6 have 7. The original ambiguous v3 run is retained separately.',
      'Plugin-off disables the math toolkit but keeps built-in tools and other plugins. Do not compare these scores directly with the controlled A/B/F benchmark.',
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = args.indexOf('--audit-root');
  if (option >= 0 && (!args[option + 1] || args[option + 1].startsWith('--'))) throw new Error('--audit-root requires a directory');
  const auditRoot = option >= 0 ? path.resolve(args[option + 1]) : process.env.NORMAL_USE_AUDIT_ROOT;
  const data = buildData({ auditRoot });
  writeFileSync(path.join(ROOT, 'normal-use-data.json'), JSON.stringify(data, null, 2) + '\n');
  writeFileSync(path.join(ROOT, 'normal-use-data.js'), `window.NORMAL_USE_DATA = ${JSON.stringify(data)};\n`);
  console.log(JSON.stringify({ generated_at: data.generated_at, studies: data.studies.map(s => ({ id: s.id, model: s.model, report_source: s.report_source, review_status: s.review_status })) }, null, 2));
  console.log(`data ${path.join(ROOT, 'normal-use-data.js')}`);
}
