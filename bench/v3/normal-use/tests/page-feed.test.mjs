import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildData } from '../build-normal-page.mjs';

const builder = fileURLToPath(new URL('../build-normal-page.mjs', import.meta.url));
const directory = 'normal-use-v1';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'normal-page-feed-'));
  const prior = process.env.NORMAL_USE_AUDIT_ROOT;
  delete process.env.NORMAL_USE_AUDIT_ROOT;
  t.after(() => {
    if (prior === undefined) delete process.env.NORMAL_USE_AUDIT_ROOT;
    else process.env.NORMAL_USE_AUDIT_ROOT = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  const study = path.join(sourceRoot, directory);
  mkdirSync(study, { recursive: true });
  writeFileSync(path.join(study, 'manifest.json'), JSON.stringify({ model: 'raw/model', tasks: [{ id: 'task' }], conditions: ['plugin-off'] }));
  writeFileSync(path.join(study, 'episodes.jsonl'), JSON.stringify({ task_id: 'task', condition: 'plugin-off', status: 'completed', duration_ms: 123, usage: null }) + '\n');
  writeReport(sourceRoot, 'raw', 1);
  return { root, sourceRoot };
}
function writeReport(root, marker, score = null) {
  const dir = path.join(root, directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ generated_at: marker,
    conditions: { 'plugin-off': { review_provenance: marker } },
    tasks: [{ task_id: 'task', conditions: { 'plugin-off': { status: 'completed', score, notes: marker } } }],
  }));
}

test('no known audit retains raw report and missing-usage metadata', t => {
  const { sourceRoot } = fixture(t);
  const [study] = buildData({ sourceRoot }).studies;
  assert.equal(study.report_source, 'original report / source artifacts');
  assert.equal(study.generated_at, 'raw');
  assert.equal(study.model, 'raw/model');
  assert.equal(study.tasks[0].conditions['plugin-off'].score, 1);
  assert.equal(study.conditions['plugin-off'].usage_episodes_known, 0);
  assert.equal(study.conditions['plugin-off'].usage_episodes_missing, 1);
  assert.equal(study.conditions['plugin-off'].tokens, null);
  assert.equal(study.conditions['plugin-off'].cost_usd, null);
});

test('known corrected audit is auto-preferred without discarding raw metadata or inventing scores', t => {
  const { sourceRoot } = fixture(t);
  writeReport(path.join(sourceRoot, 'normal-use-evidence-audit-20261111'), 'corrected');
  const [study] = buildData({ sourceRoot }).studies;
  assert.equal(study.report_source, 'audited corrected report');
  assert.equal(study.generated_at, 'corrected');
  assert.equal(study.model, 'raw/model');
  assert.equal(study.source_directory, directory);
  assert.equal(study.review_status, 'unreviewed');
  assert.equal(study.tasks[0].conditions['plugin-off'].score, null);
  assert.equal(study.tasks[0].conditions['plugin-off'].duration_ms, 123);
  assert.equal(study.conditions['plugin-off'].episodes, 1);
  assert.equal(study.conditions['plugin-off'].usage_episodes_known, 0);
  assert.equal(study.conditions['plugin-off'].usage_episodes_missing, 1);
  assert.equal(study.conditions['plugin-off'].review_scored, 0);
  assert.equal(study.conditions['plugin-off'].review_score_rate, null);
});

test('explicit option overrides environment, which overrides known audit; CLI priority is unchanged', t => {
  const { root, sourceRoot } = fixture(t);
  const envRoot = path.join(root, 'environment'), explicitRoot = path.join(root, 'explicit');
  writeReport(path.join(sourceRoot, 'normal-use-evidence-audit-20261111'), 'automatic');
  writeReport(envRoot, 'environment');
  writeReport(explicitRoot, 'explicit');
  process.env.NORMAL_USE_AUDIT_ROOT = envRoot;
  assert.equal(buildData({ sourceRoot }).studies[0].generated_at, 'environment');
  assert.equal(buildData({ sourceRoot, auditRoot: explicitRoot }).studies[0].generated_at, 'explicit');
  assert.equal(buildData({ sourceRoot, auditRoot: path.join(root, 'absent') }).studies[0].generated_at, 'raw');

  // Run an unchanged copy so CLI-generated feeds stay in the temporary fixture,
  // never overwriting the designer's live feed or HTML.
  const isolatedBuilder = path.join(root, 'build-normal-page.mjs');
  copyFileSync(builder, isolatedBuilder);
  for (const [args, expected] of [[[], 'environment'], [['--audit-root', explicitRoot], 'explicit']]) {
    const result = spawnSync(process.execPath, [isolatedBuilder, ...args], { encoding: 'utf8', env: { ...process.env, NORMAL_USE_AUDIT_ROOT: envRoot } });
    assert.equal(result.status, 0, result.stderr);
    const feed = JSON.parse(readFileSync(path.join(root, 'normal-use-data.json'), 'utf8'));
    assert.equal(feed.studies.find(study => study.id === 'v1').generated_at, expected);
  }
});
