import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, json, loadProfiles, serialize } from '../lib.mjs';
import { assertPreparedWorkspace, executeEpisode, main, parseOutput, prepareEpisode, sanitizeTask } from '../adapters/opencode.mjs';
import { auditInventory, F_CORE_TOOLS, normalizePermissions, STATIC_BLOCKER } from '../adapters/inventory-audit.mjs';

const profiles = loadProfiles();
const task = json(path.join(ROOT, 'fixtures/tasks.json'))[2];
const model = 'test/no-inference';
const dirtyTask = {
  ...task, grading: { secret: 'PRIVATE_GRADER_SENTINEL' }, correct_final: { text: 'PRIVATE_FINAL_SENTINEL' },
  excerpts: [
    ...task.excerpts,
    { document: 'secret', locator: 'private', text: 'PRIVATE_EXCERPT_SENTINEL', private: true },
    { document: 'secret', locator: 'private', text: 'PRIVATE_EXCERPT_SENTINEL', visibility: 'private' },
    { document: 'secret', locator: 'private', text: 'PRIVATE_EXCERPT_SENTINEL', public: false },
  ],
};
function prepare(t, profile = profiles[0], input = dirtyTask) {
  const plan = prepareEpisode({ task: input, profile, model, executable: 'opencode', environment: {
    PATH: process.env.PATH, SECRET_SENTINEL: 'do not inherit', OPENCODE_CONFIG: 'global-config',
    OPENCODE_CONFIG_CONTENT: 'global-override', NODE_OPTIONS: 'injected-code', MATH_BENCH_ALLOW_EXECUTE: '1',
  } });
  t.after(() => rmSync(plan.workspace, { recursive: true, force: true }));
  return plan;
}
const auditFor = plan => ({ status: 'passed', guarantee: 'runtime-verified', runtime_verified: true, supported: true,
  isolation_verified: true, profile: plan.condition_id, workspace: plan.workspace, workspace_tree: plan.hashes.workspace_tree,
  cleanup: true, observed_tools: [...plan.requested_tools, ...plan.core_tools, ...plan.transport_tools] });
const validOutput = final => [
  { type: 'step_start', part: { messageID: 'assistant-final' } },
  { type: 'text', part: { messageID: 'assistant-final', text: JSON.stringify(final) } },
  { type: 'step_finish', part: { messageID: 'assistant-final', reason: 'stop', tokens: { input: 10, output: 5 }, cost: 0.01 } },
].map(JSON.stringify).join('\n') + '\n';

for (const profile of profiles) test(`[adapter] ${profile.id} isolated dry-run inventory and public-only workspace`, async t => {
  const plan = prepare(t, profile);
  assertPreparedWorkspace(plan);
  assert.deepEqual(plan.requested_tools, profile.effective_tools);
  assert.deepEqual(plan.effective_tools, profile.id === 'B' ? profile.effective_tools : null);
  assert.equal(plan.inventory_status, profile.id === 'B' ? 'staged-plugin-exact' : 'unverified');
  assert.equal(plan.inventory_supported, profile.id === 'B');
  assert.equal(plan.runtime_inventory_status, 'unverified');
  assert.equal(plan.supported, false);
  assert.equal(plan.isolation.os_sandbox, false);
  assert.deepEqual(json(path.join(plan.workspace, 'profile.json')), profile);
  assert.equal(existsSync(path.join(plan.workspace, 'corpus/excerpts.json')), profile.id !== 'A');
  for (const name of ['task.json', ...(profile.id === 'A' ? [] : ['corpus/excerpts.json'])]) {
    const text = readFileSync(path.join(plan.workspace, name), 'utf8');
    assert.doesNotMatch(text, /PRIVATE_.*_SENTINEL|correct_final|grading/);
  }
  assert.ok(!Object.keys(plan.files).some(name => /(^|\/)(?:graders?|answers?|correct_final)(?:\.|\/|$)/i.test(name)));
  assert.equal(plan.environment.HOME, path.join(plan.workspace, 'home'));
  assert.equal(plan.environment.XDG_DATA_HOME, path.join(plan.workspace, 'home/data'));
  for (const key of ['SECRET_SENTINEL', 'OPENCODE_CONFIG_CONTENT', 'NODE_OPTIONS', 'MATH_BENCH_ALLOW_EXECUTE', 'Path']) assert.equal(plan.environment[key], undefined);
  assert.equal(plan.environment.OPENCODE_CONFIG_DIR, path.join(plan.workspace, 'home/config'));
  assert.equal(plan.environment.OPENCODE_CONFIG, path.join(plan.workspace, '.opencode/opencode.json'));
  assert.equal(plan.environment.OPENCODE_CONFIG_PROJECT_DISABLE, undefined);
  assert.equal(plan.command.shell, false);
  assert.deepEqual(plan.command.args.slice(0, 9), ['run', '--model', model, '--agent', 'benchmark', '--format', 'json', '--standalone', '--']);
  assert.ok(!plan.command.args.some(arg => ['--auto', '--continue', '--session', '--server'].includes(arg)));
  if (profile.id === 'F') {
    assert.equal(plan.requested_tools.length, 16);
    assert.ok(existsSync(path.join(plan.workspace, plan.plugin)));
    assert.deepEqual(plan.config.plugins, []);
    assert.deepEqual(plan.transport_tools, ['execute']);
    assert.deepEqual(plan.core_tools, F_CORE_TOOLS);
    assert.ok(existsSync(path.join(plan.workspace, 'node_modules/@opencode/plugin/package.json')));
    assert.ok(existsSync(path.join(plan.workspace, 'node_modules/unpdf/package.json')));
    assert.ok(!existsSync(path.join(plan.workspace, '.opencode/plugins/math-toolkit/data/math-index.json')));
    assert.ok(!existsSync(path.join(plan.workspace, 'math')));
    const loaded = await import(pathToFileURL(path.join(plan.workspace, plan.plugin)).href);
    const registered = [];
    await loaded.default.setup({ location: { directory: plan.workspace }, tool: { transform: async callback => callback({ add: tool => registered.push(tool.name) }) } });
    assert.deepEqual(registered.sort(), [...profile.effective_tools].sort(), 'local plugin registers exactly 16 tools without invoking them');
  } else if (profile.id === 'A') {
    assert.equal(plan.plugin, null);
    assert.ok(!existsSync(path.join(plan.workspace, '.opencode/plugins')));
    assert.ok(!plan.requested_tools.some(tool => tool.startsWith('math_')));
    assert.ok(!JSON.stringify(plan.config).includes('math_'));
  }
  if (profile.id === 'B') {
    assert.ok(plan.diagnostics.some(reason => reason.includes('exact four-tool')));
    assert.ok(!JSON.stringify(plan.config).includes('shell'));
    assert.ok(!JSON.stringify(plan.config).includes('math_'));
    assert.deepEqual(plan.transport_tools, ['execute']);
    assert.deepEqual(plan.config.plugins, []);
    assert.deepEqual(plan.config.agents.benchmark.permissions, [
      { action: '*', resource: '*', effect: 'deny' },
      ...[...profile.effective_tools, 'execute'].map(action => ({ action, resource: '*', effect: 'allow' })),
    ]);
    assert.ok(!existsSync(path.join(plan.workspace, '.opencode/plugins/math-toolkit.js')));
    assert.equal(readFileSync(path.join(plan.workspace, '.opencode/plugins/generic/compute.py'), 'utf8'),
      readFileSync(path.resolve(ROOT, '../../.opencode/plugins/math-toolkit/scripts/math_compute.py'), 'utf8'));
    const loaded = await import(pathToFileURL(path.join(plan.workspace, plan.plugin)).href);
    const tools = [];
    await loaded.default.setup({ location: { directory: plan.workspace }, tool: { transform: async callback => callback({ add: tool => tools.push(tool) }) } });
    assert.deepEqual(tools.map(tool => tool.name), profile.effective_tools);
    assert.ok(tools.every(tool => tool.options.codemode && !/shell|math_/.test(tool.name)));
    const search = JSON.parse((await tools[0].execute({ query: 'triangle' })).content);
    assert.equal(search.excerpts[0].document, 'toy-geometry');
    assert.ok(!JSON.stringify(search).includes('PRIVATE_'));
    const forbidden = JSON.parse((await tools[1].execute({ document: '../grader.json', locator: 'private' })).content);
    assert.equal(forbidden.status, 'rejected');
    assert.throws(() => executeEpisode(plan, { allowExecution: true, invoke: () => assert.fail('No model invocation allowed') }), /unsupported-profile/);
  }
});

test('[adapter] each episode is fresh; unexpected grader files and payload tampering fail', t => {
  const one = prepare(t), two = prepare(t);
  assert.notEqual(one.workspace, two.workspace);
  writeFileSync(path.join(one.workspace, 'grader.json'), '{}');
  assert.throws(() => assertPreparedWorkspace(one), /unexpected file grader/);
  writeFileSync(path.join(two.workspace, 'task.json'), '{}');
  assert.throws(() => assertPreparedWorkspace(two), /changed file task/);
});

test('[adapter] task sanitation rejects unsafe ids and drops nested private metadata', () => {
  assert.throws(() => sanitizeTask({ ...task, id: '../escape' }), /Invalid task id/);
  assert.throws(() => sanitizeTask({ ...task, private: true }), /marked private/);
  const clean = sanitizeTask({ ...dirtyTask, answer_contract: { type: 'citation', grading: 'private', fields: ['document'] } });
  assert.equal(clean.excerpts.length, task.excerpts.length);
  assert.deepEqual(clean.answer_contract, { type: 'citation', fields: ['document'] });
});

test('[adapter] execute requires independent authorization and exact isolation audit; never invokes mock on refusal', async t => {
  const plan = prepare(t);
  let calls = 0;
  const invoke = () => { calls++; throw new Error('unexpected invocation'); };
  assert.throws(() => executeEpisode(plan, { invoke, audit: auditFor(plan) }), /execution_not_authorized/);
  assert.throws(() => executeEpisode(plan, { invoke, allowExecution: true }), /unsupported-profile/);
  assert.throws(() => executeEpisode(plan, { invoke, allowExecution: true, audit: { ...auditFor(plan), observed_tools: ['shell'] } }), /unsupported-profile/);
  assert.throws(() => executeEpisode(plan, { invoke, allowExecution: true, audit: { ...auditFor(plan), workspace_tree: 'other-plan' } }), /unsupported-profile/);
  await assert.rejects(main(['--execute', '--profile', 'A', '--task', task.id, '--model', model, '--out', 'unused'], {}), /execution_not_authorized/);
  assert.equal(calls, 0);
});

test('[adapter] mocked execution retains capture; typed final is candidate, never trusted formal receipt', t => {
  const plan = prepare(t, profiles[0], { ...task, type: 'formal' });
  let calls = 0;
  const final = { type: 'formal', source: 'theorem demo : True := by trivial' };
  const candidate = executeEpisode(plan, { allowExecution: true, audit: auditFor(plan), invoke: (executable, args, options) => {
    calls++;
    assert.equal(executable, 'opencode');
    assert.deepEqual(args, plan.command.args);
    assert.equal(options.cwd, plan.workspace);
    assert.equal(options.shell, false);
    assert.equal(options.env.SECRET_SENTINEL, undefined);
    return { status: 0, stdout: validOutput(final), stderr: 'mock diagnostic' };
  } });
  assert.equal(calls, 1);
  assert.equal(candidate.status, 'candidate_ready');
  assert.deepEqual(candidate.final, final);
  assert.deepEqual(candidate.verification, { status: 'pending', receipt: null });
  assert.equal(candidate.graded, false);
  assert.equal(candidate.stderr, 'mock diagnostic');
  assert.equal(candidate.usage[0].tokens.input, 10);
  const earlier = JSON.stringify({ type: 'text', part: { messageID: 'assistant-earlier', text: 'Interim prose, not the final.' } }) + '\n';
  assert.deepEqual(parseOutput(earlier + validOutput(final)).final, final);
  const noFinish = JSON.stringify({ type: 'step_start', part: { messageID: 'assistant-final' } }) + '\n'
    + JSON.stringify({ type: 'text', part: { messageID: 'assistant-final', text: JSON.stringify(final) } }) + '\n';
  const parsedNoFinish = parseOutput(noFinish);
  assert.equal(parsedNoFinish.status, 'candidate_ready');
  assert.deepEqual(parsedNoFinish.final, final);
  assert.equal(parsedNoFinish.usage, null);
  assert.equal(parsedNoFinish.usage_source, 'unavailable-no-step-finish');
  assert.equal(parseOutput(validOutput(final).replace('"messageID":"assistant-final","reason"', '"messageID":"unrelated","reason"')).status, 'extraction_failure');
});

test('[adapter] parse failures and nonzero exits never become successful candidates', t => {
  const plan = prepare(t);
  for (const stdout of ['', 'not json', '{"type":"text","part":{"text":"answer"}}\n', '{"type":"step_finish","part":{"reason":"stop"}}\n', validOutput({ no_type: true }), validOutput({ type: 'numeric', value: 3 }) + '{"type":"error"}\n']) {
    const candidate = executeEpisode(plan, { allowExecution: true, audit: auditFor(plan), invoke: () => ({ status: 0, stdout, stderr: '' }) });
    assert.equal(candidate.status, 'extraction_failure');
    assert.equal(candidate.final, null);
    assert.equal(candidate.stdout, stdout);
  }
  const failed = executeEpisode(plan, { allowExecution: true, audit: auditFor(plan), invoke: () => ({ status: 1, stdout: validOutput({ type: 'numeric', value: 3 }), stderr: 'failed' }) });
  assert.equal(failed.status, 'execution_failure');
  assert.equal(failed.final, null);
  assert.equal(parseOutput(validOutput({ type: 'numeric', value: 3 }) + '{"type":"text","part":{"text":"late"}}').status, 'extraction_failure');
});

test('[adapter] --tasks default dry-run prints command/config without CLI invocation; unsupported exit is explicit', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'math-adapter-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tasksPath = path.join(root, 'tasks.json');
  writeFileSync(tasksPath, serialize([dirtyTask]));
  const output = [];
  const log = console.log;
  console.log = value => output.push(JSON.parse(value));
  try {
    const status = await main(['--profile', 'A', '--tasks', tasksPath, '--model', model, '--out', path.join(root, 'out')], { PATH: '' });
    assert.equal(status, 2);
  } finally { console.log = log; }
  assert.equal(output.length, 1);
  t.after(() => rmSync(output[0].workspace, { recursive: true, force: true }));
  assert.equal(output[0].mode, 'dry-run');
  assert.equal(output[0].supported, false);
  assert.ok(existsSync(output[0].manifest));
  assert.deepEqual(output[0].config.agents.benchmark.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
});

function mockProbe(plan, response, cleanup = () => {}) {
  return { result: response ?? Promise.resolve({
    plugin: plan.plugin ? pathToFileURL(path.join(plan.workspace, plan.plugin)).href : null,
    tools: [...plan.requested_tools],
  }), close: cleanup };
}

for (const profile of profiles) test(`[audit] ${profile.id} exact mocked registrations pass only static-equivalent; execution remains blocked`, async t => {
  const plan = prepare(t, profile);
  let cleaned = 0;
  const audit = await auditInventory(plan, { checkWorkspace: assertPreparedWorkspace,
    startProbe: staged => mockProbe(staged, undefined, () => { cleaned++; }) });
  assert.equal(audit.status, 'passed');
  assert.equal(audit.guarantee, 'static-equivalent');
  assert.equal(audit.runtime_verified, false);
  assert.deepEqual(audit.observed_tools, [...profile.effective_tools, ...plan.core_tools, ...plan.transport_tools].sort());
  assert.equal(audit.cleanup, true);
  assert.equal(cleaned, 1);
  assert.equal(audit.execution_blocker, STATIC_BLOCKER);
  assert.throws(() => executeEpisode(plan, { allowExecution: true, audit, invoke: () => assert.fail('No inference') }), /static-equivalent: no supported session-free/);
});

test('[audit] mocked extra/missing tools, host plugin, plugin failure, missing response, timeout and cleanup failure close the probe', async t => {
  const plan = prepare(t, profiles[1]);
  const plugin = pathToFileURL(path.join(plan.workspace, plan.plugin)).href;
  const cases = [
    ['extra', () => Promise.resolve({ plugin, tools: [...plan.requested_tools, 'math_search'] }), /extra or missing/],
    ['missing', () => Promise.resolve({ plugin, tools: plan.requested_tools.slice(1) }), /extra or missing/],
    ['host plugin', () => Promise.resolve({ plugin: 'file:///host/plugin.mjs', tools: plan.requested_tools }), /invalid staged/],
    ['plugin failure', () => Promise.reject(new Error('plugin_load_error: mock setup failed')), /plugin_load_error/],
    ['missing endpoint/response', () => Promise.resolve({}), /invalid staged/],
    ['timeout', () => new Promise(() => {}), /timeout/],
    ['cleanup', () => Promise.resolve({ plugin, tools: plan.requested_tools }), /cleanup failed/],
  ];
  for (const [name, result, error] of cases) {
    let cleaned = 0;
    const audit = await auditInventory(plan, { checkWorkspace: assertPreparedWorkspace, timeoutMs: 10,
      startProbe: staged => mockProbe(staged, result(), () => { cleaned++; if (name === 'cleanup') throw new Error('cleanup failed'); }) });
    assert.equal(audit.status, 'failed', name);
    assert.equal(audit.runtime_verified, false);
    assert.match(audit.error, error);
    assert.equal(cleaned, 1);
    assert.equal(audit.cleanup, name !== 'cleanup');
    assertPreparedWorkspace(plan);
  }
});

test('[audit] permissions use last-match-wins and reject open-ended/unknown permissions', () => {
  const deny = { action: '*', resource: '*', effect: 'deny' };
  const allow = { action: 'read', resource: '*', effect: 'allow' };
  assert.deepEqual(normalizePermissions([deny, allow], ['read', 'shell']), ['read']);
  assert.deepEqual(normalizePermissions([deny, allow, deny], ['read', 'shell']), []);
  assert.deepEqual(normalizePermissions([deny, allow, { ...deny, action: 'r*' }], ['read', 'shell']), []);
  assert.throws(() => normalizePermissions([{ ...deny, effect: 'allow' }], ['read']), /unbounded/);
  assert.throws(() => normalizePermissions([deny, { ...allow, action: 'unexpected' }], ['read']), /unknown allow/);
  assert.throws(() => normalizePermissions([deny, { ...allow, resource: '/somewhere' }], ['read']), /scope/);
});

test('[audit] tampered staging refuses before loading a plugin', async t => {
  const plan = prepare(t);
  writeFileSync(path.join(plan.workspace, '.opencode/opencode.json'), '{}');
  const audit = await auditInventory(plan, { checkWorkspace: assertPreparedWorkspace, startProbe: () => assert.fail('Must not load') });
  assert.equal(audit.status, 'failed');
  assert.match(audit.error, /changed file/);
});

test('[audit] --audit with --dry-run exits blocked, writes evidence and removes the workspace', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'math-audit-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = [];
  let workspace, cleaned = 0;
  const log = console.log;
  console.log = value => output.push(JSON.parse(value));
  try {
    const status = await main(['--audit', '--dry-run', '--profile', 'B', '--task', task.id, '--model', model, '--out', root], { PATH: '' }, {
      startProbe: plan => { workspace = plan.workspace; return mockProbe(plan, undefined, () => { cleaned++; }); },
    });
    assert.equal(status, 2);
  } finally { console.log = log; }
  assert.equal(output.length, 1);
  assert.equal(output[0].status, 'passed');
  assert.equal(cleaned, 1);
  assert.equal(existsSync(workspace), false);
  const saved = json(path.join(root, path.basename(workspace), 'audit.json'));
  assert.equal(saved.guarantee, 'static-equivalent');
  assert.equal(saved.runtime_verified, false);
  await assert.rejects(main(['--audit', '--execute']), /exits without inference/);
});
