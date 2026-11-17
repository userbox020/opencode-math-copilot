import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main as lineageMain } from '../grading-lineage.mjs';
import { main as reportMain } from '../report.mjs';
import { sha256 } from '../lib.mjs';

function fixture(t) {
  const temp = mkdtempSync(path.join(process.platform === 'win32' ?
    'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode' : tmpdir(), 'lineage-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const out = path.join(temp, 'run');
  mkdirSync(path.join(out, 'episodes'), { recursive: true });
  mkdirSync(path.join(out, 'evaluation/private'), { recursive: true });
  const write = (relative, value) => writeFileSync(path.join(out, relative), JSON.stringify(value, null, 2) + '\n');
  const schedule = ['plugin-on', 'plugin-off'].map((condition, index) => ({
    episode_id: `fixture-${index}`, pair_id: 'fixture-pair', task_id: 'fixture-task',
    category: 'reasoning', family: 'fixture', repeat: 0, condition,
  }));
  write('manifest.json', { run_id: 'lineage-fixture-only', schedule });
  for (const item of schedule) write(`episodes/${item.episode_id}.json`, { ...item, status: 'completed' });
  write('evaluation/blind.json', schedule.map(item => ({ blind_id: item.episode_id,
    task: { id: item.task_id, category: item.category }, checker_required: false,
    checker: { status: 'not_applicable' } })));
  write('evaluation/private/unblind.json', { schema: 'real-use-unblind/v1',
    entries: schedule.map(item => ({ blind_id: item.episode_id, episode_id: item.episode_id })) });
  const reviews = schedule.map(item => ({ schema: 'real-use-review/v1', blind_id: item.episode_id,
    correctness: 'pass', evidence: 'adequate', reviewer_kind: 'model',
    reviewer_identity: 'fixture-reviewer', notes: 'Synthetic review, not actual adjudication.' }));
  write('evaluation/reviews.json', reviews);
  write('evaluation/reviews-human.json', reviews.map(review => ({ ...review, reviewer_kind: 'human' })));
  const reviewsPath = path.join(out, 'evaluation/reviews.json');
  const humanReviewsPath = path.join(out, 'evaluation/reviews-human.json');
  const reportPath = path.join(out, 'evaluation/report.json');
  const humanReportPath = path.join(out, 'evaluation/report-human.json');
  write('evaluation/report.json', reportMain(['--out', out, '--reviews', reviewsPath]));
  write('evaluation/report-human.json', reportMain(['--out', out, '--reviews', humanReviewsPath]));
  return { temp, out, write, reviews, reviewsPath, humanReviewsPath, reportPath, humanReportPath,
    ledger: path.join(out, 'grading-lineage.json'), args: ['--out', out, '--reviews', reviewsPath] };
}

test('default report path records hashes and model reviewer counts without modifying inputs', t => {
  const f = fixture(t), files = [f.reportPath, f.reviewsPath, path.join(f.out, 'evaluation/blind.json')];
  const before = files.map(file => readFileSync(file));
  const entry = lineageMain([...f.args, '--label', 'default']);
  assert.equal(entry.report_sha256, sha256(before[0]));
  assert.equal(entry.reviews_sha256, sha256(before[1]));
  assert.deepEqual(entry.reviewer_kinds, { human: 0, model: 2 });
  assert.deepEqual(JSON.parse(readFileSync(f.ledger)), [entry]);
  files.forEach((file, index) => assert.deepEqual(readFileSync(file), before[index]));
});

test('--report appends a human-provenance report with correct human reviewer counts', t => {
  const f = fixture(t);
  const first = lineageMain([...f.args, '--label', 'model-pass']);
  const before = readFileSync(f.ledger), humanReport = readFileSync(f.humanReportPath);
  const humanReviews = readFileSync(f.humanReviewsPath);
  const second = lineageMain(['--out', f.out, '--reviews', f.humanReviewsPath,
    '--report', f.humanReportPath, '--label', 'human-pass']);
  assert.deepEqual(second.reviewer_kinds, { human: 2, model: 0 });
  assert.equal(second.report_sha256, sha256(humanReport));
  assert.equal(second.reviews_sha256, sha256(humanReviews));
  assert.notEqual(second.report_sha256, first.report_sha256);
  assert.deepEqual(JSON.parse(readFileSync(f.ledger)), [first, second]);
  const end = before.lastIndexOf(0x5d);
  assert.deepEqual(readFileSync(f.ledger).subarray(0, end), before.subarray(0, end));
  assert.deepEqual(readFileSync(f.humanReportPath), humanReport);
  assert.deepEqual(readFileSync(f.humanReviewsPath), humanReviews);
});

test('report outside --out is rejected even when it has matching bytes', t => {
  const f = fixture(t), outside = path.join(f.temp, 'report.json');
  writeFileSync(outside, readFileSync(f.reportPath));
  assert.throws(() => lineageMain([...f.args, '--label', 'outside', '--report', outside]), /inside --out/);
  assert.equal(existsSync(f.ledger), false);
});

test('non-regular report path is rejected', t => {
  const f = fixture(t);
  assert.throws(() => lineageMain([...f.args, '--label', 'directory', '--report', path.join(f.out, 'evaluation')]),
    /regular file/);
  assert.equal(existsSync(f.ledger), false);
});

test('report cannot escape through a linked directory', t => {
  const f = fixture(t), outside = path.join(f.temp, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'report.json'), readFileSync(f.reportPath));
  const link = path.join(f.out, 'linked');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => lineageMain([...f.args, '--label', 'linked', '--report', path.join(link, 'report.json')]),
    /inside --out/);
  assert.equal(existsSync(f.ledger), false);
});

test('selected human report must correspond byte-for-byte to supplied reviews', t => {
  const f = fixture(t), before = readFileSync(f.humanReportPath);
  assert.throws(() => lineageMain([...f.args, '--label', 'wrong-reviews', '--report', f.humanReportPath]),
    /does not match/);
  assert.equal(existsSync(f.ledger), false);
  f.write('evaluation/reviews-human.json', f.reviews.map(review => ({
    ...review, reviewer_kind: 'human', correctness: 'fail',
  })));
  assert.throws(() => lineageMain(['--out', f.out, '--reviews', f.humanReviewsPath,
    '--report', f.humanReportPath, '--label', 'stale']), /does not match/);
  assert.equal(existsSync(f.ledger), false);
  assert.deepEqual(readFileSync(f.humanReportPath), before);
});

test('duplicate label is refused even with a different valid report', t => {
  const f = fixture(t);
  lineageMain([...f.args, '--label', 'same-label']);
  const before = readFileSync(f.ledger);
  assert.throws(() => lineageMain(['--out', f.out, '--reviews', f.humanReviewsPath,
    '--report', f.humanReportPath, '--label', 'same-label']), /duplicate grading lineage label/);
  assert.deepEqual(readFileSync(f.ledger), before);
});

test('prior entry bytes and nonstandard whitespace survive appending', t => {
  const f = fixture(t);
  const prior = Buffer.from('[\n { "label" : "old", "note" : "π ] retained" }\t\n]\n  ');
  writeFileSync(f.ledger, prior);
  const entry = lineageMain([...f.args, '--label', 'new']);
  const end = prior.lastIndexOf(0x5d), after = readFileSync(f.ledger);
  assert.deepEqual(after.subarray(0, end), prior.subarray(0, end));
  assert.deepEqual(JSON.parse(after), [...JSON.parse(prior), entry]);
});

test('reviewer kinds count mixed reviews from the file', t => {
  const f = fixture(t);
  f.write('evaluation/reviews.json', f.reviews.map((review, index) => ({
    ...review, reviewer_kind: index ? 'human' : 'model',
  })));
  f.write('evaluation/report.json', reportMain(f.args));
  assert.deepEqual(lineageMain([...f.args, '--label', 'mixed']).reviewer_kinds, { human: 1, model: 1 });
});
