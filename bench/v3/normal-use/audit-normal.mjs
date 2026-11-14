import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNormalReport, episodeID, loadStudy, writeReport } from './report-normal.mjs';

export const STUDIES = [
  ['normal-use-v1', [4, null, 4], 12],
  ['normal-use-v2-minimal', [4, 6, 3], 18],
  ['normal-use-v3-glm', [5, 5, 3], 0],
  ['normal-use-v3b-glm', [4, 3, 3], 18],
  ['normal-use-v4-hard', [2, 2, 2], 6],
  ['normal-use-v5-hard-deepseek', [7, 7, 7], 21],
  ['normal-use-v6-hard-glm', [7, 7, 7], 0],
];
const CONDITIONS = ['plugin-on', 'plugin-on-minimal', 'plugin-off'];
const HASHES = {
  v5: '782b1de41f7d7d3ecef3be42240c1519eae824e7cba60f73bd0ddddac9346bbe',
  v6: '826d2c9df07a310e5ee71b0721fcb8be30cbcf710f59dedba896dd4b97bade3e',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Explicit answer-by-answer AI inspection supplied in the 2026-11-11 audit.
// These are NOT scores, authenticated reviewer records, or Lean check results.
// Each row is bound to the reviewed episodes.jsonl hash above. Never infer an
// answer's validity or receipt assertion merely from its treatment condition.
const INSPECTION_ROWS = `
v5|pdf-hanner-page|plugin-on|reference_match|not_applicable|not_applicable|
v5|pdf-hanner-page|plugin-on-minimal|reference_match|not_applicable|not_applicable|
v5|pdf-hanner-page|plugin-off|reference_match|not_applicable|not_applicable|
v5|lean-identity|plugin-on|plausible_term|asserted|fenced|
v5|lean-identity|plugin-on-minimal|plausible_term|asserted|fenced|
v5|lean-identity|plugin-off|plausible_term|unavailable|fenced|
v5|lean-add-zero|plugin-on|plausible_term|asserted|fenced|
v5|lean-add-zero|plugin-on-minimal|plausible_term|asserted|fenced|
v5|lean-add-zero|plugin-off|plausible_term|unavailable|fenced|
v5|lean-implications|plugin-on|plausible_term|asserted|fenced|
v5|lean-implications|plugin-on-minimal|plausible_term|asserted|fenced|
v5|lean-implications|plugin-off|plausible_term|unavailable|fenced|Incorrect receipt status vocabulary; no authentic receipt saved.
v5|lean-sum|plugin-on|plausible_term|asserted|fenced|
v5|lean-sum|plugin-on-minimal|plausible_term|asserted|fenced|
v5|lean-sum|plugin-off|plausible_term|unavailable|fenced|
v5|lean-conjunction|plugin-on|plausible_term|asserted|fenced|
v5|lean-conjunction|plugin-on-minimal|plausible_term|asserted|fenced|
v5|lean-conjunction|plugin-off|plausible_term|unavailable|fenced|
v5|lean-true|plugin-on|plausible_term|asserted|fenced|
v5|lean-true|plugin-on-minimal|plausible_term|asserted|fenced|
v5|lean-true|plugin-off|plausible_term|unavailable|fenced|Incorrect receipt status vocabulary; no authentic receipt saved.
v6|pdf-hanner-page|plugin-on|reference_match|not_applicable|not_applicable|
v6|pdf-hanner-page|plugin-on-minimal|reference_match|not_applicable|not_applicable|
v6|pdf-hanner-page|plugin-off|reference_match|not_applicable|not_applicable|
v6|lean-identity|plugin-on|plausible_term|asserted|fenced|
v6|lean-identity|plugin-on-minimal|plausible_term|asserted|fenced|
v6|lean-identity|plugin-off|plausible_term|unavailable|fenced|
v6|lean-add-zero|plugin-on|plausible_term|asserted|fenced|
v6|lean-add-zero|plugin-on-minimal|plausible_term|asserted|fenced|
v6|lean-add-zero|plugin-off|plausible_term|unavailable|inline_only|Waiting recap; incomplete standalone deliverable, despite plausible inline proof term.
v6|lean-implications|plugin-on|plausible_term|asserted|fenced|
v6|lean-implications|plugin-on-minimal|plausible_term|asserted|fenced|
v6|lean-implications|plugin-off|plausible_term|unavailable|fenced|Misstates math_lean_check as a strict receipt producer; math_lean_verify produces that receipt.
v6|lean-sum|plugin-on|plausible_term|asserted|fenced|
v6|lean-sum|plugin-on-minimal|plausible_term|asserted|fenced|
v6|lean-sum|plugin-off|plausible_term|unavailable|fenced|
v6|lean-conjunction|plugin-on|plausible_term|asserted|fenced|
v6|lean-conjunction|plugin-on-minimal|plausible_term|asserted|fenced|
v6|lean-conjunction|plugin-off|plausible_term|unavailable|fenced|Misstates math_lean_check as a strict receipt producer; math_lean_verify produces that receipt.
v6|lean-true|plugin-on|plausible_term|asserted|fenced|
v6|lean-true|plugin-on-minimal|plausible_term|asserted|fenced|
v6|lean-true|plugin-off|plausible_term|unavailable|fenced|
`.trim().split('\n').map(line => {
  const [study, task, condition, answer_by_inspection, receipt_assertion, code_presentation, note] = line.split('|');
  return { study, task_id: `hard-${task}`, condition, answer_by_inspection, receipt_assertion, code_presentation, note };
});

export function hardInspections(directoryName, episodes, source) {
  const study = directoryName === 'normal-use-v5-hard-deepseek' ? 'v5' : directoryName === 'normal-use-v6-hard-glm' ? 'v6' : null;
  if (!study) return [];
  if (source.sha256 !== HASHES[study]) throw new Error(`AI inspection source changed: ${directoryName}; re-inspection required`);
  const rows = INSPECTION_ROWS.filter(row => row.study === study);
  if (episodes.length !== rows.length) throw new Error('AI inspection episode coverage mismatch');
  return rows.map(row => {
    const matches = episodes.map((episode, index) => ({ episode, index })).filter(({ episode }) => episode.task_id === row.task_id && episode.condition === row.condition && episode.repeat_id === 1);
    if (matches.length !== 1) throw new Error(`AI inspection identity mismatch: ${row.task_id}/${row.condition}`);
    const { episode, index } = matches[0];
    const fenced = /```lean\b/i.test(episode.final_text);
    if ((row.code_presentation === 'fenced' && !fenced) || (row.code_presentation === 'inline_only' && fenced)) throw new Error('AI inspection code presentation mismatch');
    return {
      ...row, study_id: episode.study_id, repeat_id: episode.repeat_id, episode_id: episodeID(episode), output_status: episode.status,
      inspection_provenance: 'AI inspection supplied by code-reviewer audit; not authenticated human review',
      proof_verification: 'not_established', receipt_observed: false,
      receipt_scope: 'No authentic tool receipt preserved in these saved artifacts; this does not show that a receipt never existed.',
      evidence_path: `${source.path}#line=${index + 1}`, episodes_sha256: source.sha256, answer_sha256: sha256(episode.final_text),
    };
  });
}

export function auditNormal({ artifactsRoot = path.join(os.tmpdir(), 'opencode'), out }) {
  if (!out) throw new Error('--out is required');
  out = path.resolve(out);
  if (existsSync(out)) throw new Error(`Refusing existing audit output: ${out}`);
  const generatedAt = new Date().toISOString();
  const studies = STUDIES.map(([name, expectedUsage, expectedScored]) => {
    const directory = path.resolve(artifactsRoot, name);
    const data = loadStudy(directory);
    const report = buildNormalReport({ ...data, generatedAt });
    const sources = ['manifest.json', 'episodes.jsonl', 'review.csv', 'review.md', 'summary.json', 'report.json', 'report.md']
      .filter(file => existsSync(path.join(directory, file)))
      .map(file => { const filename = path.join(directory, file), bytes = readFileSync(filename); return { path: filename, bytes: bytes.length, sha256: sha256(bytes) }; });
    const annotations = hardInspections(name, data.episodes, sources.find(s => path.basename(s.path) === 'episodes.jsonl'));
    for (const [i, condition] of CONDITIONS.entries()) {
      if ((report.conditions[condition]?.usage_episodes_known ?? null) !== expectedUsage[i]) throw new Error(`Usage coverage mismatch: ${name}/${condition}`);
    }
    const summary = Object.values(report.conditions);
    if (summary.reduce((n, c) => n + c.review_scored, 0) !== expectedScored) throw new Error(`Recorded review coverage mismatch: ${name}`);
    for (const task of report.tasks) for (const episode of Object.values(task.conditions)) {
      if (episode) {
        const annotation = annotations.find(a => a.episode_id === episode.episode_id);
        if (annotation) episode.ai_inspection = annotation;
      }
    }
    return { name, report, sources, annotations, report_path: path.join(out, name, 'report.json') };
  });
  const all = studies.flatMap(s => Object.values(s.report.conditions));
  const total = field => all.reduce((n, s) => n + s[field], 0);
  const annotations = studies.flatMap(s => s.annotations);
  const totals = {
    episodes: total('episodes'), completed: total('completed'), usage_episodes_known: total('usage_episodes_known'), usage_episodes_missing: total('usage_episodes_missing'),
    tokens_known_subtotal: total('tokens_known_subtotal'), cost_usd_known_subtotal: Number(total('cost_usd_known_subtotal').toFixed(9)),
    review_scored: total('review_scored'), review_unscored: total('episodes') - total('review_scored'),
    ai_inspected: annotations.length, formal_plausible_terms: annotations.filter(a => a.answer_by_inspection === 'plausible_term').length,
    pdf_reference_matches: annotations.filter(a => a.answer_by_inspection === 'reference_match').length,
    receipt_assertions: annotations.filter(a => a.receipt_assertion === 'asserted').length,
    receipt_unavailable_statements: annotations.filter(a => a.receipt_assertion === 'unavailable').length,
    authentic_receipts_preserved_in_inspected_answers: 0,
    formal_fenced_blocks: annotations.filter(a => a.code_presentation === 'fenced').length,
    formal_inline_only: annotations.filter(a => a.code_presentation === 'inline_only').length,
  };
  const expected = { episodes: 114, usage_episodes_known: 92, usage_episodes_missing: 22, review_scored: 75, review_unscored: 39, ai_inspected: 42, formal_plausible_terms: 36, pdf_reference_matches: 6, receipt_assertions: 24, receipt_unavailable_statements: 12, formal_fenced_blocks: 35, formal_inline_only: 1 };
  for (const [key, value] of Object.entries(expected)) if (totals[key] !== value) throw new Error(`Audit mismatch: ${key}: expected ${value}, got ${totals[key]}`);
  const audit = {
    schema: 'normal-use-evidence-audit/v1', generated_at: generatedAt, artifacts_root: path.resolve(artifactsRoot), totals,
    method: 'Local artifacts only; no Lean execution or model/API calls. Existing manifests, episodes, reviews, summaries and reports preserved. AI inspection is separate from legacy scores and proof verification.',
    review_provenance: 'legacy_unattributed',
    limitations: [
      'Recorded legacy scores have no authenticated reviewer provenance; conversation records describe assistant/model adjudication. The alleged v1 second-review provenance was not saved.',
      'v5 scores 7/7, 7/7, 1/7 used six plugin-specific receipt requirements and condition-derived scoring; they are not mathematical accuracy.',
      'v3-original has 18 blank scores; v6 has 21 completed outputs and 21 blank scores. AI inspection does not fill those reviews.',
      'The inspected v5/v6 records preserve final text and lexical tool-name arrays, not authentic tool receipts. Receipt assertions cannot establish verification; absence from saved artifacts does not establish nonexistence.',
      'v5 plugin-off math_status is a lexical reference, not evidence of a successful tool call. Tool counts below retain recorded lexical counts.',
      'All six inspected PDF answers match the released Hanner PDF page 6 closing polar sentence according to the supplied code-reviewer PDF inspection; this is manuscript reference matching, not independent theorem verification.',
      'No general mathematical benefit or billing-efficiency comparison is supported. Usage coverage is incomplete; observed subtotals are not total billed cost.',
    ],
    pdf_reference: { path: 'math/preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/paper.pdf', page: 6, sentence: 'The polar of a linear Hanner body is again a linear Hanner body.', provenance: 'Released root PDF inspected by code-reviewer; no new PDF or Lean verification performed by this CLI.' },
    studies: studies.map(({ name, report, sources, annotations, report_path }) => ({ name, study_id: report.study_id, model: report.model, report_path, sources, conditions: report.conditions, annotations })),
  };
  // All inputs and expected counts validate before creating any output.
  mkdirSync(out);
  for (const study of studies) writeReport(study.report, path.dirname(study.report_path));
  writeFileSync(path.join(out, 'audit.json'), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
  const lines = ['# Normal-use evidence audit', '', audit.method, '', ...audit.limitations.map(s => `- ${s}`), '',
    '## Totals', '', ...Object.entries(totals).map(([k, v]) => `- ${k}: ${v}`), '',
    '## Study / condition coverage', '', '| Study | Condition | Completed/episodes | Usage known/total | Token subtotal | USD subtotal | Recorded scores | Blank |', '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |',
    ...studies.flatMap(s => Object.entries(s.report.conditions).map(([c, m]) => `| ${s.name} | ${c} | ${m.completed}/${m.episodes} | ${m.usage_episodes_known}/${m.episodes} | ${m.tokens_known_subtotal} | ${m.cost_usd_known_subtotal} | ${m.review_correct}/${m.review_scored} | ${m.episodes - m.review_scored} |`)), '',
    '## AI inspection (not proof verification or replacement scores)', '', '| Study | Task | Condition | Output status | Answer by inspection | Receipt assertion | Authentic receipt observed | Code | Note |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...annotations.map(a => `| ${a.study} | ${a.task_id} | ${a.condition} | ${a.output_status} | ${a.answer_by_inspection} | ${a.receipt_assertion} | no preserved receipt | ${a.code_presentation} | ${a.note} |`), '',
    '## Evidence paths and SHA-256', '', ...studies.flatMap(s => [`### ${s.name}`, `Corrected report: ${s.report_path}`, ...s.sources.map(f => `- \`${f.sha256}\` — ${f.path}`), '']),
    'Per-answer source line numbers and hashes are in audit.json. Original artifacts and reports were not rewritten.', ''];
  writeFileSync(path.join(out, 'audit.md'), lines.join('\n'), { flag: 'wx' });
  return audit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--out', '--artifacts-root'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Usage: --artifacts-root <root> --out <fresh-directory>');
      options[args[i]] = args[i + 1];
    }
    const result = auditNormal({ artifactsRoot: options['--artifacts-root'], out: options['--out'] });
    console.log(JSON.stringify({ totals: result.totals, reports: result.studies.map(s => s.report_path) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
