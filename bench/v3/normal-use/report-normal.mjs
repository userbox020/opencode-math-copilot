import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const textID = value => typeof value === 'string' && value.trim().length > 0;
const round = value => Number(value.toFixed(9));
export const episodeID = episode => JSON.stringify([episode.study_id ?? null, episode.task_id, episode.condition, episode.repeat_id ?? null]);

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  const pushCell = () => { row.push(cell); cell = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      pushCell();
      if (ch !== ',') { rows.push(row); row = []; if (ch === '\r' && text[i + 1] === '\n') i++; }
    } else if (closed) fail('Malformed CSV: characters after closing quote');
    else if (ch === '"') { if (cell) fail('Malformed CSV: quote inside unquoted field'); quoted = true; }
    else cell += ch;
  }
  if (quoted) fail('Malformed CSV: unterminated quote');
  if (cell || row.length || closed) { pushCell(); rows.push(row); }
  return rows.filter(row => !(row.length === 1 && row[0] === ''));
}

function validatedEpisodes(manifest, episodes) {
  if (!object(manifest) || !Array.isArray(episodes)) fail('Invalid manifest or episodes');
  if (manifest.study_id != null && !textID(manifest.study_id)) fail('Invalid manifest study_id');
  if (manifest.conditions != null && (!Array.isArray(manifest.conditions) || manifest.conditions.some(c => !textID(c)))) fail('Invalid manifest conditions');
  const ids = new Set();
  return episodes.map((e, index) => {
    if (!object(e) || !textID(e.task_id) || !textID(e.condition)) fail(`Invalid episode identity at ${index + 1}`);
    const study_id = e.study_id ?? manifest.study_id ?? null;
    if (study_id !== null && !textID(study_id)) fail('Invalid episode study_id');
    if (manifest.study_id && study_id !== manifest.study_id) fail('Episode study_id disagrees with manifest');
    if (manifest.conditions && !manifest.conditions.includes(e.condition)) fail('Episode condition absent from manifest');
    if (e.repeat_id != null && (!Number.isInteger(e.repeat_id) || e.repeat_id < 1)) fail('Invalid repeat_id');
    if (!['completed', 'operational_failure', 'extraction_failure'].includes(e.status)) fail('Invalid episode status');
    if (!nonnegative(e.duration_ms)) fail('Invalid episode duration_ms');
    if (!Array.isArray(e.tools) || e.tools.some(t => !textID(t)) || (e.math_tools != null && (!Array.isArray(e.math_tools) || e.math_tools.some(t => !textID(t))))) fail('Invalid episode tool-name arrays');
    if (e.final_text != null && typeof e.final_text !== 'string') fail('Invalid final_text');
    if (e.status === 'completed' && !textID(e.final_text)) fail('Completed episode has no final_text');
    if (e.usage != null) {
      if (!object(e.usage)) fail('Invalid usage');
      for (const key of ['tokens', 'cost']) if (e.usage[key] != null && !nonnegative(e.usage[key])) fail(`Invalid usage.${key}`);
      if (e.usage.tokens != null && !Number.isInteger(e.usage.tokens)) fail('Invalid usage.tokens');
    }
    const episode = { ...e, study_id, repeat_id: e.repeat_id ?? null };
    const id = episodeID(episode);
    if (ids.has(id)) fail(`Duplicate episode ID: ${id}`);
    ids.add(id);
    return episode;
  });
}

function readReviews(csv, episodes) {
  const rows = parseCsv(csv);
  if (!rows.length) return new Map();
  const header = rows.shift();
  if (new Set(header).size !== header.length || header.some(h => !h)) fail('Duplicate or empty CSV header');
  for (const name of ['task_id', 'condition', 'score']) if (!header.includes(name)) fail(`Missing CSV header: ${name}`);
  const scores = new Map();
  for (const row of rows) {
    if (row.length !== header.length) fail('CSV row width does not match header');
    const r = Object.fromEntries(header.map((name, i) => [name, row[i]]));
    if (!textID(r.task_id) || !textID(r.condition)) fail('Invalid review identity');
    if (!['', '0', '1'].includes(r.score)) fail(`Nonbinary review score: ${r.score}`);
    if (r.repeat_id && !/^[1-9]\d*$/.test(r.repeat_id)) fail('Invalid review repeat_id');
    const candidates = episodes.filter(e => e.task_id === r.task_id && e.condition === r.condition
      && (!r.study_id || e.study_id === r.study_id) && (!r.repeat_id || e.repeat_id === Number(r.repeat_id)));
    if (!candidates.length) fail(`Orphan review ID: ${r.task_id}/${r.condition}`);
    if (candidates.length !== 1) fail(`Ambiguous legacy review ID; supply study_id/repeat_id: ${r.task_id}/${r.condition}`);
    const episode = candidates[0], id = episodeID(episode);
    if (scores.has(id)) fail(`Duplicate review ID: ${id}`);
    if (r.status && r.status !== episode.status) fail(`Review status disagrees with episode: ${id}`);
    scores.set(id, { score: r.score === '' ? null : Number(r.score), notes: r.notes ?? '' });
  }
  return scores;
}

// Pure: no files, clock, environment, model calls, or condition-derived grades.
export function buildNormalReport({ manifest = {}, episodes, reviewCsv = '', generatedAt = null }) {
  const validated = validatedEpisodes(manifest, episodes);
  const reviews = readReviews(reviewCsv, validated);
  const records = validated.map(e => {
    const review = reviews.get(episodeID(e));
    return {
      episode_id: episodeID(e), study_id: e.study_id, task_id: e.task_id, repeat_id: e.repeat_id, condition: e.condition,
      status: e.status, duration_ms: e.duration_ms, tokens: e.usage?.tokens ?? null, cost_usd: e.usage?.cost ?? null,
      tools: e.tools, math_tools: e.math_tools ?? [], score: review?.score ?? null, notes: review?.notes ?? '',
      review_status: review?.score == null ? 'unreviewed' : 'recorded', review_provenance: 'legacy_unattributed',
      answer_validity: 'not_assessed', proof_verification: 'not_established', receipt_observation: 'not_authenticated',
    };
  });
  const conditions = [...new Set([...(manifest.conditions ?? []), ...records.map(e => e.condition)])];
  const summarize = condition => {
    const list = records.filter(e => e.condition === condition);
    const scored = list.filter(e => e.score !== null);
    const tokensKnown = list.filter(e => e.tokens !== null), costKnown = list.filter(e => e.cost_usd !== null);
    const known = list.filter(e => e.tokens !== null && e.cost_usd !== null).length;
    const tokens = tokensKnown.reduce((sum, e) => sum + e.tokens, 0);
    const cost = round(costKnown.reduce((sum, e) => sum + e.cost_usd, 0));
    return {
      episodes: list.length, completed: list.filter(e => e.status === 'completed').length,
      operational_failures: list.filter(e => e.status === 'operational_failure').length,
      extraction_failures: list.filter(e => e.status === 'extraction_failure').length,
      duration_ms_mean: list.length ? Math.round(list.reduce((sum, e) => sum + e.duration_ms, 0) / list.length) : null,
      tokens: list.length && tokensKnown.length === list.length ? tokens : null,
      cost_usd: list.length && costKnown.length === list.length ? cost : null,
      tokens_known_subtotal: tokens, cost_usd_known_subtotal: cost,
      usage_episodes_known: known, usage_episodes_missing: list.length - known,
      review_scored: scored.length, review_correct: scored.filter(e => e.score === 1).length,
      review_score_rate: scored.length ? Number((100 * scored.filter(e => e.score === 1).length / scored.length).toFixed(1)) : null,
      review_provenance: 'legacy_unattributed', tool_calls: list.reduce((sum, e) => sum + e.tools.length, 0),
      math_tool_calls: list.reduce((sum, e) => sum + e.math_tools.length, 0),
    };
  };
  const tasks = new Map();
  for (const e of records) {
    const key = JSON.stringify([e.study_id, e.task_id, e.repeat_id]);
    if (!tasks.has(key)) tasks.set(key, { study_id: e.study_id, task_id: e.task_id, repeat_id: e.repeat_id, conditions: Object.fromEntries(conditions.map(c => [c, null])) });
    tasks.get(key).conditions[e.condition] = e;
  }
  return {
    schema: 'normal-use-report/v2', generated_at: generatedAt, study_id: manifest.study_id ?? null, model: manifest.model ?? null,
    review_required: true, review_provenance: 'legacy_unattributed',
    evidence_note: 'Recorded legacy scores; reviewer provenance unavailable (assistant/model adjudication per conversation). No authenticated human review or receipt is assumed. Completion is not answer validity; lexical tool references are not successful tool evidence. Missing usage is unknown, not zero; known subtotals are not full billing.',
    conditions: Object.fromEntries(conditions.map(c => [c, summarize(c)])), tasks: [...tasks.values()],
  };
}

export function loadStudy(directory) {
  const read = name => readFileSync(path.join(directory, name), 'utf8');
  return { manifest: JSON.parse(read('manifest.json')), episodes: read('episodes.jsonl').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse), reviewCsv: existsSync(path.join(directory, 'review.csv')) ? read('review.csv') : '' };
}

const md = value => String(value ?? 'unknown').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
export function reportMarkdown(report) {
  return ['# Corrected normal-use report', '', `Study: ${report.study_id ?? 'unknown'}`, `Model: ${report.model ?? 'unknown'}`, '', report.evidence_note, '',
    '| Condition | Episodes | Completed | Operational | Extraction | Mean ms | Tokens known subtotal | Cost known subtotal (USD) | Usage known/total | Recorded scores | Unreviewed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
    ...Object.entries(report.conditions).map(([c, s]) => `| ${md(c)} | ${s.episodes} | ${s.completed} | ${s.operational_failures} | ${s.extraction_failures} | ${s.duration_ms_mean ?? '-'} | ${s.tokens_known_subtotal} | ${s.cost_usd_known_subtotal} | ${s.usage_episodes_known}/${s.episodes} | ${s.review_correct}/${s.review_scored} | ${s.episodes - s.review_scored} |`), '',
    '## Episode identities and recorded reviews', '', '| Study | Task | Repeat | Condition | Output status | Recorded score | Review state |', '| --- | --- | ---: | --- | --- | ---: | --- |',
    ...report.tasks.flatMap(t => Object.entries(t.conditions).map(([c, e]) => `| ${md(t.study_id)} | ${md(t.task_id)} | ${t.repeat_id ?? 'unspecified'} | ${md(c)} | ${e?.status ?? 'missing'} | ${e?.score ?? '—'} | ${e?.review_status ?? 'missing episode'} |`)), '',
    'Receipt assertions, when present in final answers, are not authenticated tool receipts or proof verification. See the separate evidence audit for AI-inspection annotations.', ''].join('\n');
}

export function writeReport(report, directory) {
  const files = ['report.json', 'report.md'].map(name => path.join(directory, name));
  if (files.some(existsSync)) fail(`Refusing to overwrite existing report in ${directory}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(files[0], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(files[1], reportMarkdown(report), { flag: 'wx' });
  return files;
}

export function reportMain(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--report-out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) fail('Usage: --out <source-study> --report-out <fresh-report-directory>');
    options[args[i]] = args[i + 1];
  }
  if (!options['--out'] || !options['--report-out']) fail('Both --out and --report-out are required; originals are never overwritten');
  const source = path.resolve(options['--out']), destination = path.resolve(options['--report-out']);
  if (source === destination || existsSync(destination)) fail('Report destination must be a fresh directory separate from the source');
  return writeReport(buildNormalReport({ ...loadStudy(source), generatedAt: new Date().toISOString() }), destination);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(reportMain().join('\n')); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
