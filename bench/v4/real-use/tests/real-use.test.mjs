import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import {
  assertFreshOutput, budgetStop, executionGate, FRESH_PROFILES, RETIRED_PROFILES, loadEpisodes, makeManifest,
  makeSchedule, parseEvents, promptFor, PROTOCOL, PROTOCOL_HASH, sanitize, sha256, usageFromSteps, validateGold,
  validatePublic, validateReadiness, writeManifest,
} from '../lib.mjs';
import { captureEpisode, CAPTURE_LIMITS, prepare } from '../run.mjs';
import { checkAnswer, checkerRequest, evaluateAnswer, exportBlind, unblindReviews, validateReviews } from '../grade.mjs';
import { report } from '../report.mjs';

const compatProfileId = Object.keys(FRESH_PROFILES).find(id => FRESH_PROFILES[id].role === 'compat');
const workflowsProfileId = Object.keys(FRESH_PROFILES).find(id => FRESH_PROFILES[id].role === 'workflows');

test('closed executable profiles contain exactly one compat and one workflows entry', () => {
  assert.equal(Object.keys(FRESH_PROFILES).length, 2);
  assert.deepEqual(Object.values(FRESH_PROFILES).map(profile => profile.role).sort(), ['compat', 'workflows']);
  for (const id of [compatProfileId, workflowsProfileId]) {
    assert.equal(Object.hasOwn(FRESH_PROFILES, id), true);
    assert.equal(FRESH_PROFILES[id].profile_id, id);
  }
  assert.notEqual(compatProfileId, workflowsProfileId);
  assert.ok(Object.keys(RETIRED_PROFILES).length > 0);
});

const tasks = Array.from({ length: 10 }, (_, i) => ({
  schema: 'real-use-task/v1', id: `workflow-${i + 1}`, category: i < 5 ? 'symbolic' : 'evidence',
  family: `family-${i + 1}`, prompt: `Public workflow ${i + 1}: compute a result.`,
}));
const gold = tasks.map(task => ({ schema: 'real-use-gold/v1', task_id: task.id,
  rubric: 'Judge the complete argument, not keywords.', reference_sources: [], expected_result: '2' }));
const options = { seed: 'fixed-seed', model: 'explicit-provider/explicit-model', run_id: 'test-run', workspace: path.resolve('isolated-fixture') };
const manifest = () => makeManifest(tasks, { ...options, max_episodes: 20, max_cost_usd: 5 });
const lean = { theorem: 'target', expected_type: '1 + 1 = 2', imports: ['Mathlib'], allowed_axioms: ['propext', 'Quot.sound', 'Classical.choice'], positive_control: 'example : 1 + 1 = 2 := by decide' };
const answer = '```lean\nimport Mathlib\ntheorem target : 1 + 1 = 2 := by decide\n```';
const review = blind_id => ({ schema: 'real-use-review/v1', blind_id, correctness: 'pass', evidence: 'adequate',
  reviewer_kind: 'human', reviewer_identity: 'named-test-reviewer', notes: 'Fixture review only; not a real mathematical adjudication.' });

function temp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'real-use-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function readiness(m, now = Date.now()) {
  return {
    schema: 'real-use-readiness/v1', status: 'ready',
    checks: Object.fromEntries(['isolation', 'checker_positive', 'checker_negative', 'tool_parity', 'gold_separation'].map(key => [key, true])),
    protocol_hash: m.protocol_hash, public_tasks_hash: m.public_tasks_hash, environment_fingerprint: m.environment_fingerprint,
    assembled_prompts_hash: m.assembled_prompts_hash,
    issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 60000).toISOString(),
  };
}
function fixtureArgs(t) {
  const dir = temp(t), publicFile = path.join(dir, 'public.json'), out = path.join(dir, 'fresh');
  writeFileSync(publicFile, JSON.stringify(tasks));
  return { dir, out, args: ['--model', options.model, '--tasks', publicFile, '--out', out, '--workspace', path.join(dir, 'workspace')] };
}
async function withoutSpawn(fn) {
  const original = childProcess.spawn;
  let calls = 0;
  childProcess.spawn = () => { calls++; throw new Error('unexpected process launch'); };
  syncBuiltinESMExports();
  try { await fn(); assert.equal(calls, 0); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}

test('stable seeded pair order and balanced ON/OFF-first with adjacent conditions', () => {
  const schedule = makeSchedule(tasks, options);
  assert.deepEqual(schedule, makeSchedule(tasks, options));
  assert.notDeepEqual(schedule, makeSchedule(tasks, { ...options, seed: 'other' }));
  const first = schedule.filter((_, i) => i % 2 === 0);
  assert.equal(first.filter(item => item.condition === 'plugin-on').length, 5);
  assert.equal(first.filter(item => item.condition === 'plugin-off').length, 5);
  for (let i = 0; i < schedule.length; i += 2) {
    assert.equal(schedule[i].pair_id, schedule[i + 1].pair_id);
    assert.notEqual(schedule[i].condition, schedule[i + 1].condition);
  }
});

test('10 tasks x 2 conditions x 2 repeats produces 40 unique bound IDs', () => {
  const schedule = makeSchedule(tasks, { ...options, repeats: 2 });
  assert.equal(schedule.length, 40);
  assert.equal(new Set(schedule.map(item => item.episode_id)).size, 40);
  assert.equal(new Set(schedule.map(item => item.pair_id)).size, 20);
  assert.notEqual(schedule[0].episode_id, makeSchedule(tasks, { ...options, repeats: 2, model: 'other/model' })[0].episode_id);
  assert.notEqual(schedule[0].episode_id, makeSchedule(tasks, { ...options, repeats: 2, run_id: 'other-run' })[0].episode_id);
});

test('public/gold contracts reject scoring leakage, duplicates, and wrong task mappings', () => {
  assert.equal(validatePublic(tasks), tasks);
  assert.equal(validateGold(gold, tasks), gold);
  for (const key of ['answer', 'rubric', 'reference_sources', 'expected_result', 'lean', 'solution']) {
    assert.throws(() => validatePublic([{ ...tasks[0], [key]: 'not public' }]), /unexpected keys/);
  }
  assert.throws(() => validatePublic([tasks[0], tasks[0]]), /duplicate/);
  assert.throws(() => validateGold([...gold.slice(1), gold[1]], tasks), /invalid record/);
});

test('manifest is immutable, binds protocol/tasks/environment, and defaults to 300 seconds', () => {
  const m = manifest();
  assert.equal(m.schedule.length, 20);
  assert.equal(m.repeats, 1);
  assert.equal(m.budgets.timeout_ms, 300000);
  assert.equal(m.public_tasks_hash, sha256(tasks));
  assert.throws(() => { m.tasks[0].prompt = 'mutated'; }, TypeError);
  assert.throws(() => { m.schedule.push({}); }, TypeError);
  assert.notEqual(m.environment_fingerprint, makeManifest(tasks, { ...options, workspace: path.resolve('other-workspace') }).environment_fingerprint);
});

test('fresh-output refusal leaves files, contents and timestamps untouched', t => {
  const dir = temp(t), out = path.join(dir, 'run');
  writeManifest(out, manifest());
  const before = readFileSync(path.join(out, 'manifest.json'));
  const modified = statSync(path.join(out, 'manifest.json')).mtimeMs;
  const files = readdirSync(out);
  assert.throws(() => assertFreshOutput(out), /output_exists/);
  assert.throws(() => writeManifest(out, manifest()), /output_exists/);
  assert.deepEqual(readFileSync(path.join(out, 'manifest.json')), before);
  assert.deepEqual(readdirSync(out), files);
  assert.equal(statSync(path.join(out, 'manifest.json')).mtimeMs, modified);
});

test('default preview writes nothing and cannot spawn; explicit model is mandatory', async t => {
  const { args, out, dir } = fixtureArgs(t);
  await withoutSpawn(() => {
    const preview = prepare(args, {});
    assert.equal(preview.mode, 'dry-run');
    assert.equal(preview.manifest.schedule.length, 20);
    assert.equal(existsSync(out), false);
    assert.deepEqual(readdirSync(dir), ['public.json']);
    assert.throws(() => prepare(args.slice(2), {}), /--model required/);
    assert.throws(() => prepare([...args, '--force'], {}), /unknown/);
  });
});

test('authorization and missing readiness fail closed without spawn or filesystem mutation', async t => {
  const { args, out } = fixtureArgs(t);
  await withoutSpawn(() => {
    assert.throws(() => prepare([...args, '--execute'], {}), /execution_not_authorized/);
    assert.throws(() => prepare([...args, '--execute', '--max-episodes', '20', '--max-cost-usd', '5'], { REAL_USE_ALLOW_EXECUTE: '1' }), /readiness_blocked/);
    assert.equal(existsSync(out), false);
  });
});

test('readiness checks, bindings and freshness all required; structural ready still cannot execute', async () => {
  const m = manifest(), now = Date.now(), good = readiness(m, now);
  assert.equal(validateReadiness(good, m, now), true);
  for (const key of Object.keys(good.checks)) {
    assert.throws(() => validateReadiness({ ...good, checks: { ...good.checks, [key]: false } }, m, now), /readiness_blocked/);
  }
  for (const key of ['protocol_hash', 'public_tasks_hash', 'environment_fingerprint']) {
    assert.throws(() => validateReadiness({ ...good, [key]: 'wrong' }, m, now), /mismatch/);
  }
  assert.throws(() => validateReadiness(good, m, now + 3600001), /freshness/);
  assert.throws(() => validateReadiness({ ...good, issued_at: new Date(now + 1).toISOString() }, m, now), /freshness/);
  await withoutSpawn(() => assert.throws(() => executionGate({ execute: true, environment: { REAL_USE_ALLOW_EXECUTE: '1' },
    workspace: options.workspace, max_episodes: 20, max_cost_usd: 5, readiness: good }, m), /sandbox_adapter_unavailable/));
});

test('host workspace and absent/nonpositive budgets fail closed', () => {
  const m = manifest();
  const opts = { execute: true, environment: { REAL_USE_ALLOW_EXECUTE: '1' }, workspace: options.workspace,
    max_episodes: 20, max_cost_usd: 5, readiness: readiness(m) };
  assert.throws(() => executionGate({ ...opts, workspace: 'C:/_Work/__OPENAI_MATH' }, m), /workspace_blocked/);
  assert.throws(() => executionGate({ ...opts, workspace: undefined }, m), /workspace_blocked/);
  for (const max_cost_usd of [undefined, null, 0, -1, NaN]) assert.throws(() => executionGate({ ...opts, max_cost_usd }, m), /budget_blocked/);
  assert.throws(() => executionGate({ ...opts, max_episodes: 0 }, m), /budget_blocked/);
});

test('partial usage is null, with separate known subtotals and coverage; zero is known', () => {
  const usage = usageFromSteps([{ tokens: { input: 10, output: 4 }, cost: 0.2 }, { tokens: { input: 3 }, cost: null }], { complete: true });
  assert.equal(usage.input_tokens, 13);
  assert.equal(usage.output_tokens, null);
  assert.equal(usage.cost_usd, null);
  assert.equal(usage.known_subtotal.output_tokens, 4);
  assert.equal(usage.known_subtotal.cost_usd, 0.2);
  assert.equal(usage.coverage.cost_usd, 1);
  assert.equal(usageFromSteps([]).cost_usd, null);
  const zero = [{ tokens: { input: 0, output: 0 }, cost: 0 }];
  assert.equal(usageFromSteps(zero).cost_usd, null, 'observed steps alone never establish episode totals');
  assert.equal(usageFromSteps(zero).known_subtotal.cost_usd, 0);
  assert.equal(usageFromSteps(zero, { complete: true }).cost_usd, 0);
});

test('unknown cost stops before the next episode, preserving soft-limit semantics', () => {
  const budgets = { max_episodes: 20, max_cost_usd: 1 };
  assert.equal(budgetStop([], budgets), null);
  assert.equal(budgetStop([{ usage: { cost_usd: null } }], budgets), 'unknown_cost');
  assert.equal(budgetStop([{ usage: { cost_usd: 1.2 } }], budgets), 'soft_cost_limit');
  assert.equal(budgetStop([{ usage: { cost_usd: 0 } }], { ...budgets, max_episodes: 1 }), 'max_episodes');
});

test('mixed NDJSON/log parsing preserves all valid events and separates errors', () => {
  const parsed = parseEvents([
    'startup diagnostic', '{malformed',
    JSON.stringify({ type: 'text', part: { text: 'valid text', messageID: 'last' } }),
    JSON.stringify({ type: 'tool_use', part: { tool: 'math_compute' } }),
    JSON.stringify({ type: 'error', error: { message: 'quota exceeded' } }),
    JSON.stringify({ type: 'step_finish', part: { cost: null, tokens: { input: 2 } } }),
  ].join('\n'));
  assert.equal(parsed.events.length, 4);
  assert.equal(parsed.extraction_failures.length, 2);
  assert.equal(parsed.provider_errors.length, 1);
  assert.equal(parsed.text, 'valid text');
  assert.deepEqual(parsed.tools, ['math_compute']);
  assert.equal(parsed.usage.cost_usd, null);
});

test('full final answer is retained without truncation; earlier assistant messages excluded', () => {
  const full = 'Unicode ∀ α ℝ. '.repeat(30000);
  const parsed = parseEvents([
    { type: 'text', part: { text: 'earlier planning', messageID: 'first' } },
    { type: 'text', part: { text: full.slice(0, 12345), messageID: 'final' } },
    { type: 'text', part: { text: full.slice(12345), messageID: 'final' } },
  ].map(JSON.stringify).join('\n'));
  assert.equal(parsed.text, full);
});

test('sanitizer redacts credential/header/environment fields and recognizable secret strings', () => {
  const clean = sanitize({ env: { SECRET: 'hidden' }, headers: { Authorization: 'hidden' },
    nested: { apiKey: 'hidden', access_token: 'hidden', password: 'hidden' },
    text: 'Authorization: Bearer abcdef\nAPI_KEY=hidden sk-1234567890',
    tokens: { input: 10, output: 0 }, formula: '∀ x : ℝ, x = x' });
  assert.equal(JSON.stringify(clean).includes('hidden'), false);
  assert.equal(JSON.stringify(clean).includes('abcdef'), false);
  assert.equal(clean.env, '[REDACTED]');
  assert.equal(clean.tokens.input, 10);
  assert.equal(clean.formula, '∀ x : ℝ, x = x');
});

test('blind exports have opaque IDs, bijective private map, no episode metadata, and flagged self-disclosure', async () => {
  const episodes = manifest().schedule.slice(0, 2).map((item, i) => ({ ...item, status: 'completed',
    text: i ? 'I used plugin-off. The answer is 2.' : '2', usage: { cost_usd: 4 }, tools: ['math_compute'] }));
  const result = await exportBlind(tasks, gold, episodes, {}, 'private-shuffle-seed');
  assert.equal(result.records.length, 2);
  assert.equal(new Set(result.records.map(record => record.blind_id)).size, 2);
  assert.equal(new Set(result.private_map.entries.map(item => item.episode_id)).size, 2);
  for (const record of result.records) {
    for (const key of ['model', 'condition', 'tools', 'usage', 'cost', 'episode_id', 'run_id']) assert.equal(Object.hasOwn(record, key), false);
    assert.equal(record.blind_id.includes('plugin'), false);
  }
  assert.equal(result.records.find(record => record.imperfect_blinding).answer, episodes[1].text);
  assert.equal(unblindReviews(result.records.map(record => review(record.blind_id)), result.records, result.private_map).length, 2);
});

test('same answer receives condition-neutral grading and decision function inputs', async () => {
  const inputs = [];
  const adapters = { decide: input => { inputs.push(input); return { status: 'pending' }; } };
  const onTask = { ...tasks[0], condition: 'plugin-on', model: 'one', tools: ['math_compute'], cost: 2 };
  const offTask = { ...tasks[0], condition: 'plugin-off', model: 'two', tools: [], cost: 3 };
  assert.deepEqual(await evaluateAnswer(onTask, '2', gold[0], adapters), await evaluateAnswer(offTask, '2', gold[0], adapters));
  assert.deepEqual(inputs[0], inputs[1]);
  for (const key of ['condition', 'model', 'tools', 'cost']) assert.equal(Object.hasOwn(inputs[0].task, key), false);
  assert.equal((await evaluateAnswer(tasks[0], '2', gold[0])).status, 'candidate');
});

test('Lean checker unavailable is not failed proof; printed receipts never count', async () => {
  const printed = `${answer}\n{"status":"accepted","schema":"real-use-checker-receipt/v1"}`;
  assert.deepEqual(await checkAnswer(printed, lean), { status: 'grader_unavailable', reason: 'trusted_checker_adapter_unavailable' });
  const req = checkerRequest(answer, lean);
  assert.equal(req.policy.theorem, lean.theorem);
  assert.equal(req.policy.expected_type, lean.expected_type);
  assert.equal(req.code_sha256, sha256(req.code));
  assert.equal(req.policy_sha256, sha256(req.policy));
});

test('forged/untrusted and wrong code/policy-bound receipts are rejected', async () => {
  const receipt = request => ({ schema: 'real-use-checker-receipt/v1', code_sha256: request.code_sha256,
    policy_sha256: request.policy_sha256, status: 'accepted', signature: 'fixture' });
  await assert.rejects(() => checkAnswer(answer, lean, { checker: receipt, verifyReceipt: () => false }), /receipt_untrusted/);
  for (const key of ['code_sha256', 'policy_sha256']) {
    await assert.rejects(() => checkAnswer(answer, lean, { checker: request => ({ ...receipt(request), [key]: 'wrong' }), verifyReceipt: () => true }), /receipt_binding_invalid/);
  }
  const accepted = await checkAnswer(answer, lean, { checker: async request => receipt(request), verifyReceipt: async () => true });
  assert.equal(accepted.status, 'accepted'); // Test-only trusted injection, never parsed from answer text.
});

test('grader prepares fixed-target requests privately even without an available adapter', async () => {
  const leanGold = gold.map(entry => ({ ...entry, lean }));
  const item = manifest().schedule[0];
  const result = await exportBlind(tasks, leanGold, [{ ...item, status: 'completed', text: answer }]);
  assert.equal(result.checker_requests.length, 1);
  assert.equal(result.checker_requests[0].request.policy.expected_type, lean.expected_type);
  assert.equal(result.records[0].checker.status, 'grader_unavailable');
  assert.equal(Object.hasOwn(result.records[0], 'episode_id'), false);
});

test('unknown/duplicate reviews, missing identity and non-bijective maps are rejected', () => {
  const records = [{ blind_id: 'a' }, { blind_id: 'b' }];
  assert.throws(() => validateReviews([review('unknown')], records), /unknown\/duplicate/);
  assert.throws(() => validateReviews([review('a'), review('a')], records), /unknown\/duplicate/);
  assert.throws(() => validateReviews([{ ...review('a'), reviewer_identity: '' }], records), /invalid typed/);
  assert.throws(() => validateReviews([{ ...review('a'), reviewer_kind: 'automated' }], records), /invalid typed/);
  assert.throws(() => unblindReviews([], records, { schema: 'real-use-unblind/v1', entries: [
    { blind_id: 'a', episode_id: 'same' }, { blind_id: 'b', episode_id: 'same' },
  ] }), /bijective/);
});

test('reports paired counts, incomplete pairs and unknown cost without treating missing as zero or fail', () => {
  const m = manifest();
  const episodes = m.schedule.slice(0, 3).map((item, i) => ({ ...item, status: 'completed',
    usage: i === 2 ? { cost_usd: null, known_subtotal: { cost_usd: 0.1 } } : { cost_usd: 0.2, input_tokens: 10, output_tokens: 5 } }));
  const reviews = episodes.slice(0, 2).map(item => ({ ...review(item.episode_id), episode_id: item.episode_id,
    correctness: item.condition === 'plugin-on' ? 'pass' : 'fail' }));
  const result = report(m, episodes, reviews);
  assert.equal(result.overall.counts['ON-only'], 1);
  assert.equal(result.overall.counts.ungraded, 9);
  assert.equal(result.overall.counts.neither, 0);
  assert.equal(result.overall.missingness.not_started, 17);
  assert.equal(result.overall.missingness.missing_review, 1);
  assert.equal(result.overall.usage.cost_usd.total, null);
  assert.equal(result.overall.usage.cost_usd.known_subtotal, 0.5);
  assert.equal(result.overall.usage.cost_usd.complete_episodes, 2);
  assert.equal(result.overall.missingness.incomplete_pairs, 9);
  assert.equal(Object.keys(result.tracks).length, 2);
});

test('operational failures, unscorable reviews and started-only records remain visible', t => {
  const dir = temp(t), m = manifest(), item = m.schedule[0];
  mkdirSync(path.join(dir, 'episodes'));
  writeFileSync(path.join(dir, 'episodes', `${item.episode_id}.start.json`), JSON.stringify({ episode_id: item.episode_id, started_at: '2026-11-11T00:00:00Z' }));
  const started = loadEpisodes(dir, m);
  assert.equal(started[0].status, 'started');
  assert.equal(report(m, started).overall.missingness.started_without_completion, 1);
  const episodes = [{ ...m.schedule[0], status: 'failed' }, { ...m.schedule[1], status: 'completed' }];
  const reviews = [{ ...review('test'), episode_id: m.schedule[1].episode_id, correctness: 'unscorable' }];
  const result = report(m, episodes, reviews);
  assert.equal(result.overall.operational_failures, 1);
  assert.equal(result.overall.missingness.unscorable, 1);
  assert.equal(result.overall.counts.ungraded, 10);
});

test('formal passes require accepted bound evaluator checks; unavailable is unscorable, not proof failure', async () => {
  const formalTasks = [{ ...tasks[0], category: 'formal' }];
  const formalGold = [{ ...gold[0], lean }];
  const m = makeManifest(formalTasks, options);
  const episodes = m.schedule.map(item => ({ ...item, status: 'completed', text: answer }));
  for (const status of ['unavailable', 'rejected', 'accepted']) {
    const adapters = { checker: request => ({ schema: 'real-use-checker-receipt/v1', status,
      code_sha256: request.code_sha256, policy_sha256: request.policy_sha256 }), verifyReceipt: () => true };
    const packet = await exportBlind(formalTasks, formalGold, episodes, adapters);
    const reviews = packet.records.map(record => review(record.blind_id));
    const manual = reviews.map(item => ({ ...item, episode_id: packet.private_map.entries.find(entry => entry.blind_id === item.blind_id).episode_id }));
    const result = report(m, episodes, manual, packet.records);
    assert.equal(result.overall.counts.both, status === 'accepted' ? 1 : 0);
    assert.equal(result.overall.counts.ungraded, status === 'accepted' ? 0 : 1);
    if (status === 'accepted') {
      assert.equal(unblindReviews(reviews, packet.records, packet.private_map).length, 2);
      for (const key of ['code_sha256', 'policy_sha256']) {
        const tampered = structuredClone(packet.records);
        tampered[0].checker[key] = '0'.repeat(64);
        assert.throws(() => unblindReviews(reviews, tampered, packet.private_map), /accepted trusted/);
        assert.equal(report(m, episodes, manual, tampered).overall.counts.both, 0);
      }
      assert.equal(report(m, episodes, manual).overall.counts.both, 0, 'review fields alone cannot establish formal success');
    } else {
      assert.throws(() => unblindReviews(reviews, packet.records, packet.private_map), /accepted trusted/);
      const failed = reviews.map(item => ({ ...item, correctness: 'fail' }));
      const unblinded = unblindReviews(failed, packet.records, packet.private_map);
      assert.ok(unblinded.every(item => item.correctness === (status === 'unavailable' ? 'unscorable' : 'fail')));
      assert.equal(report(m, episodes, unblinded, packet.records).overall.counts.neither, status === 'rejected' ? 1 : 0);
    }
  }
  const unavailable = await exportBlind(formalTasks, formalGold, episodes);
  assert.throws(() => unblindReviews(unavailable.records.map(record => review(record.blind_id)), unavailable.records, unavailable.private_map), /accepted trusted/);
  for (const reviewer_kind of ['human', 'model']) {
    const m = makeManifest([tasks[0]], options);
    const episodes = m.schedule.map(item => ({ ...item, status: 'completed', text: '2' }));
    const packet = await exportBlind([tasks[0]], [gold[0]], episodes);
    const reviews = packet.records.map(record => ({ ...review(record.blind_id), reviewer_kind }));
    assert.equal(report(m, episodes, unblindReviews(reviews, packet.records, packet.private_map), packet.records).overall.counts.both, 1);
  }
});

test('grade CLI resolves and hashes explicit corpus-relative references, rejecting traversal and link escape', t => {
  const dir = temp(t), corpus = path.join(dir, 'corpus'), out = path.join(dir, 'run');
  const source = 'Frozen source bytes.\r\n';
  mkdirSync(path.join(corpus, 'lean', 'docs'), { recursive: true });
  writeFileSync(path.join(corpus, 'lean', 'docs', 'reference.md'), source);
  const m = makeManifest([tasks[0]], options);
  writeManifest(out, m);
  mkdirSync(path.join(out, 'episodes'));
  const item = m.schedule[0];
  writeFileSync(path.join(out, 'episodes', `${item.episode_id}.json`), JSON.stringify({ ...item, status: 'completed' }));
  writeFileSync(path.join(out, 'episodes', `${item.episode_id}.answer.txt`), '2');
  const goldFile = path.join(dir, 'gold.json');
  const ref = { path: 'lean/docs/reference.md', sha256: sha256(source), locator: 'L1', quote: 'Frozen source bytes.' };
  const setRef = reference => writeFileSync(goldFile, JSON.stringify([{ ...gold[0], reference_sources: [reference] }]));
  const cli = (...extra) => childProcess.spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, '../grade.mjs'), '--out', out, '--gold', goldFile, ...extra,
  ], { encoding: 'utf8' });
  setRef(ref);
  assert.match(cli().stderr, /--corpus-root required/);
  assert.equal(existsSync(path.join(out, 'evaluation')), false);
  for (const relative of ['../gold.json', 'lean/../docs/reference.md', 'C:/outside.md', '/outside.md', 'lean\\docs\\reference.md']) {
    setRef({ ...ref, path: relative });
    assert.match(cli('--corpus-root', corpus).stderr, /unsafe corpus-relative/);
  }
  const outside = path.join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'reference.md'), source);
  symlinkSync(outside, path.join(corpus, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  setRef({ ...ref, path: 'escape/reference.md' });
  assert.match(cli('--corpus-root', corpus).stderr, /escapes corpus root/);
  setRef({ ...ref, sha256: '0'.repeat(64) });
  assert.match(cli('--corpus-root', corpus).stderr, /reference hash mismatch/);
  setRef(ref);
  const exported = cli('--corpus-root', corpus);
  assert.equal(exported.status, 0, exported.stderr);
  const records = JSON.parse(readFileSync(path.join(out, 'evaluation', 'blind.json'), 'utf8'));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].reference_sources, [ref]);
  assert.equal(records[0].answer, '2');
});

test('shared literal suffix and exact assembled prompt hashes bind preview and invalidate stale readiness without execution', async t => {
  const { args, out } = fixtureArgs(t);
  const suffix = 'Answer naturally, cite evidence where relevant, distinguish proposed work from actual verification, and do not modify the repository.';
  await withoutSpawn(() => {
    const { manifest: m } = prepare(args, {});
    assert.equal(PROTOCOL.prompt_suffix, suffix);
    assert.equal(Object.isFrozen(PROTOCOL), true);
    assert.equal(m.protocol_hash, sha256(PROTOCOL));
    assert.equal(m.protocol_hash, PROTOCOL_HASH);
    assert.deepEqual(m.tasks, tasks, 'public task contents stay unchanged with no gold');
    assert.deepEqual(m.prompts, tasks.map(task => {
      assert.equal(promptFor(task), `${task.prompt}\n\n${suffix}`);
      return { task_id: task.id, prompt_sha256: sha256(`${task.prompt}\n\n${suffix}`) };
    }));
    assert.equal(m.assembled_prompts_hash, sha256(m.prompts));
    const ready = readiness(m);
    assert.equal(validateReadiness(ready, m), true);
    const { prompt_suffix, prompt_assembly, ...oldProtocol } = PROTOCOL;
    assert.throws(() => validateReadiness({ ...ready, protocol_hash: sha256(oldProtocol) }, m), /mismatch/);
    assert.throws(() => validateReadiness({ ...ready, assembled_prompts_hash: undefined }, m), /mismatch/);
    assert.throws(() => validateReadiness(ready, { ...m, tasks: [{ ...tasks[0], prompt: 'Changed prompt' }, ...tasks.slice(1)] }), /prompt mismatch/);
    assert.throws(() => validateReadiness(ready, { ...m, protocol_hash: sha256(oldProtocol) }), /protocol\/prompt mismatch/);
    assert.equal(existsSync(out), false);
  });
});

function captureFixture(t, behavior = {}) {
  const directory = temp(t), item = manifest().schedule[0], task = tasks.find(task => task.id === item.task_id);
  const launch = Object.freeze({ executable: path.join(directory, 'fixture-owned.exe'), cwd: directory,
    args: Object.freeze(['run', '--server', 'http://127.0.0.1:4123', '--session', 'ses_fixture', '--model', `${item.model}#default`, '--agent', 'math-eval', '--format', 'json']),
    stdin: Buffer.from(promptFor(task)), stdin_sha256: sha256(promptFor(task)),
    env: Object.freeze({}), owner: item.episode_id, timeoutMs: behavior.timeoutMs ?? 1000 });
  const receipt = { exit_code: 0, signal: null, timeout: false, spawn_error: null,
    ownership: { owner: launch.owner, job_assigned: true, kill_on_close: true },
    cleanup: { confirmed: true, method: 'fixture-owned-job', active_processes: 0, files_removed: true }, ...behavior.exit };
  const state = { cleanupCalls: 0, launch: null, callbacks: null };
  const launcherFactory = (descriptor, callbacks) => {
    state.launch = descriptor; state.callbacks = callbacks;
    if (Object.hasOwn(behavior, 'launchError')) throw behavior.launchError;
    if (behavior.throwLaunch) throw new Error('fixture launch failure');
    const closed = new Promise((resolve, reject) => queueMicrotask(() => {
      for (const chunk of behavior.stdout ?? []) callbacks.onStdout(chunk);
      for (const chunk of behavior.stderr ?? []) callbacks.onStderr(chunk);
      if (behavior.delayedStdout) {
        setTimeout(() => { for (const chunk of behavior.delayedStdout) callbacks.onStdout(chunk); resolve(receipt); }, behavior.delayMs ?? 5);
        return;
      }
      if (Object.hasOwn(behavior, 'closedError')) reject(behavior.closedError);
      else if (behavior.rejectClosed) reject(new Error('fixture close failure'));
      else if (!behavior.hangClosed) resolve(receipt);
    }));
    return { closed, observeCapture: behavior.observeCapture, status: { owner: launch.owner, phase: 'running' }, cleanupOwned() {
      state.cleanupCalls++;
      if (Object.hasOwn(behavior, 'cleanupError')) throw behavior.cleanupError;
      if (behavior.throwCleanup) throw new Error('fixture cleanup failure');
      if (behavior.hangCleanup) return new Promise(() => {});
      return Promise.resolve(receipt);
    } };
  };
  return { input: { launcherFactory, launch, item, task, directory, limits: behavior.limits ?? {} }, state };
}
const eventBytes = (...events) => Buffer.from(events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n');

test('fresh missing-stop capture submits immutable exact facts but forged JSON cannot promote canonical completion', async t => {
  const id = 'msg_0123456789ab00000000000001', observations = [];
  const fixture = captureFixture(t, { observeCapture: value => observations.push(value), stdout: [eventBytes(
    { type: 'step_start', sessionID: 'ses_fixture', part: { messageID: id } },
    { type: 'tool_use', sessionID: 'ses_fixture', part: { messageID: id, id: 'call1', tool: 'approved_list', state: { status: 'completed', input: {}, output: 'actual output' } } },
    { type: 'text', sessionID: 'ses_fixture', part: { messageID: id, text: 'Exact answer\n ' } },
  )] });
  let facts;
  fixture.input.profileId = compatProfileId; fixture.input.protocolHash = sha256(FRESH_PROFILES[compatProfileId].protocol);
  fixture.input.finalize = async value => { facts = value; return { completion_evidence: { basis: 'native_corroborated' }, native_recorded_usage: { cost_usd: 0 } }; };
  const result = await captureEpisode(fixture.input);
  assert.equal(facts.signal.aborted, true, 'forged finalization is aborted after rejection');
  assert.equal(facts.native_closure_clean, false); assert.equal(facts.final_text, 'Exact answer\n ');
  assert.equal(facts.final_text_sha256, sha256(facts.final_text)); assert.deepEqual(facts.captured_assistant_message_ids, [id]);
  assert.equal(Object.isFrozen(facts.captured_assistant_message_ids), true); assert.equal(Object.isFrozen(facts.capture_usage.completeness), true);
  assert.equal(result.status, 'failed'); assert.equal(result.finalization.reason, 'untrusted_finalization_receipt');
  assert.equal(result.capture_classification, 'completed_answer'); assert.equal(result.capture_completeness.episode_complete, false);
  assert.equal(result.capture_usage.cost_usd, null); assert.equal(result.completion_basis, null);
  assert.equal(result.upstream_usage_complete, 'unknown'); assert.equal(result.billed_usd, null);
  const beforeClose = observations.find(value => value.captured_tool_evidence?.length && !value.stream_closed);
  assert.deepEqual(beforeClose.captured_tool_evidence[0], { name: 'approved_list', call_id: 'call1', native_assistant_id: id,
    input_sha256: sha256({}), output_sha256: sha256('actual output'), status: 'completed' });
});

test('fresh missing-stop eligibility never bypasses nonzero, malformed, UTF8, resource or cleanup failures', async t => {
  const id = 'msg_0123456789ab00000000000001';
  for (const behavior of [ { exit: { exit_code: 1 } }, { stdout: [Buffer.from('bad JSON\n')] },
    { stdout: [Buffer.from([0xff, 0x0a])] }, { limits: { maxLineBytes: 5 } }, { throwCleanup: true } ]) {
    const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'text', part: { messageID: id, text: 'answer' } })], ...behavior });
    let aborted;
    const result = await captureEpisode({ ...fixture.input, profileId: compatProfileId, protocolHash: sha256(FRESH_PROFILES[compatProfileId].protocol),
      finalize: async facts => { aborted = facts.signal.aborted; return {}; } });
    assert.equal(aborted, true); assert.equal(result.status, 'failed'); assert.equal(result.completion_basis, null);
  }
});

test('fresh capture cannot mark completed without a branded finalizer; invalid profiles fail before launch', async t => {
  const id = 'msg_0123456789ab00000000000001';
  const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'text', part: { messageID: id, text: 'answer' } },
    { type: 'step_finish', part: { messageID: id, reason: 'stop', cost: 0.1, tokens: { input: 1, output: 1 } } })] });
  const protocolHash = sha256(FRESH_PROFILES[compatProfileId].protocol);
  await assert.rejects(captureEpisode({ ...fixture.input, profileId: Object.keys(RETIRED_PROFILES)[0], protocolHash }), /invalid_capture_profile/);
  for (const profileId of Object.keys(RETIRED_PROFILES)) {
    await assert.rejects(captureEpisode({ ...fixture.input, profileId, protocolHash }), { message: 'invalid_capture_profile' });
  }
  assert.equal(fixture.state.launch, null);
  const result = await captureEpisode({ ...fixture.input, profileId: compatProfileId, protocolHash });
  assert.equal(result.status, 'failed'); assert.equal(result.operational_classification, 'finalization_required');
});
async function trackedCapture(fixture, failEventWrite = false) {
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync };
  const descriptors = new Map(); let injected = false, opened = 0;
  fs.openSync = (...args) => {
    const fd = original.openSync(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(fixture.input.directory) && args[1] === 'wx') { descriptors.set(fd, args[0]); opened++; }
    return fd;
  };
  fs.closeSync = fd => { const result = original.closeSync(fd); descriptors.delete(fd); return result; };
  fs.writeSync = (fd, ...args) => {
    if (failEventWrite && !injected && descriptors.get(fd)?.endsWith('.events.ndjson') && Buffer.isBuffer(args[0]) && args[0].includes(Buffer.from('trigger-write-error'))) {
      injected = true; throw new Error('fixture callback write error');
    }
    return original.writeSync(fd, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await captureEpisode(fixture.input);
    assert.equal(descriptors.size, 0, 'all capture file descriptors close, including terminal summary');
    assert.ok(opened >= 5);
    return result;
  } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
}

test('owned callback capture preserves full Unicode final answer, flushes both decoders, binds artifacts and forwards flags/stdin unchanged', async t => {
  const full = '∀ α 🧮 complete answer. '.repeat(4000);
  const first = eventBytes({ type: 'text', part: { text: 'earlier planning', messageID: 'planning' } });
  const last = Buffer.from(JSON.stringify({ type: 'text', part: { text: full, messageID: 'final' } }));
  const split = last.indexOf(Buffer.from('🧮')) + 2;
  const stderr = Buffer.from('Unicode ∀ diagnostic\nAuthorization: Bearer sensitive-token');
  const fixture = captureFixture(t, { stdout: [first, last.subarray(0, split), last.subarray(split)], stderr: [stderr.subarray(0, 9), stderr.subarray(9)] });
  const result = await trackedCapture(fixture);
  assert.equal(result.status, 'completed'); assert.equal(result.operational_classification, 'completed_answer');
  assert.equal(result.final_text, full); assert.equal(result.text, full);
  assert.equal(readFileSync(result.answer_path, 'utf8'), full);
  assert.equal(result.final_text_sha256, sha256(full)); assert.equal(result.answer_bytes, Buffer.byteLength(full));
  assert.equal(fixture.state.launch, fixture.input.launch); assert.ok(fixture.state.launch.args.includes('--server'));
  assert.equal(fixture.state.launch.args.includes('--standalone'), false);
  assert.equal(fixture.state.launch.args.length, 11);
  assert.equal(fixture.state.launch.stdin, fixture.input.launch.stdin);
  assert.deepEqual(fixture.state.launch.stdin, Buffer.from(promptFor(fixture.input.task)));
  assert.equal(fixture.state.cleanupCalls, 1); assert.equal(result.cleanup.confirmed, true);
  assert.equal(result.prompt_sha256, sha256(promptFor(fixture.input.task)));
  assert.equal(result.task_sha256, sha256(fixture.input.task)); assert.equal(result.protocol_hash, PROTOCOL_HASH);
  assert.equal(result.capture_source_sha256, sha256(readFileSync(path.resolve(import.meta.dirname, '../run.mjs'))));
  for (const artifact of Object.values(result.artifacts)) {
    const bytes = readFileSync(artifact.path); assert.equal(artifact.sha256, sha256(bytes)); assert.equal(artifact.bytes, bytes.length);
  }
  assert.match(readFileSync(result.artifacts.stderr.path, 'utf8'), /Unicode ∀ diagnostic/);
  assert.doesNotMatch(readFileSync(result.artifacts.stderr.path, 'utf8'), /sensitive-token/);
  assert.deepEqual(JSON.parse(readFileSync(result.episode_path, 'utf8')), result);
  assert.equal(result.identity_validation.status, 'unavailable');
  assert.deepEqual(result.identity_validation.observed_models, []); assert.deepEqual(result.identity_validation.observed_session_ids, []);
  const bytes = readFileSync(result.artifacts.events.path);
  fixture.state.callbacks.onStdout(eventBytes({ type: 'text', part: { text: 'late callback' } }));
  assert.deepEqual(readFileSync(result.artifacts.events.path), bytes);
});

test('provider/malformed lines retain full available answer, partial usage and tool event references, but never claim clean completion', async t => {
  const fixture = captureFixture(t, { stdout: [eventBytes(
    'malformed diagnostic', { type: 'step_finish', part: { tokens: { input: 10, output: 4 }, cost: 0.1 } },
    { type: 'tool_use', part: { tool: 'approved_search', callID: 'call-1', state: { status: 'completed' } } },
    { type: 'error', error: { message: 'provider quota exhausted' } },
    { type: 'step_finish', part: { tokens: { input: 3 }, cost: null } },
    { type: 'text', part: { text: 'Full partial answer still retained.', messageID: 'final' } },
  )] });
  const result = await trackedCapture(fixture);
  assert.equal(result.status, 'failed'); assert.equal(result.operational_classification, 'provider_error');
  assert.equal(result.extraction_failures, 1); assert.equal(result.provider_errors, 1);
  assert.equal(result.final_text, 'Full partial answer still retained.');
  assert.equal(result.usage.input_tokens, null); assert.equal(result.usage.output_tokens, null); assert.equal(result.usage.cost_usd, null);
  assert.equal(result.usage.known_subtotal.input_tokens, 13);
  assert.equal(result.usage.known_subtotal.cost_usd, 0.1); assert.equal(result.usage.known_subtotal.output_tokens, 4);
  assert.deepEqual(result.tools, ['approved_search']); assert.equal(result.tool_events[0].call_id, 'call-1');
  const raw = readFileSync(result.artifacts.events.path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(raw[result.tool_events[0].event_line - 1].part.tool, 'approved_search');
  const malformed = captureFixture(t, { stdout: [eventBytes('not JSON', { type: 'text', part: { text: 'Answer' } })] });
  assert.equal((await trackedCapture(malformed)).operational_classification, 'extraction_failure');
});

test('timeout and cleanup exceptions/hangs cannot wait forever or lose terminal summaries/file closes', async t => {
  for (const behavior of [
    { hangClosed: true, timeoutMs: 20, exit: { exit_code: null, signal: 'ABORT' } },
    { throwCleanup: true }, { hangClosed: true, hangCleanup: true, timeoutMs: 20 },
    { throwLaunch: true }, { rejectClosed: true },
  ]) {
    const fixture = captureFixture(t, { ...behavior, limits: { cleanupMs: 20 }, stdout: [eventBytes({ type: 'text', part: { text: 'retained answer' } })] });
    const started = Date.now(), result = await trackedCapture(fixture);
    assert.ok(Date.now() - started < 1500); assert.equal(result.status, 'failed');
    assert.deepEqual(JSON.parse(readFileSync(result.episode_path, 'utf8')), result);
    if (behavior.hangClosed) assert.equal(result.timeout, true);
    if (behavior.throwCleanup || behavior.hangCleanup) {
      assert.equal(result.cleanup.confirmed, false); assert.equal(result.safety_failure, true);
      assert.equal(result.final_text, 'retained answer');
    }
    if (behavior.hangCleanup) assert.equal(result.cleanup.error, 'owned_cleanup_timeout');
  }
});

test('line/output caps and callback exceptions abort the owned job, preserve prior usage/tools and persist failure', async t => {
  const prior = eventBytes({ type: 'step_finish', part: { tokens: { input: 5, output: 1 }, cost: 0.02 } },
    { type: 'tool_use', part: { tool: 'compute', callID: 'observed' } }, { type: 'text', part: { text: 'available answer' } });
  for (const [limits, tail, failWrite, expected] of [
    [{ maxLineBytes: 256 }, Buffer.from('x'.repeat(257)), false, 'line_limit'],
    [{ maxOutputBytes: 1024 }, Buffer.from('x'.repeat(1100)), false, 'output_limit'],
    [{}, eventBytes({ type: 'text', part: { text: 'trigger-write-error' } }), true, null],
  ]) {
    const fixture = captureFixture(t, { limits, hangClosed: true, stdout: [prior, tail] });
    const result = await trackedCapture(fixture, failWrite);
    assert.equal(result.status, 'failed'); assert.equal(fixture.state.callbacks.signal.aborted, true);
    assert.equal(result.resource_failure, expected); if (failWrite) assert.equal(result.capture_error, 'capture_callback_failed');
    assert.equal(result.usage.cost_usd, null); assert.equal(result.usage.known_subtotal.cost_usd, 0.02);
    assert.equal(result.usage_completeness.episode_complete, false); assert.deepEqual(result.tools, ['compute']);
    assert.equal(result.final_text, 'available answer'); assert.equal(fixture.state.cleanupCalls, 1);
    assert.equal(result.cleanup.confirmed, true); assert.equal(JSON.parse(readFileSync(result.episode_path, 'utf8')).status, 'failed');
  }
  assert.equal(CAPTURE_LIMITS.maxOutputBytes, 128 * 1024 * 1024); assert.equal(CAPTURE_LIMITS.maxLineBytes, 8 * 1024 * 1024);
});

test('DSML-only/interface blocks/nonzero exits and unbound identity are classified operationally, not as math success', async t => {
  for (const [events, exit, classification] of [
    [[{ type: 'text', part: { text: '<｜DSML｜function_calls>compute(x)</｜DSML｜function_calls>' } }], {}, 'interface_text_artifact'],
    [[{ type: 'tool_use', part: { tool: 'compute', state: { status: 'error', error: 'Tool not allowed by permission guard' } } }, { type: 'text', part: { text: 'Proposed answer' } }], {}, 'interface_call_blocked'],
    [[{ type: 'text', part: { text: 'Partial answer' } }], { exit_code: 7 }, 'nonzero_exit'],
  ]) {
    const fixture = captureFixture(t, { stdout: [eventBytes(...events)], exit });
    const result = await trackedCapture(fixture); assert.equal(result.status, 'failed'); assert.equal(result.operational_classification, classification);
  }
  const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'text', providerID: 'explicit-provider', modelID: 'explicit-model', sessionID: 'observed-session', part: { text: 'Answer' } })] });
  const result = await trackedCapture(fixture);
  assert.equal(result.identity_validation.status, 'unavailable'); assert.deepEqual(result.identity_validation.observed_models, [options.model]);
  assert.deepEqual(result.identity_validation.observed_session_ids, ['observed-session']);
});

test('capture refuses duplicate artifact paths, mutable descriptors and standalone launches without changing existing evidence', async t => {
  const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'text', part: { text: 'Answer' } })] });
  const result = await trackedCapture(fixture), original = readFileSync(result.episode_path), modified = statSync(result.episode_path).mtimeMs;
  await assert.rejects(() => captureEpisode(fixture.input), /output_exists/);
  assert.deepEqual(readFileSync(result.episode_path), original); assert.equal(statSync(result.episode_path).mtimeMs, modified);
  const fresh = captureFixture(t);
  await assert.rejects(() => captureEpisode({ ...fresh.input, launch: { ...fresh.input.launch } }), /frozen_trusted/);
  const launch = Object.freeze({ ...fresh.input.launch, args: Object.freeze(['run', '--standalone', '--', promptFor(fresh.input.task)]) });
  await assert.rejects(() => captureEpisode({ ...fresh.input, launch }), /frozen_trusted/);
  assert.deepEqual(readdirSync(fresh.input.directory), []);
});

test('capture rejects extra argv and missing, changed, oversized or NUL stdin before launch or artifact writes', async t => {
  for (const mode of ['unsplit', 'extra', 'old-delimiter', 'option-like', 'added-quotes', 'missing', 'changed', 'oversized', 'nul', 'wrong-type', 'wrong-hash']) {
    const fixture = captureFixture(t), prompt = promptFor(fixture.input.task);
    const extra = { unsplit: [prompt], extra: ['extra'], 'old-delimiter': ['--'], 'option-like': ['--model'], 'added-quotes': [`"${prompt}"`] }[mode] ?? [];
    let stdin = Buffer.from(prompt);
    if (mode === 'missing') stdin = undefined;
    if (mode === 'changed') stdin[0] ^= 1;
    if (mode === 'oversized') stdin = Buffer.alloc(1024 * 1024 + 1, 0x61);
    if (mode === 'nul') stdin[0] = 0;
    if (mode === 'wrong-type') stdin = prompt;
    fixture.input.launch = Object.freeze({ ...fixture.input.launch, stdin,
      stdin_sha256: mode === 'wrong-hash' ? '0'.repeat(64) : Buffer.isBuffer(stdin) ? sha256(stdin) : fixture.input.launch.stdin_sha256,
      args: Object.freeze([...fixture.input.launch.args, ...extra]) });
    await assert.rejects(() => captureEpisode(fixture.input), /frozen_trusted_owned_launch_required/);
    assert.equal(fixture.state.launch, null); assert.deepEqual(readdirSync(fixture.input.directory), []);
  }
});

test('capture forwards exact special-character prompt stdin without persisting descriptor bytes or content', async t => {
  const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'text', part: { text: 'Answer only' } })] });
  fixture.input.task = { ...fixture.input.task, prompt: 'Unique stdin text: spaces  "quotes"\nUnicode α 🧮\n-2, -4], --model\n' };
  const prompt = promptFor(fixture.input.task), stdin = Buffer.from(prompt);
  fixture.input.launch = Object.freeze({ ...fixture.input.launch, stdin, stdin_sha256: sha256(stdin) });
  const result = await trackedCapture(fixture);
  assert.equal(result.status, 'completed');
  assert.equal(fixture.state.launch.stdin, stdin);
  assert.deepEqual(fixture.state.launch.stdin, Buffer.from(prompt));
  assert.equal(fixture.state.launch.args.length, 11);
  for (const file of readdirSync(fixture.input.directory)) {
    const content = readFileSync(path.join(fixture.input.directory, file), 'utf8');
    assert.equal(content.includes('Unique stdin text'), false, file);
    assert.equal(content.includes(JSON.stringify(stdin)), false, file);
  }
});

test('frozen first-pair missing-cost exception cannot replace/reorder episodes or overrule spend, safety and absolute episode stops', () => {
  const m = manifest(), schedule = m.schedule, budgets = { max_episodes: 20, max_cost_usd: 1 };
  const policy = { schedule, unknownCostPolicy: PROTOCOL.unknown_cost_policy };
  const first = { ...schedule[0], status: 'completed', usage: { cost_usd: null, known_subtotal: { cost_usd: 0.2 } } };
  const second = { ...schedule[1], status: 'completed', usage: { cost_usd: 0.1 } };
  assert.equal(budgetStop([first], budgets, policy), null);
  assert.equal(budgetStop([first], budgets), 'unknown_cost');
  assert.equal(budgetStop([first, second], budgets, policy), 'unknown_cost');
  assert.equal(budgetStop([{ ...first, usage: { cost_usd: 0.1 } }, { ...second, usage: { cost_usd: null } }], budgets, policy), 'unknown_cost');
  assert.equal(budgetStop([{ ...first, usage: { cost_usd: null, known_subtotal: { cost_usd: 1 } } }], budgets, policy), 'soft_cost_limit');
  assert.equal(budgetStop([{ ...first, usage: { cost_usd: 1.1 } }], budgets, policy), 'soft_cost_limit');
  assert.equal(budgetStop([{ ...first, cleanup: { confirmed: false } }], budgets, policy), 'safety_failure');
  assert.equal(budgetStop([{ ...first, cleanup: { confirmed: true, active_processes: 1 } }], budgets, policy), 'safety_failure');
  assert.equal(budgetStop([{ ...first, cleanup: { confirmed: true, files_removed: false } }], budgets, policy), 'safety_failure');
  assert.equal(budgetStop([{ ...first, safety_failure: true }], budgets, policy), 'safety_failure');
  assert.equal(budgetStop([first], { ...budgets, max_episodes: 1 }, policy), 'max_episodes');
  assert.equal(budgetStop([{ ...first, episode_id: schedule[2].episode_id }], budgets, policy), 'schedule_mismatch');
  assert.equal(budgetStop([first], budgets, { ...policy, schedule: [schedule[0], schedule[2]] }), 'unknown_cost');
  assert.equal(budgetStop([first], budgets, { ...policy, schedule: [schedule[0], schedule[0]] }), 'schedule_mismatch');
  assert.equal(budgetStop([{ ...first, status: 'started' }], budgets, policy), 'unknown_cost');
  assert.equal(PROTOCOL.live_model, 'opencode-go/deepseek-v4.1-flash'); assert.equal(PROTOCOL.live_repeats, 1);
  assert.equal(PROTOCOL.max_episodes, 20); assert.equal(PROTOCOL.max_cost_usd, 1); assert.equal(PROTOCOL.timeout_ms, 300000);
  assert.equal(PROTOCOL.concurrency, 1); assert.equal(PROTOCOL.retries, 0); assert.equal(PROTOCOL.resume, false);
});

test('billed steps followed by interrupted inference never become complete totals or permit pair two', async t => {
  const billed = { type: 'step_finish', part: { reason: 'tool-calls', tokens: { input: 5, output: 1 }, cost: 0.02 } };
  const next = [{ type: 'step_start' }, { type: 'text', part: { text: 'Partial answer' } }];
  const final = { type: 'step_finish', part: { reason: 'stop', tokens: { input: 2, output: 3 }, cost: 0.01 } };
  const schedule = manifest().schedule, policy = { schedule, unknownCostPolicy: PROTOCOL.unknown_cost_policy };
  const budgets = { max_episodes: 20, max_cost_usd: 1 };
  for (const behavior of [
    { stdout: [eventBytes(billed, ...next)], hangClosed: true, timeoutMs: 10 },
    { stdout: [eventBytes(billed, ...next)] }, // Exit 0 is insufficient without the final finish.
    { stdout: [eventBytes(billed, ...next), Buffer.from('{"type":"step_finish","part":')] },
    { stdout: [eventBytes(billed, ...next, 'malformed', final)] },
    { stdout: [eventBytes(billed, ...next, { type: 'error', error: { message: 'provider interrupted' } }, final)] },
    { stdout: [eventBytes(billed, ...next, final)], exit: { exit_code: 7 } },
    { stdout: [eventBytes(billed, ...next, final)], throwCleanup: true },
  ]) {
    const result = await trackedCapture(captureFixture(t, behavior));
    assert.equal(result.usage.cost_usd, null); assert.equal(result.usage.input_tokens, null); assert.equal(result.usage.output_tokens, null);
    assert.ok(result.usage.known_subtotal.cost_usd >= 0.02);
    assert.ok(result.usage.known_subtotal.input_tokens >= 5); assert.ok(result.usage.coverage.cost_usd >= 1);
    assert.equal(result.usage_completeness.status, 'incomplete'); assert.equal(result.usage_completeness.episode_complete, false);
    assert.ok(result.usage_completeness.reasons.length > 0);
    assert.equal(budgetStop([result], budgets, policy), behavior.throwCleanup ? 'safety_failure' : null);
    assert.equal(budgetStop([result, { ...schedule[1], status: 'completed', usage: { cost_usd: 0 } }], budgets, policy),
      behavior.throwCleanup ? 'safety_failure' : 'unknown_cost');
    assert.equal(JSON.parse(readFileSync(result.episode_path, 'utf8')).usage.cost_usd, null);
  }
});

test('clean exhausted streams with a terminal stop finish retain legitimate zero and per-field missingness', async t => {
  for (const [tokens, cost, expected] of [
    [{ input: 0, output: 0 }, 0, { input_tokens: 0, output_tokens: 0, cost_usd: 0 }],
    [{ input: 5 }, 0.02, { input_tokens: 5, output_tokens: null, cost_usd: 0.02 }],
    [{ input: 5, output: 1 }, null, { input_tokens: 5, output_tokens: 1, cost_usd: null }],
  ]) {
    const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'step_start' },
      { type: 'text', part: { text: 'Completed answer' } }, { type: 'step_finish', part: { reason: 'stop', tokens, cost } })] });
    const result = await trackedCapture(fixture);
    assert.equal(result.status, 'completed'); assert.equal(result.usage_completeness.episode_complete, true);
    for (const [key, value] of Object.entries(expected)) assert.equal(result.usage[key], value);
    assert.equal(result.usage_completeness.status, Object.values(expected).includes(null) ? 'incomplete' : 'observed_episode_total');
    assert.match(result.usage_completeness.scope, /not bill reconciliation/);
  }
});

test('empty and truncated terminal JSON recover only matching starts without losing other episodes or changing corrupt bytes', t => {
  for (const content of ['', '{', '{"status":"complet', '{"status":']) {
    const dir = temp(t), m = manifest(), [first, second] = m.schedule, directory = path.join(dir, 'episodes');
    mkdirSync(directory);
    const start = { ...first, started_at: '2026-11-11T00:00:00Z' };
    const terminal = path.join(directory, `${first.episode_id}.json`);
    writeFileSync(path.join(directory, `${first.episode_id}.start.json`), JSON.stringify(start));
    writeFileSync(terminal, content);
    const modified = statSync(terminal).mtimeMs;
    const completed = { ...second, status: 'completed', text: 'Other complete answer', usage: { cost_usd: 0.1 } };
    writeFileSync(path.join(directory, `${second.episode_id}.json`), JSON.stringify(completed));
    const episodes = loadEpisodes(dir, m);
    assert.equal(episodes.length, 2); assert.deepEqual(episodes[1], completed);
    assert.equal(episodes[0].status, 'incomplete'); assert.equal(episodes[0].operational_classification, 'artifact_failure');
    assert.equal(episodes[0].artifact_failure, 'terminal_json_truncated'); assert.equal(episodes[0].usage.cost_usd, null);
    assert.equal(episodes[0].usage_completeness.status, 'unknown'); assert.equal(episodes[0].safety_failure, true);
    assert.equal(readFileSync(terminal, 'utf8'), content); assert.equal(statSync(terminal).mtimeMs, modified);
    assert.equal(report(m, episodes).overall.counts.both, 0);
  }
});

test('episode loading rejects orphan, duplicate, mismatched or unsafe identities instead of inventing recovered episodes', t => {
  const m = manifest(), [item, other] = m.schedule;
  for (const scenario of ['no-start', 'invalid-start', 'wrong-start', 'wrong-start-task', 'wrong-terminal', 'orphan', 'invalid-json', 'duplicate', 'traversal']) {
    const dir = temp(t), directory = path.join(dir, 'episodes'); mkdirSync(directory);
    const start = { ...item, started_at: '2026-11-11T00:00:00Z' };
    if (scenario !== 'no-start') writeFileSync(path.join(directory, `${item.episode_id}.start.json`), scenario === 'invalid-start' ? '{}' : JSON.stringify({ ...start,
      ...(scenario === 'wrong-start' ? { episode_id: other.episode_id } : {}),
      ...(scenario === 'wrong-start-task' ? { task_id: 'different' } : {}) }));
    const terminal = path.join(directory, `${item.episode_id}.json`);
    writeFileSync(terminal, scenario === 'wrong-terminal' ? JSON.stringify({ ...other, status: 'completed' }) : scenario === 'invalid-json' ? 'not JSON' : '');
    if (scenario === 'orphan') writeFileSync(path.join(directory, 'orphan.json'), '{}');
    const input = scenario === 'duplicate' ? { ...m, schedule: [item, item] } : scenario === 'traversal' ? { ...m, schedule: [{ ...item, episode_id: '../outside' }] } : m;
    assert.throws(() => loadEpisodes(dir, input), /artifact_error|duplicate episode_id|unsafe episode_id/);
    assert.ok(existsSync(terminal));
  }
  const dir = temp(t), outside = temp(t);
  symlinkSync(outside, path.join(dir, 'episodes'), 'junction');
  assert.throws(() => loadEpisodes(dir, m), /unsafe episode directory/);
});

test('terminal publication flushes exclusive temporary bytes, never overwrites a collision and preserves a visible attempt after write failure', async t => {
  for (const rejectedFinalization of [false, true]) for (const mode of ['success', 'partial-write', 'collision']) {
    const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'text', part: { text: 'Answer' } })] });
    if (rejectedFinalization) fixture.input.finalize = async () => { throw new Error('native_timestamp_basis_mismatch'); };
    const out = fixture.input.directory, directory = path.join(out, 'episodes'); mkdirSync(directory); fixture.input.directory = directory;
    const terminal = path.join(directory, `${fixture.input.item.episode_id}.json`);
    const factory = fixture.input.launcherFactory;
    fixture.input.launcherFactory = (...args) => { assert.equal(existsSync(terminal), false, 'no terminal placeholder before launch'); return factory(...args); };
    const original = { openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
    const descriptors = new Set(); let terminalFD, flushed = false, published = false;
    fs.openSync = (...args) => { const fd = original.openSync(...args); if (args[1] === 'wx' && String(args[0]).includes('.terminal-')) { terminalFD = fd; descriptors.add(fd); } return fd; };
    fs.closeSync = fd => { const value = original.closeSync(fd); descriptors.delete(fd); return value; };
    fs.fsyncSync = fd => { const value = original.fsyncSync(fd); if (fd === terminalFD) flushed = true; return value; };
    fs.writeSync = (fd, ...args) => {
      if (fd === terminalFD && mode === 'partial-write') { original.writeSync(fd, args[0].subarray(0, 19)); throw new Error('fixture_terminal_write_failed'); }
      return original.writeSync(fd, ...args);
    };
    fs.linkSync = (source, destination) => {
      assert.equal(flushed, true); assert.equal(descriptors.size, 0);
      assert.equal(JSON.parse(readFileSync(source, 'utf8')).episode_id, fixture.input.item.episode_id);
      if (rejectedFinalization) assert.equal(JSON.parse(readFileSync(source, 'utf8')).finalization.reason_code, 'native_timestamp_basis_mismatch');
      if (mode === 'collision') writeFileSync(destination, 'existing user evidence', { flag: 'wx' });
      const value = original.linkSync(source, destination); published = true; return value;
    };
    syncBuiltinESMExports();
    try {
      if (mode === 'success') {
        const result = await captureEpisode(fixture.input);
        assert.equal(published, true); assert.deepEqual(JSON.parse(readFileSync(terminal, 'utf8')), result);
        assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
      } else {
        await assert.rejects(() => captureEpisode(fixture.input), mode === 'partial-write' ? /fixture_terminal_write_failed/ : /EEXIST/);
        assert.equal(published, false); assert.ok(readdirSync(directory).some(name => name.endsWith('.tmp')));
        if (mode === 'collision') assert.equal(readFileSync(terminal, 'utf8'), 'existing user evidence');
        else {
          assert.equal(existsSync(terminal), false);
          const episodes = loadEpisodes(out, manifest());
          assert.equal(episodes.length, 1); assert.equal(episodes[0].status, 'started'); assert.equal(episodes[0].usage.cost_usd, null);
        }
      }
      assert.equal(descriptors.size, 0);
    } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
  }
});

for (const code of ['invalid_native_timestamp_basis', 'native_timestamp_basis_mismatch', 'native_completion_kind_mismatch',
  'native_completion_evidence_rejected', 'invalid_fresh_finish_facts', 'live_finish_guard_rejected', 'native_complete_interval_rejected']) {
  test(`finalization attribution preserves exact rejection code ${code} without authorizing completion`, async t => {
    const id = 'msg_0123456789ab00000000000001', text = 'Retained ∀ answer\n';
    const step = { reason: 'stop', tokens: { input: 5, output: 2 }, cost: 0.02 };
    const fixture = captureFixture(t, { stdout: [eventBytes(
      { type: 'step_start', part: { messageID: id } },
      { type: 'text', part: { messageID: id, text } },
      { type: 'step_finish', part: { messageID: id, ...step } })] });
    let facts, aborts = 0;
    fixture.input.profileId = compatProfileId; fixture.input.protocolHash = sha256(FRESH_PROFILES[compatProfileId].protocol);
    fixture.input.finalize = async value => {
      facts = value; assert.equal(value.signal.aborted, false); throw new Error(code);
    };
    fixture.input.finalize.abort = async () => { aborts++; };
    const result = await trackedCapture(fixture);
    assert.deepEqual(result.finalization, { status: 'unconfirmed', reason: 'finalization_failed', reason_code: code });
    assert.equal(result.status, 'failed'); assert.equal(result.operational_classification, 'finalization_failure');
    assert.equal(result.safety_failure, true); assert.equal(result.capture_classification, 'completed_answer');
    assert.deepEqual(result.capture_usage, usageFromSteps([step], { complete: true, reasons: [] }));
    assert.deepEqual(result.capture_completeness, result.capture_usage.completeness);
    assert.deepEqual(result.usage, usageFromSteps([step], { reasons: ['finalization_failed'] }));
    assert.deepEqual(result.usage_completeness, result.usage.completeness);
    assert.equal(result.completion_basis, null); assert.equal(result.upstream_usage_complete, 'unknown'); assert.equal(result.billed_usd, null);
    assert.equal(result.identity_validation.status, 'unavailable'); assert.equal(result.guard, undefined);
    assert.equal(result.final_text, text); assert.equal(result.answer_bytes, Buffer.byteLength(text)); assert.equal(result.final_text_sha256, sha256(text));
    assert.equal(result.exit_code, 0); assert.equal(result.signal, null); assert.equal(result.timeout, false);
    assert.equal(facts.signal.aborted, true); assert.equal(fixture.state.callbacks.signal.aborted, false);
    assert.equal(fixture.state.cleanupCalls, 1); assert.equal(aborts, 1);
    assert.equal(result.cleanup.cli.confirmed, true); assert.equal(result.cleanup.bridge.confirmed, false); assert.equal(result.cleanup.confirmed, false);
    assert.equal(result.capture_diagnostics.finalization, 'finalization_failed');
    const withoutCode = structuredClone(result); delete withoutCode.finalization.reason_code;
    assert.equal(budgetStop([result], manifest().budgets), budgetStop([withoutCode], manifest().budgets));
    assert.deepEqual(JSON.parse(readFileSync(result.episode_path, 'utf8')), result);
    assert.equal(readdirSync(fixture.input.directory).some(name => name.endsWith('.tmp')), false);
    const published = readFileSync(result.episode_path);
    await assert.rejects(() => captureEpisode(fixture.input), /output_exists/);
    assert.deepEqual(readFileSync(result.episode_path), published);
  });
}

test('unknown finalizer errors never persist hostile text, paths, headers, bodies or stacks', async t => {
  const hostile = 'SYNTHETIC_PRIVATE C:\\fixture-private\\trace Authorization: Bearer sk-fixture-secret https://private.invalid body=hidden';
  for (const thrown of [new Error(hostile), new Error('invalid_unlisted_code'), new Error('native_unlisted_rejected'),
    new Error(`native_timestamp_basis_mismatch ${hostile}`), { message: { toString() { throw new Error(hostile); } }, stack: hostile },
    { get message() { throw new Error(hostile); } }, null, undefined, hostile]) {
    const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'text', part: { text: 'Answer' } },
      { type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0.01 } })] });
    fixture.input.finalize = async () => { throw thrown; };
    const result = await trackedCapture(fixture);
    assert.deepEqual(result.finalization, { status: 'unconfirmed', reason: 'finalization_failed', reason_code: 'unknown_failure' });
    for (const name of readdirSync(fixture.input.directory)) {
      assert.doesNotMatch(readFileSync(path.join(fixture.input.directory, name), 'utf8'),
        /SYNTHETIC_PRIVATE|fixture-private|Authorization|Bearer|sk-fixture-secret|private\.invalid|body=hidden|invalid_unlisted_code|native_unlisted_rejected/);
    }
  }
});

test('successful finalization has no reason code (isolated receipt-consumer stub, not admission authority)', async t => {
  // Stub only the consumer in a separately loaded capture module. The real
  // admission module and captureEpisode import retain their receipt checks.
  const runURL = new URL('../run.mjs?fixture-finalization-success', import.meta.url);
  const admissionURL = new URL('../admission.mjs', import.meta.url).href;
  const stub = 'data:text/javascript,' + encodeURIComponent(
    `export { nativePromptTransportMatch } from ${JSON.stringify(admissionURL)}; export const consumeFinalizationReceipt = () => true;`);
  const hooks = registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    return url === runURL.href ? { ...loaded, source: String(loaded.source).replace("from './admission.mjs'", `from '${stub}'`) } : loaded;
  } });
  let isolatedCapture;
  try { isolatedCapture = (await import(runURL.href)).captureEpisode; } finally { hooks.deregister(); }
  const make = () => captureFixture(t, { stdout: [eventBytes({ type: 'text', part: { text: 'Answer' } },
    { type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0.01 } })] });
  const receipt = { identity_validation: { status: 'fixture-only' }, guard: { status: 'fixture-only' }, cleanup: { confirmed: true } };
  const fixture = make(); fixture.input.finalize = async () => receipt;
  const result = await isolatedCapture(fixture.input);
  assert.deepEqual(result.finalization, { status: 'validated_owned_receipt' });
  assert.equal(Object.hasOwn(result.finalization, 'reason_code'), false);
  assert.deepEqual(JSON.parse(readFileSync(result.episode_path, 'utf8')).finalization, result.finalization);
  const genuine = make(); genuine.input.finalize = async () => receipt;
  assert.equal((await captureEpisode(genuine.input)).finalization.reason, 'untrusted_finalization_receipt');
});

test('bounded optional finalization preserves partial answers and billing, rejects unbranded success, and publishes failures after callback rejection/hang', async t => {
  for (const mode of ['unbranded-success', 'reject', 'hang', 'solver-timeout']) {
    const order = [], fixture = captureFixture(t, { limits: { finalizeMs: 10 }, timeoutMs: mode === 'solver-timeout' ? 10 : 1000,
      hangClosed: mode === 'solver-timeout', stdout: [eventBytes(
        { type: 'text', part: { text: 'Available answer' } },
        { type: 'step_finish', part: { reason: 'stop', tokens: { input: 5, output: 2 }, cost: 0.02 } })] });
    const finalize = async facts => {
      order.push('finalize'); assert.equal(fixture.state.cleanupCalls, 1); assert.equal(facts.prompt_sha256, sha256(promptFor(fixture.input.task)));
      assert.equal(typeof facts.signal.aborted, 'boolean');
      if (mode === 'reject') throw new Error('synthetic-private-finalizer-error');
      if (mode === 'hang') return new Promise(() => {});
      return { identity_validation: { status: 'validated' }, guard: { status: 'passed' }, cleanup: { confirmed: true }, private: 'synthetic-private-value' };
    };
    finalize.abort = async () => { order.push('abort'); };
    fixture.input.finalize = finalize; fixture.input.setupMs = 12;
    const started = Date.now(), result = await trackedCapture(fixture);
    assert.ok(Date.now() - started < 1500); assert.equal(result.status, 'failed'); assert.equal(result.safety_failure, true);
    assert.equal(result.operational_classification, 'finalization_failure'); assert.equal(result.identity_validation.status, 'unavailable');
    assert.equal(result.final_text, 'Available answer'); assert.equal(result.usage.cost_usd, null);
    assert.equal(result.usage.known_subtotal.cost_usd, 0.02); assert.equal(result.usage.coverage.cost_usd, 1);
    assert.equal(result.cleanup.cli.confirmed, true); assert.equal(result.cleanup.bridge.confirmed, false);
    assert.equal(result.timings.setup_ms, 12); assert.ok(result.timings.solver_ms >= 0); assert.ok(result.timings.cleanup_ms >= 0);
    assert.ok(result.timings.end_to_end_ms >= result.timings.setup_ms + result.timings.solver_ms);
    const saved = readFileSync(result.episode_path, 'utf8'); assert.deepEqual(JSON.parse(saved), result);
    assert.doesNotMatch(saved, /synthetic-private/);
    if (mode === 'hang') assert.equal(result.finalization.reason, 'finalization_timeout');
    if (mode === 'solver-timeout') { assert.equal(result.timeout, true); assert.ok(order.indexOf('abort') < order.indexOf('finalize'), 'owned bridge abort begins before evidence finalization'); }
  }
});

test('null, undefined and primitive finalizer/launcher rejections retain terminal evidence and close all descriptors', async t => {
  for (const thrown of [null, undefined, 'synthetic-private-throw', 42, { secret: 'synthetic-private-throw' }]) {
    const fixture = captureFixture(t, { limits: { finalizeMs: 10, cleanupMs: 10 }, stdout: [eventBytes(
      { type: 'text', part: { text: 'Retained partial answer' } },
      { type: 'step_finish', part: { reason: 'stop', tokens: { input: 4, output: 2 }, cost: 0.02 } })] });
    let aborts = 0;
    fixture.input.finalize = async () => { throw thrown; };
    fixture.input.finalize.abort = async () => { aborts++; };
    const result = await trackedCapture(fixture);
    assert.equal(result.status, 'failed'); assert.equal(result.safety_failure, true); assert.equal(result.finalization.reason, 'finalization_failed');
    assert.equal(result.final_text, 'Retained partial answer'); assert.equal(result.usage.cost_usd, null);
    assert.equal(result.usage.known_subtotal.cost_usd, 0.02); assert.equal(result.usage.known_subtotal.input_tokens, 4);
    assert.equal(result.usage.coverage.cost_usd, 1); assert.equal(fixture.state.cleanupCalls, 1); assert.equal(aborts, 1);
    const terminal = readFileSync(result.episode_path, 'utf8');
    assert.deepEqual(JSON.parse(terminal), result); assert.doesNotMatch(terminal, /synthetic-private-throw/);
  }
  for (const thrown of [null, undefined, 'synthetic-private-throw']) {
    for (const key of ['launchError', 'cleanupError', 'closedError']) {
      const fixture = captureFixture(t, { [key]: thrown, limits: { cleanupMs: 10 }, stdout: [eventBytes(
        { type: 'text', part: { text: 'Available answer' } },
        { type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0.02 } })] });
      const result = await trackedCapture(fixture);
      assert.equal(result.status, 'failed'); assert.equal(result.usage.cost_usd, null);
      if (key !== 'launchError') { assert.equal(result.usage.known_subtotal.cost_usd, 0.02); assert.equal(fixture.state.cleanupCalls, 1); }
      if (key === 'cleanupError') { assert.equal(result.safety_failure, true); assert.equal(result.cleanup.error, 'owned_cleanup_failed'); }
      assert.deepEqual(JSON.parse(readFileSync(result.episode_path, 'utf8')), result);
      assert.doesNotMatch(readFileSync(result.episode_path, 'utf8'), /synthetic-private-throw/);
    }
  }
});

test('early/nonzero/truncated native closure aborts bridge before cleanup or finalizer wait and retains partial billing', async t => {
  for (const mode of ['early', 'nonzero', 'truncated']) {
    const order = [], output = eventBytes({ type: 'text', sessionID: 'ses_fixture', part: { text: 'Partial answer' } },
      { type: 'step_finish', sessionID: 'ses_fixture', part: { reason: mode === 'early' ? 'tool-calls' : 'stop', tokens: { input: 5, output: 2 }, cost: 0.02 } });
    const fixture = captureFixture(t, { exit: { exit_code: mode === 'nonzero' ? 7 : 0 },
      stdout: [mode === 'truncated' ? output.subarray(0, output.length - 1) : output] });
    fixture.input.finalize = async facts => {
      order.push('finalize'); assert.equal(facts.signal.aborted, true); assert.equal(facts.native_closure_clean, false);
      assert.deepEqual(facts.observed_models, []); throw new Error('fixture_no_native_finish');
    };
    fixture.input.finalize.abort = async () => { order.push('abort'); assert.equal(fixture.state.cleanupCalls, 0); };
    const result = await trackedCapture(fixture);
    assert.deepEqual(order, ['abort', 'finalize']); assert.equal(result.safety_failure, true);
    assert.equal(result.identity_validation.status, 'unavailable'); assert.equal(result.final_text, 'Partial answer');
    assert.equal(result.usage.cost_usd, null); assert.equal(result.usage.known_subtotal.cost_usd, 0.02);
  }
});

test('native-shaped complete stream without flat model fields reaches identity evidence inspection, not branded success', async t => {
  const fixture = captureFixture(t, { stdout: [eventBytes(
    { type: 'text', sessionID: 'ses_fixture', part: { text: 'Native shaped answer' } },
    { type: 'tool_use', sessionID: 'ses_fixture', part: { tool: 'compute', state: { input: { model: { providerID: 'untrusted', id: 'text' } }, output: 'other/model' } } },
    { type: 'step_finish', sessionID: 'ses_fixture', part: { reason: 'stop', tokens: { input: 5, output: 2 }, cost: 0.02 } })] });
  fixture.input.finalize = async facts => {
    assert.equal(facts.native_closure_clean, true); assert.equal(facts.signal.aborted, false);
    assert.deepEqual(facts.observed_models, []); assert.deepEqual(facts.observed_session_ids, ['ses_fixture']);
    assert.ok(facts.solver_deadline > Date.now());
    throw new Error('fixture_does_not_mint_finalization');
  };
  const result = await trackedCapture(fixture);
  assert.equal(result.model_mismatch, false); assert.equal(result.identity_validation.status, 'unavailable');
  assert.equal(result.finalization.reason, 'finalization_failed');
});

test('native typed model Ref identity is observed and conflicting Ref is rejected', async t => {
  for (const conflict of [false, true]) {
    const fixture = captureFixture(t), [providerID, id] = fixture.input.item.model.split('/');
    const source = captureFixture(t, { stdout: [eventBytes({ type: 'text', sessionID: 'ses_fixture',
      model: { providerID, id: conflict ? 'conflicting-model' : id }, part: { text: 'Answer' } },
      { type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0.01 } })] });
    const result = await trackedCapture(source);
    assert.equal(result.model_mismatch, conflict);
    assert.deepEqual(result.identity_validation.observed_models, [`${providerID}/${conflict ? 'conflicting-model' : id}`]);
  }
});

function preservedTrace(condition) {
  const root = 'C:/Users/MiPC/AppData/Local/Temp/opencode/real-use-study-g004-20261112/episodes';
  const prefix = path.join(root, `real-use-g004-20261112.hanner-released-pdf.r1.m11bd2a5fe7979cf8.${condition}`);
  const files = [prefix + '.events.ndjson', prefix + '.answer.txt', prefix + '.json'];
  const bytes = files.map(file => readFileSync(file));
  const hashes = bytes.map(sha256);
  const expectedEventsHash = condition === 'plugin-off' ? '7993215be2736e35b46e6bf90299f3b7179a0ee08a4fe01a32147098f680f75a'
    : 'bf61a0bd7ef431f165d2da67a6c6d816049e3ace2f504c721e38aa9b912243bc';
  assert.equal(hashes[0], expectedEventsHash, 'literal preserved trace, not a manufactured substitute');
  return { bytes: bytes[0], answer: bytes[1], episode: JSON.parse(bytes[2]),
    unchanged: () => files.forEach((file, i) => assert.equal(sha256(readFileSync(file)), hashes[i])) };
}

test('preserved OFF 25-event trace replay retains exact answer and six subtotals, detects unfinished seventh step, aborts before finalizer', async t => {
  const trace = preservedTrace('plugin-off'), order = [];
  assert.equal(trace.bytes.toString('utf8').trim().split('\n').length, 25);
  const fixture = captureFixture(t, { stdout: [trace.bytes], exit: { exit_code: 0 } });
  fixture.input.finalize = async facts => {
    order.push('finalize'); assert.equal(facts.signal.aborted, true); assert.equal(facts.native_closure_clean, false);
    throw new Error('fixture_no_owned_identity');
  };
  fixture.input.finalize.abort = async () => { order.push('abort'); };
  await withoutSpawn(async () => {
    const result = await trackedCapture(fixture), d = result.capture_diagnostics;
    assert.deepEqual(order, ['abort', 'finalize']); assert.equal(result.final_text, trace.answer.toString('utf8'));
    assert.equal(result.answer_bytes, 3216); assert.equal(result.final_text_sha256, trace.episode.final_text_sha256);
    assert.equal(result.usage.steps, 6); assert.deepEqual(result.usage.known_subtotal, trace.episode.usage.known_subtotal);
    assert.deepEqual(result.usage.coverage, { input_tokens: 6, output_tokens: 6, cost_usd: 6 });
    for (const key of ['input_tokens', 'output_tokens', 'cost_usd']) assert.equal(result.usage[key], null);
    assert.ok(result.usage.completeness.reasons.includes('unfinished_step'));
    assert.ok(result.usage.completeness.reasons.includes('terminal_step_finish_missing'));
    assert.equal(d.step_starts, 7); assert.equal(d.step_finishes, 6); assert.equal(d.pending_steps, 1);
    assert.equal(d.events.length, 25); assert.equal(d.events.at(-1).type, 'text');
    assert.equal(d.terminal_step_finish_observed, false); assert.equal(d.native_closure_clean, false);
    assert.equal(d.cancellation_cause, 'native_closure_incomplete'); assert.equal(d.upstream_cause, 'unknown');
    assert.equal(d.provider_errors, 0); assert.equal(d.extraction_failures, 0);
    assert.equal(result.status, 'failed'); assert.equal(result.safety_failure, true); assert.equal(result.identity_validation.status, 'unavailable');
  });
  trace.unchanged();
});

test('preserved ON 16-event trace replay is a terminal-stop candidate only, never production identity or a proof receipt', async t => {
  const trace = preservedTrace('plugin-on');
  assert.equal(trace.bytes.toString('utf8').trim().split('\n').length, 16);
  const fixture = captureFixture(t, { stdout: [trace.bytes], exit: { exit_code: 0 } });
  await withoutSpawn(async () => {
    const result = await trackedCapture(fixture), d = result.capture_diagnostics;
    assert.equal(result.final_text, trace.answer.toString('utf8')); assert.equal(result.final_text_sha256, trace.episode.final_text_sha256);
    assert.equal(result.answer_bytes, 1288); assert.equal(d.events.length, 16);
    assert.equal(d.native_closure_clean, true); assert.equal(d.terminal_step_finish_observed, true); assert.equal(d.pending_steps, 0);
    assert.equal(d.step_starts, 5); assert.equal(d.step_finishes, 5);
    assert.equal(result.usage.cost_usd, trace.episode.usage.cost_usd); assert.equal(result.usage.completeness.episode_complete, true);
    assert.equal(result.identity_validation.status, 'unavailable'); assert.equal(result.guard, undefined);
    assert.equal(result.finalization, undefined); assert.equal(d.finalization, 'not_attempted');
    assert.match(d.authority, /not native identity or admission/);
  });
  trace.unchanged();
});

test('delayed terminal finish before closure is observed, whereas a stream disconnect remains incomplete and aborts', async t => {
  const beginning = eventBytes({ type: 'step_start', sessionID: 'ses_fixture' }, { type: 'text', sessionID: 'ses_fixture', part: { text: 'Retained answer' } });
  const finish = eventBytes({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 2, output: 1 }, cost: 0.01 } });
  const delayed = captureFixture(t, { stdout: [beginning], delayedStdout: [finish], delayMs: 10 });
  const complete = await trackedCapture(delayed);
  assert.equal(complete.capture_diagnostics.native_closure_clean, true); assert.equal(complete.capture_diagnostics.pending_steps, 0);
  assert.equal(complete.identity_validation.status, 'unavailable');
  const disconnected = captureFixture(t, { stdout: [beginning], closedError: new Error('SYNTHETIC_PRIVATE_DISCONNECT') });
  const order = [];
  disconnected.input.finalize = async facts => { order.push('finalize'); assert.equal(facts.signal.aborted, true); throw null; };
  disconnected.input.finalize.abort = async () => { order.push('abort'); };
  const incomplete = await trackedCapture(disconnected);
  assert.deepEqual(order, ['abort', 'finalize']); assert.equal(incomplete.capture_diagnostics.stream_closed, false);
  assert.equal(incomplete.capture_diagnostics.pending_steps, 1); assert.equal(incomplete.capture_diagnostics.upstream_cause, 'unknown');
  assert.equal(incomplete.final_text, 'Retained answer'); assert.equal(incomplete.usage.cost_usd, null);
  assert.doesNotMatch(JSON.stringify(incomplete.capture_diagnostics), /SYNTHETIC_PRIVATE/);
});

test('explicit provider error records its observed event class but never its hostile message in capture telemetry', async t => {
  const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'step_start', sessionID: 'ses_fixture' },
    { type: 'text', part: { text: 'Retained answer' } }, { type: 'error', error: { message: 'SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD' } })] });
  const order = [];
  fixture.input.finalize = async facts => { order.push('finalize'); assert.equal(facts.signal.aborted, true); throw new Error('fixture_no_guard'); };
  fixture.input.finalize.abort = async () => { order.push('abort'); };
  const result = await trackedCapture(fixture);
  assert.deepEqual(order, ['abort', 'finalize']); assert.equal(result.capture_diagnostics.provider_errors, 1);
  assert.equal(result.capture_diagnostics.events.at(-1).type, 'error'); assert.equal(result.capture_diagnostics.upstream_cause, 'unknown');
  assert.doesNotMatch(JSON.stringify(result.capture_diagnostics), /SYNTHETIC_PRIVATE/);
  assert.equal(result.usage.cost_usd, null); assert.equal(result.safety_failure, true);
});

test('capture diagnostics cap event records and bytes, omit text/secrets, and an observer failure cannot prevent terminal publication', async t => {
  const secret = 'SYNTHETIC_PRIVATE_OBSERVATION', events = Array.from({ length: 90 }, () => ({ type: 'text', sessionID: secret,
    headers: { Authorization: secret }, part: { text: secret, messageID: secret } }));
  events.push({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0 } });
  const fixture = captureFixture(t, { stdout: [eventBytes(...events)] }), factory = fixture.input.launcherFactory;
  fixture.input.launcherFactory = (...args) => ({ ...factory(...args), observeCapture() { throw new Error(secret); } });
  const result = await trackedCapture(fixture), d = result.capture_diagnostics;
  assert.equal(d.bridge_observation_failed, true); assert.equal(d.events.length, 64); assert.equal(d.events_dropped, 27); assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 16384); assert.doesNotMatch(JSON.stringify(d), /SYNTHETIC_PRIVATE|Authorization/);
  assert.equal(d.session_sha256, sha256(secret)); assert.equal(d.message_sha256, sha256(secret));
  assert.equal(result.cleanup.confirmed, true); assert.equal(fixture.state.cleanupCalls, 1);
  assert.deepEqual(JSON.parse(readFileSync(result.episode_path, 'utf8')), result);
});

test('finalizer RPC-error fixture preserves clean CLI observations but cannot claim native wait or upstream cause', async t => {
  const fixture = captureFixture(t, { stdout: [eventBytes({ type: 'step_start', sessionID: 'ses_fixture' },
    { type: 'text', part: { text: 'Retained answer' } }, { type: 'step_finish', part: { reason: 'stop', tokens: { input: 2, output: 1 }, cost: 0.01 } })] });
  fixture.input.finalize = async () => { throw new Error('SYNTHETIC_PRIVATE_GUARD_RPC_ERROR'); };
  fixture.input.finalize.abort = async () => {};
  const result = await trackedCapture(fixture), d = result.capture_diagnostics;
  assert.equal(d.native_closure_clean, true); assert.equal(d.finalization, 'finalization_failed');
  assert.equal(d.native_wait, 'unknown; only owned bridge can observe'); assert.equal(d.upstream_cause, 'unknown');
  assert.equal(d.provider_errors, 0); assert.equal(result.usage.cost_usd, null); assert.equal(result.usage.known_subtotal.cost_usd, 0.01);
  assert.equal(result.identity_validation.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(d), /SYNTHETIC_PRIVATE/);
});
