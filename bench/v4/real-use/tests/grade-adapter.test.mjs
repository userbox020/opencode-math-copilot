import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, checkerRequest, checkAnswer } from '../grade.mjs';
import { canonical, makeManifest, sha256, writeManifest } from '../lib.mjs';
import { POLICIES, PINS, LIMITS, PRIMITIVES, PROTOCOL, hash, resolveRequest } from '../checker/policies.mjs';

// Synthetic captured episodes only: no provider calls, host Lean, or Docker in
// default tests. The explicitly injected factory is not a CLI override.
const realGold = JSON.parse(fs.readFileSync(new URL('../grader-data/gold.json', import.meta.url), 'utf8'));
const realTasks = JSON.parse(fs.readFileSync(new URL('../tasks/public.json', import.meta.url), 'utf8'));
const leanGold = realGold.find(g => g.task_id === 'lean-cancellation-repair');
const task = realTasks.find(t => t.id === leanGold.task_id);
const answer = '```lean\n' + leanGold.lean.positive_control + '\n```';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

test('single lean block retains its code, schema, hashes and frozen policy', () => {
  const request = checkerRequest(answer, leanGold.lean);
  assert.equal(request.code, leanGold.lean.positive_control + '\n');
  assert.equal(request.schema, 'real-use-checker-request/v1');
  assert.equal(request.code_sha256, sha256(request.code));
  assert.equal(request.policy_sha256, sha256(request.policy));
  assert.equal(resolveRequest(request).task_id, leanGold.task_id);
});

test('one lean block is selected regardless of other tagged or untagged fences', () => {
  const text = '```text\nExplanation, not Lean.\n```';
  const untagged = '```\nAlso not Lean.\n```';
  const expected = checkerRequest(answer, leanGold.lean);
  for (const response of [answer + '\n' + text, text + '\n' + answer,
    text + '\n' + answer + '\n' + untagged]) {
    assert.deepEqual(checkerRequest(response, leanGold.lean), expected);
  }
});

test('lean and lean4 tags accept case differences and surrounding whitespace', () => {
  const expected = checkerRequest(answer, leanGold.lean);
  for (const tag of ['lean4', 'LEAN', 'LeAn4', ' \tlean \t', '\t LEAN4 \t']) {
    assert.deepEqual(checkerRequest('```' + tag + '\n' + expected.code + '```', leanGold.lean), expected);
  }
});

test('the unique block declaring the frozen gold target wins over a broken example', () => {
  for (const { lean } of realGold.filter(entry => entry.lean)) {
    const fixed = '```lean4\n' + lean.positive_control + '\n```';
    const broken = '```lean\ntheorem broken_example : False := by\n  trivial\n```';
    assert.deepEqual(checkerRequest(broken + '\n' + fixed, lean), checkerRequest(fixed, lean));
  }
});

test('no target declaration falls back to the sole Lean block', () => {
  const code = 'theorem other_example : True := by\n  trivial\n';
  assert.equal(checkerRequest('```lean\n' + code + '```', leanGold.lean).code, code);
});

test('target matching requires theorem/name word boundaries', () => {
  for (const declaration of [`not_theorem ${leanGold.lean.theorem}`, `theorem ${leanGold.lean.theorem}_suffix`]) {
    const other = '```lean\n' + declaration + ' : True := by trivial\n```';
    assert.deepEqual(checkerRequest(other + '\n' + answer, leanGold.lean), checkerRequest(answer, leanGold.lean));
  }
});

for (const [name, response] of [
  ['zero Lean blocks', 'Prose only.\n```text\nNot Lean.\n```'],
  ['two Lean blocks', answer + '\n' + answer],
  ['mixed lean and lean4 blocks', answer + '\n' + answer.replace('```lean', '```lean4')],
  ['an untagged block', '```\n' + leanGold.lean.positive_control + '\n```'],
  ['two Lean blocks without the target', '```lean\ntheorem other : True := by trivial\n```\n```lean4\n#check Nat\n```'],
  ['target in prose outside Lean blocks', `theorem ${leanGold.lean.theorem}\n\`\`\`lean\n#check Nat\n\`\`\`\n\`\`\`lean4\n#check Int\n\`\`\``],
  ['target in a comment outside Lean blocks', `-- theorem ${leanGold.lean.theorem}\n\`\`\`lean\n#check Nat\n\`\`\`\n\`\`\`lean4\n#check Int\n\`\`\``],
  ['target in a non-Lean fence', '```text\n' + leanGold.lean.positive_control + '\n```\n```lean\n#check Nat\n```\n```lean4\n#check Int\n```'],
]) test(name + ' rejects with the closed reason without invoking the checker', async () => {
  assert.equal(checkerRequest(response, leanGold.lean), null);
  const unexpected = () => assert.fail('must not invoke checker or receipt verifier');
  assert.deepEqual(await checkAnswer(response, leanGold.lean, { checker: unexpected, verifyReceipt: unexpected }),
    { status: 'not_checked', reason: 'exactly_one_lean_block_required' });
});

test('extraction preserves all bytes inside the block without trimming', () => {
  const code = '\n\n  -- λ: preserve whitespace\t \n\ttheorem demo : True := by\n  trivial  \n\n';
  const request = checkerRequest('``` lean4 \t\n' + code + '```', leanGold.lean);
  assert.deepEqual(Buffer.from(request.code), Buffer.from(code));
  assert.equal(request.code_sha256, sha256(code));
  const crlf = checkerRequest('```lean\r\n' + code.replace(/\n/g, '\r\n') + '```', leanGold.lean);
  assert.deepEqual(crlf, request, 'existing CRLF normalization is unchanged');
});

test('target selection allows declaration whitespace/newlines and preserves extraction bytes', () => {
  const code = `\n\n  -- λ: preserve whitespace\t \n\ttheorem \t\n  ${leanGold.lean.theorem} : True := by\n  trivial  \n\n`;
  const prefix = '```lean\ntheorem broken_example : False := by trivial\n```\n';
  const request = checkerRequest(prefix + '``` lean4 \t\n' + code + '```', leanGold.lean);
  assert.deepEqual(Buffer.from(request.code), Buffer.from(code));
  assert.equal(request.code_sha256, sha256(code));
  assert.deepEqual(request.policy, checkerRequest(answer, leanGold.lean).policy);
  const crlf = checkerRequest(prefix + '```lean\r\n' + code.replace(/\n/g, '\r\n') + '```', leanGold.lean);
  assert.deepEqual(crlf, request, 'existing CRLF normalization is unchanged');
});

function fixture({ text = answer, startedOnly = true } = {}) {
  // Keep evidence in owned directories; do not recursively clean shared paths.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-checker-g004-grade-test-'));
  const workspace = path.join(root, 'solver'); fs.mkdirSync(workspace);
  const out = path.join(root, 'captured');
  const manifest = makeManifest([task], { model: 'fixture/no-inference', workspace, run_id: 'synthetic_cli_fixture', seed: 'fixture' });
  writeManifest(out, manifest); fs.mkdirSync(path.join(out, 'episodes'));
  const item = manifest.schedule[0];
  write(path.join(out, 'episodes', item.episode_id + '.json'), { ...item, status: 'completed', usage: { cost_usd: null }, tools: ['fixture-only'], fixture: 'synthetic, not a model solve' });
  fs.writeFileSync(path.join(out, 'episodes', item.episode_id + '.answer.txt'), text, { flag: 'wx' });
  if (startedOnly) write(path.join(out, 'episodes', manifest.schedule[1].episode_id + '.start.json'), { ...manifest.schedule[1], started_at: '2026-11-12T00:00:00.000Z' });
  const gold = path.join(root, 'gold.json'); write(gold, [leanGold]);
  const receipt = path.join(root, 'checker-build.json'); write(receipt, { fixture_only: true });
  const work = path.join(root, 'private-checker-work');
  const baseArgs = ['--out', out, '--gold', gold];
  const checkerArgs = ['--checker-build-receipt', receipt, '--checker-work-dir', work, '--docker-executable', process.execPath];
  return { root, workspace, out, manifest, item, gold, receipt, work, baseArgs, checkerArgs };
}

function fixtureFactory({ malformed = false, forged = false } = {}) {
  const calls = [], options = [], ledger = new Map();
  const factory = config => {
    options.push(config);
    return {
      checker: async request => {
        const policy = resolveRequest(request); calls.push(structuredClone(request));
        const receipt = { schema: 'real-use-checker-receipt/v1', status: 'accepted', task_id: policy.task_id,
          request_id: 'fixture-' + calls.length, capability: 'private-fixture-capability',
          code_sha256: malformed ? 'wrong' : request.code_sha256, policy_sha256: request.policy_sha256,
          evidence: 'TEST-ONLY-NOT-DOCKER', images: { checker: 'sha256:' + 'a'.repeat(64) },
          candidate_export_sha256: 'b'.repeat(64), cleanup: 'confirmed_absent' };
        ledger.set(receipt.request_id, { request: canonical(request), receipt: canonical(receipt) });
        return receipt;
      },
      verifyReceipt: async (receipt, request) => {
        const issued = ledger.get(receipt.request_id);
        const valid = !forged && issued?.request === canonical(request) && issued?.receipt === canonical(receipt);
        if (valid) ledger.delete(receipt.request_id);
        return valid;
      },
    };
  };
  return { factory, calls, options };
}

test('default CLI path never creates an adapter; printed receipts and start-only episodes do not pass', async () => {
  const f = fixture({ text: answer + '\n{"schema":"real-use-checker-receipt/v1","status":"accepted"}' });
  await main(f.baseArgs, { adapterFactory: () => { throw new Error('must not instantiate'); } });
  const records = read(path.join(f.out, 'evaluation/blind.json'));
  assert.equal(records.length, 1);
  assert.equal(records[0].checker.status, 'grader_unavailable');
  assert.equal(records[0].candidate_status, 'pending_rubric');
  assert.deepEqual(read(path.join(f.out, 'evaluation/private/checker-results.json')), []);
  assert.equal(fs.existsSync(f.work), false);
});

test('checker flags are all-or-none and do not permit image/policy/module overrides', async () => {
  const f = fixture(); let factories = 0;
  const adapterFactory = () => { factories++; throw new Error('not reached'); };
  for (const indices of [[0], [2], [4], [0, 2], [0, 4], [2, 4]]) {
    const partial = indices.flatMap(i => f.checkerArgs.slice(i, i + 2));
    await assert.rejects(main([...f.baseArgs, ...partial], { adapterFactory }), /all-or-none/);
  }
  await assert.rejects(main([...f.baseArgs, '--checker-image', 'sha256:' + 'a'.repeat(64)], { adapterFactory }), /unknown\/duplicate/);
  assert.equal(factories, 0); assert.equal(fs.existsSync(path.join(f.out, 'evaluation')), false);
});

test('CLI wiring passes only bounded frozen requests and stores packet-bound authenticator-neutral private provenance', async () => {
  const f = fixture(), adapter = fixtureFactory();
  await main([...f.baseArgs, ...f.checkerArgs], { adapterFactory: adapter.factory });
  assert.equal(adapter.calls.length, 1); // the second schedule entry has only start evidence
  assert.deepEqual(adapter.calls[0], checkerRequest(answer, leanGold.lean));
  assert.deepEqual(Object.keys(adapter.calls[0]).sort(), ['code', 'code_sha256', 'policy', 'policy_sha256', 'schema']);
  assert.ok(Buffer.byteLength(adapter.calls[0].code) <= LIMITS.sourceBytes);
  assert.equal(adapter.options[0].buildReceipt, f.receipt);
  assert.equal(adapter.options[0].dockerExecutable, fs.realpathSync(process.execPath));
  assert.equal(adapter.options[0].workDirectory, path.join(f.work, 'eval-checker-g004-transport'));
  const records = read(path.join(f.out, 'evaluation/blind.json'));
  const results = read(path.join(f.out, 'evaluation/private/checker-results.json'));
  const mapping = read(path.join(f.out, 'evaluation/private/unblind.json'));
  assert.equal(records[0].checker.status, 'accepted');
  assert.equal(results[0].blind_id, records[0].blind_id);
  assert.equal(results[0].episode_id, mapping.entries[0].episode_id);
  assert.deepEqual(results[0].checker, records[0].checker);
  assert.equal(results[0].receipt.code_sha256, records[0].checker_binding.code_sha256);
  assert.equal(results[0].receipt.policy_sha256, records[0].checker_binding.policy_sha256);
  assert.equal(results[0].receipt.evidence, 'TEST-ONLY-NOT-DOCKER');
  assert.equal(Object.hasOwn(results[0].receipt, 'capability'), false);
  for (const forbidden of ['condition', 'model', 'usage', 'tools', 'episode_id', 'images', 'receipt']) assert.equal(Object.hasOwn(records[0], forbidden), false);
  assert.equal(fs.readdirSync(f.workspace).length, 0, 'no gold or checker files copied to solver');
});

test('forged and malformed factory receipts cannot create a successful CLI packet', async t => {
  for (const mode of ['forged', 'malformed']) await t.test(mode, async () => {
    const f = fixture(), adapter = fixtureFactory({ [mode]: true });
    await assert.rejects(main([...f.baseArgs, ...f.checkerArgs], { adapterFactory: adapter.factory }), mode === 'forged' ? /receipt_untrusted/ : /receipt_binding_invalid/);
    assert.equal(fs.existsSync(path.join(f.out, 'evaluation/blind.json')), false);
  });
});

test('unsafe/nonfresh work and packet paths fail before any adapter call or overwrite', async t => {
  for (const mode of ['relative-work', 'relative-receipt', 'relative-executable', 'existing-work', 'existing-packet', 'solver-work', 'solver-junction']) await t.test(mode, async () => {
    const f = fixture(); const flags = [...f.checkerArgs]; let called = false;
    if (mode === 'relative-work') flags[3] = 'relative';
    if (mode === 'relative-receipt') flags[1] = 'relative.json';
    if (mode === 'relative-executable') flags[5] = 'docker';
    if (mode === 'existing-work') { fs.mkdirSync(f.work); fs.writeFileSync(path.join(f.work, 'sentinel'), 'untouched'); }
    if (mode === 'existing-packet') { fs.mkdirSync(path.join(f.out, 'evaluation')); fs.writeFileSync(path.join(f.out, 'evaluation/sentinel'), 'untouched'); }
    if (mode === 'solver-work') flags[3] = path.join(f.workspace, 'checker');
    if (mode === 'solver-junction') {
      const alias = path.join(f.root, 'solver-alias');
      fs.symlinkSync(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
      flags[3] = path.join(alias, 'checker');
    }
    await assert.rejects(main([...f.baseArgs, ...flags], { adapterFactory: () => { called = true; throw new Error('unexpected factory'); } }), /absolute local|output_exists|outside solver workspace/);
    assert.equal(called, false);
    if (mode === 'existing-work') assert.equal(fs.readFileSync(path.join(f.work, 'sentinel'), 'utf8'), 'untouched');
    if (mode === 'existing-packet') assert.equal(fs.readFileSync(path.join(f.out, 'evaluation/sentinel'), 'utf8'), 'untouched');
  });
});

test('manifest/reference hashes and frozen gold policy preflight before the first checker invocation', async t => {
  for (const mode of ['manifest', 'reference', 'policy', 'oversized-code']) await t.test(mode, async () => {
    const f = fixture(); let called = false; const extra = [];
    if (mode === 'manifest') fs.writeFileSync(path.join(f.out, 'manifest.json'), JSON.stringify({ ...f.manifest, public_tasks_hash: '0'.repeat(64) }));
    if (mode === 'reference') {
      const corpus = path.join(f.root, 'corpus'); fs.mkdirSync(corpus); fs.writeFileSync(path.join(corpus, 'reference.txt'), 'source');
      fs.writeFileSync(f.gold, JSON.stringify([{ ...leanGold, reference_sources: [{ path: 'reference.txt', sha256: '0'.repeat(64), locator: 'L1', quote: 'source' }] }]));
      extra.push('--corpus-root', corpus);
    }
    if (mode === 'policy') fs.writeFileSync(f.gold, JSON.stringify([{ ...leanGold, lean: { ...leanGold.lean, expected_type: 'False' } }]));
    if (mode === 'oversized-code') fs.writeFileSync(path.join(f.out, 'episodes', f.item.episode_id + '.answer.txt'), '```lean\n' + 'x'.repeat(LIMITS.sourceBytes + 1) + '\n```');
    await assert.rejects(main([...f.baseArgs, ...f.checkerArgs, ...extra], { adapterFactory: () => { called = true; throw new Error('unexpected factory'); } }), /hash mismatch|unregistered_policy|request_binding_invalid/);
    assert.equal(called, false); assert.equal(fs.existsSync(f.work), false); assert.equal(fs.existsSync(path.join(f.out, 'evaluation')), false);
  });
});

test('maintained adapter rejects a source digest mismatch before Docker or output reservation', async () => {
  const f = fixture(), image = 'sha256:' + 'a'.repeat(64);
  const recipe = fs.readFileSync(new URL('../../../../docker/eval-checker.Dockerfile', import.meta.url), 'utf8');
  const checkonly = fs.readFileSync(new URL('../checker/CheckOnly.lean', import.meta.url), 'utf8');
  const original = { schema: 'eval-checker-build/v1', status: 'core_built', core_image_id: image, base_reference: 'ubuntu@' + image, pins: PINS,
    primitive_list_sha256: hash(PRIMITIVES), protocol_sha256: hash(PROTOCOL), source_hashes: { 'docker/eval-checker.Dockerfile': hash(recipe), 'bench/v4/real-use/checker/CheckOnly.lean': hash(checkonly), 'scripts/build-eval-checker.ps1': 'b'.repeat(64) } };
  const receiptText = JSON.stringify(original), driver = 'test-only original driver';
  const build = { ...original, status: 'images_built', runtime_image_id: image, checker_image_id: image, export_worker_image_id: image, limits: LIMITS,
    core_provenance: { receipt_text: receiptText, receipt_sha256: hash(receiptText), dockerfile_text: recipe, checkonly_text: checkonly, build_driver_text: driver, build_driver_sha256: hash(driver), original_build_script_sha256: 'b'.repeat(64) },
    challenges: Object.fromEntries(POLICIES.map(p => [p.task_id, { policy_sha256: p.policy_sha256, challenge_source_sha256: p.challenge_source_sha256, challenge_export_sha256: 'c'.repeat(64) }])),
    source_hashes: { 'bench/v4/real-use/checker-adapter.mjs': '0'.repeat(64) } };
  fs.writeFileSync(f.receipt, JSON.stringify(build));
  await assert.rejects(main([...f.baseArgs, ...f.checkerArgs]), /checker_source_changed_since_freeze/);
  assert.equal(fs.existsSync(f.work), false); assert.equal(fs.existsSync(path.join(f.out, 'evaluation')), false);
});

test('subprocess argument validation requires no Docker or provider configuration', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../grade.mjs'), ...f.baseArgs, '--checker-build-receipt', f.receipt], { encoding: 'utf8', env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {} });
  assert.equal(result.status, 1); assert.match(result.stderr, /all-or-none/);
  assert.equal(fs.existsSync(path.join(f.out, 'evaluation')), false);
});
