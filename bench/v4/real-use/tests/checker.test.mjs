import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCheckerAdapter, createCheckerDockerTransport, createTestChecker, workerArguments } from '../checker-adapter.mjs';
import { POLICIES, LIMITS, PRIMITIVES, PINS, PROTOCOL, hash, resolveRequest, validateCoreReceipt, validateCoreProvenance } from '../checker/policies.mjs';
import { checkerRequest } from '../grade.mjs';

const request = (p, code = p.positive_control) => checkerRequest('```lean\n' + code + '\n```', {
  theorem: p.policy.theorem, expected_type: p.policy.expected_type, imports: p.policy.imports,
  allowed_axioms: p.policy.allowed_axioms, positive_control: p.positive_control,
});
const id = c => 'sha256:' + c.repeat(64);
const mockBuild = { runtime_image_id: id('a'), core_image_id: id('b'), export_worker_image_id: id('c'), checker_image_id: id('d'), challenges: Object.fromEntries(POLICIES.map(p => [p.task_id, { challenge_export_sha256: 'e'.repeat(64) }])) };
function mockTransport({ exportFailure, checkFailure, oom = false, protocol, exit = 0, cleanupFail = false } = {}) {
  const calls = [], containers = new Map();
  const result = (stdout = '', code = 0, failure = null) => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), code, signal: null, failure });
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'image') return result(JSON.stringify([{ Id: args[2], Os: 'linux', Config: { Labels: { 'org.opencode.eval.checker': args[2] === id('c') ? 'export-v1' : 'data-only-v1' } } }]));
    if (args[0] === 'create') {
      const at = flag => args[args.indexOf(flag) + 1];
      const labels = Object.fromEntries(args.flatMap((v, i) => v === '--label' ? [args[i + 1].split('=')] : []));
      containers.set(at('--name'), { Id: 'f'.repeat(64), Name: '/' + at('--name'), Image: args.includes(id('c')) ? id('c') : id('d'), Config: { Labels: labels, User: '10001:10001' }, HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'] }, Mounts: [], State: { Running: false, OOMKilled: oom, ExitCode: labels['org.opencode.eval.role'] === 'export' ? 0 : exit, Error: '' } });
      return result('f'.repeat(64));
    }
    if (args[0] === 'start') {
      const c = containers.get(args.at(-1)), exporting = c.Config.Labels['org.opencode.eval.role'] === 'export';
      return result(exporting ? 'untrusted export bytes' : protocol ?? JSON.stringify({ schema: 'comparator-check-only/v1', task_id: POLICIES[0].task_id, status: 'accepted' }), exporting ? 0 : exit, exporting ? exportFailure : checkFailure);
    }
    if (args[1] === 'inspect') return result(JSON.stringify([containers.get(args[2])]));
    if (args[1] === 'rm') return result('', cleanupFail ? 1 : 0);
    if (args[1] === 'ls') return result('');
    throw new Error('unexpected_mock_command');
  };
  return { docker, calls };
}

test('frozen registry exactly matches grade checkerRequest, primitives and hash bindings', () => {
  assert.equal(POLICIES.length, 2); assert.equal(PRIMITIVES.length, 26);
  for (const p of POLICIES) assert.equal(resolveRequest(request(p)).task_id, p.task_id);
  const r = request(POLICIES[0]); r.code += '-- changed'; assert.throws(() => resolveRequest(r), /binding/);
  const s = request(POLICIES[0]); s.policy.expected_type = 'False'; s.policy_sha256 = hash(s.policy); assert.throws(() => resolveRequest(s), /unregistered/);
});

test('worker flags use immutable images, no mounts/network, closed task, separate memory limits', () => {
  for (const role of ['export', 'check']) {
    const args = workerArguments({ image: id('a'), role, task: POLICIES[0].task_id, name: 'own', owner: 'owner', run: 'run', episode: 'episode' });
    assert.ok(args.includes('--read-only')); assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.equal(args[args.indexOf('--memory') + 1], role === 'export' ? '2g' : '4g');
    assert.ok(!args.includes('--mount')); assert.ok(!args.includes('-v')); assert.ok(!args.includes('lake'));
  }
});

test('mocked accepted protocol cannot mint trusted receipts; A is removed before B creation', async () => {
  const { docker, calls } = mockTransport(); const a = createTestChecker({ build: mockBuild, docker });
  const r = request(POLICIES[0]), receipt = await a.checker(r);
  assert.equal(receipt.status, 'accepted'); assert.equal(await a.verifyReceipt(receipt, r), false);
  const creates = calls.flatMap((c, i) => c[0] === 'create' ? [i] : []);
  assert.equal(creates.length, 2);
  assert.ok(calls.slice(creates[0], creates[1]).some(c => c[1] === 'rm'));
  assert.ok(calls.slice(creates[0], creates[1]).some(c => c[1] === 'ls'));
});

test('request snapshot survives mutation to a different registered task during deferred A transport', async () => {
  const base = mockTransport(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true, exportedSource;
  const docker = async (args, options) => {
    if (first) { first = false; entered(); await gate; }
    if (args[0] === 'start' && args.at(-1).includes('-export-')) exportedSource = options.stdin.toString();
    return base.docker(args, options);
  };
  const a = createTestChecker({ build: mockBuild, docker });
  const original = request(POLICIES[0]), before = structuredClone(original);
  const pending = a.checker(original); await started;
  Object.assign(original, request(POLICIES[1])); release();
  const receipt = await pending;
  assert.equal(exportedSource, before.code);
  assert.equal(receipt.task_id, POLICIES[0].task_id);
  assert.equal(receipt.code_sha256, before.code_sha256);
  assert.equal(receipt.policy_sha256, before.policy_sha256);
  assert.notEqual(receipt.policy_sha256, original.policy_sha256);
  assert.equal(await a.verifyReceipt(receipt, original), false);
});

test('core reuse rejects wrong pins, recipe, source inputs and reused receipt provenance', () => {
  const dockerfile = fs.readFileSync(new URL('../../../../docker/eval-checker.Dockerfile', import.meta.url), 'utf8');
  const checkonly = fs.readFileSync(new URL('../checker/CheckOnly.lean', import.meta.url), 'utf8');
  const inputs = { dockerfile: hash(dockerfile), checkonly: hash(checkonly) };
  const prior = { schema: 'eval-checker-build/v1', status: 'core_built', pins: PINS, core_image_id: id('a'), base_reference: 'ubuntu@' + id('b'), primitive_list_sha256: hash(PRIMITIVES), protocol_sha256: hash(PROTOCOL), source_hashes: { 'docker/eval-checker.Dockerfile': inputs.dockerfile, 'bench/v4/real-use/checker/CheckOnly.lean': inputs.checkonly, 'scripts/build-eval-checker.ps1': 'a'.repeat(64) } };
  assert.equal(validateCoreReceipt(prior, inputs), prior);
  for (const key of Object.keys(PINS)) assert.throws(() => validateCoreReceipt({ ...prior, pins: { ...PINS, [key]: 'wrong' } }, inputs), /pin_mismatch/);
  assert.throws(() => validateCoreReceipt(prior, { ...inputs, dockerfile: '0'.repeat(64) }), /input_mismatch/);
  assert.throws(() => validateCoreReceipt(prior, { ...inputs, checkonly: '0'.repeat(64) }), /input_mismatch/);
  const text = JSON.stringify(prior), driver = 'original build driver fixture';
  const origin = { receipt_text: text, receipt_sha256: hash(text), dockerfile_text: dockerfile, checkonly_text: checkonly, build_driver_text: driver, build_driver_sha256: hash(driver), original_build_script_sha256: 'a'.repeat(64) };
  assert.equal(validateCoreProvenance(origin, inputs).core_image_id, id('a'));
  assert.throws(() => validateCoreProvenance({ ...origin, receipt_text: text + ' ' }, inputs), /provenance_invalid/);
  assert.throws(() => validateCoreProvenance({ ...origin, dockerfile_text: dockerfile + '\n' }, inputs), /provenance_invalid/);
  assert.throws(() => validateCoreProvenance({ ...origin, build_driver_text: 'new helper pretending to be original' }, inputs), /provenance_invalid/);
  assert.throws(() => validateCoreProvenance({ ...origin, original_build_script_sha256: 'b'.repeat(64) }, inputs), /helper_mismatch/);
  const reused = JSON.stringify({ ...prior, status: 'images_built' });
  assert.throws(() => validateCoreProvenance({ ...origin, receipt_text: reused, receipt_sha256: hash(reused) }, inputs), /pin_mismatch/);
});

test('mocked resource/transport/protocol/cleanup failures never accept', async t => {
  for (const config of [{ exportFailure: 'timeout' }, { exportFailure: 'stdout_overflow' }, { checkFailure: 'timeout' }, { checkFailure: 'stderr_overflow' }, { oom: true }, { protocol: 'Your solution is okay!' }, { protocol: '{"status":"accepted"}' }, { exit: 1 }, { cleanupFail: true }]) {
    await t.test(JSON.stringify(config), async () => {
      const { docker, calls } = mockTransport(config); const a = createTestChecker({ build: mockBuild, docker });
      const receipt = await a.checker(request(POLICIES[0])); assert.equal(receipt.status, 'unavailable');
      if (config.exportFailure || config.oom || config.cleanupFail) assert.equal(calls.filter(c => c[0] === 'create').length, 1);
    });
  }
});

// Real controls are explicit operator opt-in, not mocked CI claims. Output is
// evaluator-private and must be a NEW eval-checker-g004-* directory.
test('ACTUAL two-container independent proofgrader controls', { skip: !process.env.EVAL_CHECKER_BUILD_RECEIPT }, async t => {
  const work = process.env.EVAL_CHECKER_CONTROL_DIR;
  assert.ok(work && path.isAbsolute(work) && path.basename(work).startsWith('eval-checker-g004-'));
  fs.mkdirSync(work); // refuse overwriting prior evidence
  const followup = process.env.EVAL_CHECKER_FOLLOWUP === '1';
  const only = process.env.EVAL_CHECKER_ONLY ? new Set(process.env.EVAL_CHECKER_ONLY.split(',')) : null;
  const followupControls = new Set(['gold_positive_lean-cancellation-repair', 'gold_positive_lean-rational-odd-sum', 'live_request_mutation_binding', 'prepare_valid_artifact', 'changed_allowlisted_axiom', 'changed_primitive_body', 'tampered_quotient', 'duplicate_level_index', 'duplicate_expr_index', 'actual_process_failure_not_accepted', 'actual_memory_limit_not_accepted', 'actual_B_termination', 'actual_B_timeout']);
  const control = (name, fn) => t.test(name, { skip: only ? !only.has(name) : followup && !followupControls.has(name) }, fn);
  const adapter = createCheckerAdapter({ buildReceipt: process.env.EVAL_CHECKER_BUILD_RECEIPT, dockerExecutable: process.env.EVAL_CHECKER_DOCKER, workDirectory: work, runId: 'g004-checker-controls', episodeId: 'pipeline-not-model-solve' });
  const write = (name, value) => fs.writeFileSync(path.join(work, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const workerRecord = (name, r) => {
    const { stdout, stderr, ...record } = r;
    fs.writeFileSync(path.join(work, name + '.stdout'), stdout, { flag: 'wx' });
    fs.writeFileSync(path.join(work, name + '.stderr'), stderr, { flag: 'wx' });
    write(name, { ...record, stdout_sha256: hash(stdout), stderr_sha256: hash(stderr), stdout_bytes: stdout.length });
  };
  for (const p of POLICIES) await control('gold_positive_' + p.task_id, async () => {
    const r = request(p), receipt = await adapter.checker(r); write('positive-' + p.task_id, receipt);
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.cleanup, 'confirmed_absent');
    const wrongCode = request(p, p.positive_control + '\n-- different code');
    const bindings = {
      wrong_code_denied: await adapter.verifyReceipt(receipt, wrongCode) === false,
      changed_receipt_policy_denied: await adapter.verifyReceipt({ ...receipt, policy_sha256: '0'.repeat(64) }, r) === false,
      wrong_request_policy_denied: await adapter.verifyReceipt(receipt, request(POLICIES.find(other => other.task_id !== p.task_id))) === false,
      issued_receipt_verified: await adapter.verifyReceipt(structuredClone(receipt), structuredClone(r)) === true,
      replay_denied: await adapter.verifyReceipt(receipt, r) === false,
    };
    write('positive-binding-' + p.task_id, { request_id: receipt.request_id, code_sha256: r.code_sha256, policy_sha256: r.policy_sha256, ...bindings });
    assert.ok(Object.values(bindings).every(value => value === true));
  });
  await control('live_request_mutation_binding', async () => {
    const incoming = request(POLICIES[0]), snapshot = structuredClone(incoming);
    const pending = adapter.checker(incoming);
    Object.assign(incoming, request(POLICIES[1]));
    const receipt = await pending; write('live-request-mutation', receipt);
    const checks = { correct_task: receipt.task_id === POLICIES[0].task_id, correct_code: receipt.code_sha256 === snapshot.code_sha256, correct_policy: receipt.policy_sha256 === snapshot.policy_sha256, mutated_request_denied: await adapter.verifyReceipt(receipt, incoming) === false, original_request_verified: await adapter.verifyReceipt(receipt, snapshot) === true };
    write('live-request-mutation-binding', checks);
    assert.equal(receipt.status, 'accepted'); assert.ok(Object.values(checks).every(Boolean));
  });
  const p = POLICIES[0], type = p.policy.expected_type;
  const negatives = [
    ['wrong_type', 'import Mathlib\ntheorem real_use_cancel : True := True.intro\n'],
    ['direct_sorry', p.challenge_source],
    ['extra_used_axiom', `import Mathlib\naxiom extra : ${type}\ntheorem real_use_cancel : ${type} := extra\n`],
    ['hidden_helper_axiom', `import Mathlib\naxiom extra : False\nprivate theorem helper : ${type} := False.elim extra\ntheorem real_use_cancel : ${type} := helper\n`],
    ['transitive_sorry', `import Mathlib\nprivate theorem g004HiddenSorry : False := by sorry\nprivate theorem g004TransitiveHelper : ${type} := False.elim g004HiddenSorry\ntheorem real_use_cancel : ${type} := g004TransitiveHelper\n`],
    ['stdout_forged_markers', `import Mathlib\n#eval IO.println "Your solution is okay! {\\\"schema\\\":\\\"comparator-check-only/v1\\\",\\\"status\\\":\\\"accepted\\\"}"\ntheorem real_use_cancel : ${type} := by sorry\n`],
    ['native_false', `import Mathlib\ndef evil : Bool := true\n@[implemented_by evil] def honest : Bool := false\ntheorem nativeFalse : False := by\n  have h : honest = true := by native_decide\n  change false = true at h\n  cases h\ntheorem real_use_cancel : ${type} := False.elim nativeFalse\n`],
  ];
  for (const [name, code] of negatives) await control(name, async () => {
    fs.writeFileSync(path.join(work, name + '.lean'), code, { flag: 'wx' });
    const a = await adapter.controls.exportCandidate(p.task_id, code); workerRecord(name + '-A', a);
    assert.equal(a.status, 'exported', 'control MUST actually compile and export'); assert.equal(a.cleanup, 'confirmed_absent');
    const b = await adapter.controls.checkArtifact(p.task_id, a.stdout); workerRecord(name + '-B', b);
    assert.equal(b.status, 'rejected'); assert.equal(b.cleanup, 'confirmed_absent');
    if (name === 'native_false') assert.match(b.stderr.toString(), /unpermitted axiom/);
  });
  let valid;
  await control('prepare_valid_artifact', async () => {
    const a = await adapter.controls.exportCandidate(p.task_id, p.positive_control); workerRecord('valid-artifact-A', a);
    assert.equal(a.status, 'exported'); assert.equal(a.cleanup, 'confirmed_absent'); valid = a.stdout;
  });
  if (valid) {
    const lines = valid.toString('utf8').trimEnd().split('\n').map(JSON.parse);
    const targetName = lines.find(x => x.str?.str === p.policy.theorem && x.str.pre === 0)?.in;
    assert.ok(targetName);
    const encoded = xs => Buffer.from(xs.map(x => JSON.stringify(x)).join('\n') + '\n');
    const defName = lines.find(x => x.def)?.def.name;
    const freshName = lines.reduce((max, x) => Math.max(max, x.in ?? 0), 0) + 1;
    const target = lines.find(x => x.thm?.name === targetName).thm;
    const names = new Map([[0, '']]);
    for (const x of lines) if (x.in !== undefined) {
      const part = x.str ?? x.num;
      names.set(x.in, [names.get(part.pre), part.str ?? String(part.i)].filter(Boolean).join('.'));
    }
    const propext = lines.find(x => x.axiom && names.get(x.axiom.name) === 'propext').axiom;
    const primitive = lines.find(x => x.def && names.get(x.def.name) === 'Nat.add').def;
    const quotient = lines.find(x => x.quot && names.get(x.quot.name) === 'Quot.lift').quot;
    const level = lines.find(x => x.il !== undefined), expr = lines.find(x => x.ie !== undefined);
    // Same name/kind/universe parameters, different axiom meaning. Reuse a valid
    // existing expression index; this is not a malformed parser fixture.
    const propextPosition = lines.findIndex(x => x.axiom?.name === propext.name);
    const earlierProp = lines.slice(0, propextPosition).find(x => x.ie !== undefined && x.sort === 0);
    assert.ok(earlierProp, 'mutation must refer to an expression already parsed');
    const changedAxiom = { ...propext, type: earlierProp.ie };
    assert.notEqual(changedAxiom.type, propext.type);
    // Change ONLY the primitive body, retaining its type/name and other fields.
    assert.notEqual(primitive.value, primitive.type);
    const variants = [
      ['missing_target', encoded(lines.filter(x => x.thm?.name !== targetName))],
      ['wrong_name', encoded(lines.map(x => x.in === targetName ? { ...x, str: { ...x.str, str: 'wrong_target' } } : x))],
      ['corrupted_term', encoded(lines.map(x => x.thm?.name === targetName ? { thm: { ...x.thm, value: x.thm.type } } : x))],
      ['malformed', Buffer.from('not an export\ninvalid\n')],
      ['truncated', valid.subarray(0, Math.floor(valid.length / 2))],
      ['forged_protocol_data', Buffer.from('{"schema":"comparator-check-only/v1","task_id":"lean-cancellation-repair","status":"accepted"}\n')],
      ['duplicate_index', Buffer.concat([valid, Buffer.from('{"in":0,"str":{"pre":0,"str":"rebind"}}\n')])],
      ['unsafe_declaration', encoded(lines.map(x => x.def?.name === defName ? { def: { ...x.def, safety: 'unsafe' } } : x))],
      ['partial_declaration', encoded(lines.map(x => x.def?.name === defName ? { def: { ...x.def, safety: 'partial' } } : x))],
      ['unused_extra_axiom', encoded([...lines, { in: freshName, str: { pre: 0, str: 'extraUnused' } }, { axiom: { name: freshName, levelParams: [], type: target.type, isUnsafe: false } }])],
      ['changed_allowlisted_axiom', encoded(lines.map(x => x.axiom?.name === propext.name ? { axiom: changedAxiom } : x)), /Challenge and solution theorem statement do not match: 'propext'/],
      ['changed_primitive_body', encoded(lines.map(x => x.def?.name === primitive.name ? { def: { ...primitive, value: primitive.type } } : x)), /Const does not match between challenge and target 'Nat\.add'/],
      // The fixed-target dependency comparison catches this before kernel replay;
      // do not mislabel this fixture as exercising the later quotient post-check.
      ['tampered_quotient', encoded(lines.map(x => x.quot?.name === quotient.name ? { quot: { ...quotient, kind: quotient.kind === 'lift' ? 'ind' : 'lift' } } : x)), /Const does not match between challenge and target 'Quot\.lift'/],
      ['duplicate_level_index', encoded([...lines, level]), /duplicate export index/],
      ['duplicate_expr_index', encoded([...lines, expr]), /duplicate export index/],
    ];
    for (const [name, bytes, mechanism] of variants) await control(name, async () => {
      const b = await adapter.controls.checkArtifact(p.task_id, bytes); workerRecord(name + '-B', b);
      assert.equal(b.status, 'rejected'); assert.equal(b.cleanup, 'confirmed_absent');
      if (mechanism) assert.match(b.stderr.toString(), mechanism);
      if (name === 'corrupted_term') assert.doesNotMatch(b.stderr.toString(), /statement do not match|unpermitted axiom|Unknown export/);
    });
  }
  await control('oversized_data_bounded_before_worker', () => {
    assert.throws(() => adapter.controls.checkArtifact(p.task_id, Buffer.alloc(LIMITS.artifactBytes + 1)), /artifact_limit/);
    write('oversized-data', { status: 'blocked_before_worker', limit: LIMITS.artifactBytes });
  });
  await control('actual_process_failure_not_accepted', async () => {
    const code = 'import Mathlib\n#eval do\n  let _ ← IO.Process.output { cmd := "/usr/bin/python3", args := #["-c", "import os,signal; os.kill(os.getppid(),signal.SIGKILL)"] }\n' + p.positive_control.replace('import Mathlib\n', '');
    const receipt = await adapter.checker(request(p, code)); write('process-failure', receipt);
    assert.equal(receipt.status, 'unavailable'); assert.equal(receipt.outcomes.check, null); assert.equal(receipt.cleanup, 'confirmed_absent');
    assert.equal(receipt.outcomes.export.exit_code, 20);
    assert.match(receipt.outcomes.export.stderr, /"phase": "compile", "returncode": -9/);
  });
  const allocator = "from pathlib import Path; Path('/proc/self/oom_score_adj').write_text('1000'); x=bytearray(3*1024**3)";
  const allocationSupervisor = "import os,subprocess,sys; fd=os.open('/proc/1/fd/2',os.O_WRONLY); os.write(fd,b'G004_ALLOCATION_ATTEMPT_BYTES=3221225472\\n'); r=subprocess.run([sys.executable,'-c'," + JSON.stringify(allocator) + "]); os.write(fd,('G004_ALLOC_CHILD_RETURN_CODE='+str(r.returncode)+'\\n').encode()); sys.exit(42 if r.returncode==-9 else 43)";
  const allocationBody = '#eval do\n  let r ← IO.Process.output { cmd := "/usr/bin/python3", args := #["-c", ' + JSON.stringify(allocationSupervisor) + '] }\n  if r.exitCode != 0 then throw (IO.userError "G004_ALLOCATION_CHILD_FAILED")';
  for (const [name, body, expectedReason] of [
    ['diagnostic_overflow', '#eval IO.println (String.ofList (List.replicate 200000 \'x\'))', 'stderr_overflow'],
    ['timeout', '#eval IO.sleep 130000', 'timeout'],
    ['memory_limit', allocationBody, null],
  ]) await control('actual_' + name + '_not_accepted', async () => {
    const receipt = await adapter.checker(request(p, 'import Mathlib\n' + body + '\n' + p.positive_control.replace('import Mathlib\n', '')));
    write(name, receipt); assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.outcomes.check, null); assert.equal(receipt.cleanup, 'confirmed_absent');
    if (expectedReason) assert.equal(receipt.outcomes.export.reason, expectedReason);
    if (name === 'memory_limit') {
      assert.equal(receipt.outcomes.export.state.OOMKilled, true);
      assert.match(receipt.outcomes.export.stderr, /G004_ALLOCATION_ATTEMPT_BYTES=3221225472/);
      assert.match(receipt.outcomes.export.stderr, /G004_ALLOC_CHILD_RETURN_CODE=-9/);
      // OOM may kill both the allocating child and Lean before Lean can print its
      // IO exception. Require either that specific propagated exception or the
      // launcher's actual compiler SIGKILL return code, never generic failure.
      assert.match(receipt.outcomes.export.stderr, /G004_ALLOCATION_CHILD_FAILED|"phase": "compile", "returncode": -9/);
    }
  });
  // Finite operator fault injection, not submitted code: start the real B binary
  // with its interactive stdin deliberately withheld, then kill it or time out
  // waiting. All Docker operations are real; the same worker cleanup is used.
  // The test-only factory cannot mint trusted receipts. The short timeout here
  // tests lifecycle recovery, not B's unchanged production 120-second budget.
  for (const mode of ['termination', 'timeout']) await control('actual_B_' + mode, async () => {
    assert.ok(valid);
    const build = JSON.parse(fs.readFileSync(process.env.EVAL_CHECKER_BUILD_RECEIPT, 'utf8'));
    const real = createCheckerDockerTransport({ dockerExecutable: process.env.EVAL_CHECKER_DOCKER, workDirectory: work });
    let intervention;
    const faultTransport = async (args, options) => {
      if (args[0] !== 'start') return real(args, options);
      const name = args.at(-1);
      const started = await real(['start', name]); assert.equal(started.code, 0); assert.equal(started.failure, null);
      const inspected = await real(['container', 'inspect', name]);
      const info = JSON.parse(inspected.stdout)[0]; assert.equal(info.State.Running, true);
      intervention = { mode, container: name, actual_binary: '/opt/comparator_check_only', stdin_deliberately_withheld: true, production_wall_ms: LIMITS.wallMs, fixture_wait_ms: mode === 'timeout' ? 1000 : LIMITS.controlMs };
      if (mode === 'termination') {
        const killed = await real(['kill', '--signal', 'KILL', name]); assert.equal(killed.code, 0); assert.equal(killed.failure, null);
      }
      const waited = await real(['wait', name], { timeoutMs: intervention.fixture_wait_ms });
      intervention.wait = { code: waited.code, failure: waited.failure, stdout: waited.stdout.toString(), stderr: waited.stderr.toString() };
      if (mode === 'termination') { assert.equal(waited.code, 0); assert.equal(waited.stdout.toString().trim(), '137'); }
      else assert.equal(waited.failure, 'timeout');
      return mode === 'termination' ? { ...waited, code: 137, stdout: Buffer.alloc(0) } : waited;
    };
    const controlled = createTestChecker({ build, docker: faultTransport });
    const result = await controlled.controls.checkArtifact(p.task_id, valid);
    workerRecord('B-' + mode, result); write('B-' + mode + '-intervention', intervention ?? {});
    assert.equal(result.status, 'unavailable'); assert.equal(result.cleanup, 'confirmed_absent');
    if (mode === 'termination') assert.equal(result.state.ExitCode, 137);
    else { assert.equal(result.reason, 'timeout'); assert.equal(result.state.Running, true); }
  });
  console.log('ACTUAL_CHECKER_CONTROL_EVIDENCE ' + work);
});
