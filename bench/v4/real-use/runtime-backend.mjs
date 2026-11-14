import { randomUUID, createHash } from 'node:crypto';
import { closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_ID, POLICY as LEAN_POLICY, POLICY_HASH as LEAN_POLICY_HASH,
  containerArguments, createDockerTransport } from '../../v3/arxivlean/lib/eval-sandbox.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const fail = message => { throw new Error(message); };
function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('invalid_keys');
}
const workerFile = fileURLToPath(new URL('../../../.opencode/plugins/math-toolkit/scripts/math_compute.py', import.meta.url));
const workerBytes = readFileSync(workerFile);
const workerSource = new TextDecoder('utf-8', { fatal: true }).decode(workerBytes);
export const COMPUTE_WORKER_HASH = hash(workerBytes);
export const OPERATIONS = Object.freeze(['simplify', 'factor', 'expand', 'solve', 'diff', 'integrate', 'limit', 'series', 'evalf', 'det', 'eigenvalues']);
const objectSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
export const COMPILE_SCHEMA = freeze(objectSchema({ code: { type: 'string', minLength: 1, maxLength: LEAN_POLICY.sourceBytes } }, ['code']));
export const COMPUTE_SCHEMA = freeze(objectSchema({ operation: { type: 'string', enum: OPERATIONS },
  expression: { type: 'string', minLength: 1, maxLength: 2000 },
  matrix: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'number' } } },
  variable: { type: 'string', minLength: 1, maxLength: 32 },
  point: { anyOf: [{ type: 'string', minLength: 1, maxLength: 2000 }, { type: 'number' }] },
  order: { type: 'integer', minimum: 1, maximum: 50 },
}, ['operation']));
export const RUNTIME_BACKEND_POLICY = freeze({ version: 'real-use-runtime-backend/v1', compile_policy_sha256: LEAN_POLICY_HASH,
  compute_worker_sha256: COMPUTE_WORKER_HASH, compile_schema_sha256: hash(JSON.stringify(COMPILE_SCHEMA)), compute_schema_sha256: hash(JSON.stringify(COMPUTE_SCHEMA)),
  command: { compile: [LEAN_POLICY.command, '--stdin'], compute: ['/usr/bin/python3', '-I', '-c', 'trusted-worker-source', 'bounded-json-data'] },
  jsonBytes: 20000, commandLineCharacters: 28000, outputBytes: LEAN_POLICY.outputBytes, wallMs: LEAN_POLICY.wallMs,
  controlMs: LEAN_POLICY.controlMs, ledgerBytes: 1024 * 1024, maximumContainers: 200,
  runtime_label: 'mathlib-only-v1', ownership: 'exact name/id/image and owner/run/episode/role labels; append intent before create',
  endpoint_binding: 'exact normalized local Docker endpoint and SHA-256 in identity/ledger; recovery must match before queries',
  ledger_recovery: 'validated complete prefix only; damaged or unknown suffix keeps overall cleanup unconfirmed',
  provenance: 'local producer trust; not cryptographic image authentication',
});
export const RUNTIME_BACKEND_POLICY_HASH = hash(JSON.stringify(RUNTIME_BACKEND_POLICY));
const identities = new WeakMap();
export const runtimeBackendIdentity = backend => identities.get(backend) ?? null;
const ok = result => result?.code === 0 && !result.signal && !result.failure && result.client_config_cleanup !== 'unconfirmed';
function resultJSON(result) {
  if (!ok(result)) fail('docker_command_failed');
  try { return JSON.parse(result.stdout); } catch { fail('docker_json_invalid'); }
}
function validateOwner(owner) {
  keys(owner, ['runId', 'episodeId', 'nonce']);
  if (![owner.runId, owner.episodeId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) ||
      typeof owner.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(owner.nonce)) fail('invalid_runtime_owner');
  return freeze({ runId: owner.runId, episodeId: owner.episodeId, nonce: owner.nonce });
}
function localEndpoint(value) {
  const endpoint = value ?? (process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
  if (typeof endpoint !== 'string' || !(/^(?:unix:\/\/\/(?!\/)[^\s\\\0?#]+|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+)$/.test(endpoint))) fail('local_docker_endpoint_required');
  return endpoint;
}
const ownerLabels = (owner, role) => ({ 'org.opencode.eval.owner': owner.nonce, 'org.opencode.eval.run': owner.runId,
  'org.opencode.eval.episode': owner.episodeId, 'org.opencode.eval.role': role });
const sameOwner = (a, b) => ['runId', 'episodeId', 'nonce'].every(key => a?.[key] === b?.[key]);
const sameFile = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
function safeLedger(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('absolute_ledger_path_required');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || path.relative(path.resolve(file), realpathSync(file)) !== '' ||
      stat.size > RUNTIME_BACKEND_POLICY.ledgerBytes || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) fail('ledger_ownership_invalid');
  return stat;
}
function ledgerWriter(file, header) {
  let fd;
  try { fd = openSync(file, 'wx', 0o600); closeSync(fd); }
  catch (error) { if (error.code !== 'EEXIST') fail('ledger_create_failed'); }
  let identity;
  try { identity = safeLedger(file); } catch { fail('ledger_ownership_invalid'); }
  if (identity.size !== 0) fail('fresh_empty_ledger_required');
  let size = 0;
  const append = record => {
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (size + bytes.length > RUNTIME_BACKEND_POLICY.ledgerBytes) fail('ledger_limit');
    let handle;
    try {
      const before = safeLedger(file);
      if (!sameFile(identity, before) || before.size !== size) fail('ledger_changed');
      handle = openSync(file, 'r+');
      if (!sameFile(identity, fstatSync(handle))) fail('ledger_changed');
      if (writeSync(handle, bytes, 0, bytes.length, size) !== bytes.length) fail('ledger_append_failed');
      fsyncSync(handle); size += bytes.length;
    } catch { fail('ledger_append_failed'); }
    finally { if (handle !== undefined) closeSync(handle); }
  };
  append(header);
  return append;
}
export function validateCompileInput(input) {
  keys(input, ['code']);
  if (typeof input.code !== 'string' || !input.code.trim() || Buffer.byteLength(input.code) > LEAN_POLICY.sourceBytes) fail('bounded_code_only_required');
  return { code: input.code };
}
export function validateComputeInput(input) {
  keys(input, ['operation', 'expression', 'matrix', 'variable', 'point', 'order'], ['operation']);
  if (!OPERATIONS.includes(input.operation)) fail('unsupported_compute_operation');
  const expression = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !value.includes('\0');
  if (Object.hasOwn(input, 'expression') && !expression(input.expression)) fail('invalid_compute_expression');
  if (Object.hasOwn(input, 'matrix') && (!Array.isArray(input.matrix) || input.matrix.length < 1 || input.matrix.length > 10 ||
      input.matrix.some(row => !Array.isArray(row) || row.length !== input.matrix.length || row.some(value => typeof value !== 'number' || !Number.isFinite(value))))) fail('invalid_compute_matrix');
  if (['det', 'eigenvalues'].includes(input.operation) ? !Object.hasOwn(input, 'matrix') : !Object.hasOwn(input, 'expression')) fail('missing_compute_input');
  if (Object.hasOwn(input, 'variable') && (typeof input.variable !== 'string' || !input.variable.length || input.variable.length > 32 || input.variable.includes('\0'))) fail('invalid_compute_variable');
  if (Object.hasOwn(input, 'point') && !(expression(input.point) || (typeof input.point === 'number' && Number.isFinite(input.point)))) fail('invalid_compute_point');
  if (Object.hasOwn(input, 'order') && (!Number.isSafeInteger(input.order) || input.order < 1 || input.order > 50)) fail('invalid_compute_order');
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) >= RUNTIME_BACKEND_POLICY.jsonBytes) fail('compute_json_limit');
  return JSON.parse(json);
}
function callOptions(options) {
  keys(options, ['signal'], []);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('invalid_abort_signal');
  return options;
}
function argumentsFor(image, intent, input) {
  const args = containerArguments(image, intent.name, intent.labels['org.opencode.eval.owner']);
  args[args.indexOf('org.opencode.eval.role=compile')] = `org.opencode.eval.role=${intent.role}`;
  args.splice(args.indexOf('--interactive'), 0, '--label', `org.opencode.eval.run=${intent.labels['org.opencode.eval.run']}`,
    '--label', `org.opencode.eval.episode=${intent.labels['org.opencode.eval.episode']}`);
  if (intent.role === 'compute') args.splice(args.indexOf('--entrypoint'), 4, '--entrypoint', '/usr/bin/python3', image, '-I', '-c', workerSource, JSON.stringify(input));
  // Conservative Windows quoting expansion including backslashes and double quotes;
  // leaves space for executable and transport's fixed config/endpoint arguments.
  if (args.reduce((sum, arg) => sum + arg.length + (arg.match(/[\\"]/g)?.length ?? 0) + 3, 0) > RUNTIME_BACKEND_POLICY.commandLineCharacters) fail('runtime_command_line_limit');
  return args;
}
function assertOwned(info, intent, id) {
  if (info?.Name !== `/${intent.name}` || !/^[a-f0-9]{64}$/.test(info.Id ?? '') || info.Image !== intent.image ||
      (id && info.Id !== id) || Object.entries(intent.labels).some(([key, value]) => info.Config?.Labels?.[key] !== value)) fail('cleanup_ownership_mismatch');
  return info.Id;
}
async function cleanIntent(docker, intent, id, uncertain) {
  let found = false;
  const inspected = await docker(['container', 'inspect', intent.name]);
  if (ok(inspected)) {
    const info = resultJSON(inspected);
    if (!Array.isArray(info) || info.length !== 1) fail('cleanup_ownership_mismatch');
    id = assertOwned(info[0], intent, id); found = true;
    if (!ok(await docker(['container', 'rm', '--force', id]))) fail('cleanup_remove_failed');
  } else if (inspected.failure || inspected.signal) fail('cleanup_inspect_failed');
  const remaining = await docker(['container', 'ls', '--all', '--filter', `name=^/${intent.name}$`, '--format', '{{.Names}}']);
  if (!ok(remaining) || remaining.stdout.trim()) fail('cleanup_not_confirmed');
  if (id) {
    const byId = await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}']);
    if (!ok(byId) || byId.stdout.trim()) fail('cleanup_not_confirmed');
  }
  if (!found && uncertain) fail('cleanup_not_confirmed_after_uncertain_create');
  return 'confirmed_absent';
}
function configuration(options) {
  keys(options, ['image', 'dockerExecutable', 'endpoint', 'owner', 'ledgerPath'], ['image', 'owner', 'ledgerPath']);
  if (!IMAGE_ID.test(options.image ?? '')) fail('immutable_image_id_required');
  if (typeof options.ledgerPath !== 'string' || !path.isAbsolute(options.ledgerPath) || options.ledgerPath.includes('\0')) fail('absolute_ledger_path_required');
  return freeze({ ...options, endpoint: localEndpoint(options.endpoint), owner: validateOwner(options.owner) });
}
function makeBackend(config, docker, evidence) {
  const identity = freeze({ schema: 'real-use-runtime-backend-identity/v1', backend_id: randomUUID(), evidence,
    image: config.image, owner: config.owner, policy_sha256: RUNTIME_BACKEND_POLICY_HASH,
    docker_endpoint: config.endpoint, docker_endpoint_sha256: hash(config.endpoint),
    worker_sha256: COMPUTE_WORKER_HASH, producer_trust: 'not_cryptographically_authenticated' });
  const append = ledgerWriter(config.ledgerPath, { schema: 'real-use-container-ledger/v1', event: 'owner', identity });
  let containers = 0;
  async function inspectImage() {
    const info = resultJSON(await docker(['image', 'inspect', config.image]));
    if (!Array.isArray(info) || info.length !== 1) fail('unknown_eval_image');
    const [image] = info;
    if (image.Id !== config.image || image.Os !== 'linux' || image.Config?.Labels?.['org.opencode.eval.runtime'] !== 'mathlib-only-v1') fail('unknown_eval_image');
    if (Object.keys(image.Config.Volumes ?? {}).length || image.Config.OnBuild?.length ||
        (image.Config.Healthcheck?.Test?.length && image.Config.Healthcheck.Test[0] !== 'NONE')) fail('image_volumes_or_hooks_forbidden');
    for (const entry of image.Config.Env ?? []) {
      if (typeof entry !== 'string') fail('unexpected_image_environment');
      const separator = entry.indexOf('=');
      if (separator < 0 || LEAN_POLICY.environment[entry.slice(0, separator)] !== entry.slice(separator + 1)) fail('unexpected_image_environment');
    }
    return freeze({ ...identity, inspect_sha256: hash(JSON.stringify(image)) });
  }
  async function run(role, raw, options = {}) {
    let input;
    const base = { schema: `real-use-runtime-${role}/v1`, evidence, backend_id: identity.backend_id, image: config.image,
      policy_sha256: RUNTIME_BACKEND_POLICY_HASH, worker_sha256: COMPUTE_WORKER_HASH,
      proof: { status: 'not_assessed' }, cleanup: 'not_needed' };
    try { input = role === 'compile' ? validateCompileInput(raw) : validateComputeInput(raw); callOptions(options); }
    catch (error) { return { ...base, status: 'blocked', reason: error.message }; }
    if (options.signal?.aborted) return { ...base, status: 'blocked', reason: 'cancelled' };
    if (containers >= RUNTIME_BACKEND_POLICY.maximumContainers) return { ...base, status: 'blocked', reason: 'runtime_container_budget_exhausted' };
    try { await inspectImage(); } catch { return { ...base, status: 'blocked', reason: 'runtime_image_not_admitted' }; }
    const name = `real-use-${role}-${hash(JSON.stringify(config.owner)).slice(0, 12)}-${randomUUID()}`;
    const intent = { event: 'intent', name, role, image: config.image, labels: ownerLabels(config.owner, role) };
    let args;
    try {
      if (containers >= RUNTIME_BACKEND_POLICY.maximumContainers) fail('runtime_container_budget_exhausted');
      args = argumentsFor(config.image, intent, input); append(intent); containers++;
    }
    catch (error) { return { ...base, status: 'blocked', reason: error.message }; }
    let id, uncertain = true;
    let result = { ...base, status: 'error', reason: 'container_not_started' };
    try {
      const created = await docker(args, { signal: options.signal });
      uncertain = Boolean(created.failure || created.signal);
      if (!ok(created)) fail(created.failure || 'container_create_failed');
      if (!/^[a-f0-9]{64}$/.test(created.stdout.trim())) { uncertain = true; fail('container_id_invalid'); }
      id = created.stdout.trim();
      append({ event: 'created', name, id });
      const inspected = resultJSON(await docker(['container', 'inspect', name]));
      if (!Array.isArray(inspected) || inspected.length !== 1) fail('container_identity_invalid');
      assertOwned(inspected[0], intent, id);
      const execution = await docker(['start', '--attach', '--interactive', id], {
        stdin: role === 'compile' ? input.code : '', timeoutMs: LEAN_POLICY.wallMs, signal: options.signal,
      });
      result = { ...result, exit_code: execution.code, diagnostics: { stdout: execution.stdout, stderr: execution.stderr, trust: 'untrusted_container_output' } };
      if (!ok(execution)) fail(execution.failure || (execution.signal ? 'process_signal' : 'runtime_nonzero'));
      if (Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr) > LEAN_POLICY.outputBytes) fail('output_limit');
      if (role === 'compile') result = { ...result, status: 'compiled', reason: 'compilation_only_not_proof_verification' };
      else {
        let output;
        try { output = JSON.parse(execution.stdout); } catch { fail('compute_output_invalid'); }
        if (!output || typeof output.ok !== 'boolean') fail('compute_output_invalid');
        try { keys(output, output.ok ? ['ok', 'result'] : ['ok', 'error']); } catch { fail('compute_output_invalid'); }
        if (typeof output[output.ok ? 'result' : 'error'] !== 'string') fail('compute_output_invalid');
        result = { ...result, status: output.ok ? 'computed' : 'rejected', reason: output.ok ? 'bounded_symbolic_result' : 'worker_input_rejected', output };
      }
    } catch (error) { result = { ...result, status: 'error', reason: error.message }; delete result.output; }
    finally {
      try { result.cleanup = await cleanIntent(docker, intent, id, uncertain); }
      catch (error) { result = { ...result, status: 'error', reason: error.message, cleanup: 'unconfirmed' }; delete result.output; }
      try { append({ event: 'result', name, ...(id ? { id } : {}), status: result.status, reason: result.reason, cleanup: result.cleanup }); }
      catch { result = { ...result, status: 'error', reason: 'ledger_append_failed' }; delete result.output; }
    }
    return result;
  }
  const backend = freeze({ evidence, identity, inspectImage,
    compile: (input, options) => run('compile', input, options), compute: (input, options) => run('compute', input, options) });
  identities.set(backend, identity);
  return backend;
}

export function createRuntimeBackend(options) {
  const config = configuration(options);
  return makeBackend(config, createDockerTransport({ dockerExecutable: config.dockerExecutable, endpoint: config.endpoint }), 'local-docker');
}
// Test injection cannot acquire a production identity through public fields.
export function createFixtureRuntimeBackend(options, docker) {
  if (typeof docker !== 'function') fail('fixture_transport_required');
  return makeBackend(configuration(options), docker, 'fixture');
}

async function cleanupLedger(options, docker, evidence) {
  const owner = validateOwner(options.owner);
  const endpoint = localEndpoint(options.endpoint);
  let lines, header, ledgerIssue = null;
  try {
    const before = safeLedger(options.ledgerPath);
    const bytes = readFileSync(options.ledgerPath);
    const after = safeLedger(options.ledgerPath);
    if (bytes.length > RUNTIME_BACKEND_POLICY.ledgerBytes || bytes.length !== before.size ||
        !sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('ledger_changed');
    lines = bytes.toString('utf8').split('\n');
    // Only newline-terminated records are committed. Never parse a partial suffix,
    // even if its bytes happen to form valid JSON.
    if (lines.pop() !== '') ledgerIssue = 'ledger_torn_suffix';
    header = JSON.parse(lines.shift());
    keys(header, ['schema', 'event', 'identity']);
    keys(header.identity, ['schema', 'backend_id', 'evidence', 'image', 'owner', 'policy_sha256',
      'docker_endpoint', 'docker_endpoint_sha256', 'worker_sha256', 'producer_trust']);
    validateOwner(header.identity.owner);
    if (header.identity.schema !== 'real-use-runtime-backend-identity/v1' ||
        !/^[a-f0-9-]{36}$/.test(header.identity.backend_id ?? '') || header.identity.worker_sha256 !== COMPUTE_WORKER_HASH ||
        header.identity.producer_trust !== 'not_cryptographically_authenticated') fail('ledger_invalid');
  } catch { fail('ledger_invalid'); }
  if (header?.schema !== 'real-use-container-ledger/v1' || header.event !== 'owner' || !sameOwner(header.identity?.owner, owner) ||
      header.identity?.evidence !== evidence || header.identity.policy_sha256 !== RUNTIME_BACKEND_POLICY_HASH || !IMAGE_ID.test(header.identity.image ?? '')) fail('ledger_owner_mismatch');
  if (header.identity.docker_endpoint !== endpoint || header.identity.docker_endpoint_sha256 !== hash(endpoint)) fail('ledger_endpoint_mismatch');
  const intents = new Map();
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.event === 'intent') {
        keys(record, ['event', 'name', 'role', 'image', 'labels']);
        const prefix = `real-use-${record.role}-${hash(JSON.stringify(owner)).slice(0, 12)}-`;
        if (!['compile', 'compute'].includes(record.role) || typeof record.name !== 'string' || !record.name.startsWith(prefix) ||
            !/^[a-f0-9-]{36}$/.test(record.name.slice(prefix.length)) || record.image !== header.identity.image || intents.has(record.name)) fail('ledger_intent_invalid');
        const expected = ownerLabels(owner, record.role);
        keys(record.labels, Object.keys(expected));
        if (Object.entries(expected).some(([key, value]) => record.labels[key] !== value)) fail('ledger_intent_invalid');
        if (intents.size >= RUNTIME_BACKEND_POLICY.maximumContainers) fail('ledger_limit');
        intents.set(record.name, { intent: record, id: null, uncertain: true });
      } else if (record.event === 'created' || record.event === 'result') {
        keys(record, record.event === 'created' ? ['event', 'name', 'id'] : ['event', 'name', 'id', 'status', 'reason', 'cleanup'],
          record.event === 'created' ? ['event', 'name', 'id'] : ['event', 'name', 'status', 'reason', 'cleanup']);
        const entry = intents.get(record.name);
        if (!entry || (Object.hasOwn(record, 'id') && (!/^[a-f0-9]{64}$/.test(record.id) || (entry.id && entry.id !== record.id)))) fail('ledger_sequence_invalid');
        if (record.event === 'result' && (!['compiled', 'computed', 'rejected', 'error', 'blocked'].includes(record.status) ||
            typeof record.reason !== 'string' || !record.reason || !['confirmed_absent', 'unconfirmed'].includes(record.cleanup))) fail('ledger_result_invalid');
        if (record.id) { entry.id = record.id; entry.uncertain = false; }
        if (record.event === 'result' && record.cleanup === 'confirmed_absent') entry.uncertain = false;
      } else fail('ledger_record_invalid');
    } catch {
      // Do not skip a malformed record and resume trusting later entries: unknown
      // intents may exist after the validated prefix, so total cleanup cannot pass.
      ledgerIssue = 'ledger_invalid_record';
      break;
    }
  }
  if (intents.size > RUNTIME_BACKEND_POLICY.maximumContainers) fail('ledger_limit');
  const results = [];
  for (const { intent, id, uncertain } of intents.values()) {
    try { results.push({ name: intent.name, cleanup: await cleanIntent(docker, intent, id, uncertain) }); }
    catch (error) { results.push({ name: intent.name, cleanup: 'unconfirmed', reason: error.message }); }
  }
  return freeze({ schema: 'real-use-owned-cleanup/v1', evidence,
    status: !ledgerIssue && results.every(result => result.cleanup === 'confirmed_absent') ? 'confirmed_absent' : 'unconfirmed',
    ledger_integrity: ledgerIssue ? 'incomplete' : 'complete', ...(ledgerIssue ? { reason: ledgerIssue } : {}), results });
}
export function cleanupOwned(options) {
  keys(options, ['ledgerPath', 'owner', 'dockerExecutable', 'endpoint'], ['ledgerPath', 'owner']);
  const endpoint = localEndpoint(options.endpoint);
  return cleanupLedger({ ...options, endpoint }, createDockerTransport({ dockerExecutable: options.dockerExecutable, endpoint }), 'local-docker');
}
export function cleanupOwnedForTests(options, docker) {
  keys(options, ['ledgerPath', 'owner', 'endpoint'], ['ledgerPath', 'owner']);
  if (typeof docker !== 'function') fail('fixture_transport_required');
  return cleanupLedger(options, docker, 'fixture');
}
