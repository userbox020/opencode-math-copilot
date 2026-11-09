import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256, loadProfiles, json, serialize } from '../lib.mjs';
import { buildManifest, dryRun, executeStudy } from '../study/run-study.mjs';

const task = {
  id: 'toy-numeric', family: 'arithmetic', domain: 'arithmetic', type: 'numeric', negative: false,
  prompt: 'A toy object travels 6 m in 2 s at constant speed. Give speed with units.',
  answer_contract: '{type:numeric,value:number,domain:string,units:string,conditions:string[]}',
  grading: { value: 3, tolerance: { absolute: 0.000001, relative: 0 }, domain: 'nonnegative-real', units: 'm/s', conditions: ['constant speed'] },
  correct_final: { type: 'numeric', value: 3, domain: 'nonnegative-real', units: 'm/s', conditions: ['constant speed'] },
  provisional: true, review_status: 'owner-review-pending', notes: ['test fixture'],
};
const tasksFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'study-task-')), 'tasks.json');
writeFileSync(tasksFile, serialize([task]));
const model = 'test/no-inference';
const leanToolchain = 'test-lean';
const budgets = { tokens: 1000, tool_calls: 10, duration_ms: 60000, usd: 1 };
const manifest = buildManifest({ tasks: [task], tasksFile, model, profiles: loadProfiles(), repeats: [1], attempts: [1], budgets, seed: 1, resamples: 10, studyId: 'study-runner-test', leanToolchain });

function planFor(profile) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'study-workspace-'));
  return { workspace, condition_id: profile.id, hashes: { public_payload: sha256(`payload-${profile.id}`), workspace_tree: sha256(`tree-${profile.id}`), profile: sha256(profile) }, environment: {} };
}
const prepare = ({ profile }) => planFor(profile);
const runtimeAudit = async plan => ({ profile: plan.condition_id, status: 'passed', guarantee: 'runtime-verified', runtime_verified: true, supported: true, isolation_verified: true, workspace: plan.workspace, workspace_tree: plan.hashes.workspace_tree, cleanup: true, observed_tools: [] });
const staticAudit = async plan => ({ profile: plan.condition_id, status: 'passed', guarantee: 'static-equivalent', runtime_verified: false, supported: false, isolation_verified: false, workspace: plan.workspace, workspace_tree: plan.hashes.workspace_tree, cleanup: true, observed_tools: [], execution_blocker: 'static-equivalent: runtime unverified' });
const candidate = {
  status: 'candidate_ready',
  final: { type: 'numeric', value: 3, domain: 'nonnegative-real', units: 'm/s', conditions: ['constant speed'] },
  events: [],
  usage: [{ tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.001 }],
  duration_ms: 100,
  error: null,
};
const candidateFor = plan => ({
  ...candidate,
  events: plan.condition_id === 'F'
    ? [{ type: 'tool_use', part: { tool: 'read', state: { status: 'completed', input: { path: 'task.json' }, output: 'ok' } } }]
    : plan.condition_id === 'B'
      ? [{ type: 'tool_use', part: { tool: 'compute', state: { status: 'completed', input: { operation: 'simplify' }, output: '3' } } }]
      : [],
});

test('dry-run reports a static audit as not execution-ready and writes only plan.json', async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'study-dry-'));
  const plan = await dryRun({ manifest, tasks: [task], tasksFile, out, model }, { prepareEpisode: prepare, auditInventory: staticAudit, assertPreparedWorkspace: () => {}, modelsAvailable: () => ({ available: true, error: null }) });
  assert.equal(plan.dry_run, true);
  assert.equal(plan.episode_count, 3);
  assert.equal(plan.execution_ready, false);
  assert.equal(plan.audits.every(audit => audit.runtime_verified === false), true);
  assert.equal(existsSync(path.join(out, 'plan.json')), true);
  assert.equal(existsSync(path.join(out, 'manifest.json')), false);
  assert.equal(existsSync(path.join(out, 'episodes.jsonl')), false);
  rmSync(out, { recursive: true, force: true });
  rmSync(path.dirname(tasksFile), { recursive: true, force: true });
});

test('execution refuses a static audit even with explicit authorization', async () => {
  process.env.MATH_BENCH_ALLOW_EXECUTE = '1';
  const out = mkdtempSync(path.join(os.tmpdir(), 'study-static-'));
  await assert.rejects(
    executeStudy({ manifest, tasks: [task], tasksFile, out, model, leanToolchain, allowProvisional: true, spendCap: 10 }, { prepareEpisode: prepare, auditInventory: staticAudit, assertPreparedWorkspace: () => {}, modelsAvailable: () => ({ available: true, error: null }), executeEpisode: () => { throw new Error('must not execute'); } }),
    /runtime_inventory_unverified/
  );
  assert.equal(existsSync(path.join(out, 'manifest.json')), false);
  rmSync(out, { recursive: true, force: true });
});

test('execution refuses without the explicit environment opt-in', async () => {
  delete process.env.MATH_BENCH_ALLOW_EXECUTE;
  const out = mkdtempSync(path.join(os.tmpdir(), 'study-noauth-'));
  await assert.rejects(
    executeStudy({ manifest, tasks: [task], tasksFile, out, model, leanToolchain, allowProvisional: true, spendCap: 10 }, { prepareEpisode: prepare, auditInventory: runtimeAudit, assertPreparedWorkspace: () => {}, modelsAvailable: () => ({ available: true, error: null }), executeEpisode: () => candidate }),
    /execution_not_authorized/
  );
  rmSync(out, { recursive: true, force: true });
});

test('mocked runtime audit and candidate produce graded, artifact-backed episodes', async () => {
  process.env.MATH_BENCH_ALLOW_EXECUTE = '1';
  const out = mkdtempSync(path.join(os.tmpdir(), 'study-exec-'));
  const result = await executeStudy(
    { manifest, tasks: [task], tasksFile, out, model, leanToolchain, allowProvisional: true, spendCap: 10 },
    { prepareEpisode: prepare, auditInventory: runtimeAudit, assertPreparedWorkspace: () => {}, modelsAvailable: () => ({ available: true, error: null }), executeEpisode: plan => structuredClone(candidateFor(plan)) }
  );
  assert.equal(result.episodes, 3);
  assert.equal(result.stop, null);
  const episodes = readFileSync(path.join(out, 'episodes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(episodes.length, 3);
  for (const episode of episodes) {
    assert.equal(episode.status, 'completed');
    assert.equal(episode.grade.correct, true);
    assert.equal(episode.under_budget, true);
    assert.equal(episode.usage.tool_calls, episode.condition_id === 'A' ? 0 : 1);
    assert.equal(episode.events.length, episode.usage.tool_calls);
    assert.equal(episode.artifacts.length, 2);
  }
  assert.deepEqual(episodes.map(episode => episode.condition_id).sort(), ['A', 'B', 'F']);
  assert.equal(existsSync(path.join(out, 'report.json')), true);
  assert.equal(existsSync(path.join(out, 'study-caveats.md')), true);
  rmSync(out, { recursive: true, force: true });
});
