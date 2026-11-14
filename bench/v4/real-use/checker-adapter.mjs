// Evaluator-only. Never register this factory, its transport, or the check-only
// worker as a model tool. The caller supplies an operator-owned build receipt.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, LIMITS, PINS, POLICIES, PRIMITIVES, PROTOCOL, resolveRequest, validateCoreProvenance } from './checker/policies.mjs';

const IMAGE = /^sha256:[a-f0-9]{64}$/;
const adapterHash = hash(fs.readFileSync(fileURLToPath(import.meta.url)));
const ok = r => r?.code === 0 && !r.signal && !r.failure;
const parse = r => { if (!ok(r)) throw new Error(r?.failure || 'docker_command_failed'); return JSON.parse(r.stdout.toString('utf8')); };

// Separate byte budgets: artifacts are not diagnostics. Empty isolated Docker
// client configuration, fixed local endpoint, no inherited Docker/auth/proxy env.
export function createCheckerDockerTransport({ dockerExecutable, endpoint, workDirectory } = {}) {
  if (typeof dockerExecutable !== 'string' || !path.isAbsolute(dockerExecutable) || dockerExecutable.includes('\0')) throw new Error('absolute_docker_executable_required');
  endpoint ??= process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  if (endpoint !== (process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock')) throw new Error('fixed_local_endpoint_required');
  const root = workDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'eval-checker-g004-client-'));
  if (!path.isAbsolute(root) || !path.basename(root).startsWith('eval-checker-g004-')) throw new Error('owned_checker_directory_required');
  const environment = process.platform === 'win32'
    ? { PATH: `${path.dirname(dockerExecutable)};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, SystemRoot: process.env.SystemRoot }
    : { PATH: '/usr/bin:/bin' };
  return (args, { stdin = Buffer.alloc(0), timeoutMs = LIMITS.controlMs, stdoutBytes = LIMITS.diagnosticBytes, stderrBytes = LIMITS.diagnosticBytes } = {}) => new Promise(resolve => {
    let child, timer, finished = false, failure = null, config, identity;
    const record = path.join(root, `transport-${randomUUID()}`);
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    const finish = (code = null, signal = null) => {
      if (finished) return; finished = true; clearTimeout(timer);
      let cleanup = 'not_created';
      try {
        if (config) {
          const current = fs.lstatSync(config);
          if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('ownership');
          fs.unlinkSync(path.join(config, 'config.json')); fs.rmdirSync(config); cleanup = 'confirmed_removed';
        }
      } catch { failure ??= 'client_config_cleanup_unconfirmed'; cleanup = 'unconfirmed'; }
      const stdout = Buffer.concat(chunks.stdout), stderr = Buffer.concat(chunks.stderr);
      // Operator-private evidence, including the exact hostile artifact passed to
      // B. Filenames are evaluator-generated, never supplied by the submission.
      try {
        fs.writeFileSync(record + '.stdin', stdin, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(record + '.stdout', stdout, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(record + '.stderr', stderr, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(record + '.json', JSON.stringify({ args, timeoutMs, stdoutBytes, stderrBytes, code, signal, failure, client_config_cleanup: cleanup, stdin_sha256: hash(stdin), stdout_sha256: hash(stdout), stderr_sha256: hash(stderr) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      } catch { failure ??= 'evidence_write_failed'; }
      resolve({ code, signal, failure, client_config_cleanup: cleanup, stdout, stderr });
    };
    const stop = why => { failure ??= why; try { child?.kill('SIGKILL'); } catch {} finish(); };
    try {
      config = fs.mkdtempSync(path.join(root, 'client-')); identity = fs.lstatSync(config);
      fs.writeFileSync(path.join(config, 'config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
      child = spawn(dockerExecutable, ['--config', config, '--host', endpoint, ...args], { shell: false, windowsHide: true, env: { ...environment, ...(process.platform === 'win32' ? { TEMP: config, TMP: config } : { TMPDIR: config }) }, stdio: ['pipe', 'pipe', 'pipe'] });
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', value => {
        if (finished) return;
        const b = Buffer.from(value), limit = stream === 'stdout' ? stdoutBytes : stderrBytes;
        chunks[stream].push(b.subarray(0, Math.max(0, limit - sizes[stream]))); sizes[stream] += b.length;
        if (sizes[stream] > limit) stop(`${stream}_overflow`);
      });
      child.on('error', () => stop('transport_error')); child.on('close', finish);
      child.stdin.on('error', () => stop('stdin_error'));
      timer = setTimeout(() => stop('timeout'), timeoutMs); child.stdin.end(stdin);
    } catch { stop('transport_error'); }
  });
}

export function workerArguments({ image, role, task, name, owner, run, episode }) {
  if (!IMAGE.test(image) || !['export', 'check'].includes(role) || !POLICIES.some(p => p.task_id === task)) throw new Error('closed_worker_configuration_required');
  const memory = role === 'export' ? LIMITS.exportMemory : LIMITS.checkerMemory;
  return ['create', '--pull=never', '--name', name, '--label', `org.opencode.eval.owner=${owner}`, '--label', `org.opencode.eval.run=${run}`, '--label', `org.opencode.eval.episode=${episode}`, '--label', `org.opencode.eval.role=${role}`,
    '--interactive', '--network', 'none', '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--memory', memory, '--memory-swap', memory, '--cpus', LIMITS.cpus, '--pids-limit', LIMITS.pids, '--ulimit', 'nofile=128:128', '--ulimit', 'fsize=67108864:67108864', '--ulimit', 'core=0:0', '--restart', 'no', '--ipc', 'none',
    '--tmpfs', '/work:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=700', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=700', '--workdir', '/work',
    '--entrypoint', role === 'export' ? '/usr/bin/python3' : '/opt/comparator_check_only', image, ...(role === 'export' ? ['/opt/export-launcher.py'] : []), task];
}

function validateBuild(build) {
  if (build?.schema !== 'eval-checker-build/v1' || build.status !== 'images_built' || build.cleanup_unconfirmed?.length || ![build.runtime_image_id, build.core_image_id, build.checker_image_id, build.export_worker_image_id].every(x => IMAGE.test(x))) throw new Error('completed_operator_build_required');
  if (canonical(build.pins) !== canonical(PINS) || canonical(build.limits) !== canonical(LIMITS) || build.protocol_sha256 !== hash(PROTOCOL) || build.primitive_list_sha256 !== hash(PRIMITIVES)) throw new Error('build_policy_mismatch');
  const core = validateCoreProvenance(build.core_provenance, {
    dockerfile: hash(fs.readFileSync(new URL('../../../docker/eval-checker.Dockerfile', import.meta.url))),
    checkonly: hash(fs.readFileSync(new URL('./checker/CheckOnly.lean', import.meta.url))),
  });
  if (core.core_image_id !== build.core_image_id || core.base_reference !== build.base_reference) throw new Error('core_image_provenance_mismatch');
  for (const p of POLICIES) {
    const c = build.challenges?.[p.task_id];
    if (c?.policy_sha256 !== p.policy_sha256 || c?.challenge_source_sha256 !== p.challenge_source_sha256 || !/^[a-f0-9]{64}$/.test(c?.challenge_export_sha256)) throw new Error('challenge_binding_invalid');
  }
  for (const [relative, url] of [
    ['bench/v4/real-use/checker-adapter.mjs', import.meta.url],
    ['bench/v4/real-use/checker/CheckOnly.lean', new URL('./checker/CheckOnly.lean', import.meta.url)],
    ['bench/v4/real-use/checker/export-launcher.py', new URL('./checker/export-launcher.py', import.meta.url)],
    ['bench/v4/real-use/checker/policies.mjs', new URL('./checker/policies.mjs', import.meta.url)],
  ]) if (build.source_hashes?.[relative] !== hash(fs.readFileSync(new URL(url)))) throw new Error('checker_source_changed_since_freeze');
}

function adapter(build, docker, evidence, run, episode) {
  // This invocation ledger and random capabilities never come from solver output.
  const ledger = new Map();
  async function imageCheck(image, label) {
    const [info] = parse(await docker(['image', 'inspect', image]));
    if (info.Id !== image || info.Os !== 'linux' || info.Config.Labels?.['org.opencode.eval.checker'] !== label || Object.keys(info.Config.Volumes ?? {}).length || info.Config.OnBuild?.length) throw new Error('checker_image_mismatch');
  }
  async function worker(role, task, input) {
    const owner = randomUUID(), name = `eval-checker-g004-${role}-${owner}`;
    const image = role === 'export' ? build.export_worker_image_id : build.checker_image_id;
    const result = { role, image, container: name, owner, run, episode, cleanup: 'unconfirmed', status: 'unavailable', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let attempted = false;
    try {
      await imageCheck(image, role === 'export' ? 'export-v1' : 'data-only-v1');
      attempted = true;
      const created = await docker(workerArguments({ image, role, task, name, owner, run, episode }));
      if (!ok(created)) throw new Error(created.failure || 'create_failed');
      const [configured] = parse(await docker(['container', 'inspect', name]));
      const hc = configured.HostConfig;
      if (configured.Image !== image || configured.Config.User !== '10001:10001' || hc.NetworkMode !== 'none' || !hc.ReadonlyRootfs || hc.Privileged || !hc.CapDrop?.includes('ALL') || !hc.SecurityOpt?.includes('no-new-privileges=true') || configured.Mounts.some(m => m.Type !== 'tmpfs')) throw new Error('actual_worker_isolation_mismatch');
      result.isolation = { user: configured.Config.User, network: hc.NetworkMode, read_only: hc.ReadonlyRootfs, memory: hc.Memory, memory_swap: hc.MemorySwap, pids: hc.PidsLimit, cap_drop: hc.CapDrop, security_opt: hc.SecurityOpt, mounts: configured.Mounts };
      const r = await docker(['start', '--attach', '--interactive', name], { stdin: input, timeoutMs: LIMITS.wallMs, stdoutBytes: role === 'export' ? LIMITS.artifactBytes : LIMITS.diagnosticBytes });
      result.stdout = Buffer.from(r.stdout); result.stderr = Buffer.from(r.stderr);
      result.exit_code = r.code; result.signal = r.signal; result.failure = r.failure;
      const [info] = parse(await docker(['container', 'inspect', name]));
      if (info.Name !== `/${name}` || info.Image !== image || info.Config.Labels?.['org.opencode.eval.owner'] !== owner || info.Config.Labels?.['org.opencode.eval.run'] !== run || info.Config.Labels?.['org.opencode.eval.episode'] !== episode) throw new Error('worker_identity_mismatch');
      result.state = info.State;
      if (r.failure || r.signal || info.State.Running || info.State.OOMKilled || info.State.Error || info.State.ExitCode !== r.code) throw new Error(r.failure || 'worker_process_failure');
      if (role === 'export') {
        if (r.code !== 0 || !result.stdout.length) throw new Error('compile_export_failed');
        result.status = 'exported';
      } else {
        let protocol;
        try { protocol = JSON.parse(result.stdout.toString('utf8')); } catch { throw new Error('checker_protocol_missing'); }
        if (canonical(Object.keys(protocol).sort()) !== canonical(PROTOCOL.keys) || protocol.schema !== PROTOCOL.schema || protocol.task_id !== task || !['accepted', 'rejected'].includes(protocol.status) || r.code !== (protocol.status === 'accepted' ? 0 : 1)) throw new Error('checker_protocol_invalid');
        result.protocol = protocol; result.status = protocol.status;
      }
    } catch (e) { result.status = 'unavailable'; result.reason = e.message; }
    finally {
      if (!attempted) result.cleanup = 'not_created';
      else try {
        const [info] = parse(await docker(['container', 'inspect', name]));
        if (info.Name !== `/${name}` || info.Image !== image || info.Config.Labels?.['org.opencode.eval.owner'] !== owner || info.Config.Labels?.['org.opencode.eval.run'] !== run || info.Config.Labels?.['org.opencode.eval.episode'] !== episode || !/^[a-f0-9]{64}$/.test(info.Id)) throw new Error('cleanup_identity_mismatch');
        if (!ok(await docker(['container', 'rm', '--force', info.Id]))) throw new Error('cleanup_remove_failed');
        const absent = await docker(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
        if (!ok(absent) || absent.stdout.toString().trim()) throw new Error('cleanup_unconfirmed');
        result.cleanup = 'confirmed_absent';
      } catch (e) { result.status = 'unavailable'; result.reason = e.message; result.cleanup = 'unconfirmed'; }
    }
    return result;
  }
  const summarize = r => { const { stdout, stderr, ...rest } = r; return { ...rest, stdout_sha256: hash(stdout), stdout_bytes: stdout.length, stderr: stderr.toString('utf8'), stderr_sha256: hash(stderr) }; };
  async function checker(request) {
    // Snapshot, validate and bind synchronously before the first await. Never use
    // the caller's mutable object again during this evaluator invocation.
    const snapshot = structuredClone(request);
    const policy = resolveRequest(snapshot), requestCanonical = canonical(snapshot);
    const requestId = randomUUID(), capability = randomUUID();
    const a = await worker('export', policy.task_id, Buffer.from(snapshot.code));
    // A is destroyed and absence confirmed before a fresh B is even created.
    const b = a.status === 'exported' && a.cleanup === 'confirmed_absent' ? await worker('check', policy.task_id, a.stdout) : null;
    const receipt = { schema: 'real-use-checker-receipt/v1', request_id: requestId, capability, evidence, task_id: policy.task_id,
      status: b?.status ?? 'unavailable', code_sha256: snapshot.code_sha256, policy_sha256: snapshot.policy_sha256,
      challenge_source_sha256: policy.challenge_source_sha256, challenge_export_sha256: build.challenges[policy.task_id].challenge_export_sha256,
      candidate_export_sha256: a.status === 'exported' ? hash(a.stdout) : null, adapter_sha256: adapterHash,
      protocol_sha256: hash(PROTOCOL), primitive_list_sha256: hash(PRIMITIVES), limits_sha256: hash(LIMITS), pins: PINS,
      images: { runtime: build.runtime_image_id, core: build.core_image_id, export: build.export_worker_image_id, checker: build.checker_image_id },
      outcomes: { export: summarize(a), check: b ? summarize(b) : null }, cleanup: a.cleanup === 'confirmed_absent' && (!b || b.cleanup === 'confirmed_absent') ? 'confirmed_absent' : 'unconfirmed' };
    ledger.set(requestId, { request: requestCanonical, receipt: canonical(receipt), capability });
    return structuredClone(receipt);
  }
  async function verifyReceipt(receipt, request) {
    try {
      const policy = resolveRequest(request);
      if (receipt?.task_id !== policy.task_id) return false;
      const entry = ledger.get(receipt?.request_id);
      if (!entry || evidence !== 'local-docker' || entry.capability !== receipt.capability || entry.request !== canonical(request) || entry.receipt !== canonical(receipt)) return false;
      ledger.delete(receipt.request_id); // one evaluator consumption, no replay
      return true;
    } catch { return false; }
  }
  // Operator controls use precisely the same workers, but cannot mint receipts.
  const controls = Object.freeze({
    exportCandidate: (task, code) => { if (typeof code !== 'string' || Buffer.byteLength(code) > LIMITS.sourceBytes) throw new Error('source_limit'); return worker('export', task, Buffer.from(code)); },
    checkArtifact: (task, bytes) => { if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.artifactBytes) throw new Error('artifact_limit'); return worker('check', task, bytes); },
  });
  return Object.freeze({ checker, verifyReceipt, controls });
}

export function createCheckerAdapter({ buildReceipt, dockerExecutable, endpoint, workDirectory, runId = randomUUID(), episodeId = randomUUID() } = {}) {
  const build = JSON.parse(fs.readFileSync(buildReceipt, 'utf8')); validateBuild(build);
  return adapter(build, createCheckerDockerTransport({ dockerExecutable, endpoint, workDirectory }), 'local-docker', runId, episodeId);
}

// Deliberately incapable of producing a trusted receipt, even if a fake transport
// emits the accepted protocol. No injection option exists in the production API.
export function createTestChecker({ build, docker }) { return adapter(build, docker, 'test-only', 'test-run', 'test-episode'); }
