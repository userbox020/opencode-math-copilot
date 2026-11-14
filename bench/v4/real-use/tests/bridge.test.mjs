import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AGENT, SYSTEM, TITLE, PLUGIN_ID, DISPATCH_PROOF, HOOK_REVIEW, DEFINITIONS, SOURCE_TOOL_MAPPING, hash, namesFor, permissionsFor, createRuntimePlugin, inspectInventory, inspectContext, verifyFrozenAssets, makeRequestTemplate, withModelIdentity, WORKTREE_FRAGMENT, diagnosticShape, validDiagnosticShape, nativeMessageID, withNativeMessage } from '../runtime-plugin.js';
import { cleanEnvironment, nativeConfig, stageAudit, APPROVED_TEMP } from '../stage.mjs';
import { validateAuditEnvelope, inspectConfigEntries, validateBuiltinRegistry, contextSubmissionGate, summarizeSessionLog, checkLogTransport, createLiveCapture, createSSEDecoder, monitorSessionLog, verifyAbortCertificate, validateNativeStore, isOwnedBridge, nativePromptBytes } from '../bridge.mjs';
import { BASELINE_DEFINITIONS, NAVIGATION_DEFINITIONS } from '../runtime-tools.mjs';
import { GENERIC_DEFINITIONS } from '../lib/snapshot-tools.mjs';
import { createLiveGate, projectNativeHistory, normalizeHistory, MODEL_REF } from '../runtime-plugin.js';
import { ADMISSION_API } from '../bridge.mjs';
import { BRIDGE_API, consumeEpisodeCapability } from '../admission.mjs';
import { cleanupOwnedCLI, createSolverDeadline, validateFinishIdentity, createProductionDiagnostics, projectGuardDiagnostics, diagnosticReason } from '../bridge.mjs';
import { createRouteEnvelopeProbe, readRouteEnvelopeJSON, createNativeCorrespondence } from '../bridge.mjs';
import { isFinalizationReceipt, consumeFinalizationReceipt } from '../admission.mjs';

// All fixture output remains in newly owned approved-temp directories; no cleanup of others' work.
const root = mkdtempSync(path.join(APPROVED_TEMP, 'real-use-bridge-g004-tests-'));
const runtimeHash = hash(readFileSync(fileURLToPath(new URL('../runtime-plugin.js', import.meta.url))));
function fixture(condition = 'plugin-off') {
  const entryPath = path.join(root, `${randomUUID()}.js`), configPath = path.join(root, `${randomUUID()}.json`);
  writeFileSync(entryPath, '// fixture\n', { flag: 'wx' });
  writeFileSync(configPath, '{}\n', { flag: 'wx' });
  const options = { condition, nonce: randomUUID(), entryPath, configPath, config_sha256: hash('{}\n'), runtime_sha256: runtimeHash,
    cli_sha256: 'a'.repeat(64), project_sha256: 'b'.repeat(64), snapshot_sha256: null,
    approvedPlugins: [{ id: PLUGIN_ID, source_type: 'local', source_sha256: hash('// fixture\n') }] };
  const hooks = new Map(), tools = new Map([['execute', { id: 'execute', name: 'execute' }], ['shell', { id: 'shell', name: 'shell' }]]);
  const agents = new Map([[AGENT, { id: AGENT }], ['build', { id: 'build' }]]);
  const plugins = [{ id: PLUGIN_ID, source: { type: 'local', path: entryPath }, state: { status: 'active' } }];
  let rpc, bind, pending, bindLiveMessage, setupDone = false;
  const registration = () => Promise.resolve({ dispose: async () => {} });
  const ctx = { app: { version: '2.0.29' },
    model: { list: async () => ({ data: [{ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'Fixture model display' }] }) },
    session: { hook: async (name, callback) => { hooks.set(name, callback); return registration(); } },
    permission: { hook: async (name, callback) => { hooks.set(`permission.${name}`, callback); return registration(); } },
    agent: { transform: async callback => { callback({ list: () => [...agents.values()], remove: id => agents.delete(id), update: (id, update) => { if (agents.has(id)) update(agents.get(id)); }, default: () => {} }); return registration(); }, list: async () => ({ location: { directory: root }, data: [...agents.values()] }) },
    tool: { transform: async callback => { callback({ list: () => [...tools.values()], remove: id => tools.delete(id), add: tool => tools.set(tool.name, { ...tool, id: tool.name }) }); return registration(); }, list: async () => { assert.equal(setupDone, true, 'no list during boot'); return [...tools.values()]; } },
    plugin: { list: async () => ({ location: { directory: root }, data: plugins }) },
    rpc: { register: async (definition, handlers) => { assert.equal(definition.id, 'real-use-audit'); assert.deepEqual(Object.keys(handlers).sort(), ['armEpisode', 'audit', 'bindContext', 'bindEpisodeContext', 'bindLiveMessage', 'episodeStatus', 'pending', 'revokeEpisode', 'sealEpisode']); rpc = handlers.audit; bind = handlers.bindContext; pending = handlers.pending; bindLiveMessage = handlers.bindLiveMessage; return registration(); } },
  };
  return { options, ctx, hooks, tools, agents, plugins, async setup(extra = {}) {
    const plugin = createRuntimePlugin({ define: value => value }, { ...options, ...extra });
    await plugin.setup(ctx); setupDone = true;
    return Object.assign(request => rpc(request ?? { nonce: options.nonce }), { bindContext: request => bind(request), pending: request => pending(request), bindLiveMessage: request => bindLiveMessage(request) });
  } };
}

const probeSID = 'ses_fixture_probe';
const probeRoutes = [`/api/session/${probeSID}`, `/api/session/${probeSID}/message?order=asc&limit=200`,
  `/api/session/${probeSID}/inbox`, `/api/session?parentID=${probeSID}&limit=1`];
const probeNames = ['session_detail', 'message_page', 'inbox', 'children'];
const probeBodies = () => [{ data: { id: probeSID, time: { created: 1 }, title: 'private value' } },
  { data: [], cursor: {} }, { data: [] }, { data: [{ id: 'ses_child' }], cursor: {} }];
function routeProbeFixture(bodies = probeBodies(), responseFor) {
  const calls = [];
  const probe = createRouteEnvelopeProbe((route, init) => {
    calls.push({ route, method: init.method });
    return readRouteEnvelopeJSON('http://127.0.0.1:12345', route, 'fixture', init, async (url, request) => {
      const index = probeRoutes.indexOf(route);
      assert.ok(index >= 0); assert.equal(request.method, 'GET'); assert.equal(request.body, undefined);
      assert.equal(url.searchParams.get('location[directory]'), 'fixture');
      return responseFor ? responseFor(index, request) : new Response(JSON.stringify(bodies[index]), { headers: { 'Content-Type': 'application/json' } });
    });
  }, () => probeSID);
  return { probe, calls };
}

test('route envelope probe returns exactly four frozen key/count projections from exactly four GETs', async () => {
  const f = routeProbeFixture(), value = await f.probe();
  assert.deepEqual(value, {
    session_detail: { ok: true, data_keys: ['id', 'time', 'title'] },
    message_page: { ok: true, data_length: 0, cursor_exists: true, cursor_next_present: false, cursor_keys: [] },
    inbox: { ok: true, data_length: 0 },
    children: { ok: true, data_length: 1, cursor_next_present: false, foreign_rows: 1 },
  });
  assert.deepEqual(f.calls, probeRoutes.map(route => ({ route, method: 'GET' })));
  assert.ok(Object.isFrozen(value));
  for (const row of Object.values(value)) assert.ok(Object.isFrozen(row));
  assert.ok(Object.isFrozen(value.session_detail.data_keys)); assert.ok(Object.isFrozen(value.message_page.cursor_keys));
  assert.doesNotMatch(JSON.stringify(value), /private value|ses_fixture|ses_child|created/);
  assert.equal(isOwnedBridge(value), false); assert.equal(isFinalizationReceipt(value), false);
  assert.equal(consumeFinalizationReceipt(value, { episode_id: 'fixture' }, hash('prompt')), false);
});

test('route envelope key names are sorted, unique, capped and exclude invalid and identifier-like names', async () => {
  const bodies = probeBodies();
  bodies[0].data = JSON.parse('{"ses_secret":"secret value","msg_secret":"secret value","bad-key":"secret value","9bad":"secret value","z":"secret value","a":"secret value"}');
  bodies[1].cursor = { msg_secret: 'secret value', ses_secret: 'secret value', next: 'private cursor', previous: 'private cursor' };
  const value = await routeProbeFixture(bodies).probe();
  assert.deepEqual(value.session_detail.data_keys, ['a', 'z']);
  assert.deepEqual(value.message_page.cursor_keys, ['next', 'previous']);
  assert.doesNotMatch(JSON.stringify(value), /secret|private cursor/);
  bodies[0].data = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key_${String(i).padStart(3, '0')}`, 'discarded']));
  bodies[0].data['x'.repeat(65)] = 'discarded'; bodies[1].cursor = bodies[0].data;
  const capped = await routeProbeFixture(bodies).probe();
  for (const keys of [capped.session_detail.data_keys, capped.message_page.cursor_keys]) {
    assert.equal(keys.length, 64); assert.equal(new Set(keys).size, 64);
    assert.deepEqual(keys, [...keys].sort()); assert.ok(keys.every(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)));
  }
});

test('route envelope cursor flags use own-property presence, never truthiness', async () => {
  for (const next of [null, false, '', 0, undefined]) {
    const bodies = probeBodies(); bodies[1] = { data: [], cursor: { next } }; bodies[3].cursor = { next };
    // Direct parsed-data fixture also covers an own undefined property, which JSON cannot encode.
    const probe = createRouteEnvelopeProbe(async route => bodies[probeRoutes.indexOf(route)], () => probeSID);
    const value = await probe();
    assert.equal(value.message_page.cursor_exists, true); assert.equal(value.message_page.cursor_next_present, true);
    assert.deepEqual(value.message_page.cursor_keys, ['next']); assert.equal(value.children.cursor_next_present, true);
  }
  const bodies = probeBodies();
  bodies[1] = Object.assign(Object.create({ cursor: { next: 'inherited' } }), { data: [] });
  bodies[3].cursor = Object.create({ next: 'inherited' });
  const value = await createRouteEnvelopeProbe(async route => bodies[probeRoutes.indexOf(route)], () => probeSID)();
  assert.deepEqual(value.message_page, { ok: true, data_length: 0, cursor_exists: false, cursor_next_present: false, cursor_keys: [] });
  assert.equal(value.children.cursor_next_present, false);
});

test('route envelope children count foreign IDs without returning them and reject unbounded or malformed data', async () => {
  const bodies = probeBodies(); bodies[3].data = [{ id: probeSID }, { id: 'ses_other' }, { id: 'ses_another' }];
  assert.deepEqual((await routeProbeFixture(bodies).probe()).children,
    { ok: true, data_length: 3, cursor_next_present: false, foreign_rows: 2 });
  for (const data of [null, {}, [null], [{}], Array.from({ length: 201 }, () => ({ id: 'ses_other' }))]) {
    bodies[3].data = data;
    assert.deepEqual((await routeProbeFixture(bodies).probe()).children, { ok: false, error_code: 'route_shape_error' });
  }
  bodies[3].data = Array.from({ length: 200 }, () => ({ id: 'ses_other' }));
  assert.equal((await routeProbeFixture(bodies).probe()).children.foreign_rows, 200);
});

test('route envelope failures are isolated and closed-coded without raw HTTP/JSON/transport leakage', async () => {
  const hostile = 'secret endpoint headers body stack';
  const scenarios = [
    ['route_http_error', () => new Response(hostile, { status: 503, headers: { 'Content-Type': 'text/html' } })],
    ['route_json_error', () => new Response(hostile, { headers: { 'Content-Type': 'application/json' } })],
    ['route_json_error', () => new Response('{"data":[]}', { headers: { 'Content-Type': 'text/plain' } })],
    ['route_shape_error', () => new Response('{"data":"secret endpoint headers body stack"}', { headers: { 'Content-Type': 'application/json' } })],
    ['route_shape_error', () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })],
    ['route_transport_error', () => { throw new Error(hostile); }],
    ['route_transport_error', () => { throw { get message() { throw new Error(hostile); } }; }],
    ['route_timeout', () => { throw new DOMException(hostile, 'TimeoutError'); }],
  ];
  for (const [expected, respond] of scenarios) for (let bad = 0; bad < 4; bad++) {
    const bodies = probeBodies(), f = routeProbeFixture(bodies, index => index === bad ? respond()
      : new Response(JSON.stringify(bodies[index]), { headers: { 'Content-Type': 'application/json' } }));
    const value = await f.probe();
    assert.deepEqual(value[probeNames[bad]], { ok: false, error_code: expected });
    assert.ok(probeNames.filter((_, i) => i !== bad).every(name => value[name].ok));
    assert.doesNotMatch(JSON.stringify(value), /secret|endpoint|headers|body|stack|http:\/\//);
    assert.equal(f.calls.length, 4);
  }
});

test('route envelope probe is one-use, lifecycle-scoped, bounded on hung reads and cannot mutate guard/correspondence', async () => {
  let lifecycle = 'audit', dispatched = false, calls = 0;
  const guard = Object.freeze({ phase: 'armed', released: 0, model_requests: 0 });
  const correspondence = createNativeCorrespondence({ sessionID: probeSID, incarnation: 'fixture', promptSha256: hash('prompt'), createdAt: 1, condition: 'plugin-off' });
  const before = correspondence.snapshot(), bodies = probeBodies();
  const probe = createRouteEnvelopeProbe(async route => { calls++; return bodies[probeRoutes.indexOf(route)]; },
    () => lifecycle === 'admitted' && !dispatched ? probeSID : null);
  await assert.rejects(probe(), { message: 'live_route_probe_ineligible' }); assert.equal(calls, 0);
  lifecycle = 'admitted'; const first = probe();
  await assert.rejects(probe(), { message: 'live_route_probe_reused' }); await first;
  await assert.rejects(probe(), { message: 'live_route_probe_reused' }); assert.equal(calls, 4);
  dispatched = true;
  await assert.rejects(probe(), { message: 'live_route_probe_ineligible' }); assert.equal(calls, 4);
  assert.deepEqual(guard, { phase: 'armed', released: 0, model_requests: 0 }); assert.deepEqual(correspondence.snapshot(), before);
  let signal, hungCalls = 0;
  const hung = createRouteEnvelopeProbe((_route, init) => { hungCalls++; signal = init.signal; return new Promise(() => {}); }, () => probeSID, 10);
  assert.deepEqual(await hung(), Object.fromEntries(probeNames.map(name => [name, { ok: false, error_code: 'route_timeout' }])));
  assert.equal(hungCalls, 4); assert.equal(signal.aborted, true);
  await assert.rejects(hung(), { message: 'live_route_probe_reused' });
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /const probeRouteEnvelopes = createRouteEnvelopeProbe\(\(route, init\) => owned\.ready\.then\(base => owned\.json\(base, route, init, true\)\),\s*\(\) => !cleanup && lifecycle === 'admitted' && !dispatched \? sessionID : null\)/);
  assert.match(source, /const handle = Object\.freeze\(\{[^\n]*\n\s*probeRouteEnvelopes,/);
});

test('native config uses supported V2 fields and exact deny/allow rules', () => {
  for (const condition of ['plugin-off', 'plugin-on']) {
    const config = nativeConfig(condition, path.join(root, 'entry.js'));
    assert.deepEqual(config.model, { providerID: 'opencode-go', model: 'deepseek-v4.1-flash', variant: 'default' });
    assert.equal(config.default_agent, AGENT);
    assert.deepEqual(config.permissions[0], { action: '*', resource: '*', effect: 'deny' });
    assert.deepEqual(config.permissions.at(-1), { action: 'execute', resource: '*', effect: 'deny' });
    assert.deepEqual(config.permissions.slice(1, -1).map(rule => rule.action), namesFor(condition));
    assert.equal(config.warming, false); assert.equal(config.compaction.auto, false);
    assert.equal(config.plugins.length, 1); assert.match(config.plugins[0].package, /^file:\/\//);
    assert.equal(Object.hasOwn(config, 'permission'), false);
  }
});

test('native CLI stdin preserves exact whitespace, Unicode, quotes and leading-dash tokens', () => {
  for (const prompt of ['Public prompt.', '  leading  and trailing  ', 'Literal  "quoted text"\n\nUnicode: α\tβ\n-2, -4], --agent -h\n', 'one\nline']) {
    const stdin = nativePromptBytes(prompt);
    assert.equal(Buffer.isBuffer(stdin), true);
    assert.deepEqual(stdin, Buffer.from(prompt));
    assert.equal(hash(stdin), hash(prompt));
  }
  assert.throws(() => nativePromptBytes(''), /prompt_stdin_rejected/);
  assert.throws(() => nativePromptBytes('bad\0input'), /prompt_stdin_rejected/);
  assert.equal(nativePromptBytes('x'.repeat(1024 * 1024)).length, 1024 * 1024);
  assert.throws(() => nativePromptBytes('x'.repeat(1024 * 1024 + 1)), /prompt_stdin_rejected/);
  assert.throws(() => nativePromptBytes('α'.repeat(524289)), /prompt_stdin_rejected/);
});

test('production and audit launch wiring uses only fixed flags and exact stdin bytes', () => {
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /args: Object\.freeze\(\['run', '--server', base, '--session', sessionID, '--model', `\$\{MODEL\}#default`, '--agent', AGENT, '--format', 'json'\]\)/);
  assert.match(source, /args: Object\.freeze\(\['run', '--server', base, '--session', sessionID, '--model', `\$\{MODEL_REF.providerID\}\/\$\{MODEL_REF.id\}#default`, '--agent', AGENT, '--format', 'json', '--title', TITLE\]\)/);
  assert.equal((source.match(/const stdin = nativePromptBytes\(prompt\);/g) ?? []).length, 2);
  assert.equal((source.match(/stdin, stdin_sha256: hash\(stdin\)/g) ?? []).length, 2);
  assert.doesNotMatch(source, /nativePromptArguments|prompt\.split\(' '\)/);
});

function contextFixture() {
  const prompt = 'Public scheduled prompt, unchanged.';
  const template = makeRequestTemplate({ sessionID: `ses_${randomUUID()}`, messageID: `msg_${randomUUID()}`,
    prompt, promptHash: hash(prompt), directory: root, projectDirectory: root, tmp: path.join(root, 'tmp'),
    localDate: 'Wed Nov 11 2026', platform: 'win32' });
  const context = { sessionID: template.sessionID, agent: AGENT, model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default' },
    system: structuredClone(template.system), messages: structuredClone(template.messages),
    tools: structuredClone(Object.fromEntries(namesFor('plugin-off').map(name => [name, DEFINITIONS[name]]))) };
  return { template, context, options: { condition: 'plugin-off', requestTemplate: template } };
}

test('exact independently assembled native context shape passes inspection', () => {
  const { template, context, options } = contextFixture();
  assert.deepEqual(template.messages, [{ id: template.messageID, role: 'user', content: [{ type: 'text', text: 'Public scheduled prompt, unchanged.' }], metadata: {} }]);
  assert.deepEqual(template.system[0], { type: 'text', text: SYSTEM });
  assert.equal(template.system[1].text, `Today's date: Wed Nov 11 2026\n\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: ${root}\n  Workspace root folder: ${root}\n  Is directory a git repo: no\n  Platform: win32\n  Prefer ${path.join(root, 'tmp')} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\n</env>`);
  assert.deepEqual(inspectContext(context, options).reasons, []);
  for (const variant of [undefined, null, '', 'unapproved']) assert.ok(inspectContext({ ...context, model: { ...context.model, variant } }, options).reasons.includes('model_mismatch'));
  assert.equal(HOOK_REVIEW.auth_http_may_precede, true);
  assert.equal(HOOK_REVIEW.stateless_generate_covered, false);
});

test('wrong tool/system/prompt/session/message/model/history are independently rejected', () => {
  const { context, options } = contextFixture();
  const edits = [
    [c => { c.tools.execute = { description: 'unexpected', input: {} }; }, 'request_tools_mismatch'],
    [c => { c.system[0].text += ' unexpected'; }, 'system_template_unapproved'],
    [c => { c.system.push({ type: 'text', text: 'unexpected instructions' }); }, 'system_template_unapproved'],
    [c => { c.messages[0].content[0].text += ' changed'; }, 'history_template_unapproved'],
    [c => { c.sessionID = `ses_${randomUUID()}`; }, 'session_mismatch'],
    [c => { c.messages[0].id = `msg_${randomUUID()}`; }, 'history_template_unapproved'],
    [c => { c.model.variant = 'unapproved'; }, 'model_mismatch'],
    [c => { c.messages.push({ id: 'msg_old', role: 'assistant', content: [], metadata: {} }); }, 'history_template_unapproved'],
  ];
  for (const [edit, reason] of edits) { const changed = structuredClone(context); edit(changed); assert.ok(inspectContext(changed, options).reasons.includes(reason)); }
});

test('one-shot template binding grants matching evidence, never inference authority', async () => {
  const f = fixture(), { template, context } = contextFixture();
  const finalTemplate = withModelIdentity(template, 'Fixture model display');
  context.system = structuredClone(finalTemplate.system);
  const audit = await f.setup({ requestTemplate: template });
  const incarnation = (await audit()).incarnation;
  const binding = { nonce: f.options.nonce, incarnation, mode: 'direct', invocation_token: randomUUID(), template_sha256: hash(finalTemplate), catalog_display_name: 'Fixture model display' };
  assert.equal((await audit.bindContext(binding)).production_admission, false);
  let inferenceReached = false;
  await assert.rejects((async () => { await f.hooks.get('context')(context); inferenceReached = true; })(), /audit_only_dispatch_blocked/);
  assert.equal(inferenceReached, false);
  const result = await audit();
  assert.deepEqual(result.last_request.reasons, []);
  assert.equal(result.auth_http_may_precede, true);
  assert.equal(result.stateless_generate_covered, false);
  assert.equal(result.guard_counts.context, 1);
  assert.equal(result.abort_record.abort_committed, true);
  assert.equal(result.abort_count, 1);
  assert.equal(verifyAbortCertificate(result, { bindings: f.options }, finalTemplate, incarnation).scope, 'trusted-guard-pinned-source-session-inference-prevented');
  assert.throws(() => verifyAbortCertificate(result, { bindings: f.options }, finalTemplate, randomUUID()), /certificate_rejected/);
  assert.equal(validateAuditEnvelope({ output: result }, { bindings: f.options }, 'context').production_admission, false);
  const forged = structuredClone(result);
  forged.last_request.model_diagnostic.shape.properties[0].raw_value = 'not-permitted';
  assert.throws(() => validateAuditEnvelope({ output: forged }, { bindings: f.options }, 'context'), /malformed_context_diagnostic/);
  assert.throws(() => f.hooks.get('model.request')({ kind: 'title' }), /audit_only_dispatch_blocked/);
  await assert.rejects(audit.bindContext(binding), /context_binding_rejected/);
  assert.equal((await audit()).guard_state, 'revoked');
});

test('forged binding/stale incarnation permanently revokes without authority', async () => {
  for (const change of [{ admit: true }, { nonce: 'forged' }, { incarnation: randomUUID() }, { template_sha256: '0'.repeat(64) }, { catalog_display_name: 'unexpected' }]) {
    const f = fixture(), { template } = contextFixture(), audit = await f.setup({ requestTemplate: template });
    const binding = { nonce: f.options.nonce, incarnation: (await audit()).incarnation, mode: 'direct', invocation_token: randomUUID(),
      template_sha256: hash(withModelIdentity(template, 'Fixture model display')), catalog_display_name: 'Fixture model display' };
    await assert.rejects(audit.bindContext({ ...binding, ...change }), /binding_rejected/);
    await assert.rejects(audit.bindContext(binding), /context_binding_rejected/);
    assert.equal((await audit()).abort_count, 0);
  }
  assert.equal(isOwnedBridge({ getBindings: () => ({ production_admission: false }) }), false);
});

async function nativeFixture() {
  const f = fixture(), { template, context } = contextFixture(), audit = await f.setup({ requestTemplate: template });
  const incarnation = (await audit()).incarnation, invocation = randomUUID();
  const initial = withModelIdentity(template, 'Fixture model display');
  const native = withNativeMessage(initial, 'msg_012345abcdefABCDEFGHIJKLMN');
  context.system = structuredClone(native.system); context.messages = structuredClone(native.messages);
  await audit.bindContext({ nonce: f.options.nonce, incarnation, mode: 'native-cli', invocation_token: invocation, template_sha256: hash(initial), catalog_display_name: 'Fixture model display' });
  const blocked = f.hooks.get('context')(context);
  const rejected = assert.rejects(blocked, /audit_only_dispatch_blocked/);
  const pending = await audit.pending({ nonce: f.options.nonce, incarnation });
  const artifact = { id: native.messageID, type: 'user', time: { created: 1 }, text: native.messages[0].content[0].text };
  const projection = validateNativeStore({ data: artifact }, { data: [artifact] }, { data: [] }, native);
  return { f, audit, native, context, rejected, pending, artifact, request: { nonce: f.options.nonce, incarnation, episode_id: 'plugin-off',
    session_id: native.sessionID, message_id: native.messageID, prompt_sha256: native.prompt_sha256, invocation_token: invocation, digest: pending.pending.digest, store_projection: projection } };
}

test('native MID pending gate releases only to synchronous committed abort; duplicate release revokes', async () => {
  const n = await nativeFixture();
  assert.equal((await n.audit()).abort_count, 0);
  assert.equal(n.pending.state, 'pending-first-context');
  assert.equal((await n.audit.bindLiveMessage(n.request)).production_admission, false);
  await n.rejected;
  const result = await n.audit();
  assert.equal(result.abort_count, 1);
  assert.equal(verifyAbortCertificate(result, { bindings: n.f.options }, n.native, n.request.incarnation).abort_committed, true);
  await assert.rejects(n.audit.bindLiveMessage(n.request), /native_binding_rejected/);
  assert.equal((await n.audit()).guard_state, 'revoked');
});

test('wrong nonce/incarnation/digest/MID/store projection and concurrent context revoke pending gates', async () => {
  for (const edit of [{ nonce: 'wrong' }, { incarnation: randomUUID() }, { digest: '0'.repeat(64) }, { message_id: 'msg_wrong' }, { store_projection: {} }]) {
    const n = await nativeFixture();
    await assert.rejects(n.audit.bindLiveMessage({ ...n.request, ...edit }), /native_binding_rejected/);
    await n.rejected;
    assert.equal((await n.audit()).abort_count, 0);
  }
  const n = await nativeFixture();
  assert.throws(() => n.f.hooks.get('context')(n.context), /audit_only_dispatch_blocked/);
  await n.rejected;
  assert.equal((await n.audit()).guard_state, 'revoked');
});

test('native store artifact rejects attachments/metadata/extra users/wrong text and unbound MID syntax', async () => {
  const n = await nativeFixture();
  for (const edit of [{ text: 'wrong' }, { type: 'synthetic' }, { files: [{}] }, { agents: [] }, { skills: [] }, { metadata: { extra: true } }, { id: 'msg_wrong' }]) {
    assert.throws(() => validateNativeStore({ data: { ...n.artifact, ...edit } }, { data: [n.artifact] }, { data: [] }, n.native), /artifact_rejected/);
  }
  assert.throws(() => validateNativeStore({ data: n.artifact }, { data: [n.artifact, n.artifact] }, { data: [] }, n.native), /history_rejected/);
  assert.throws(() => validateNativeStore({ data: n.artifact }, { data: [n.artifact] }, { data: [n.artifact] }, n.native), /history_rejected/);
  assert.equal(nativeMessageID('msg_012345abcdefABCDEFGHIJKLMN'), true);
  assert.equal(nativeMessageID(`msg_${randomUUID()}`), false);
  await assert.rejects(n.audit.bindLiveMessage({ ...n.request, digest: 'wrong' }), /native_binding_rejected/); await n.rejected;
});

test('native CLI empty files and repeated locked agent selection do not authorize extra history', async () => {
  const n = await nativeFixture();
  const user = { ...n.artifact, files: [] };
  const selection = { type: 'agent-switched', id: 'msg_012345abcdefABCDEFGHIJKLMO', time: { created: 1 }, agent: AGENT, previous: AGENT };
  assert.equal(validateNativeStore({ data: user }, { data: [selection, user] }, { data: [] }, n.native).id, user.id);
  for (const history of [[{ ...selection, previous: 'unapproved' }, user], [user, selection], [selection, selection, user],
    [{ ...selection, type: 'system', text: 'unapproved' }, user]]) {
    assert.throws(() => validateNativeStore({ data: user }, { data: history }, { data: [] }, n.native), /native_store_/);
  }
  await assert.rejects(n.audit.bindLiveMessage({ ...n.request, digest: 'wrong' }), /native_binding_rejected/); await n.rejected;
});

test('pending native binding timeout revokes without committing an abort certificate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const n = await nativeFixture();
  t.mock.timers.tick(20001);
  await n.rejected;
  const result = await n.audit();
  assert.equal(result.guard_state, 'revoked'); assert.equal(result.abort_count, 0);
  await assert.rejects(n.audit.bindLiveMessage(n.request), /native_binding_rejected/);
});

test('context submission requires independent closed registry, not observed IDs or JSON nonce', () => {
  const registry = JSON.parse(readFileSync(new URL('../cli-builtins.json', import.meta.url), 'utf8'));
  const cliHash = registry.cli_sha256;
  const builtins = registry.builtin_ids.map(id => ({ id, source_type: 'builtin', source_sha256: cliHash }));
  const stage = { cli: { sha256: cliHash }, operator: {}, contextPreflight: {}, bindings: { requestTemplate: {}, approvedPlugins: builtins }, config: { warming: false, compaction: { auto: false } } };
  const startup = { config_audit: { passed: true }, model_metadata: { exact_model_present: true }, startup_audit: { inventory_passed: true,
    backend_available: true, production_admission: false, dispatch_proof: DISPATCH_PROOF, runtime_evidence: { admission: 'not_assessed' } } };
  assert.throws(() => contextSubmissionGate(startup, stage, null), /approved_builtin_registry_missing/);
  assert.throws(() => validateBuiltinRegistry({ ...registry, source_commit: null }, cliHash), /approved_builtin_provenance_required/);
  assert.throws(() => validateBuiltinRegistry({ ...registry, builtin_ids: [...registry.builtin_ids, 'opencode.unknown'] }, cliHash), /approved_builtin_provenance_required/);
  assert.throws(() => validateBuiltinRegistry({ ...registry, cli_sha256: '0'.repeat(64) }, cliHash), /approved_builtin_provenance_required/);
  assert.equal(contextSubmissionGate(startup, stage, registry), true);
  assert.throws(() => contextSubmissionGate({ ...startup, startup_audit: { ...startup.startup_audit, inventory_passed: false } }, stage, registry), /context_startup_not_approved/);
});

test('approved model identity is inserted exactly at index one, not learned from context', () => {
  const { template } = contextFixture();
  const bound = withModelIdentity(template, 'Fixture model display');
  assert.equal(bound.system.length, 4);
  assert.equal(bound.system[0].text, SYSTEM);
  assert.equal(bound.system[1].text, '# Your Model\n- Name: Fixture model display\n- Provider ID: opencode-go\n- Model ID: deepseek-v4.1-flash');
  assert.deepEqual(bound.system[2], template.system[1]);
  assert.equal(bound.system[3].text, WORKTREE_FRAGMENT);
  assert.throws(() => withModelIdentity(template, 'name\nunapproved instruction'), /invalid_catalog_identity/);
});

test('source-approved fourth fragment is exact; extra fifth and trailing newline rejected', () => {
  const { template, context } = contextFixture();
  const requestTemplate = withModelIdentity(template, 'Fixture model display');
  context.system = structuredClone(requestTemplate.system);
  const options = { condition: 'plugin-off', requestTemplate };
  assert.equal(hash(WORKTREE_FRAGMENT), '9773c841c54059e514f6802176668325a05bae99089c9a2129f63349d8479d51');
  assert.deepEqual(inspectContext(context, options).reasons, []);
  context.system[3].text += '\n';
  assert.ok(inspectContext(context, options).reasons.includes('system_template_unapproved'));
  context.system = [...requestTemplate.system, { type: 'text', text: 'unknown fifth' }];
  assert.ok(inspectContext(context, options).reasons.includes('system_template_unapproved'));
  assert.equal(namesFor('plugin-on').includes('execute'), false);
});

test('model diagnostics expose bounded names/types and equality only, never accept unknown keys', () => {
  const { context, options } = contextFixture();
  context.model = { ...context.model, variant: undefined, unknownOption: { secret: 'synthetic-private-value' } };
  const result = inspectContext(context, options);
  assert.ok(result.reasons.includes('model_mismatch'));
  assert.deepEqual(result.model_diagnostic, { shape: { type: 'object', truncated: false, properties: [
    { name: 'providerID', type: 'string' }, { name: 'id', type: 'string' }, { name: 'variant', type: 'undefined' }, { name: 'unknownOption', type: 'object' },
  ] }, providerID_equals_expected: true, id_equals_expected: true, variant_is_undefined: true });
  assert.equal(JSON.stringify(result).includes('synthetic-private-value'), false);
  assert.equal(validDiagnosticShape(result.model_diagnostic.shape), true);
  const shape = diagnosticShape(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`unsafe key ${i}`, 'synthetic-private-value'])));
  assert.equal(shape.truncated, true); assert.equal(shape.properties.length, 32);
  assert.ok(shape.properties.every(p => p.name === 'redacted_key'));
  assert.equal(validDiagnosticShape({ ...shape, raw: {} }), false);
});

test('SSE transport rejects HTTP errors and non-SSE without parsing response bodies', () => {
  const diagnostic = {};
  assert.throws(() => checkLogTransport(403, 'text/event-stream', diagnostic), /session_log_http_rejected/);
  assert.equal(diagnostic.rejection_reason, 'http_status');
  assert.equal(diagnostic.http_status, 403);
  assert.throws(() => checkLogTransport(200, 'application/json', diagnostic), /session_log_content_type_rejected/);
  assert.equal(diagnostic.content_type, 'other');
  checkLogTransport(200, 'text/event-stream; charset=utf-8', diagnostic);
  assert.equal(diagnostic.content_type, 'event-stream');
});

test('SSE framing handles CR/LF/CRLF, comments and multiline data; refuses incomplete frames', () => {
  const sid = 'ses_fixture';
  const source = ': comment\nevent: message\ndata: {"type":"log.synced",\ndata: "aggregateID":"ses_fixture"}\n\n';
  for (const ending of ['\n', '\r', '\r\n']) {
    const diagnostic = {};
    assert.equal(summarizeSessionLog(source.replaceAll('\n', ending), sid, diagnostic).complete, true);
    assert.equal(diagnostic.frame_count, 1);
    assert.equal(diagnostic.rejection_reason, null);
  }
  const diagnostic = {};
  assert.throws(() => summarizeSessionLog(source.trimEnd(), sid, diagnostic), /malformed_session_log/);
  assert.equal(diagnostic.rejection_reason, 'unterminated_frame');
  assert.throws(() => summarizeSessionLog('data: {private-invalid-json}\n\n', sid, diagnostic), /malformed_session_log/);
  assert.deepEqual(Object.keys(diagnostic.events[0]).sort(), ['byte_count', 'json_parse_failed', 'sha256']);
  assert.equal(JSON.stringify(diagnostic).includes('private-invalid-json'), false);
});

test('SSE diagnostics distinguish sequence, aggregate, boundary and unsupported shape failures', () => {
  const sid = 'ses_fixture';
  const event = { type: 'session.execution.failed', durable: { aggregateID: sid, seq: 1, version: 1 },
    data: { error: { type: 'unknown', message: 'synthetic-private-value real_use_audit_only_dispatch_blocked' } } };
  const boundary = { type: 'log.synced', aggregateID: sid, seq: 1 };
  const cases = [
    [[event, { ...event, durable: { ...event.durable, seq: 0 } }, boundary], 'sequence_reorder'],
    [[{ ...event, durable: { ...event.durable, aggregateID: 'ses_other' } }, boundary], 'event_aggregate'],
    [[event, { ...boundary, seq: 0 }], 'boundary_watermark'],
    [[event, boundary, event], 'event_after_boundary'],
    [[{ ...event, type: 'unapproved-private-type' }, boundary], 'unsupported_event_type'],
    [[{ data: event }, boundary], 'unsupported_event_type'],
  ];
  for (const [events, reason] of cases) {
    const diagnostic = {};
    assert.throws(() => summarizeSessionLog(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), sid, diagnostic), /malformed_session_log/);
    assert.equal(diagnostic.rejection_reason, reason);
    assert.equal(diagnostic.frame_count, events.length);
    assert.equal(diagnostic.events.at(-1).synced_seq, reason === 'event_after_boundary' ? null : events.at(-1).seq);
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-private-value'), false);
    assert.equal(JSON.stringify(diagnostic).includes('ses_other'), false);
    assert.equal(JSON.stringify(diagnostic).includes('unapproved-private-type'), false);
  }
});

test('bounded Session log evidence distinguishes abort from usage and prior sessions', () => {
  const sid = `ses_${randomUUID()}`;
  const stream = types => types.map((type, i) => `data: ${JSON.stringify({ type, durable: { aggregateID: sid, seq: i + 1 }, data: { error: { type: 'unknown', message: 'real_use_audit_only_dispatch_blocked' } } })}\n\n`).join('') +
    `data: ${JSON.stringify({ type: 'log.synced', aggregateID: sid, seq: types.length })}\n\n`;
  const text = stream(['session.created', 'session.execution.failed']);
  assert.deepEqual(summarizeSessionLog(text, sid), { complete: true, evidence_scope: 'historical-retained-payload-only', abort_evidence: 'insufficient_retained_payload', event_counts: { 'session.created': 1, 'session.execution.failed': 1 }, usage_events: 0,
    forbidden_inference_events: 0, execution_failed: true, guard_error_observed: true, authentication_failure_observed: false });
  assert.equal(summarizeSessionLog(stream(['session.usage.recorded']), sid).usage_events, 1);
  assert.throws(() => summarizeSessionLog(text, 'ses_wrong'), /malformed_session_log/);
  assert.throws(() => summarizeSessionLog('data: {}\n\n', sid), /malformed_session_log/);
  assert.throws(() => summarizeSessionLog('', sid), /session_log_incomplete/);
  assert.equal(summarizeSessionLog(`data: ${JSON.stringify({ type: 'log.synced', aggregateID: sid, seq: 5 })}\n\n`, sid).abort_evidence, 'insufficient_retained_payload');
});

test('historical sequences start at zero, permit gaps and marker advancement, never prove live abort', () => {
  const sid = 'ses_fixture';
  const events = [0, 7].map(seq => ({ type: 'session.created', durable: { aggregateID: sid, seq }, data: { sessionID: sid } }));
  events.push({ type: 'log.synced', aggregateID: sid, seq: 12 });
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  const result = summarizeSessionLog(text, sid);
  assert.equal(result.complete, true); assert.equal(result.abort_evidence, 'insufficient_retained_payload');
  assert.throws(() => summarizeSessionLog(text, sid, {}, 0), /malformed_session_log/);
  assert.throws(() => summarizeSessionLog(text.replace('"seq":12', '"seq":6'), sid), /malformed_session_log/);
});

const liveSID = 'ses_live_fixture', liveMID = 'msg_live_fixture';
const liveEvent = (type, seq, data = {}) => ({ type, durable: { aggregateID: liveSID, seq, version: 1 }, data: { sessionID: liveSID, ...data } });
const liveFailure = seq => liveEvent('session.execution.failed', seq, { error: { type: 'unknown', message: 'real_use_audit_only_dispatch_blocked' } });
const liveBaseline = { type: 'log.synced', aggregateID: liveSID, seq: 0 };
const liveEnqueued = liveEvent('session.inbox.enqueued', 1, { inboxID: liveMID });
const sse = event => `data: ${JSON.stringify(event)}\r\n\r\n`;

test('live capture requires pre-prompt baseline, scoped message and controlled terminal; replay cannot substitute', () => {
  const capture = createLiveCapture(liveSID, liveMID);
  assert.throws(() => capture.submitted(), /monitor_not_ready/);
  assert.equal(capture.accept(liveFailure(0)), 'historical');
  assert.equal(capture.accept(liveBaseline), 'ready');
  capture.submitted();
  assert.throws(() => capture.end(true), /live_evidence_incomplete/);
  capture.accept(liveEnqueued);
  assert.equal(capture.accept(liveFailure(4)), 'terminal');
  assert.equal(capture.end(true).owned_monitor_end, 'intentional-after-terminal-wait-rpc');
  assert.equal(capture.summary.event_counts['session.execution.failed'], 1);
  assert.equal(capture.summary.historical_replay_claimed, false);
});

test('live capture rejects wrong session/message, non-guard failure, usage and missing terminal', () => {
  for (const event of [
    { ...liveEnqueued, durable: { ...liveEnqueued.durable, aggregateID: 'ses_wrong' } },
    liveEvent('session.inbox.enqueued', 1, { inboxID: 'msg_wrong' }),
    liveEvent('session.inbox.enqueued', 1, { sessionID: 'ses_wrong', inboxID: liveMID }),
    liveEvent('session.usage.recorded', 1),
    liveEvent('session.execution.failed', 1, { error: { message: 'not the guard' } }),
    liveFailure(1),
  ]) {
    const capture = createLiveCapture(liveSID, liveMID);
    capture.accept(liveBaseline); capture.submitted();
    assert.throws(() => capture.accept(event), /malformed_session_log/);
    assert.throws(() => capture.end(true), /live_evidence_incomplete/);
  }
});

test('incremental SSE handles split CRLF and rejects truncated data without raw persistence', () => {
  const events = [], diagnostic = {};
  const parser = createSSEDecoder(event => events.push(event), diagnostic);
  for (const character of sse(liveBaseline)) parser.push(character);
  parser.finish(); assert.deepEqual(events, [liveBaseline]);
  parser.push('data: {"unfinished":');
  assert.throws(() => parser.finish(), /malformed_session_log/);
  assert.equal(JSON.stringify(diagnostic).includes('unfinished'), false);
});

test('owned streaming monitor waits for sync before submission and closes after controlled failure', async () => {
  let stream;
  const diagnostic = {};
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  let ready = false;
  const opening = monitorSessionLog(async () => response, liveSID, liveMID, diagnostic).then(value => { ready = true; return value; });
  await Promise.resolve(); assert.equal(ready, false);
  stream.enqueue(new TextEncoder().encode(sse(liveBaseline)));
  const monitor = await opening;
  monitor.submitted();
  stream.enqueue(new TextEncoder().encode(sse(liveEnqueued) + sse(liveFailure(4))));
  await monitor.terminal;
  const summary = await monitor.close(true);
  assert.equal(summary.terminal_guard_failure, true);
  assert.equal(summary.bound_message_event, true);
  assert.equal(summary.owned_monitor_end, 'intentional-after-terminal-wait-rpc');
  assert.equal(summary.usage_events, 0);
});

test('live stream EOF without controlled terminal never becomes historical abort evidence', async () => {
  const response = new Response(sse(liveBaseline), { headers: { 'Content-Type': 'text/event-stream' } });
  const monitor = await monitorSessionLog(async () => response, liveSID, liveMID, {});
  await assert.rejects(monitor.terminal, /live_unexpected_eof/);
  assert.equal((await monitor.close(false)).terminal_guard_failure, false);
});

test('marker-only live stream times out without claiming controlled abort', async () => {
  const diagnostic = {};
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(sse(liveBaseline)));
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const monitor = await monitorSessionLog(async () => response, liveSID, liveMID, diagnostic, 25);
  monitor.submitted();
  await assert.rejects(monitor.terminal, /session_log_live_timeout/);
  const result = await monitor.close(false);
  assert.equal(result.terminal_guard_failure, false);
  assert.equal(diagnostic.monitor_failure, 'session_log_live_timeout');
  assert.equal(result.owned_monitor_end, 'intentional-unverified-cleanup');
});

test('fixed staged schemas exactly match separately owned runtime tool definitions', () => {
  assert.deepEqual(SOURCE_TOOL_MAPPING, { approved_list: 'list_sources', approved_read: 'read_source', approved_search: 'search_source', approved_pdf_text: 'read_pdf' });
  for (const [name, source] of Object.entries(SOURCE_TOOL_MAPPING)) assert.equal(BASELINE_DEFINITIONS[name].inputSchema, GENERIC_DEFINITIONS[source].inputSchema);
  for (const [name, definition] of Object.entries({ ...BASELINE_DEFINITIONS, ...NAVIGATION_DEFINITIONS })) {
    assert.deepEqual(DEFINITIONS[name].input, definition.inputSchema);
    assert.equal(DEFINITIONS[name].description, definition.description);
  }
});

test('effective config rejects extra documents, changed permissions and unowned discovery', () => {
  const configPath = path.join(root, 'native.json');
  const config = nativeConfig('plugin-off', path.join(root, 'entry.js'));
  const resolved = structuredClone(config);
  resolved.model = { providerID: 'opencode-go', model: 'deepseek-v4.1-flash', variant: 'default' };
  resolved.agents[AGENT].model = resolved.model;
  const stage = { root, config, bindings: { configPath } };
  const entries = [{ type: 'document', path: configPath, info: resolved }];
  assert.equal(inspectConfigEntries(entries, stage).passed, true);
  assert.equal(inspectConfigEntries([...entries, { type: 'directory', path: 'C:\\unowned' }], stage).passed, false);
  assert.equal(inspectConfigEntries([...entries, { type: 'document', path: path.join(root, 'extra.json'), info: { instructions: ['unexpected'] } }], stage).passed, false);
  const changed = structuredClone(entries); changed[0].info.permissions[0].effect = 'allow';
  assert.equal(inspectConfigEntries(changed, stage).passed, false);
});

test('post-boot final transform removes late browser tools before first audit', async () => {
  const f = fixture(), audit = await f.setup();
  f.tools.set('browser_evaluate', { id: 'browser_evaluate', name: 'evaluate' });
  const result = await audit();
  assert.equal(result.inventory_passed, true);
  assert.equal(f.tools.has('browser_evaluate'), false);
});

test('inherited environment is allowlisted, preserving only computed native data-root selection', () => {
  const env = cleanEnvironment(root, { USERPROFILE: 'C:\\Users\\fixture', SystemRoot: 'C:\\Windows',
    XDG_DATA_HOME: 'D:\\native-data', OPENCODE_CONFIG_CONTENT: 'do-not-inherit',
    NODE_OPTIONS: 'do-not-inherit', HTTP_PROXY: 'do-not-inherit', TOKEN: 'synthetic-not-a-secret', PATH: 'untrusted' });
  assert.equal(env.XDG_DATA_HOME, 'D:\\native-data');
  assert.equal(env.OPENCODE_CONFIG_PROJECT_DISABLE, '1');
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1');
  for (const key of ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB', 'NODE_OPTIONS', 'HTTP_PROXY', 'TOKEN']) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(env.PATH, 'C:\\Windows\\System32');
  assert.equal(env.USERPROFILE, path.join(root, 'home'));
  assert.throws(() => cleanEnvironment(root, { USERPROFILE: '\\\\host\\share' }), /absolute_local_path/);
  assert.throws(() => cleanEnvironment(root, { USERPROFILE: 'C:\\Users\\fixture', OPENCODE_DB: 'synthetic-selected-locator' }), /native_db_locator_requires_operator_approval/);
});

test('frozen runtime source graph rejects mutation and extra module paths', () => {
  const assetRoot = mkdtempSync(path.join(root, 'assets-'));
  const files = ['bench/v4/real-use/runtime-tools.mjs', 'bench/v4/real-use/runtime-backend.mjs',
    'bench/v4/real-use/lib/snapshot-tools.mjs', 'bench/v3/arxivlean/lib/eval-sandbox.mjs',
    '.opencode/plugins/math-toolkit/lib/search.js', '.opencode/plugins/math-toolkit/lib/format.js',
    '.opencode/plugins/math-toolkit/scripts/math_compute.py', 'package.json'];
  const sources = files.map(file => { mkdirSync(path.dirname(path.join(assetRoot, file)), { recursive: true });
    writeFileSync(path.join(assetRoot, file), 'fixture', { flag: 'wx' }); return { file, sha256: hash('fixture') }; });
  const operator = { assetRoot, sources, sourceGraphHash: hash(sources) };
  verifyFrozenAssets(operator);
  assert.throws(() => verifyFrozenAssets({ ...operator, sources: [...sources, { file: '../outside', sha256: hash('fixture') }] }), /frozen_asset_manifest_mismatch/);
  writeFileSync(path.join(assetRoot, files[0]), 'changed');
  assert.throws(() => verifyFrozenAssets(operator), /frozen_asset_source_mismatch/);
});

for (const condition of ['plugin-off', 'plugin-on']) test(`fixture V2 setup removes all tools, direct schemas, post-boot audit: ${condition}`, async () => {
  const f = fixture(condition), audit = await f.setup();
  assert.deepEqual([...f.tools.keys()], namesFor(condition));
  for (const [name, tool] of f.tools) {
    assert.deepEqual(tool.input, DEFINITIONS[name].input);
    assert.deepEqual(tool.options, { codemode: false, permission: name });
    await assert.rejects(tool.execute({}), /frozen_backend_unavailable/);
  }
  const result = await audit();
  assert.equal(result.inventory_passed, true);
  assert.equal(result.production_admission, false);
  assert.equal(result.backend_available, false);
  assert.deepEqual(result.effective_permissions, permissionsFor(condition));
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(validateAuditEnvelope({ output: result }, { bindings: f.options }), result);
  await assert.rejects(audit({ nonce: f.options.nonce, admit: true }), /audit_request_rejected/);
  await assert.rejects(audit({ nonce: 'forged' }), /audit_request_rejected/);
});

test('all request paths blocked; title local; retries disabled; permissions denied', async () => {
  const f = fixture(); await f.setup();
  for (const name of ['model.request', 'http.request', 'experimental.ws.handshake', 'experimental.ws.send', 'compaction', 'generate', 'context']) {
    assert.throws(() => f.hooks.get(name)({ tools: {}, messages: [], system: [] }), /audit_only_dispatch_blocked/);
  }
  const title = {}; f.hooks.get('title')(title); assert.equal(title.result, TITLE);
  const retry = { decision: { retry: true, delay: 1 } }; f.hooks.get('retry')(retry); assert.deepEqual(retry.decision, { retry: false });
  const permission = { action: 'approved_read', effect: 'allow' }; f.hooks.get('permission.evaluate')(permission); assert.equal(permission.effect, 'deny');
  assert.deepEqual([...f.agents.keys()], [AGENT]);
  assert.equal(f.agents.get(AGENT).system, SYSTEM);
});

test('unknown plugins, source hash mismatch, foreign tools and codemode fail closed', async () => {
  const f = fixture(), audit = await f.setup();
  await audit(); // Post-boot restriction precedes adversarial late registration.
  f.plugins.push({ id: 'unapproved-provider', source: { type: 'builtin' }, state: { status: 'active' } });
  f.tools.set('execute', { id: 'execute', name: 'execute', input: {}, options: { codemode: true } });
  f.tools.get('compute').options.codemode = true;
  const result = await audit();
  assert.equal(result.inventory_passed, false);
  assert.ok(result.reasons.includes('unapproved_plugin:unapproved-provider'));
  assert.ok(result.reasons.includes('unexpected_tool:execute'));
  assert.ok(result.reasons.includes('unexpected_tool:compute'));
  assert.equal(result.plugins.find(item => item.id === 'unapproved-provider').approved, false);
  const options = { ...f.options, approvedPlugins: [{ ...f.options.approvedPlugins[0], source_sha256: 'c'.repeat(64) }] };
  assert.ok(inspectInventory([...f.tools.values()], f.plugins, options).reasons.includes(`unapproved_plugin:${PLUGIN_ID}`));
});

test('no caller JSON admission or unfrozen callback enables live execution', async () => {
  const f = fixture();
  await assert.rejects(f.setup({ production_admission: true }), /invalid_runtime_options/);
  await assert.rejects(f.setup({ runtime_sha256: '0'.repeat(64) }), /runtime_source_mismatch/);
  await assert.rejects(f.setup({ tools: { compute: async () => ({}) } }), /invalid_frozen_backend/);
  const callbacks = Object.freeze(Object.fromEntries(Object.entries(BASELINE_DEFINITIONS).map(([name, definition]) =>
    [name, Object.freeze({ ...definition, handler: async () => { assert.fail('backend must not run in audit mode'); } })])));
  await f.setup({ tools: callbacks, backend_sha256: 'd'.repeat(64) });
  for (const [name, tool] of f.tools) assert.equal(tool.input, callbacks[name].inputSchema, 'reuse the factory schema object');
  await assert.rejects(f.tools.get('compute').execute({}), /audit_only_tool_invocation_blocked/);
});

test('history/system are not approved by hashing unexpected contents', () => {
  const options = { condition: 'plugin-off' };
  const context = { agent: AGENT, sessionID: 'ses_fixture', model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' },
    tools: Object.fromEntries(namesFor('plugin-off').map(name => [name, DEFINITIONS[name]])), messages: [{ role: 'user', content: 'not-approved' }], system: [{ text: 'injected' }] };
  const evidence = inspectContext(context, options);
  assert.ok(evidence.reasons.includes('history_template_unapproved'));
  assert.ok(evidence.reasons.includes('system_template_unapproved'));
  assert.equal(JSON.stringify(evidence).includes('not-approved'), false);
  assert.equal(JSON.stringify(evidence).includes('injected'), false);
});

test('malformed RPC, fake verdict, extra fields and empty tools rejected', async () => {
  const f = fixture(), audit = await f.setup(), output = await audit(), stage = { bindings: f.options };
  for (const bad of [null, {}, { data: output }, { output, extra: true }, { output: { ...output, production_admission: true } },
    { output: { ...output, tools: [] } }, { output: { ...output, nonce: randomUUID() } }, { output: { ...output, env: {} } }]) {
    assert.throws(() => validateAuditEnvelope(bad, stage));
  }
});

test('backend receipt binds source graph/endpoint/owner and image inspection never admits', async () => {
  const f = fixture();
  const sources = [{ file: 'fixture-only', sha256: 'a'.repeat(64) }];
  const operator = { sources, sourceGraphHash: hash(sources), backend: { image: `sha256:${'b'.repeat(64)}`,
    endpoint: 'npipe:////./pipe/fixture', owner: { runId: 'fixture', episodeId: 'plugin-off', nonce: f.options.nonce } } };
  const evidence = { backend_id: randomUUID(), image: operator.backend.image, evidence: 'local-docker',
    policy_sha256: 'c'.repeat(64), worker_sha256: 'd'.repeat(64),
    docker_endpoint_sha256: hash(operator.backend.endpoint), owner_sha256: hash(operator.backend.owner),
    image_inspection_sha256: 'e'.repeat(64), image_inspected: true, admission: 'not_assessed', can_authorize_model_run: false,
    inventory_sha256: 'f'.repeat(64), source_graph_sha256: operator.sourceGraphHash, sources };
  const tools = Object.freeze(Object.fromEntries(Object.entries(BASELINE_DEFINITIONS).map(([name, definition]) =>
    [name, Object.freeze({ ...definition, handler: async () => assert.fail('fixture must not execute') })])));
  const audit = await f.setup({ tools, backend_sha256: operator.sourceGraphHash, runtime_evidence: evidence });
  const output = await audit();
  const stage = { bindings: { ...f.options, backend_sha256: operator.sourceGraphHash }, operator };
  assert.equal(validateAuditEnvelope({ output }, stage).production_admission, false);
  for (const changes of [{ admission: 'ready' }, { can_authorize_model_run: true }, { image_inspected: false },
    { source_graph_sha256: '0'.repeat(64) }, { docker_endpoint_sha256: '0'.repeat(64) }, { sources: [] }]) {
    assert.throws(() => validateAuditEnvelope({ output: { ...output, runtime_evidence: { ...output.runtime_evidence, ...changes } } }, stage), /audit_backend_evidence_mismatch/);
  }
});

test('stage refuses existing output (no overwrite/resume)', () => {
  const cliPackageDir = 'C:\\Users\\MiPC\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli';
  assert.throws(() => stageAudit({ condition: 'plugin-off', cliPackageDir, output: root }), /EEXIST/);
});

// Pure state/projection checks only: no host, Docker, native CLI or provider calls.
const nativeID = n => `msg_0123456789ab${String(n).padStart(14, '0')}`;
function liveFixture(purpose = 'production') {
  const original = contextFixture();
  const template = withNativeMessage(withModelIdentity(original.template, 'Fixture model display'), nativeID(1));
  const context = { ...original.context, system: structuredClone(template.system), messages: structuredClone(template.messages) };
  const nonce = randomUUID(), incarnation = randomUUID(), invocation = randomUUID();
  const solverDeadline = Date.now() + 300000;
  const gate = createLiveGate({ template, condition: 'plugin-off', incarnation, invocation, purpose, nonce });
  const user = { id: template.messageID, type: 'user', time: { created: 1 }, text: template.messages[0].content[0].text, files: [], metadata: {} };
  const bind = () => {
    const p = gate.evidence().pending;
    return { nonce, incarnation, invocation_token: invocation, session_id: template.sessionID, message_id: p.message_id,
      ordinal: p.ordinal, digest: p.digest, messages_sha256: p.messages_sha256,
      ...(purpose === 'production' ? { solver_deadline: solverDeadline } : {}) };
  };
  const request = { sessionID: template.sessionID, agent: AGENT, model: MODEL_REF, kind: 'primary' };
  return { gate, template, context, user, bind, request };
}

test('native runtime seal retains records without a violation and denies every future gate', async () => {
  const f = liveFixture(), waiting = f.gate.context(f.context);
  f.gate.bind(f.bind()); await waiting;
  // Dispatch is synchronous and independent of any step-start observation.
  assert.equal(f.gate.transport('model.request', f.request), undefined);
  assert.equal(f.gate.transport('http.request', f.request), undefined);
  const records = f.gate.evidence().records;
  f.gate.seal(); assert.equal(f.gate.evidence().phase, 'sealed');
  assert.equal(f.gate.evidence().violations, 0, 'sealing itself is not a violation');
  assert.deepEqual(f.gate.evidence().records, records);
  for (const action of [() => f.gate.context(f.context), () => f.gate.bind({}),
    () => f.gate.transport('http.request', f.request), () => f.gate.tool('approved_list', {})])
    assert.throws(action, /live_gate_sealed/);
  assert.equal(f.gate.permission({}), false); assert.equal(f.gate.evidence().violations, 5, 'later admission attempts invalidate completion');
});

test('native runtime seal wins delivered-bind and pending-continuation races without admission', async () => {
  for (const deliver of [false, true]) {
    const f = liveFixture(), waiting = f.gate.context(f.context), request = f.bind();
    const rejected = assert.rejects(waiting, /live_gate_sealed/);
    if (deliver) f.gate.bind(request);
    f.gate.seal();
    assert.throws(() => f.gate.bind(request), /live_gate_sealed/);
    await rejected; assert.equal(f.gate.evidence().released, 0); assert.equal(f.gate.evidence().violations, 1, 'only the later bind attempt is a violation');
  }
});

test('owned live: fixtures and serialized bindings cannot mint an episode capability', () => {
  assert.equal(ADMISSION_API, BRIDGE_API);
  const forged = Object.freeze({ getBindings: () => ({ schema: ADMISSION_API, active: true }) });
  assert.equal(isOwnedBridge(forged), false);
  for (const capability of [{}, Object.freeze(Object.create(null)), { admitted: true }]) {
    assert.throws(() => consumeEpisodeCapability(capability, forged, forged.getBindings()), /invalid_or_consumed_episode_capability/);
  }
});

test('owned CLI cleanup requires the separate contained zero-process receipt; reject, hang and missing receipts fail closed', async () => {
  const good = { cleanup: { confirmed: true, active_processes: 0 }, ownership: { job_assigned: true, kill_on_close: true }, ownership_sha256: 'a'.repeat(64) };
  for (const cleanupOwned of [() => Promise.reject(null), () => new Promise(() => {}), () => undefined,
    () => ({ ...good, ownership: {} }), () => ({ ...good, cleanup: { confirmed: true, active_processes: 1 } })]) {
    const cli = await cleanupOwnedCLI({ cleanupOwned }, true, 10);
    assert.equal(cli.confirmed, false);
    assert.equal(true && true && cli.confirmed, false, 'confirmed server and daemon cannot hide CLI failure');
  }
  let calls = 0;
  const child = { cleanupOwned: async () => { calls++; return good; } };
  assert.equal((await cleanupOwnedCLI(child, true)).process_tree_containment, true);
  assert.equal((await cleanupOwnedCLI(child, true)).confirmed, true, 'already-cleaned launcher evidence remains valid');
  assert.equal(calls, 2);
  assert.deepEqual(await cleanupOwnedCLI(undefined, false), { status: 'not_started', confirmed: true, active_processes: 0 });
});

test('solver lifecycle expires during awaited native inventory before bind, revoking the actual pending gate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = liveFixture(), waiting = f.gate.context(f.context), rejected = assert.rejects(waiting, /live_guard_rejected/);
  let cleanupCalls = 0, resolveRPC;
  const clock = createSolverDeadline(300000, () => { cleanupCalls++; f.gate.revoke(); });
  const nativeRPC = new Promise(resolve => { resolveRPC = resolve; });
  const watch = (async () => { await nativeRPC; clock.check(true); f.gate.bind(f.bind()); })();
  const stopped = assert.rejects(watch, /live_solver_deadline_or_closure/);
  t.mock.timers.tick(300001); resolveRPC(); await stopped; await rejected;
  assert.equal(cleanupCalls, 1); assert.equal(f.gate.evidence().released, 0); assert.equal(f.gate.evidence().model_requests, 0);
  clock.disarm();
});

test('CLI closure during suspended native projection prevents binding and leaves deadline armed until cleanup', async () => {
  const f = liveFixture(), waiting = f.gate.context(f.context), rejected = assert.rejects(waiting, /live_guard_rejected/);
  let cleanupCalls = 0, resolveRPC;
  const clock = createSolverDeadline(300000, () => { cleanupCalls++; f.gate.revoke(); });
  const nativeRPC = new Promise(resolve => { resolveRPC = resolve; });
  const watch = (async () => { await nativeRPC; clock.check(true); f.gate.bind(f.bind()); })();
  const stopped = assert.rejects(watch, /live_solver_deadline_or_closure/);
  clock.closeCLI(); resolveRPC(); await stopped; await rejected;
  assert.equal(cleanupCalls, 1); assert.equal(f.gate.evidence().released, 0); clock.disarm();
});

test('native delivered-bind deadline fences bind, continuation and provider transport even before host timers execute', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  for (const phase of ['bind', 'continuation', 'model', 'http']) {
    t.mock.timers.setTime(now);
    const f = liveFixture(), waiting = f.gate.context(f.context), binding = f.bind();
    if (phase === 'bind') {
      const rejected = assert.rejects(waiting, /live_guard_rejected/);
      t.mock.timers.setTime(now + 300001); assert.throws(() => f.gate.bind(binding), /live_guard_rejected/); await rejected;
    } else {
      f.gate.bind(binding);
      if (phase === 'continuation') {
        t.mock.timers.setTime(now + 300001); await assert.rejects(waiting, /live_guard_rejected/);
      } else {
        await waiting;
        if (phase === 'http') f.gate.transport('model.request', f.request);
        t.mock.timers.setTime(now + 300001);
        assert.throws(() => f.gate.transport(phase === 'http' ? 'http.request' : 'model.request', f.request), /live_guard_rejected/);
      }
    }
    assert.equal(f.gate.evidence().phase, 'revoked');
  }
});

test('data-only native identity supports absent CLI models only with strong native evidence; never a branded finalization', () => {
  assert.doesNotThrow(() => validateFinishIdentity(['ses_native'], [], 'ses_native', true));
  for (const [sessions, models, strong] of [[[], [], true], [['ses_other'], [], true], [['ses_native'], [], false],
    [['ses_native'], ['other/model'], true]]) {
    assert.throws(() => validateFinishIdentity(sessions, models, 'ses_native', strong), /live_finish_identity_rejected/);
  }
});

test('owned live: native text/reasoning/local-tool projection follows pinned constructors', () => {
  const f = liveFixture();
  const row = { id: nativeID(2), type: 'assistant', agent: AGENT, model: MODEL_REF, time: { created: 2, streamed: 3, completed: 5 }, metadata: {},
    content: [{ type: 'text', text: '' }, { type: 'reasoning', text: 'reason', state: { signature: 'fixture' }, time: { created: 2, completed: 3 } },
      { type: 'text', text: 'answer' }, { type: 'tool', id: 'call_1', name: 'compute', time: { created: 3, ran: 4, completed: 5 },
        providerState: { signature: 'call' }, providerResultState: { signature: 'result' },
        state: { status: 'completed', input: { operation: 'simplify', expression: '1+1' }, content: [{ type: 'text', text: '2' }] } }] };
  const placeholder = { id: nativeID(3), type: 'assistant', agent: AGENT, model: MODEL_REF, time: { created: 6 }, content: [] };
  const result = projectNativeHistory([f.user, row, placeholder], f.template, 'plugin-off');
  assert.deepEqual(result.messages, [f.template.messages[0], { id: row.id, role: 'assistant', metadata: {}, content: [
    { type: 'reasoning', text: 'reason', providerMetadata: { 'opencode-go': { signature: 'fixture' } } }, { type: 'text', text: 'answer' },
    { type: 'tool-call', id: 'call_1', name: 'compute', input: { operation: 'simplify', expression: '1+1' }, providerMetadata: { 'opencode-go': { signature: 'call' } } }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'call_1', name: 'compute', result: { type: 'text', value: '2' }, providerMetadata: { 'opencode-go': { signature: 'result' } } }] }]);
  assert.equal(result.completed.size, 2);
  assert.equal(result.messages[2].id, undefined, 'Message.tool does not manufacture a message ID');
  const failed = structuredClone(row); failed.content = [failed.content.at(-1)];
  failed.content[0].state = { status: 'error', input: {}, error: { type: 'unknown', message: 'fixture error' } };
  assert.deepEqual(projectNativeHistory([f.user, failed], f.template, 'plugin-off').messages.at(-1).content[0].result,
    { type: 'error', value: { error: { type: 'unknown', message: 'fixture error' }, content: [] } });
});

test('owned live: projection rejects extra input, unknown schemas, hosted tools and rewritten completed artifacts', () => {
  const f = liveFixture();
  const row = { id: nativeID(2), type: 'assistant', agent: AGENT, model: MODEL_REF, time: { created: 2, completed: 3 }, content: [{ type: 'text', text: 'done' }] };
  const previous = projectNativeHistory([f.user, row], f.template, 'plugin-off').completed;
  const edits = [rows => { rows[0].text += 'tampered'; }, rows => { rows[0].sessionID = f.template.sessionID; },
    rows => { rows[0].skills = []; }, rows => { rows[0].files = [{ type: 'text', text: 'injected' }]; },
    rows => { rows.push({ ...f.user, id: nativeID(3) }); }, rows => { rows[1].content[0].extra = true; },
    rows => { rows[1].time.extra = 5; }, rows => { rows[1].type = 'synthetic'; },
    rows => { rows[1].metadata = { injected: 'no' }; }, rows => { rows[1].content[0].text = 'rewritten'; },
    rows => { rows.splice(1, 1); }];
  for (const edit of edits) {
    const rows = structuredClone([f.user, row]); edit(rows);
    assert.throws(() => projectNativeHistory(rows, f.template, 'plugin-off', previous));
  }
  const tool = { ...row, content: [{ type: 'tool', id: 'call_1', name: 'compute', executed: true, time: { created: 2, completed: 3 },
    state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'result' }] } }] };
  assert.throws(() => projectNativeHistory([f.user, tool], f.template, 'plugin-off'), /native_history_rejected/);
  tool.content[0].executed = false; tool.content[0].name = 'math_search';
  assert.throws(() => projectNativeHistory([f.user, tool], f.template, 'plugin-off'), /native_history_rejected/);
  assert.equal(projectNativeHistory([f.user, tool], f.template, 'plugin-on').messages.length, 3);
});

test('owned live: only source-defined optional undefined fields are normalized', () => {
  const messages = [{ role: 'tool', id: undefined, content: [{ type: 'tool-result', id: 'c', name: 'compute', namespace: undefined,
    providerExecuted: undefined, cache: undefined, metadata: undefined, providerMetadata: undefined, result: { type: 'text', value: '2' }, extra: undefined }] }];
  const normalized = normalizeHistory(messages);
  assert.equal(Object.hasOwn(normalized[0], 'id'), false);
  assert.equal(Object.hasOwn(normalized[0].content[0], 'namespace'), false);
  assert.equal(Object.hasOwn(normalized[0].content[0], 'extra'), true, 'unknown fields cannot disappear into normalization');
});

test('owned live: each context waits for one-use authenticated native projection release', async () => {
  const f = liveFixture(); let resumed = false;
  const first = f.gate.context(f.context).then(() => { resumed = true; });
  await Promise.resolve(); assert.equal(resumed, false); assert.equal(f.gate.evidence().model_requests, 0);
  assert.equal(f.bind().messages_sha256, hash(projectNativeHistory([f.user], f.template, 'plugin-off').messages));
  f.gate.bind(f.bind()); await first;
  assert.equal(f.gate.evidence().pending, null);
  f.gate.transport('model.request', f.request); f.gate.transport('http.request', f.request);
  const row = { id: nativeID(2), type: 'assistant', agent: AGENT, model: MODEL_REF, time: { created: 2, completed: 3 }, content: [{ type: 'text', text: 'next' }] };
  const messages = projectNativeHistory([f.user, row], f.template, 'plugin-off').messages;
  const second = f.gate.context({ ...f.context, messages });
  assert.equal(f.gate.evidence().pending.ordinal, 2); f.gate.bind(f.bind()); await second;
  f.gate.transport('model.request', f.request); f.gate.transport('http.request', f.request);
  assert.equal(f.gate.evidence().model_requests, 2); f.gate.revoke();
});

test('owned live: wrong nonce/incarnation/MID/digest/ordinal and duplicate releases revoke', async () => {
  for (const edit of [{ nonce: 'wrong' }, { incarnation: randomUUID() }, { message_id: nativeID(9) }, { digest: '0'.repeat(64) },
    { ordinal: 2 }, { messages_sha256: '0'.repeat(64) }, { session_id: `ses_${randomUUID()}` }, { extra: true }]) {
    const f = liveFixture(), waiting = f.gate.context(f.context);
    const rejected = assert.rejects(waiting, /live_guard_rejected/);
    assert.throws(() => f.gate.bind({ ...f.bind(), ...edit }), /live_guard_rejected/); await rejected;
    assert.equal(f.gate.evidence().phase, 'revoked'); assert.equal(f.gate.evidence().model_requests, 0);
  }
  const f = liveFixture(), waiting = f.gate.context(f.context), binding = f.bind();
  f.gate.bind(binding); await waiting;
  assert.throws(() => f.gate.bind(binding), /live_guard_rejected/);
});

test('owned live: changed prompt, system, tools, model, MID and extra user never reach transport', () => {
  for (const edit of [c => { c.messages[0].content[0].text += 'extra'; }, c => { c.system.push({ type: 'text', text: 'extra' }); },
    c => { c.tools.execute = {}; }, c => { c.model = { ...MODEL_REF, variant: 'other' }; },
    c => { c.messages[0].id = 'msg_not_native'; }, c => { c.messages.push(c.messages[0]); }, c => { c.unrecognized = true; }]) {
    const f = liveFixture(); edit(f.context);
    assert.throws(() => f.gate.context(f.context), /live_guard_rejected/);
    assert.equal(f.gate.evidence().model_requests, 0);
  }
});

test('owned live: auxiliary requests, retries and unknown transports revoke after release', async () => {
  for (const [kind, requestKind] of [['model.request', 'title'], ['http.request', 'generate'], ['compaction', 'primary'],
    ['generate', 'primary'], ['retry', 'primary'], ['unknown', 'primary']]) {
    const f = liveFixture(), waiting = f.gate.context(f.context); f.gate.bind(f.bind()); await waiting;
    assert.throws(() => f.gate.transport(kind, { ...f.request, kind: requestKind }), /live_guard_rejected/);
    assert.equal(f.gate.evidence().phase, 'revoked');
  }
});

test('owned live: timeout and explicit cleanup revoke pending contexts without release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = liveFixture(), waiting = f.gate.context(f.context), rejected = assert.rejects(waiting, /live_guard_rejected/);
  t.mock.timers.tick(20001); await rejected;
  assert.equal(f.gate.evidence().phase, 'revoked'); assert.equal(f.gate.evidence().released, 0);
  const g = liveFixture(), pending = g.gate.context(g.context), revoked = assert.rejects(pending, /live_guard_rejected/);
  g.gate.revoke(); g.gate.revoke(); await revoked;
  assert.equal(g.gate.evidence().active_tools, 0); assert.equal(g.gate.evidence().pending, null);
});

test('owned live: forced abort handoff cannot invoke any downstream provider path', async () => {
  const f = liveFixture('abort-control'), waiting = f.gate.context(f.context);
  const aborted = assert.rejects(waiting, /real_use_live_handoff_control_aborted/);
  f.gate.bind(f.bind()); await aborted;
  assert.equal(f.gate.evidence().phase, 'control-aborted');
  assert.equal(f.gate.evidence().model_requests, 0);
  assert.throws(() => f.gate.transport('model.request', f.request), /live_guard_rejected/);
});

test('owned live: release-time mutation and repeated or mixed transport dispatch fail closed', async () => {
  const f = liveFixture(), waiting = f.gate.context(f.context), rejected = assert.rejects(waiting, /live_guard_rejected/);
  f.gate.bind(f.bind()); f.context.messages[0].content[0].text += ' changed while suspended'; await rejected;
  for (const [first, second] of [['http.request', 'http.request'], ['http.request', 'experimental.ws.handshake'],
    ['experimental.ws.handshake', 'http.request'], ['experimental.ws.handshake', 'experimental.ws.handshake'], ['model.request', 'model.request']]) {
    const g = liveFixture(), pending = g.gate.context(g.context); g.gate.bind(g.bind()); await pending;
    if (first !== 'model.request') g.gate.transport('model.request', g.request);
    g.gate.transport(first, g.request);
    assert.throws(() => g.gate.transport(second, g.request), /live_guard_rejected/);
  }
});

test('owned live: tools are session-scoped, single-use, and block the next context until settled', async () => {
  const f = liveFixture(), pending = f.gate.context(f.context); f.gate.bind(f.bind()); await pending;
  f.gate.transport('model.request', f.request); f.gate.transport('http.request', f.request);
  const context = { sessionID: f.template.sessionID, agent: AGENT, messageID: nativeID(2), id: 'call_1' };
  const done = f.gate.tool('compute', context); assert.equal(f.gate.evidence().active_tools, 1);
  done(); done(); assert.equal(f.gate.evidence().active_tools, 0);
  assert.throws(() => f.gate.tool('compute', context), /live_guard_rejected/);
  for (const edit of [{ sessionID: `ses_${randomUUID()}` }, { agent: 'other' }, { messageID: 'msg_invalid' }]) {
    const g = liveFixture(), waiting = g.gate.context(g.context); g.gate.bind(g.bind()); await waiting;
    g.gate.transport('model.request', g.request);
    assert.throws(() => g.gate.tool('compute', { ...context, sessionID: g.template.sessionID, ...edit }), /live_guard_rejected/);
  }
});

function diagnosticFixture(f = liveFixture()) {
  const value = f.gate.diagnostics(), telemetry = createProductionDiagnostics({ 'bench/v4/real-use/bridge.mjs': 'a'.repeat(64) });
  const identity = { incarnation: value.incarnation, session_sha256: value.session_sha256, prompt_sha256: value.prompt_sha256, model_sha256: value.model_sha256 };
  telemetry.bind(identity);
  return { ...f, telemetry, identity };
}

test('native diagnostic snapshots retain bounded release hashes and accepted transport counters after revocation without granting authority', async () => {
  const f = diagnosticFixture();
  for (let i = 0; i < 34; i++) {
    const waiting = f.gate.context(f.context); f.gate.bind(f.bind()); await waiting;
    f.gate.transport('model.request', f.request); f.gate.transport('http.request', f.request);
  }
  assert.throws(() => f.gate.tool('compute', { sessionID: f.template.sessionID, agent: 'wrong' }), /live_guard_rejected/);
  const d = f.gate.diagnostics();
  assert.equal(d.phase, 'revoked'); assert.equal(d.last_failure.stage, 'tool');
  assert.equal(d.last_failure.reason, 'guard_rejected');
  assert.deepEqual(d.transport_counts, { model: 34, http: 34, ws_handshake: 0, ws_send: 0 });
  assert.equal(d.records_count, 34); assert.equal(d.records.length, 32); assert.equal(d.records_truncated, true);
  assert.equal(d.records_sha256, hash(f.gate.evidence().records));
  assert.equal(d.last_pending.message_sha256, hash(f.template.messageID));
  assert.equal(d.pending, null); f.telemetry.guard(d);
  const snapshot = f.telemetry.snapshot();
  assert.equal(snapshot.guard.violations, 1); assert.equal(snapshot.guard.active_tools, 0);
  assert.equal(isOwnedBridge(snapshot), false);
  assert.throws(() => consumeEpisodeCapability(snapshot, {}, {}), /invalid_or_consumed/);
  assert.throws(() => f.gate.transport('model.request', f.request), /live_guard_rejected/);
});

test('diagnostic projection excludes hostile error text, secrets, extra fields and raw IDs; unknown fields stay unknown', async () => {
  const f = diagnosticFixture(), waiting = f.gate.context(f.context); f.gate.bind(f.bind()); await waiting;
  const secret = 'SYNTHETIC_PRIVATE_BEARER_secret', d = f.gate.diagnostics();
  d.headers = { Authorization: secret }; d.endpoint = `https://${secret}.invalid`; d.environment = { SECRET: secret };
  d.stage = secret; d.transport_counts.ws_send = secret; d.records[0].password = secret;
  d.last_failure = { stage: secret, reason: `Error: ${secret}`, stack: secret, at_ms: secret, ordinal: secret };
  f.telemetry.guard(d); f.telemetry.event(secret, new Error(secret));
  f.telemetry.capture({ schema: 'real-use-capture-diagnostics/v1', headers: secret, answer: secret, cancellation_cause: secret });
  f.telemetry.nativeWait(secret);
  const snapshot = f.telemetry.snapshot(), text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, new RegExp(secret)); assert.doesNotMatch(text, /Authorization|https:\/\/|environment|password/);
  assert.doesNotMatch(text, new RegExp(f.template.sessionID)); assert.doesNotMatch(text, new RegExp(f.template.messageID));
  assert.equal(snapshot.guard.transport_counts.ws_send, null); assert.equal(snapshot.native_wait, 'unknown');
  assert.equal(snapshot.guard.last_failure.reason, 'unknown_failure'); assert.equal(snapshot.capture.native_closure_clean, null);
  const file = path.join(mkdtempSync(path.join(APPROVED_TEMP, 'production-diagnostic-redaction-')), 'production-diagnostics.json');
  assert.equal((await f.telemetry.persist(file)).status, 'written');
  assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(secret));
  assert.equal(diagnosticReason(new Error('local_rpc_http_503_rpc_internal')), 'rpc_http_failure');
  assert.equal(diagnosticReason(new Error(`live_guard_rejected ${secret}`)), 'unknown_failure');
  assert.equal(projectGuardDiagnostics(d, {}), null);
  assert.equal(projectGuardDiagnostics({ ...d, session_sha256: 'b'.repeat(64) }, f.identity), null);
  f.telemetry.guard({ ...d, incarnation: randomUUID() });
  assert.deepEqual(f.telemetry.snapshot().guard, snapshot.guard, 'invalid later payload cannot replace cached owned projection');
  f.gate.revoke();
});

test('host telemetry caps records and bytes explicitly and persists only the fixed projection', async () => {
  const f = diagnosticFixture();
  for (let i = 0; i < 1000; i++) f.telemetry.event('status_rpc', 'observed', i);
  f.telemetry.guard(f.gate.diagnostics());
  const snapshot = f.telemetry.snapshot();
  assert.equal(snapshot.events.length, 64); assert.equal(snapshot.events_dropped, 936); assert.equal(snapshot.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 65536);
  const root = mkdtempSync(path.join(APPROVED_TEMP, 'production-diagnostic-test-'));
  const file = path.join(root, 'production-diagnostics.json'), receipt = await f.telemetry.persist(file);
  assert.equal(receipt.status, 'written'); assert.equal(hash(readFileSync(file)), receipt.sha256);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.upstream_cause, 'unknown'); assert.equal(stored.events_dropped, 936);
  assert.equal((await f.telemetry.persist(file)).status, 'write_failed', 'exclusive publication never overwrites an earlier snapshot');
});

test('diagnostic reject/hang cannot hold up owned termination and reports bounded persistence failure without raw errors', async () => {
  for (const mode of ['reject', 'throw', 'hang']) {
    const telemetry = createProductionDiagnostics({}), order = [];
    const writing = telemetry.persist('fixture-never-written.json', 10, () => {
      order.push('write_started');
      if (mode === 'throw') throw new Error('SYNTHETIC_PRIVATE_WRITE_ERROR');
      return mode === 'reject' ? Promise.reject(new Error('SYNTHETIC_PRIVATE_WRITE_ERROR')) : new Promise(() => {});
    });
    // Same non-awaiting ordering used by the owned bridge cleanup. No production
    // bridge/capability is forged by this lifecycle fixture.
    order.push('owned_server_termination_started');
    const result = await writing;
    assert.deepEqual(order, ['write_started', 'owned_server_termination_started']);
    assert.equal(result.status, mode === 'hang' ? 'write_timeout' : 'write_failed');
    assert.equal(result.sha256, null); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
  }
});

test('deadline remains armed while diagnostic persistence hangs and cannot release a pending native request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = diagnosticFixture(), waiting = f.gate.context(f.context), rejected = assert.rejects(waiting, /live_guard_rejected/);
  const clock = createSolverDeadline(10, () => { f.telemetry.event('deadline', 'solver_deadline'); f.gate.revoke(); });
  f.telemetry.guard(f.gate.diagnostics());
  const writing = f.telemetry.persist('fixture-never-written.json', 20, () => new Promise(() => {}));
  t.mock.timers.tick(11); await rejected;
  assert.throws(() => clock.check(true), /live_solver_deadline_or_closure/);
  assert.equal(f.gate.evidence().released, 0); assert.equal(f.gate.evidence().model_requests, 0);
  t.mock.timers.tick(10); assert.equal((await writing).status, 'write_timeout');
  assert.equal(f.telemetry.snapshot().events.at(-1).reason, 'solver_deadline'); clock.disarm();
});

test('guard RPC error and native-wait failure fixtures distinguish observed stage from unknown upstream cause', async () => {
  const f = diagnosticFixture(), waiting = f.gate.context(f.context), rejected = assert.rejects(waiting, /live_guard_rejected/);
  f.telemetry.guard(f.gate.diagnostics());
  try { await Promise.reject(new Error('SYNTHETIC_PRIVATE_RPC_FAILURE')); }
  catch (error) { f.telemetry.event('status_rpc', diagnosticReason(error), 1); f.gate.revoke(); }
  await rejected;
  f.telemetry.nativeWait('failed');
  const snapshot = f.telemetry.snapshot();
  assert.equal(snapshot.events.at(-1).stage, 'status_rpc'); assert.equal(snapshot.events.at(-1).reason, 'unknown_failure');
  assert.equal(snapshot.native_wait, 'failed'); assert.equal(snapshot.upstream_cause, 'unknown');
  assert.equal(snapshot.guard.phase, 'pending', 'cached pre-failure evidence is explicitly not a terminal-state assertion');
  assert.match(snapshot.guard_evidence_scope, /may precede terminal failure/);
  assert.equal(f.gate.evidence().released, 0);
});
