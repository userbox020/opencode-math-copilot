// Operator-only controls. No model, provider, grader, credential or host Lean calls.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeBackend, cleanupOwned, RUNTIME_BACKEND_POLICY, RUNTIME_BACKEND_POLICY_HASH, COMPUTE_WORKER_HASH } from './runtime-backend.mjs';
import { createRuntimeTools, BASELINE_DEFINITIONS, NAVIGATION_DEFINITIONS, RUNTIME_INVENTORY_HASHES } from './runtime-tools.mjs';
import { APPROVED_PATHS, createSnapshotTools } from './lib/snapshot-tools.mjs';
import { createDockerTransport, POLICY as COMPILE_POLICY, POLICY_HASH as COMPILE_POLICY_HASH } from '../../v3/arxivlean/lib/eval-sandbox.mjs';
import { createOwnedLauncher } from './trusted-launch.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const absolute = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value) && path.isAbsolute(value);
const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const backendURL = new URL('./runtime-backend.mjs', import.meta.url).href;
const BASELINE = ['approved_list', 'approved_read', 'approved_search', 'approved_pdf_text', 'compute', 'lean_compile'];
const WRAPPERS = ['math_search', 'math_manuscript'];
const SOURCE_FILES = ['./runtime-controls.mjs', './runtime-backend.mjs', './runtime-tools.mjs', './lib/snapshot-tools.mjs',
  './trusted-launch.mjs', './windows-job.ps1', '../../v3/arxivlean/lib/eval-sandbox.mjs',
  '../../../.opencode/plugins/math-toolkit/scripts/math_compute.py'];
const PROBE_PREFIX = 'REAL_USE_CONTROL:';
const WAIT_CODE = pythonLean(`import time\ntime.sleep(${Math.ceil(COMPILE_POLICY.wallMs / 1000) + 30})\nprint("WAIT_FINISHED")`);
const MATRIX = [[3, -2, 5, 1], [4, 0, -1, 2], [-3, 6, 2, -4], [1, 5, -2, 3]];
const NEGATIVE_PATHS = ['/etc/passwd', '../outside', 'https://example.invalid/source', 'grader-data/gold.json', 'output/report.json', '.opencode/opencode.jsonc'];
export const CONTROL_NAMES = Object.freeze(['inventory_parity', 'source_list', 'source_read', 'source_search', 'source_pdf_physical_page_6',
  'source_negative_paths', 'navigation_wrappers', 'compute_det_589', 'compute_expand', 'compute_factor', 'compute_solve',
  'compute_rational_integral_derivative', 'compute_injection_rejected', 'compute_unknown_operation_rejected',
  'compile_init', 'compile_mathlib', 'compile_wrong_type_expected_failure', 'nonroot_uid', 'immutable_dependencies',
  'scratch_write_read', 'scratch_fresh_invocation', 'host_paths_absent', 'synthetic_environment_absent', 'network_testnet_denied',
  'actual_host_config', 'abort_owned_invocation', 'timeout_owned_invocation', 'output_cap', 'forced_owned_job_crash_recovery',
  'parent_cleanup_owned', 'source_binding_unchanged']);

function fresh(file) {
  try { lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('output_exists: fresh output required');
}
function validateOptions(options) {
  const keys = ['image', 'snapshotRoot', 'snapshotHash', 'dockerExecutable', 'out'];
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(options, key))) throw new Error('invalid_operator_options');
  if (typeof options.image !== 'string' || options.image.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error('immutable_image_id_required');
  if (typeof options.snapshotHash !== 'string' || options.snapshotHash.length !== 64 || !/^[a-f0-9]{64}$/.test(options.snapshotHash)) throw new Error('snapshot_hash_required');
  for (const key of ['snapshotRoot', 'dockerExecutable', 'out']) if (!absolute(options[key])) throw new Error(`absolute_${key}_required`);
  if (process.platform === 'win32' && !/\.exe$/i.test(options.dockerExecutable)) throw new Error('native_docker_executable_required');
  fresh(options.out);
  return Object.freeze({ ...options });
}
export function parseRuntimeControlArgs(args) {
  const names = { '--image': 'image', '--snapshot-root': 'snapshotRoot', '--snapshot-hash': 'snapshotHash', '--docker-executable': 'dockerExecutable', '--out': 'out' };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    if (!key || Object.hasOwn(options, key) || typeof args[i + 1] !== 'string' || args[i + 1].startsWith('--')) throw new Error('invalid_cli_arguments');
    options[key] = args[i + 1];
  }
  return validateOptions(options);
}
function definitions(toolset) {
  return Object.fromEntries(Object.entries(toolset.tools).map(([name, { handler, ...definition }]) => [name, definition]));
}
function assessParity(on, off, evidence) {
  try {
    if (!['fixture', 'local-docker'].includes(evidence) || [on, off].some(tools => tools?.schema !== 'real-use-runtime-tools/v1' || tools.evidence !== evidence ||
      tools.imageInspected !== (evidence === 'local-docker') || tools.admission !== 'not_assessed' || tools.canAuthorizeModelRun !== false || Object.hasOwn(tools, 'productionAdmitted'))) return false;
    if (on.condition !== 'plugin-on' || off.condition !== 'plugin-off' || !same(Object.keys(off.tools).sort(), [...BASELINE].sort()) ||
      !same(Object.keys(on.tools).sort(), [...BASELINE, ...WRAPPERS].sort())) return false;
    for (const name of [...BASELINE, ...WRAPPERS]) {
      const expected = BASELINE_DEFINITIONS[name] ?? NAVIGATION_DEFINITIONS[name];
      if (typeof on.tools[name]?.handler !== 'function' || !same(definitions(on)[name], expected)) return false;
      if (BASELINE.includes(name) && (typeof off.tools[name]?.handler !== 'function' || !same(definitions(off)[name], expected))) return false;
    }
    return on.baselineInventoryHash === RUNTIME_INVENTORY_HASHES.baseline && off.baselineInventoryHash === RUNTIME_INVENTORY_HASHES.baseline &&
      on.inventoryHash === RUNTIME_INVENTORY_HASHES['plugin-on'] && off.inventoryHash === RUNTIME_INVENTORY_HASHES['plugin-off'];
  } catch { return false; }
}

// Strict result assessment: a known expected compiler failure is a CONTROL pass,
// never a mathematical statement/proof pass. Missing/unknown fields fail closed.
function assessRuntime(result, { role, expected, image, evidence, backendId }) {
  const fail = reason => ({ status: 'failed', reason });
  if (!result || result.schema !== `real-use-runtime-${role}/v1` || result.evidence !== evidence || result.image !== image ||
      typeof backendId !== 'string' || result.backend_id !== backendId || result.policy_sha256 !== RUNTIME_BACKEND_POLICY_HASH ||
      result.worker_sha256 !== COMPUTE_WORKER_HASH || result.proof?.status !== 'not_assessed' || typeof result.reason !== 'string') return fail('malformed_or_unbound_runtime_result');
  if (result.status === 'blocked') return result.cleanup === 'not_needed' ? { status: 'blocked', reason: result.reason } : fail('blocked_cleanup_invalid');
  if (result.cleanup !== 'confirmed_absent') return fail('invocation_cleanup_unconfirmed');
  if (!result.diagnostics || typeof result.diagnostics.stdout !== 'string' || typeof result.diagnostics.stderr !== 'string' ||
      result.diagnostics.trust !== 'untrusted_container_output') return fail('missing_diagnostics');
  if (expected === 'compiled') return role === 'compile' && result.status === 'compiled' && result.exit_code === 0 && result.reason === 'compilation_only_not_proof_verification'
    ? { status: 'passed', reason: 'compilation_only_not_assessed' } : fail('expected_compile_success');
  if (expected === 'computed') return role === 'compute' && result.status === 'computed' && result.exit_code === 0 && result.reason === 'bounded_symbolic_result' &&
    result.output?.ok === true && typeof result.output.result === 'string' ? { status: 'passed', reason: 'bounded_compute_result' } : fail('expected_compute_success');
  if (expected === 'rejected') return role === 'compute' && result.status === 'rejected' && result.exit_code === 0 && result.reason === 'worker_input_rejected' &&
    result.output?.ok === false && typeof result.output.error === 'string' && /forbidden|not allowed|syntax/i.test(result.output.error)
    ? { status: 'passed', reason: 'worker_rejected_input' } : fail('expected_worker_rejection');
  if (expected === 'wrong-type') return role === 'compile' && result.status === 'error' && result.reason === 'runtime_nonzero' &&
    Number.isInteger(result.exit_code) && result.exit_code > 0 && /type mismatch|has type/i.test(result.diagnostics.stdout + result.diagnostics.stderr)
    ? { status: 'passed', reason: 'expected_wrong_type_failure_not_math_assessment' } : fail('expected_wrong_type_diagnostic');
  if (['cancelled', 'timeout', 'output_limit'].includes(expected)) return result.status === 'error' && result.reason === expected && !result.output
    ? { status: 'passed', reason: `expected_${expected}` } : fail(`expected_${expected}`);
  return fail('unknown_expectation');
}
function brief(result) {
  if (!result || typeof result !== 'object') return { malformed: true };
  return { result_sha256: hash(result), schema: result.schema, status: result.status, reason: result.reason, evidence: result.evidence,
    exit_code: result.exit_code, cleanup: result.cleanup, proof: result.proof, output: result.output,
    diagnostics: result.diagnostics && { trust: result.diagnostics.trust,
      stdout_bytes: Buffer.byteLength(result.diagnostics.stdout ?? ''), stderr_bytes: Buffer.byteLength(result.diagnostics.stderr ?? ''),
      stdout_sha256: hash(result.diagnostics.stdout ?? ''), stderr_sha256: hash(result.diagnostics.stderr ?? ''),
      stdout_excerpt: (result.diagnostics.stdout ?? '').slice(0, 2048), stderr_excerpt: (result.diagnostics.stderr ?? '').slice(0, 2048) } };
}
function record(name, passed, details = {}) { return { name, status: passed ? 'passed' : 'failed', ...details }; }
function pythonLean(source) {
  return `import Lean\n#eval (do\n  let result ← IO.Process.output { cmd := "/usr/bin/python3", args := #["-I", "-c", ${JSON.stringify(source)}] }\n  if result.exitCode != 0 then\n    throw <| IO.userError s!"control Python failed: {result.exitCode}: {result.stderr}"\n  IO.print result.stdout\n  : IO Unit)\n`;
}
function probeData(result) {
  if (result?.status !== 'compiled') return null;
  const lines = result.diagnostics?.stdout?.split(/\r?\n/).filter(line => line.startsWith(PROBE_PREFIX));
  if (lines?.length !== 1) return null;
  try { return JSON.parse(lines[0].slice(PROBE_PREFIX.length)); } catch { return null; }
}
function sourceBinding() { return SOURCE_FILES.map(relative => ({ source: relative, sha256: hash(readFileSync(new URL(relative, import.meta.url))) })); }
function ledgerRecords(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > RUNTIME_BACKEND_POLICY.ledgerBytes) throw new Error('control_ledger_invalid');
  const text = readFileSync(file, 'utf8');
  // Watchers only use durably newline-terminated records. Recovery itself is the
  // backend's responsibility and must mark a torn suffix unconfirmed.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
}
function ownedCreated(records, owner, image) {
  const header = records[0];
  if (header?.event !== 'owner' || header.identity?.evidence !== 'local-docker' || header.identity.image !== image ||
      !same(header.identity.owner, owner) || header.identity.docker_endpoint !== endpoint || header.identity.docker_endpoint_sha256 !== hash(endpoint)) throw new Error('control_ledger_owner_mismatch');
  const intents = new Map(); const created = [];
  const prefix = `real-use-compile-${hash(owner).slice(0, 12)}-`;
  for (const entry of records.slice(1)) {
    if (entry.event === 'intent' && entry.role === 'compile') {
      if (entry.image !== image || typeof entry.name !== 'string' || !entry.name.startsWith(prefix) ||
          !/^[a-f0-9-]{36}$/.test(entry.name.slice(prefix.length)) ||
          entry.labels?.['org.opencode.eval.owner'] !== owner.nonce || entry.labels?.['org.opencode.eval.run'] !== owner.runId ||
          entry.labels?.['org.opencode.eval.episode'] !== owner.episodeId || entry.labels?.['org.opencode.eval.role'] !== 'compile') throw new Error('control_intent_mismatch');
      intents.set(entry.name, entry);
    }
    if (entry.event === 'created' && intents.has(entry.name)) {
      if (!/^[a-f0-9]{64}$/.test(entry.id)) throw new Error('control_created_id_invalid');
      created.push({ ...intents.get(entry.name), id: entry.id });
    }
  }
  return created;
}
function observeCreated(file, owner, image) {
  const seen = new Set(existsSync(file) ? ownedCreated(ledgerRecords(file), owner, image).map(entry => entry.name) : []);
  let watcher, timer, settled = false, settle;
  const promise = new Promise((resolve, reject) => {
    settle = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); watcher?.close(); error ? reject(error) : resolve(value); };
    const check = () => {
      try {
        if (!existsSync(file)) return;
        const records = ledgerRecords(file); if (!records.length) return;
        const found = ownedCreated(records, owner, image).find(entry => !seen.has(entry.name));
        if (found) settle(null, found);
      } catch { settle(new Error('control_ledger_observation_failed')); }
    };
    watcher = watch(path.dirname(file), check);
    watcher.on('error', () => settle(new Error('control_ledger_watch_failed')));
    timer = setTimeout(() => settle(new Error('control_created_not_observed')), 12000);
    check();
  });
  // A launch can fail before the observer is awaited; cancellation must not create
  // an unhandled rejection while its caller is recovering the owned ledger.
  promise.catch(() => {});
  return { promise, cancel: () => settle(new Error('control_observation_cancelled')) };
}
function inspectFacts(info, intent, owner, image) {
  const labels = info?.Config?.Labels;
  if (info?.Id !== intent.id || info.Name !== `/${intent.name}` || info.Image !== image ||
      labels?.['org.opencode.eval.owner'] !== owner.nonce || labels?.['org.opencode.eval.run'] !== owner.runId ||
      labels?.['org.opencode.eval.episode'] !== owner.episodeId || labels?.['org.opencode.eval.role'] !== 'compile') throw new Error('observed_container_owner_mismatch');
  const h = info.HostConfig ?? {};
  return { inspect_sha256: hash(info), id: info.Id, name: intent.name, running: info.State?.Running,
    user: info.Config?.User, network: h.NetworkMode, ipc: h.IpcMode, readonly: h.ReadonlyRootfs, privileged: h.Privileged,
    memory: h.Memory, memory_swap: h.MemorySwap, nano_cpus: h.NanoCpus, pids: h.PidsLimit, cap_drop: h.CapDrop, cap_add: h.CapAdd,
    security_options: h.SecurityOpt, tmpfs: h.Tmpfs, binds: h.Binds, mounts: info.Mounts, host_mounts: h.Mounts,
    restart: h.RestartPolicy?.Name, ulimits: h.Ulimits };
}
function validHostFacts(f) {
  try {
  if (!f || f.running !== true || f.user !== '10001:10001' || f.network !== 'none' || f.ipc !== 'none' || f.readonly !== true ||
    f.privileged !== false || f.memory !== 2147483648 || f.memory_swap !== 2147483648 || f.nano_cpus !== 2000000000 || f.pids !== 64 ||
    f.restart !== 'no' || !same((f.cap_drop ?? []).map(x => x.toUpperCase()), ['ALL']) || (f.cap_add ?? []).length ||
    !(f.security_options ?? []).some(x => /^no-new-privileges(?::|=)true$/.test(x)) || (f.binds ?? []).length || (f.host_mounts ?? []).length) return false;
  if (!same(Object.keys(f.tmpfs ?? {}).sort(), ['/tmp', '/work'])) return false;
  for (const value of Object.values(f.tmpfs)) if (!['rw', 'noexec', 'nosuid', 'nodev', 'size=64m', 'uid=10001', 'gid=10001', 'mode=700'].every(part => value.split(',').includes(part))) return false;
  if (!Array.isArray(f.mounts) || f.mounts.some(m => m.Type !== 'tmpfs' || !['/work', '/tmp'].includes(m.Destination))) return false;
  return [['nofile', 128], ['fsize', 16777216], ['core', 0]].every(([name, value]) => f.ulimits?.some(limit => limit.Name === name && limit.Soft === value && limit.Hard === value));
  } catch { return false; }
}
async function inspectOwnedOnce(docker, intent, owner, image) {
  // A single bounded observation, not an argument-based policy inference or a
  // machine-wide inventory. If scheduling misses running state it cannot pass.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const result = await docker(['container', 'inspect', intent.name]);
  if (result.code !== 0 || result.signal || result.failure || result.client_config_cleanup !== 'confirmed_removed') throw new Error('control_inspect_failed');
  const info = JSON.parse(result.stdout);
  if (!Array.isArray(info) || info.length !== 1) throw new Error('control_inspect_invalid');
  return inspectFacts(info[0], intent, owner, image);
}
function makeReport(evidence, binding, controls, invocations, cleanup) {
  const all = CONTROL_NAMES.map(name => controls.find(control => control.name === name) ?? { name, status: 'blocked', reason: 'control_not_executed' });
  for (const control of all) {
    if (!['passed', 'failed', 'blocked'].includes(control.status)) { control.status = 'failed'; control.reason = 'unknown_control_status'; }
    const calls = invocations.filter(call => call.control === control.name && call.started);
    if (calls.some(call => call.result?.cleanup !== 'confirmed_absent' || cleanup?.status !== 'confirmed_absent' ||
      call.names.some(name => !cleanup.results?.some(result => result.name === name && result.cleanup === 'confirmed_absent')))) {
      control.status = 'failed'; control.reason = 'started_invocation_cleanup_unconfirmed';
    }
  }
  const summary = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, all.filter(control => control.status === status).length]));
  return freeze({ schema: 'real-use-runtime-controls/v1', evidence, admission: 'not_assessed', canAuthorizeModelRun: false,
    proof: { status: 'not_assessed' }, scope: 'runtime controls only; not global readiness, grading or mathematical accuracy',
    binding, controls: all, invocations, cleanup, summary });
}

let running = false;
export async function runRuntimeControls(operatorOptions) {
  const startedAt = new Date().toISOString(), startedMs = performance.now();
  if (running) throw new Error('runtime_controls_already_running');
  const options = validateOptions(operatorOptions);
  // Verify approved bytes read-only before reserving output or launching anything.
  createSnapshotTools({ snapshotRoot: options.snapshotRoot, expectedManifestHash: options.snapshotHash });
  const snapshotIdentity = realpathSync(options.snapshotRoot);
  const sourcesBefore = sourceBinding();
  const snapshotManifest = JSON.parse(readFileSync(path.join(snapshotIdentity, 'source-manifest.json'), 'utf8'));
  mkdirSync(options.out, { mode: 0o700 });
  const temp = path.join(options.out, 'transport-temp'); mkdirSync(temp, { mode: 0o700 });
  const tempIdentity = lstatSync(temp);
  // The transport uses os.tmpdir(). Redirect only standard temporary-path variables
  // in this operator process, not arbitrary host environment/configuration.
  const tempKeys = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];
  const savedTemp = tempKeys.map(key => [key, process.env[key]]);
  for (const key of tempKeys) process.env[key] = temp;
  const sentinelKey = `REAL_USE_CONTROL_SENTINEL_${randomUUID().replaceAll('-', '')}`;
  process.env[sentinelKey] = 'synthetic-not-a-credential';
  running = true;
  const owner = { runId: `controls-${randomUUID()}`, episodeId: 'runtime-controls', nonce: randomUUID() };
  const ledgerPath = path.join(options.out, 'owned-containers.ndjson');
  const config = { image: options.image, dockerExecutable: options.dockerExecutable, endpoint, owner, ledgerPath };
  const controls = [], invocations = [];
  const binding = { image: options.image, endpoint, docker_executable: options.dockerExecutable, operator_owner: owner,
    snapshot_root: snapshotIdentity, snapshot_manifest_sha256: options.snapshotHash, snapshot_sources: snapshotManifest.files,
    snapshot_index: snapshotManifest.index, implementation_sources: sourcesBefore,
    runtime_policy: RUNTIME_BACKEND_POLICY, runtime_policy_sha256: RUNTIME_BACKEND_POLICY_HASH,
    compile_policy: COMPILE_POLICY, compile_policy_sha256: COMPILE_POLICY_HASH, compute_worker_sha256: COMPUTE_WORKER_HASH,
    inventory_hashes: RUNTIME_INVENTORY_HASHES, baseline_inventory: BASELINE_DEFINITIONS, navigation_inventory: NAVIGATION_DEFINITIONS };
  let backend, on, off, cleanup = { status: 'unconfirmed', results: [] };
  const add = item => { controls.push(item); return item; };
  const attempt = async (name, action) => {
    try { return await action(); } catch { return add({ name, status: 'blocked', reason: 'control_execution_unavailable' }); }
  };
  async function invoke(control, role, input, expected, callOptions = {}) {
    const invocationStarted = performance.now();
    const before = new Set(ledgerRecords(ledgerPath).filter(entry => entry.event === 'intent').map(entry => entry.name));
    const result = await off.tools[role === 'compile' ? 'lean_compile' : 'compute'].handler(input, callOptions);
    const names = ledgerRecords(ledgerPath).filter(entry => entry.event === 'intent' && !before.has(entry.name)).map(entry => entry.name);
    invocations.push({ control, role, started: names.length > 0, names, elapsed_ms: Math.round(performance.now() - invocationStarted), result: brief(result) });
    const assessment = assessRuntime(result, { role, expected, image: options.image, evidence: 'local-docker', backendId: backend.identity.backend_id });
    return { result, assessment };
  }
  async function compute(name, input, expectedValue) {
    return attempt(name, async () => {
      const { result, assessment } = await invoke(name, 'compute', input, 'computed');
      add({ name, ...assessment, ...(assessment.status === 'passed' && result.output.result !== expectedValue ? { status: 'failed', reason: 'unexpected_exact_symbolic_result' } : {}) });
    });
  }
  async function compile(name, code, expected = 'compiled', callOptions) {
    const outcome = await invoke(name, 'compile', { code }, expected, callOptions);
    add({ name, ...outcome.assessment }); return outcome;
  }
  async function python(name, source, predicate) {
    return attempt(name, async () => {
      const { result, assessment } = await invoke(name, 'compile', { code: pythonLean(source) }, 'compiled');
      const data = probeData(result);
      add({ name, ...assessment, observed: data, ...(assessment.status === 'passed' && (!data || !predicate(data)) ? { status: 'failed', reason: 'probe_assertion_failed' } : {}) });
    });
  }
  const printJSON = expression => `print(${JSON.stringify(PROBE_PREFIX)} + json.dumps(${expression}, sort_keys=True))`;
  try {
    backend = createRuntimeBackend(config);
    const toolConfig = { snapshotRoot: options.snapshotRoot, expectedManifestHash: options.snapshotHash, backend };
    on = await createRuntimeTools({ ...toolConfig, condition: 'plugin-on' });
    off = await createRuntimeTools({ ...toolConfig, condition: 'plugin-off' });
    binding.backend_identity = backend.identity;
    binding.image_inspection_sha256 = off.imageInspectionHash;
    const parity = assessParity(on, off, 'local-docker');
    add(record('inventory_parity', parity));
    if (!parity) throw new Error('runtime_tools_not_ready');
    const both = handler => [off, on].map(handler);
    for (const [name, handler, predicate] of [
      ['source_list', tools => tools.approved_list.handler({}), result => same(result.sources?.map(source => source.path), APPROVED_PATHS)],
      ['source_read', tools => {
        const reads = APPROVED_PATHS.slice(0, 2).map(logical => tools.approved_read.handler({ path: logical, limit: 20 }));
        return { reads, manifest_sha256: reads[0].manifest_sha256 };
      }, result => result.reads?.length === 2 && result.reads.every((read, i) => read.path === APPROVED_PATHS[i] && read.lines?.some(line => line.text.length) && read.manifest_sha256 === options.snapshotHash)],
      ['source_search', tools => tools.approved_search.handler({ query: 'Kaplansky', limit: 5 }), result => result.matches?.length > 0 && result.matches.every(match => APPROVED_PATHS.includes(match.path))],
      ['source_pdf_physical_page_6', tools => tools.approved_pdf_text.handler({ path: APPROVED_PATHS[2], pages: '6' }), result => result.pages?.length === 1 && result.pages[0].page === 6 && result.pages[0].text.trim().length > 0 && same(result.scope?.returned_physical_pages, [6])],
    ]) await attempt(name, async () => {
      const outputs = both(set => handler(set.tools));
      add(record(name, outputs.every(predicate) && same(outputs[0], outputs[1]) && outputs.every(output => output.manifest_sha256 === options.snapshotHash), { output_sha256: outputs.map(hash) }));
    });
    await attempt('source_negative_paths', async () => {
      const checks = [];
      for (const set of [off, on]) for (const target of NEGATIVE_PATHS) {
        let rejected = false;
        try { set.tools.approved_read.handler({ path: target }); } catch (error) { rejected = /^path_(rejected|not_approved)$/.test(error.message); }
        checks.push({ condition: set.condition, path: target, rejected });
      }
      add(record('source_negative_paths', checks.every(check => check.rejected), { checks }));
    });
    await attempt('navigation_wrappers', async () => {
      const search = on.tools.math_search.handler({ query: 'Kaplansky', limit: 3 });
      const manuscript = on.tools.math_manuscript.handler({ path: APPROVED_PATHS[0] });
      add(record('navigation_wrappers', search.results?.length > 0 && manuscript.source?.path === APPROVED_PATHS[0] && manuscript.manifest_sha256 === options.snapshotHash,
        { output_sha256: [hash(search), hash(manuscript)] }));
    });
    await compute('compute_det_589', { operation: 'det', matrix: MATRIX }, '589');
    await compute('compute_expand', { operation: 'expand', expression: '(x+1)^2' }, 'x**2 + 2*x + 1');
    await compute('compute_factor', { operation: 'factor', expression: 'x^2-1' }, '(x - 1)*(x + 1)');
    await compute('compute_solve', { operation: 'solve', expression: 'x^2-4', variable: 'x' }, '[-2, 2]');
    await attempt('compute_rational_integral_derivative', async () => {
      const name = 'compute_rational_integral_derivative';
      const expression = '(3*x+5)/(x^2+3*x+2)', reference = '2*log(x+1)+log(x+2)';
      const run = async input => {
        const value = await invoke(name, 'compute', input, 'computed');
        if (value.assessment.status !== 'passed') { add({ name, ...value.assessment }); return null; }
        return value.result.output.result;
      };
      const partial = await run({ operation: 'simplify', expression: `(${expression})-(2/(x+1)+1/(x+2))` }); if (partial === null) return;
      const integral = await run({ operation: 'integrate', expression, variable: 'x' }); if (integral === null) return;
      const equality = await run({ operation: 'simplify', expression: `(${integral})-(${reference})` }); if (equality === null) return;
      const derivative = await run({ operation: 'diff', expression: integral, variable: 'x' }); if (derivative === null) return;
      const residual = await run({ operation: 'simplify', expression: `(${derivative})-(${expression})` }); if (residual === null) return;
      add(record(name, partial === '0' && equality === '0' && residual === '0', { partial_fractions: '2/(x+1)+1/(x+2)', reference_antiderivative: reference,
        domain: 'formal symbolic identity away from poles, with compatible logarithm branches', residual }));
    });
    await attempt('compute_injection_rejected', async () => {
      const { assessment } = await invoke('compute_injection_rejected', 'compute', { operation: 'simplify', expression: '__import__("os").getcwd()' }, 'rejected');
      add({ name: 'compute_injection_rejected', ...assessment });
    });
    await attempt('compute_unknown_operation_rejected', async () => {
      const before = hash(readFileSync(ledgerPath)); let rejected = false;
      try { await off.tools.compute.handler({ operation: 'exec', expression: '1' }); }
      catch (error) { rejected = error.message === 'unsupported_compute_operation'; }
      add(record('compute_unknown_operation_rejected', rejected && hash(readFileSync(ledgerPath)) === before, { no_container_intent: hash(readFileSync(ledgerPath)) === before }));
    });
    await attempt('compile_init', () => compile('compile_init', 'import Init\nexample : 2 + 2 = 4 := rfl\n'));
    await attempt('compile_mathlib', () => compile('compile_mathlib', 'import Mathlib\nexample : (3 : Nat) + 4 = 7 := by norm_num\n'));
    await attempt('compile_wrong_type_expected_failure', () => compile('compile_wrong_type_expected_failure', 'import Init\ndef runtimeControlWrongType : Nat := "not a Nat"\n', 'wrong-type'));
    await python('nonroot_uid', `import os,json\n${printJSON('{"uid":os.getuid(),"gid":os.getgid()}')}`, data => data.uid === 10001 && data.gid === 10001);
    await python('immutable_dependencies', `import os,json,errno\nresults=[]\nfor base in ["/opt/lean", "/opt/mathlib", "/opt/mathlib/.lake/build/lib/lean", "/opt/mathlib/.lake/packages/batteries"]:\n try:\n  fd=os.open(base+"/runtime-control-write-probe",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\n  os.close(fd)\n  results.append({"base":base,"denied":False})\n except OSError as e:\n  results.append({"base":base,"denied":e.errno in [errno.EROFS,errno.EACCES,errno.EPERM],"errno":e.errno})\n${printJSON('{"writes":results}')}`,
      data => data.writes?.length === 4 && data.writes.every(item => item.denied === true));
    const marker = `/work/runtime-control-${randomUUID()}`;
    await python('scratch_write_read', `import json,pathlib\np=pathlib.Path(${JSON.stringify(marker)})\np.write_text("fresh-owned-marker")\n${printJSON('{"readback":p.read_text()}')}`, data => data.readback === 'fresh-owned-marker');
    await python('scratch_fresh_invocation', `import json,pathlib\n${printJSON(`{"marker_absent":not pathlib.Path(${JSON.stringify(marker)}).exists()}`)}`, data => data.marker_absent === true);
    const absentPaths = ['/math', '/work/math', '/var/run/docker.sock', '/opt/checker', '/grader', '/grader-data', '/host', '/run/host', '/mnt/host', '/workspace', '/root/.config/opencode', '/work/.opencode'];
    await python('host_paths_absent', `import os,json\npaths=${JSON.stringify(absentPaths)}\n${printJSON('{"paths":[{"path":p,"absent":not os.path.lexists(p)} for p in paths]}')}`,
      data => same(data.paths?.map(item => item.path), absentPaths) && data.paths.every(item => item.absent === true));
    await python('synthetic_environment_absent', `import os,json\n${printJSON(`{"synthetic_sentinel_absent":${JSON.stringify(sentinelKey)} not in os.environ}`)}`, data => data.synthetic_sentinel_absent === true);
    await python('network_testnet_denied', `import socket,json\ns=socket.socket()\ns.settimeout(1.0)\ncode=None\ntry:\n s.connect(("198.51.100.1",9))\n code=0\nexcept OSError as e:\n code=e.errno\nfinally:\n s.close()\n${printJSON('{"testnet_address":"198.51.100.1","errno":code}')}`, data => data.testnet_address === '198.51.100.1' && [1, 13, 101, 113].includes(data.errno));
    await attempt('actual_host_config', async () => {
      const observer = observeCreated(ledgerPath, owner, options.image), controller = new AbortController();
      const execution = invoke('abort_owned_invocation', 'compile', { code: WAIT_CODE }, 'cancelled', { signal: controller.signal });
      execution.catch(() => {});
      let facts;
      try {
        const intent = await observer.promise;
        facts = await inspectOwnedOnce(createDockerTransport({ dockerExecutable: options.dockerExecutable, endpoint }), intent, owner, options.image);
        add(record('actual_host_config', validHostFacts(facts), { observed: facts }));
      } finally {
        controller.abort(); observer.cancel();
        const { assessment } = await execution;
        add({ name: 'abort_owned_invocation', ...assessment });
      }
    });
    await attempt('timeout_owned_invocation', () => compile('timeout_owned_invocation', WAIT_CODE, 'timeout'));
    await attempt('output_cap', () => compile('output_cap', pythonLean('print("X" * 196608)'), 'output_limit'));
    await attempt('forced_owned_job_crash_recovery', async () => {
      if (process.platform !== 'win32') { add({ name: 'forced_owned_job_crash_recovery', status: 'blocked', reason: 'windows_owned_job_required' }); return; }
      const crashOwner = { ...owner, episodeId: 'forced-job-crash', nonce: randomUUID() };
      const crashLedger = path.join(options.out, 'crash-owned-containers.ndjson');
      const crashConfig = { ...config, owner: crashOwner, ledgerPath: crashLedger };
      const observer = observeCreated(crashLedger, crashOwner, options.image);
      let handle, recovery, local;
      try {
        const code = `import {createRuntimeBackend} from ${JSON.stringify(backendURL)}; const b=createRuntimeBackend(${JSON.stringify(crashConfig)}); await b.compile(${JSON.stringify({ code: WAIT_CODE })});`;
        handle = createOwnedLauncher({ executable: process.execPath, args: ['--input-type=module', '-e', code], cwd: options.out,
          env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: temp, TMP: temp }, timeoutMs: 45000, owner: 'runtime-controls-crash', tempRoot: temp });
        const intent = await observer.promise;
        const observed = await inspectOwnedOnce(createDockerTransport({ dockerExecutable: options.dockerExecutable, endpoint }), intent, crashOwner, options.image);
        handle.child.kill(); // Only the exact owned launcher handle; no name/PID sweep.
        local = await handle.closed;
        recovery = await cleanupOwned({ ledgerPath: crashLedger, owner: crashOwner, dockerExecutable: options.dockerExecutable, endpoint });
        add(record('forced_owned_job_crash_recovery', observed.running === true && local.cleanup.confirmed === false && recovery.status === 'confirmed_absent' &&
          recovery.results.some(result => result.name === intent.name && result.cleanup === 'confirmed_absent'), { owned_launcher: local, recovery, observed }));
      } finally {
        observer.cancel();
        if (handle) await handle.cleanupOwned();
        if (!recovery && existsSync(crashLedger)) {
          try { recovery = await cleanupOwned({ ledgerPath: crashLedger, owner: crashOwner, dockerExecutable: options.dockerExecutable, endpoint }); }
          catch { recovery = { status: 'unconfirmed' }; }
          add({ name: 'forced_owned_job_crash_recovery', status: 'failed', reason: 'crash_control_incomplete', recovery });
        }
      }
    });
  } catch {
    // Never echo raw errors, options, environment or Docker configuration.
    if (!controls.some(control => control.name === 'inventory_parity')) add({ name: 'inventory_parity', status: 'blocked', reason: 'runtime_setup_unavailable' });
  } finally {
    if (existsSync(ledgerPath)) {
      try { cleanup = await cleanupOwned({ ledgerPath, owner, dockerExecutable: options.dockerExecutable, endpoint }); }
      catch { cleanup = { status: 'unconfirmed', results: [] }; }
    }
    add(record('parent_cleanup_owned', cleanup.status === 'confirmed_absent', { cleanup }));
    let unchanged = false;
    try {
      createSnapshotTools({ snapshotRoot: options.snapshotRoot, expectedManifestHash: options.snapshotHash });
      unchanged = same(sourceBinding(), sourcesBefore) && realpathSync(options.snapshotRoot) === snapshotIdentity;
    } catch { /* Changes are not accepted as controls evidence. */ }
    add(record('source_binding_unchanged', unchanged));
    delete process.env[sentinelKey];
    for (const [key, value] of savedTemp) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    try {
      const identity = lstatSync(temp);
      if (identity.dev !== tempIdentity.dev || identity.ino !== tempIdentity.ino || identity.isSymbolicLink()) throw new Error('temp_identity_changed');
      rmSync(temp, { recursive: true, maxRetries: 10, retryDelay: 50 });
      binding.control_temp_cleanup = 'confirmed_removed';
    } catch {
      binding.control_temp_cleanup = 'unconfirmed';
      const control = controls.find(item => item.name === 'parent_cleanup_owned');
      control.status = 'failed'; control.reason = 'control_temp_cleanup_unconfirmed';
    }
    running = false;
  }
  binding.execution = { started_at: startedAt, finished_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - startedMs) };
  const report = makeReport('local-docker', binding, controls, invocations, cleanup);
  writeFileSync(path.join(options.out, 'runtime-controls.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}

// Explicitly fixture-only, read-only assessment helpers. Production accepts no
// dependency injection, fixture flag, mutable image, or user-authored readiness.
export const runtimeControlsForTests = Object.freeze({ validateOptions, assessParity, assessRuntime, validHostFacts,
  report: (binding, controls, invocations = [], cleanup = { status: 'confirmed_absent', results: [] }) => makeReport('fixture', binding, controls, invocations, cleanup) });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runRuntimeControls(parseRuntimeControlArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ schema: report.schema, evidence: report.evidence, summary: report.summary, admission: 'not_assessed', canAuthorizeModelRun: false }) + '\n');
    process.exitCode = report.summary.failed || report.summary.blocked ? 1 : 0;
  } catch {
    process.stderr.write('runtime_controls_blocked: require immutable --image, absolute --snapshot-root/--docker-executable/--out, --snapshot-hash and fresh output\n');
    process.exitCode = 2;
  }
}
