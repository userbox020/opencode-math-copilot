import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNormalReport, parseCsv, reportMain, writeReport } from '../report-normal.mjs';
import { auditNormal, hardInspections } from '../audit-normal.mjs';

const manifest = { study_id: 'study', model: 'fixture', conditions: ['plugin-on', 'plugin-off'] };
const episode = overrides => ({ study_id: 'study', task_id: 'task', condition: 'plugin-on', repeat_id: 1, status: 'completed', duration_ms: 12, tools: [], math_tools: [], usage: { tokens: 10, cost: 0.01 }, final_text: 'Answer; receipt verified (self-report only).', ...overrides });
const report = (episodes = [episode()], reviewCsv = '', extra = {}) => buildNormalReport({ manifest, episodes, reviewCsv, ...extra });
const csv = rows => 'task_id,condition,score\n' + rows;
const temporary = fn => { const dir = mkdtempSync(path.join(os.tmpdir(), 'normal-audit-test-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('missing usage is unknown, not zero; known subtotals and coverage remain visible', () => {
  const r = report([episode(), episode({ task_id: 'missing', usage: null })]);
  const c = r.conditions['plugin-on'];
  assert.equal(c.tokens, null); assert.equal(c.cost_usd, null);
  assert.equal(c.tokens_known_subtotal, 10); assert.equal(c.cost_usd_known_subtotal, 0.01);
  assert.equal(c.usage_episodes_known, 1); assert.equal(c.usage_episodes_missing, 1);
  assert.equal(r.tasks[1].conditions['plugin-on'].tokens, null);
  const zero = report([episode({ usage: { tokens: 0, cost: 0 } })]).conditions['plugin-on'];
  assert.equal(zero.tokens, 0); assert.equal(zero.cost_usd, 0); assert.equal(zero.usage_episodes_known, 1);
});

test('partial usage retains independently known metrics without inventing cost', () => {
  const c = report([episode({ usage: { tokens: 10, cost: null } })]).conditions['plugin-on'];
  assert.equal(c.tokens, 10); assert.equal(c.cost_usd, null); assert.equal(c.usage_episodes_known, 0);
  assert.equal(c.cost_usd_known_subtotal, 0);
});

test('duplicate and orphan review IDs fail including duplicate blank reviews', () => {
  for (const rows of ['task,plugin-on,1\ntask,plugin-on,0', 'task,plugin-on,\ntask,plugin-on,']) assert.throws(() => report(undefined, csv(rows)), /Duplicate review/);
  assert.throws(() => report(undefined, csv('unknown,plugin-on,1')), /Orphan review/);
  assert.throws(() => report(undefined, 'study_id,task_id,condition,repeat_id,score\nother,task,plugin-on,1,1'), /Orphan review/);
});

test('nonbinary scores and malformed CSV fail closed', () => {
  for (const score of ['2', '-1', '0.5', 'true', 'NaN', 'Infinity', '01', ' 1 ']) assert.throws(() => report(undefined, csv(`task,plugin-on,${score}`)), /Nonbinary/);
  for (const input of ['task_id,condition,score\ntask,plugin-on,"1', 'task_id,condition,score\ntask,plugin-on,"1"junk', 'task_id,condition,score\nta"sk,plugin-on,1', 'task_id,condition,score\ntask,plugin-on', 'task_id,condition,score,score\ntask,plugin-on,1,1']) assert.throws(() => report(undefined, input), /CSV|header/);
  assert.deepEqual(parseCsv('a,b\r\n"line\nwith ""quote""",x\r\n'), [['a', 'b'], ['line\nwith "quote"', 'x']]);
});

test('ambiguous legacy reviews fail for repeated task/condition; distinct repeats remain distinct', () => {
  const episodes = [episode(), episode({ repeat_id: 2 })];
  assert.throws(() => report(episodes, csv('task,plugin-on,1')), /Ambiguous.*repeat_id/);
  const r = report(episodes, 'study_id,task_id,condition,repeat_id,score\nstudy,task,plugin-on,1,1\nstudy,task,plugin-on,2,0');
  assert.equal(r.tasks.length, 2);
  assert.deepEqual(r.tasks.map(t => t.repeat_id), [1, 2]);
  assert.deepEqual(r.tasks.map(t => t.conditions['plugin-on'].score), [1, 0]);
  assert.equal(r.conditions['plugin-on'].review_scored, 2);
  assert.equal(r.conditions['plugin-on'].review_correct, 1);
  assert.throws(() => report([episode(), episode()]), /Duplicate episode/);
});

test('study identity is retained and ambiguous cross-study legacy reviews fail', () => {
  const episodes = [episode(), episode({ study_id: 'other' })];
  assert.throws(() => report(episodes, csv('task,plugin-on,1'), { manifest: {} }), /Ambiguous/);
  const r = report(episodes, 'study_id,task_id,condition,repeat_id,score\nstudy,task,plugin-on,1,1\nother,task,plugin-on,1,0', { manifest: {} });
  assert.equal(r.tasks.length, 2);
  assert.deepEqual(r.tasks.map(t => t.study_id), ['study', 'other']);
});

test('invalid artifact fields and mismatched review status are rejected', () => {
  for (const overrides of [{ status: 'verified' }, { usage: { tokens: '20', cost: 1 } }, { usage: { tokens: 1, cost: -1 } }, { usage: [] }, { duration_ms: null }, { tools: [{}] }, { math_tools: 'math_status' }, { repeat_id: 0 }, { study_id: 'other' }, { final_text: null }]) assert.throws(() => report([episode(overrides)]), /Invalid|disagrees|no final_text/);
  assert.throws(() => report(undefined, 'task_id,condition,status,score\ntask,plugin-on,operational_failure,1'), /status disagrees/);
});

test('blank v6-style review remains unreviewed; completed output is not validity or verification', () => {
  const r = report(undefined, csv('task,plugin-on,'));
  const c = r.conditions['plugin-on'], e = r.tasks[0].conditions['plugin-on'];
  assert.equal(c.completed, 1); assert.equal(c.review_scored, 0); assert.equal(c.review_score_rate, null);
  assert.equal(c.review_provenance, 'legacy_unattributed');
  assert.equal(e.score, null); assert.equal(e.review_status, 'unreviewed');
  assert.equal(e.answer_validity, 'not_assessed'); assert.equal(e.proof_verification, 'not_established');
  assert.equal(e.receipt_observation, 'not_authenticated');
  assert.doesNotMatch(JSON.stringify(r), /"human_/);
});

test('scores come from recorded rows, never from condition', () => {
  const r = report([episode(), episode({ condition: 'plugin-off' })], csv('task,plugin-on,0\ntask,plugin-off,1'));
  assert.equal(r.conditions['plugin-on'].review_correct, 0);
  assert.equal(r.conditions['plugin-off'].review_correct, 1);
});

test('AI receipt assertions are not observed receipts or proof grades; inline recap remains separate', () => {
  const episodes = [];
  for (const task of ['pdf-hanner-page', 'lean-identity', 'lean-add-zero', 'lean-implications', 'lean-sum', 'lean-conjunction', 'lean-true']) for (const condition of ['plugin-on', 'plugin-on-minimal', 'plugin-off']) {
    episodes.push(episode({ task_id: `hard-${task}`, condition, final_text: task === 'lean-add-zero' && condition === 'plugin-off' ? 'Still waiting: inline proof.' : '```lean\nexample : True := True.intro\n```' }));
  }
  const source = { path: 'fixture/episodes.jsonl', sha256: '826d2c9df07a310e5ee71b0721fcb8be30cbcf710f59dedba896dd4b97bade3e' };
  const annotations = hardInspections('normal-use-v6-hard-glm', episodes, source);
  assert.equal(annotations.filter(a => a.receipt_assertion === 'asserted').length, 12);
  assert(annotations.every(a => a.receipt_observed === false && a.proof_verification === 'not_established'));
  const inline = annotations.find(a => a.code_presentation === 'inline_only');
  assert.equal(inline.output_status, 'completed'); assert.match(inline.note, /incomplete standalone/);
  assert.equal(inline.answer_by_inspection, 'plausible_term');
  assert.throws(() => hardInspections('normal-use-v6-hard-glm', episodes, { ...source, sha256: 'changed' }), /source changed/);
});

test('report and audit refuse existing output; source artifacts remain unchanged', () => temporary(dir => {
  const r = report();
  writeReport(r, dir);
  const before = readFileSync(path.join(dir, 'report.json'), 'utf8');
  assert.throws(() => writeReport(r, dir), /Refusing/);
  assert.throws(() => auditNormal({ artifactsRoot: dir, out: dir }), /Refusing/);
  assert.equal(readFileSync(path.join(dir, 'report.json'), 'utf8'), before);
  assert.throws(() => reportMain(['--out', dir]), /required/);
  assert.throws(() => reportMain(['--out', dir, '--report-out', dir]), /fresh directory/);
}));

test('report CLI uses a fresh destination and preserves original reports and blank reviews', () => temporary(dir => {
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'episodes.jsonl'), JSON.stringify(episode()) + '\n');
  const reviews = csv('task,plugin-on,');
  writeFileSync(path.join(dir, 'review.csv'), reviews);
  writeFileSync(path.join(dir, 'report.json'), 'historical report');
  const destination = path.join(dir, 'corrected');
  reportMain(['--out', dir, '--report-out', destination]);
  assert.equal(readFileSync(path.join(dir, 'report.json'), 'utf8'), 'historical report');
  assert.equal(readFileSync(path.join(dir, 'review.csv'), 'utf8'), reviews);
  assert.equal(JSON.parse(readFileSync(path.join(destination, 'report.json'))).conditions['plugin-on'].review_scored, 0);
  assert.throws(() => reportMain(['--out', dir, '--report-out', destination]), /fresh directory/);
}));
