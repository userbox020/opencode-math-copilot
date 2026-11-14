// Evaluator-only authority. Serialized records bind evidence, never mint authority.
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertFreshOutput, budgetStop, canonical, FRESH_PROFILES, profileForRole, profileRole, profileManifest, makeSchedule, promptBindings, promptFor, PROTOCOL_HASH, sha256, validatePublic } from './lib.mjs';
export { FRESH_PROFILES, profileManifest } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const TEMP = 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode';
export const BRIDGE_API = 'real-use-owned-live-bridge/v1';
export const PINS = Object.freeze({
  prereg: 'a04ad25e701d6006998c8feb596ec260a8483d6f9761310c9fd536e63f63b211',
  amendment: '70adade851570ff1e78b940ef4ba550627cb1c65b3042de3ea301cb135c17847',
  runtime: '6fa5f7a14dc1194b2994678bdab99590a4db6264961ad9370581bf89336fc0e5',
  checker: 'fc4c52bcb67506afd013514bf43f142e9be70128f7aac89e7bf291dc7bd599c6',
  followup: 'b33904aeca66ad9c8f1659b65534c62f9001283692c8bfaf7ba7b516adcb3907',
});
const CONTROL_FILES = Object.freeze({
  runtime: 'runtime-controls-g021-bed9aab2144f/runtime-controls.json',
  checker: 'eval-checker-g004-789fe1d19ce243fda0851cb8601e7712/build-receipt.json',
  followup: 'eval-checker-g004-followup-summary-lbMi2u/followup-summary.json',
});
export const DRIVER_SOURCES = Object.freeze(['admission.mjs', 'execute.mjs', 'run.mjs', 'lib.mjs',
  'bridge.mjs', 'stage.mjs', 'runtime-plugin.js', 'cli-builtins.json'].map(file => `bench/v4/real-use/${file}`));
const approvals = new WeakMap(), capabilities = new WeakMap(), finalizations = new WeakMap();
const fail = reason => { throw new Error(reason); };
const same = (a, b) => canonical(a) === canonical(b);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
// One-file lineage amendment for the extraction-only Lean-block change. The
// historical controls and their pins remain unchanged; the fresh synthetic CLI
// smoke below is the new binding, not a solver outcome. Parent reviews/freezes.
export const GRADER_INTEGRATION_AMENDMENT = freeze({
  schema: 'real-use-grader-integration-amendment/v1', scope: 'operator synthetic CLI smoke not model outcome',
  source: 'bench/v4/real-use/grade.mjs',
  from_sha256: 'e36768e032aaf0a2358bf901b599b8a95b84305e8df3db882929bf02f4a875e1',
  to_sha256: 'cd73166bcd0ec44a67e97569dc3b6da4ac3e1eac9b1f161ac5ed82fd85973722',
  adapter_source: 'bench/v4/real-use/checker-adapter.mjs',
  adapter_sha256: 'bdee73b268b96126a02d757256a8a1cb692f64b62499970388bd7eeb395b54cf',
  policy_sha256: '4fcb2f16300d0ea4116ce6e0420fe5a0d30c45376b77d4b80bd8209f2a53e5e1',
  root: 'eval-checker-g024-grade-cli-Q7xuKv',
  artifacts: {
    summary: { path: 'smoke-summary.json', sha256: 'b27b2718045428faedcd1fca6a0341cd5bf73cf976de56ca65d13b3d9831e89b' },
    results: { path: 'captured-synthetic/evaluation/private/checker-results.json', sha256: '573c58d7fee11c7fe3a291976e7f7c7c18629858479a5d396a4ce5fb5c6ddc5e' },
    requests: { path: 'captured-synthetic/evaluation/private/checker-requests.json', sha256: '1fb458c95a673944ffc1f41825fef5514abddece05353079ce7d27d2beb278eb' },
    blind: { path: 'captured-synthetic/evaluation/blind.json', sha256: '1aaa285824b0e7a9a3924e3fefd4cbb9322bdc89ed869e4e28af98a731f78edd' },
  },
});

// Pure evidence validation for tests and the loader. It cannot mint admission or
// accept alternate pins. Tests supply actual pinned bytes as data, never authority.
export function validateGraderIntegrationAmendment({ sourceHashes, currentGradeHash, currentAdapterHash, artifacts, buildBytes, followupBytes }) {
  const pin = GRADER_INTEGRATION_AMENDMENT;
  const decode = (raw, expected) => {
    if (!Buffer.isBuffer(raw) || sha256(raw) !== expected) fail('grader_integration_evidence_digest_mismatch');
    return JSON.parse(raw);
  };
  const build = decode(buildBytes, PINS.checker), followup = decode(followupBytes, PINS.followup);
  if (!sourceHashes || sourceHashes[pin.source] !== pin.from_sha256 || currentGradeHash !== pin.to_sha256 ||
      sourceHashes[pin.adapter_source] !== pin.adapter_sha256 || currentAdapterHash !== pin.adapter_sha256 ||
      followup.current_source_sha256?.[pin.source] !== pin.from_sha256 ||
      followup.current_source_sha256?.[pin.adapter_source] !== pin.adapter_sha256 ||
      build.source_hashes?.[pin.adapter_source] !== pin.adapter_sha256 || followup.build_receipt_sha256 !== PINS.checker) fail('grader_integration_source_lineage_mismatch');
  const decoded = Object.fromEntries(Object.entries(pin.artifacts).map(([key, value]) => [key, decode(artifacts?.[key], value.sha256)]));
  const { summary, results, requests, blind } = decoded;
  const root = path.join(TEMP, pin.root);
  if (summary.schema !== 'real-use-grade-cli-smoke/v1' ||
      summary.fixture !== 'operator gold positive; synthetic captured episode; NOT a model solve or study score' ||
      summary.cli_exit !== 0 || summary.checker_status !== 'accepted' || summary.no_provider_calls !== true ||
      summary.grade_source_sha256 !== pin.to_sha256 || summary.adapter_sha256 !== pin.adapter_sha256 ||
      summary.build_receipt_sha256 !== PINS.checker || summary.policy_sha256 !== pin.policy_sha256 || summary.cleanup !== 'confirmed_absent' ||
      path.resolve(summary.build_receipt) !== path.resolve(TEMP, CONTROL_FILES.checker) ||
      path.resolve(summary.private_result) !== path.resolve(root, pin.artifacts.results.path) ||
      path.resolve(summary.blind_packet) !== path.resolve(root, pin.artifacts.blind.path) ||
      path.resolve(summary.checker_work) !== path.resolve(root, 'private-checker-work')) fail('grader_integration_summary_mismatch');
  if (![results, requests, blind].every(records => Array.isArray(records) && records.length === 1)) fail('grader_integration_packet_mismatch');
  const result = results[0], request = requests[0].request, packet = blind[0], receipt = result.receipt;
  const policy = build.challenges?.['lean-cancellation-repair'];
  const images = { runtime: build.runtime_image_id, core: build.core_image_id, export: build.export_worker_image_id, checker: build.checker_image_id };
  if (build.schema !== 'eval-checker-build/v1' || build.status !== 'images_built' || policy?.policy_sha256 !== pin.policy_sha256 ||
      !same(summary.images, images) || !same(receipt?.images, images) ||
      !result.episode_id?.startsWith('operator_checker_cli_positive.lean-cancellation-repair.') || result.episode_id !== requests[0].episode_id ||
      result.blind_id !== packet.blind_id || packet.schema !== 'real-use-blind/v1' || packet.task?.id !== 'lean-cancellation-repair' ||
      packet.checker_required !== true || packet.candidate_status !== 'candidate' ||
      request?.schema !== 'real-use-checker-request/v1' || sha256(request.code) !== summary.code_sha256 ||
      request.code_sha256 !== summary.code_sha256 || request.policy_sha256 !== pin.policy_sha256 ||
      receipt?.schema !== 'real-use-checker-receipt/v1' || receipt.task_id !== 'lean-cancellation-repair' || receipt.status !== 'accepted' ||
      receipt.evidence !== 'local-docker' || receipt.adapter_sha256 !== pin.adapter_sha256 || receipt.cleanup !== 'confirmed_absent' ||
      receipt.code_sha256 !== summary.code_sha256 || receipt.policy_sha256 !== pin.policy_sha256 ||
      receipt.challenge_source_sha256 !== policy.challenge_source_sha256 || receipt.challenge_export_sha256 !== policy.challenge_export_sha256 ||
      ![result.checker, packet.checker].every(checker => checker?.status === 'accepted' && checker.code_sha256 === summary.code_sha256 && checker.policy_sha256 === pin.policy_sha256) ||
      !same(packet.checker_binding, { code_sha256: summary.code_sha256, policy_sha256: pin.policy_sha256 })) fail('grader_integration_packet_mismatch');
  for (const [role, status, image] of [['export', 'exported', images.export], ['check', 'accepted', images.checker]]) {
    const outcome = receipt.outcomes?.[role];
    if (outcome?.status !== status || outcome.image !== image || outcome.cleanup !== 'confirmed_absent' ||
        outcome.exit_code !== 0 || outcome.signal !== null || outcome.failure !== null ||
        outcome.state?.Running !== false || outcome.state.ExitCode !== 0 || outcome.state.OOMKilled !== false) fail('grader_integration_cleanup_mismatch');
  }
  return freeze({ sourceHashes: { ...sourceHashes, [pin.source]: pin.to_sha256 }, metadata: {
    schema: pin.schema, scope: pin.scope, source: pin.source, from_sha256: pin.from_sha256, to_sha256: pin.to_sha256,
    adapter_sha256: pin.adapter_sha256, policy_sha256: pin.policy_sha256,
    evidence_sha256: Object.fromEntries(Object.entries(pin.artifacts).map(([key, value]) => [key, value.sha256])),
    build_receipt_sha256: PINS.checker, followup_sha256: PINS.followup,
  } });
}

function loadGraderIntegrationAmendment(sourceHashes) {
  const pin = GRADER_INTEGRATION_AMENDMENT;
  return validateGraderIntegrationAmendment({ sourceHashes,
    currentGradeHash: sha256(bytes(sourceFile(pin.source))), currentAdapterHash: sha256(bytes(sourceFile(pin.adapter_source))),
    artifacts: Object.fromEntries(Object.entries(pin.artifacts).map(([key, value]) => [key, bytes(path.join(TEMP, pin.root, value.path))])),
    buildBytes: bytes(path.join(TEMP, CONTROL_FILES.checker)), followupBytes: bytes(path.join(TEMP, CONTROL_FILES.followup)) });
}
// No positional messages: the pinned CLI reads the exact prompt bytes from stdin.
// This data-only check conveys no URL/session/executable ownership authority:
// production still requires the genuine bridge's private dispatch scope and
// exact native artifact/guard verification before inference is released.
export function nativePromptTransportMatch(launch, prompt, { model = 'opencode-go/deepseek-v4.1-flash', serverURL, sessionID } = {}) {
  const { args, stdin, stdin_sha256 } = launch ?? {};
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0')) ||
      typeof prompt !== 'string' || !prompt.length || prompt.includes('\0') || !Buffer.isBuffer(stdin) ||
      stdin.length > 1024 * 1024 || stdin.includes(0) || !stdin.equals(Buffer.from(prompt)) || stdin_sha256 !== sha256(stdin)) return false;
  const prefix = ['run', '--server', args[2], '--session', args[4], '--model', `${model}#default`, '--agent', 'math-eval', '--format', 'json'];
  const address = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(args[2]);
  if (args.length !== prefix.length || !prefix.every((value, index) => args[index] === value) ||
      !address || Number(address[1]) > 65535 || !/^ses_[A-Za-z0-9_-]+$/.test(args[4]) ||
      (serverURL !== undefined && args[2] !== serverURL) || (sessionID !== undefined && args[4] !== sessionID)) return false;
  return true;
}
// Data-only snapshots: these helpers confer no approval, capability or receipt brand.
export function snapshotEpisodeInputs(manifest, index, item, task) {
  const authoritativeItem = manifest.schedule[index];
  const authoritativeTask = manifest.tasks.find(entry => entry.id === authoritativeItem?.task_id);
  if (!authoritativeItem || !authoritativeTask || !same(item, authoritativeItem) || !same(task, authoritativeTask)) fail('admission_schedule_or_budget_blocked');
  return freeze(structuredClone({ item: authoritativeItem, task: authoritativeTask }));
}
export function snapshotFinishFacts(facts, promptHash, { fresh = false } = {}) {
  if (!facts || facts.prompt_sha256 !== promptHash ||
      !['observed_session_ids', 'observed_models'].every(key => Array.isArray(facts[key]) && facts[key].every(value => typeof value === 'string'))) fail('invalid_finish_observations');
  // AbortSignal deliberately retains live cancellation semantics; all evidence is copied.
  const extra = {};
  if (fresh || facts.final_text !== undefined) {
    if (typeof facts.final_text !== 'string' || Buffer.byteLength(facts.final_text) > 8 * 1024 * 1024 ||
        sha256(facts.final_text) !== facts.final_text_sha256 || !Array.isArray(facts.captured_assistant_message_ids) ||
        !facts.captured_assistant_message_ids.length || facts.captured_assistant_message_ids.length > 200 ||
        !facts.captured_assistant_message_ids.every(id => typeof id === 'string' && id.length <= 200 && /^msg_[A-Za-z0-9_-]+$/.test(id)) ||
        new Set(facts.captured_assistant_message_ids).size !== facts.captured_assistant_message_ids.length ||
        !Number.isFinite(facts.cli_closed_at) || !Number.isFinite(facts.solver_deadline) ||
        facts.cli_closed_at > facts.solver_deadline || typeof facts.native_closure_clean !== 'boolean' ||
        !facts.capture_usage || typeof facts.capture_usage !== 'object' || facts.timeout === true) fail('invalid_fresh_finish_facts');
    for (const key of ['final_text', 'final_text_sha256', 'captured_assistant_message_ids', 'cli_closed_at',
      'native_closure_clean', 'capture_usage', 'solver_deadline', 'cli_cleanup', 'timeout']) {
      if (facts[key] !== undefined) extra[key] = structuredClone(facts[key]);
    }
    freeze(extra);
  }
  return Object.freeze({ observed_session_ids: Object.freeze([...facts.observed_session_ids]),
    observed_models: Object.freeze([...facts.observed_models]), prompt_sha256: facts.prompt_sha256, ...extra, signal: facts.signal });
}
export function snapshotSettledEpisode(episode, item, persisted) {
  let copy;
  try { copy = structuredClone(episode); } catch { fail('invalid_settled_episode'); }
  const jsonData = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(jsonData);
    return value && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(jsonData);
  };
  if (!copy || !jsonData(copy) || !Object.keys(item).every(key => same(copy[key], item[key])) ||
      !['completed', 'failed'].includes(copy.status) ||
      ['safety_failure', 'model_mismatch'].some(key => key in copy && typeof copy[key] !== 'boolean')) fail('invalid_settled_episode');
  if (copy.usage !== null && copy.usage !== undefined) {
    const usage = copy.usage;
    if (typeof usage !== 'object' || Array.isArray(usage)) fail('invalid_settled_usage');
    for (const key of ['known_subtotal', 'coverage', 'completeness']) {
      if (key in usage && (!usage[key] || typeof usage[key] !== 'object' || Array.isArray(usage[key]))) fail('invalid_settled_usage');
    }
    const amount = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    for (const key of ['input_tokens', 'output_tokens', 'cost_usd']) {
      if (key in usage && !amount(usage[key])) fail('invalid_settled_usage');
      if (usage.known_subtotal && key in usage.known_subtotal && !amount(usage.known_subtotal[key])) fail('invalid_settled_usage');
      if (usage.coverage && key in usage.coverage && (!Number.isSafeInteger(usage.coverage[key]) || usage.coverage[key] < 0)) fail('invalid_settled_usage');
      if (usage.completeness?.episode_complete === false && usage[key] != null) fail('invalid_settled_usage');
    }
    if ('steps' in usage && (!Number.isSafeInteger(usage.steps) || usage.steps < 0)) fail('invalid_settled_usage');
    if (copy.usage_completeness && usage.completeness && !same(copy.usage_completeness, usage.completeness)) fail('invalid_settled_usage');
  }
  if (persisted !== undefined && !same(copy, persisted)) fail('settled_episode_persisted_mismatch');
  return freeze(copy);
}
function bytes(file, maximum = 16 * 1024 * 1024) {
  if (!path.isAbsolute(file)) fail('absolute_artifact_path_required');
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_artifact_ancestor');
    if (parent === path.dirname(parent)) break;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('unsafe_artifact');
  return readFileSync(file);
}
function pinnedJSON(file, digest) {
  const raw = bytes(file);
  if (sha256(raw) !== digest) fail('artifact_digest_mismatch');
  return JSON.parse(raw);
}
function sourceFile(file) {
  const absolute = path.resolve(REPO, file);
  if (!absolute.startsWith(REPO + path.sep) || !/\.(?:mjs|js|json|py|ps1|lean|Dockerfile)$/.test(file) || /(?:^|[\/])\.env/.test(file)) fail('unsafe_source_binding');
  return absolute;
}
function checkSources(records) {
  for (const [file, digest] of Object.entries(records)) if (sha256(bytes(sourceFile(file))) !== digest) fail('current_dependency_hash_mismatch');
}
function checkSnapshot(root, digest) {
  const snapshot = pinnedJSON(path.join(root, 'source-manifest.json'), digest);
  for (const file of [...snapshot.files, snapshot.index]) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(path.resolve(root) + path.sep) || sha256(bytes(target)) !== file.sha256) fail('snapshot_binding_mismatch');
  }
}

// Read-only, including in previews. No Docker, staging, native credentials or RPC.
export function loadApprovedArtifacts({ prereg, amendment, approvedArtifacts, out }) {
  const original = pinnedJSON(path.resolve(prereg), PINS.prereg);
  const variant = pinnedJSON(path.resolve(amendment), PINS.amendment);
  const raw = bytes(path.resolve(approvedArtifacts)), approved = JSON.parse(raw);
  if (!approved || approved.schema !== 'real-use-execution-bindings/v1' ||
      !same(Object.keys(approved).sort(), ['schema', 'prereg_sha256', 'amendment_sha256', 'source_sha256', 'operator'].sort()) ||
      approved.prereg_sha256 !== PINS.prereg || approved.amendment_sha256 !== PINS.amendment ||
      !same(Object.keys(approved.source_sha256 ?? {}).sort(), [...DRIVER_SOURCES].sort()) ||
      !same(Object.keys(approved.operator ?? {}).sort(), ['cliPackageDir', 'nativeTmpRelative'].sort()) ||
      !path.isAbsolute(approved.operator.cliPackageDir ?? '') ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(approved.operator.nativeTmpRelative ?? '')) fail('invalid_execution_bindings');
  const manifest = original.manifest;
  validatePublic(manifest.tasks);
  if (path.resolve(out) !== path.resolve(original.study_out) || manifest.run_id !== 'real-use-g004-20261112' ||
      manifest.seed !== 'real-use-v1' || manifest.model !== variant.base_model || variant.effective_variant !== 'default' ||
      manifest.repeats !== 1 || manifest.schedule.length !== 20 || manifest.tasks.length !== 10 ||
      manifest.public_tasks_hash !== sha256(manifest.tasks) || manifest.protocol_hash !== sha256(manifest.protocol) ||
      manifest.protocol_hash !== PROTOCOL_HASH || !same(manifest.prompts, promptBindings(manifest.tasks)) ||
      manifest.assembled_prompts_hash !== sha256(manifest.prompts) || !same(manifest.schedule, makeSchedule(manifest.tasks, manifest)) ||
      !same(manifest.budgets, { timeout_ms: 300000, max_episodes: 20, max_cost_usd: 1, cost_limit_kind: 'soft', unknown_cost_policy: 'first-pair-counterpart-only' })) fail('preregistration_binding_mismatch');
  const controls = Object.fromEntries(Object.entries(CONTROL_FILES).map(([key, file]) => [key, pinnedJSON(path.join(TEMP, file), PINS[key])]));
  let sourceHashes = { ...approved.source_sha256, ...controls.checker.source_hashes, ...controls.followup.current_source_sha256 };
  for (const entry of controls.runtime.binding.implementation_sources) sourceHashes[path.relative(REPO, path.resolve(HERE, entry.source)).replaceAll('\\', '/')] = entry.sha256;
  const graderIntegration = loadGraderIntegrationAmendment(sourceHashes);
  sourceHashes = graderIntegration.sourceHashes;
  checkSources(sourceHashes);
  const runtime = controls.runtime.binding;
  const snapshotRoot = runtime.snapshot_root;
  checkSnapshot(snapshotRoot, original.snapshot_manifest_sha256);
  if (runtime.image !== original.runtime_image || runtime.snapshot_manifest_sha256 !== original.snapshot_manifest_sha256 ||
      sha256(JSON.stringify(runtime.runtime_policy)) !== runtime.runtime_policy_sha256 || sha256(JSON.stringify(runtime.compile_policy)) !== runtime.compile_policy_sha256 ||
      controls.followup.build_receipt_sha256 !== PINS.checker || controls.followup.cleanup !== 'confirmed_absent' ||
      controls.followup.actual_latest_per_control.passed !== 13 || controls.followup.actual_latest_per_control.failed !== 0) fail('control_binding_mismatch');
  const effective = freeze({ ...structuredClone(manifest), effective_variant: 'default',
    execution_metadata: { schema: 'real-use-execution-metadata-amendment/v1', timing: 'pre-inference',
      original_prereg_sha256: PINS.prereg, variant_amendment_sha256: PINS.amendment, approved_bindings_sha256: sha256(raw),
      source_sha256: approved.source_sha256, protocol_changed: false,
      grader_integration: graderIntegration.metadata,
      scope: 'controller wiring only; original model/schedule/budgets/prompts/logical workspace unchanged; actual staged workspace bound per episode' } });
  const handle = freeze({ manifest: effective, out: path.resolve(out), original, amendment: variant, binding_sha256: sha256(raw) });
  approvals.set(handle, { sourceHashes, controls, operator: approved.operator, original, manifest: effective,
    cursor: 0, episodes: [], pending: null, nonces: new Set(), halted: false });
  return handle;
}

export const FRESH_HISTORICAL_EVIDENCE = freeze({
  prereg: { path: path.join(TEMP, 'real-use-prereg-g004.json'), sha256: PINS.prereg },
  amendment: { path: path.join(TEMP, 'real-use-prereg-g004-default-variant.json'), sha256: PINS.amendment },
  parent_approval: { path: path.join(TEMP, 'real-use-controller-handoff-final-1b9Kow/parent-approval.json'), sha256: 'c35ea0689e68dd145b006c2bd2589ca02a96dde5ee5e28197083497479c46785' },
  source_archive: { path: path.join(TEMP, 'real-use-g004-frozen-source-WFtcOc/source-manifest.json'), sha256: '5445e3a68ac704789fd9d5ad7c4cec22f5fed2d8b19e3685b537c90f5c323a54' },
  execution_bindings: { path: path.join(TEMP, 'real-use-controller-handoff-final-1b9Kow/candidate-bindings.json'), sha256: '8a5310f846cd085e01bad98615f22b90c7939e66b4e6a9027ca5e1cfc7b40d82' },
  diagnosis: { path: path.join(TEMP, 'real-use-study-g004-20261112/evaluation/operational-diagnosis.json'), sha256: 'ef0fc9dd798d7a0e6f8a439b563f27d8d202e70101f13a4adb81b80595ecc4ec' },
  reviews: { path: path.join(TEMP, 'real-use-study-g004-20261112/evaluation/reviews.json'), sha256: '7927feb5b002ddc6142c6bbf5d87a9436a3b7073e482d6a17da55340c670a8cb' },
  g005_parent_approval: { path: path.join(TEMP, 'real-use-g005-freeze-handoff-W9Ub4y/parent-approval.json'), sha256: '0b237304035e589156f19bf9376dc7197ecd42dfc0da1fa03f0512cc2bbe6358' },
  g005_two_registration_freeze: { path: path.join(TEMP, 'real-use-g005-freeze-handoff-W9Ub4y/two-registration-freeze.json'), sha256: 'cc8913cf44bb57ab5236d8901ba1e812075243fc98e8150712f599409470f726' },
  g005_probe_report: { path: path.join(TEMP, 'real-use-g005-compat-20261112/evaluation/report.json'), sha256: 'abd8c290ee5bb2186779c7ccac89009d8d1e7f92d3aec953d359d4d98435d0c5' },
  g007_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-0InhYu/parent-approval.json'), sha256: '1422ab16f69ae0087395ac60251e26b0bf32adae733e0d4c16082caa65a78c00' },
  g007_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-0InhYu/two-registration-freeze.json'), sha256: 'c5cbba4e3f2229a2cf42a6a83c282dcc086f3c2cb41874d15e40d9fa16b708a0' },
  g007_execution_stop: { path: path.join(TEMP, 'real-use-g007-compat-20261113/execution-stop.json'), sha256: 'd793fd72984675e741bef79e9236e281c741910931aae4101eda6a9b267c4ae0' },
  g009_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-FpGezI/parent-approval.json'), sha256: '60bc657e2f3e0e27719e6f6efd37c97f79f74dd34ac41762e62ccbc61edcd3d8' },
  g009_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-FpGezI/two-registration-freeze.json'), sha256: '9714970c79f8ef51cf076db88fb50927eca1b0cb211f2173db865d92c0c91b59' },
  g009_execution_stop: { path: path.join(TEMP, 'real-use-g009-compat-20261113/execution-stop.json'), sha256: '1e6c6b0878717352f1544ed3b53d15806f764a76a5b9f930f8b8744ba0a92901' },
  g011_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-t484QK/parent-approval.json'), sha256: '8766484230095e566c0cf46a8d4aecb13a10eb5deb394b3d0d0db0270909dda4' },
  g011_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-t484QK/two-registration-freeze.json'), sha256: '9a69a2a90b83d70782d8366c250d23b86a5ad1136323e1c2548ace64db796e22' },
  g011_execution_stop: { path: path.join(TEMP, 'real-use-g011-compat-20261113/execution-stop.json'), sha256: 'b4738ddd4db4d6fc186218eff6742d2c45197c6575f4b0e2f5bc6686c7448e2b' },
  g013_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-E4xkA2/parent-approval.json'), sha256: '8a6ed36853a911f67036e9ff17e13518f734cca4627855e342c2b216c888b1ac' },
  g013_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-E4xkA2/two-registration-freeze.json'), sha256: '5766927cbe00901b90bf6a9ca2fd2d430c59ec3bb019bcf570d4e46a2cd15e88' },
  g013_execution_stop: { path: path.join(TEMP, 'real-use-g013-compat-20261113/execution-stop.json'), sha256: 'a0a722f21ca1627a08ac3772be8a6032c77443663c302982536c5dd3280cddd9' },
  g013_native_completion_evidence: { path: path.join(TEMP, 'real-use-bridge-g013-s1XUTH/private/native-completion-evidence.json'), sha256: 'bf9edf6fca9016ce45c30464e8e1fe49a75d4e4d70afe56c41672c8ab6eb2f54' },
  g015_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-lE6XTf/parent-approval.json'), sha256: 'e0d21170720a2daae6bb622cd71ac27394a0b28bffbf3e324241bb032f12665a' },
  g015_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-lE6XTf/two-registration-freeze.json'), sha256: 'd0ea28d4cfd681c04c1bb57a719590a2aae0841c6fd647b9fe736ce99a7cc324' },
  g015_execution_stop: { path: path.join(TEMP, 'real-use-g015-compat-20261113/execution-stop.json'), sha256: '5c74acae97a5de611bf04c10ea51ebbfb0bb9149545aad986631a9ccdbd47a07' },
  g017_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-rfAoV3/parent-approval.json'), sha256: 'bb879b4d9587cfb5d8ff446038521e05a07ce863ac25b8a67708b2605cf7b314' },
  g017_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-rfAoV3/two-registration-freeze.json'), sha256: 'b1f0e664c7dda0453384e5c2d3d25c8da338f8a9b206e9a4d941e2bc12efd895' },
  g017_first_pair_checkpoint: { path: path.join(TEMP, 'real-use-g017-compat-20261113/first-pair-checkpoint.json'), sha256: 'e8dcff9126a9f59188775186271111a8e29bcba48124b1dbc3dd6d8fc5227c33' },
  g018_execution_stop: { path: path.join(TEMP, 'real-use-g018-workflows-20261113/execution-stop.json'), sha256: '1ad80492feacbc275fb2ceec90e08cbf63e0bd866e20cc9209a4fccd125ba15e' },
  g018_report: { path: path.join(TEMP, 'real-use-g018-workflows-20261113/evaluation/report.json'), sha256: 'df1e7f3716e2308aa7e12110628c76b8f1aa04a5036c15864d0952f114f83283' },
  g019_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-XpAQu4/parent-approval.json'), sha256: '46ee72be9ede7b69b9591f1882688473849df59af89ec063193496ece1ebddd3' },
  g019_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-XpAQu4/two-registration-freeze.json'), sha256: '8dc47b89b9ab9f505f58e1310b0cb73b3445d553977e72957c3e84df6ee399ec' },
  g019_execution_stop: { path: path.join(TEMP, 'real-use-g019-compat-20261113/execution-stop.json'), sha256: 'f06760e32e480141ce6d9f8f63e81e4f317f5d3a12c033046896b8d93bdd5cf4' },
  g021_parent_approval: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-gdtaCW/parent-approval.json'), sha256: '42d5a91d4b61a37cd15d6b5600741f5220196e4efbdf05a41b6124bb52fae59a' },
  g021_two_registration_freeze: { path: path.join(TEMP, 'real-use-g007-freeze-handoff-gdtaCW/two-registration-freeze.json'), sha256: '417d88c1dd35f271614454b20d45a5cd0d73476e01a7f508511cd3e80d61e65d' },
  g021_first_pair_checkpoint: { path: path.join(TEMP, 'real-use-g021-compat-20261113/first-pair-checkpoint.json'), sha256: '0a0bc87d8b5e10aa9fb3cc0329937717deee96fb6b960899a18999323ba6510c' },
  g022_execution_stop: { path: path.join(TEMP, 'real-use-g022-workflows-20261113/execution-stop.json'), sha256: '86e903d6a20f0ad627e9c7dc7dda2302830ec48185d6f75803b9388bb53d147b' },
  g022_report: { path: path.join(TEMP, 'real-use-g022-workflows-20261113/evaluation/report.json'), sha256: 'c30341a2442face31701040bc923f235de32f526837350a7e580966d1c93b8f4' },
});
const freshControls = freeze({ ...Object.fromEntries(Object.entries(CONTROL_FILES).map(([key, file]) =>
  [key, { path: path.join(TEMP, file), sha256: PINS[key] }])), grader_integration: GRADER_INTEGRATION_AMENDMENT });
const freshExposure = freeze({ classification: 'exploratory_not_confirmatory',
  historical_hanner: 'original first Hanner ON/OFF pair exposed; retained without post-outcome selection',
  compat_source: 'compatibility source exposure planned before main; completion evidence is a separate runtime checkpoint',
  selection: 'both profiles fixed before probe; no post-outcome task or order selection' });
const compatProfile = profileForRole('compat');
const probeRequirement = freeze({ profile_id: compatProfile.profile_id,
  run_id: compatProfile.run_id, study_out: compatProfile.study_out,
  checkpoint_path: path.win32.join(compatProfile.study_out, 'first-pair-checkpoint.json'),
  evidence_contract: 'owned artifact-bound operational checkpoint required; identity alone never passes',
  blocking: ['unknown_usage', 'safety_failure', `reported_cost_at_or_above_${compatProfile.protocol.max_cost_usd.toFixed(2)}`],
  answer_correctness_is_pipeline_gate: false });
const exact = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !same(Object.keys(value).sort(), [...keys].sort())) fail(label);
};
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const historical = key => { const ref = FRESH_HISTORICAL_EVIDENCE[key]; return pinnedJSON(ref.path, ref.sha256); };
export function currentSourceVersion() {
  return freeze({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal'], { cwd: REPO, encoding: 'utf8' }).trim()),
    source_sha256: Object.fromEntries(DRIVER_SOURCES.map(file => [file, sha256(bytes(sourceFile(file)))])) });
}
function validateSourceVersion(value) {
  exact(value, ['revision', 'dirty', 'source_sha256'], 'invalid_source_version');
  exact(value.source_sha256, DRIVER_SOURCES, 'invalid_driver_source_set');
  if (!/^[a-f0-9]{40}$/.test(value.revision ?? '') || typeof value.dirty !== 'boolean' ||
      !Object.values(value.source_sha256).every(digest)) fail('invalid_source_version');
}
function lineageChanges(sourceVersion) {
  const old = historical('parent_approval').source_sha256;
  return DRIVER_SOURCES.filter(file => old[file] !== sourceVersion.source_sha256[file]).map(file =>
    ({ source: file, before_sha256: old[file], after_sha256: sourceVersion.source_sha256[file] }));
}
// Construction/validation is data-only. The caller freezes external final source
// bindings after editing finishes; no digest of this module is embedded in itself.
export function createFreshRegistration({ profile_id, created_at, source_version, verification }) {
  validateSourceVersion(source_version);
  const manifest = profileManifest(profile_id, historical('prereg').manifest, created_at);
  const registration = { schema: 'real-use-fresh-registration/v1', profile_id, run_id: manifest.run_id, created_at,
    study_out: FRESH_PROFILES[profile_id].study_out, manifest, source_version: structuredClone(source_version),
    historical_evidence: FRESH_HISTORICAL_EVIDENCE, control_bindings: freshControls,
    source_lineage: { changes: lineageChanges(source_version), verification }, exposure: freshExposure,
    prerequisite_probe: profileRole(profile_id) === 'workflows' ? probeRequirement : null };
  validateFreshRegistration(registration);
  return freeze(structuredClone(registration));
}
export function validateFreshRegistration(registration) {
  exact(registration, ['schema', 'profile_id', 'run_id', 'created_at', 'study_out', 'manifest', 'source_version',
    'historical_evidence', 'control_bindings', 'source_lineage', 'exposure', 'prerequisite_probe'], 'invalid_registration_keys');
  const profile = Object.hasOwn(FRESH_PROFILES, registration.profile_id) && FRESH_PROFILES[registration.profile_id];
  if (!profile || registration.schema !== 'real-use-fresh-registration/v1' || registration.run_id !== profile.run_id ||
      registration.study_out !== profile.study_out) fail('invalid_fresh_profile_identity');
  if (!same(registration.manifest, profileManifest(registration.profile_id, historical('prereg').manifest, registration.created_at)) ||
      !same(registration.historical_evidence, FRESH_HISTORICAL_EVIDENCE) || !same(registration.control_bindings, freshControls) ||
      !same(registration.exposure, freshExposure) || !same(registration.prerequisite_probe,
         profileRole(registration.profile_id) === 'workflows' ? probeRequirement : null)) fail('fresh_registration_binding_mismatch');
  validateSourceVersion(registration.source_version);
  exact(registration.source_lineage, ['changes', 'verification'], 'invalid_source_lineage');
  if (!same(registration.source_lineage.changes, lineageChanges(registration.source_version))) fail('source_lineage_mismatch');
  const ref = registration.source_lineage.verification;
  exact(ref, ['path', 'sha256'], 'invalid_verification_reference');
  if (typeof ref.path !== 'string' || !path.isAbsolute(ref.path) ||
      !path.resolve(ref.path).startsWith(path.resolve(TEMP) + path.sep) || !digest(ref.sha256) ||
      path.extname(ref.path) !== '.json') fail('invalid_verification_reference');
  return true;
}

function freezeArtifactPath(file) {
  if (typeof file !== 'string' || file.length > 4096 || /[\0\r\n]/.test(file) || !path.isAbsolute(file) ||
      !path.resolve(file).startsWith(path.resolve(TEMP) + path.sep) || path.extname(file) !== '.json') fail('invalid_freeze_artifact_path');
}
// Read-only data verification. This never creates an approval/capability and has
// no test bypass: both registrations must match the current eight-driver graph.
export function validateTwoRegistrationFreeze({ freezeRecord, freezeSha256 }) {
  if (!digest(freezeSha256)) fail('two_registration_freeze_required');
  freezeArtifactPath(freezeRecord);
  const raw = bytes(freezeRecord, 64 * 1024);
  if (sha256(raw) !== freezeSha256) fail('freeze_digest_mismatch');
  if (!Buffer.from(raw.toString('utf8')).equals(raw)) fail('invalid_freeze_encoding');
  const record = JSON.parse(raw);
  exact(record, ['schema', 'created_at', 'source_version', 'registrations'], 'invalid_two_registration_freeze');
  if (record.schema !== 'real-use-two-registration-freeze/v1' || typeof record.created_at !== 'string' ||
      !Number.isFinite(Date.parse(record.created_at)) || new Date(record.created_at).toISOString() !== record.created_at ||
      !Array.isArray(record.registrations) || record.registrations.length !== 2) fail('invalid_two_registration_freeze');
  validateSourceVersion(record.source_version);
  if (!same(record.source_version, currentSourceVersion())) fail('stale_freeze_source_version');
  const registrations = record.registrations.map((ref, index) => {
    exact(ref, ['profile_id', 'path', 'sha256'], 'invalid_frozen_registration_reference');
    if (ref.profile_id !== profileForRole(['compat', 'workflows'][index]).profile_id || !digest(ref.sha256)) fail('invalid_frozen_registration_reference');
    freezeArtifactPath(ref.path);
    const registrationBytes = bytes(ref.path, 1024 * 1024);
    if (sha256(registrationBytes) !== ref.sha256) fail('frozen_registration_digest_mismatch');
    const value = JSON.parse(registrationBytes);
    validateFreshRegistration(value);
    if (value.profile_id !== ref.profile_id || !same(value.source_version, record.source_version) ||
        Date.parse(value.created_at) > Date.parse(record.created_at)) fail('frozen_registration_binding_mismatch');
    return value;
  });
  if (registrations[0].created_at !== registrations[1].created_at ||
      !same(registrations[0].source_lineage, registrations[1].source_lineage)) fail('frozen_registration_pair_mismatch');
  return freeze({ ref: { path: freezeRecord, sha256: freezeSha256 }, record, registrations, raw: raw.toString('utf8') });
}
function revalidateRegistrationFreeze(state) {
  if (!state.freezeRef) fail('two_registration_freeze_required');
  const current = validateTwoRegistrationFreeze({ freezeRecord: state.freezeRef.path, freezeSha256: state.freezeRef.sha256 });
  if (!same(current.record.registrations, state.registrationPair) || !same(current.registrations, state.frozenRegistrations)) fail('registration_freeze_changed');
  return current;
}

// Read-only loader. External digests are operator approvals, not model fields.
export function loadRegisteredArtifacts({ registration, registrationSha256, out, execute = false, probeCheckpointSha256, freezeRecord, freezeSha256 }) {
  if (!digest(registrationSha256) || typeof execute !== 'boolean') fail('registration_digest_required');
  if (typeof registration !== 'string' || !path.isAbsolute(registration)) fail('absolute_registration_required');
  const hasFreeze = freezeRecord !== undefined || freezeSha256 !== undefined;
  if (execute && !hasFreeze) fail('two_registration_freeze_required');
  const frozen = hasFreeze ? validateTwoRegistrationFreeze({ freezeRecord, freezeSha256 }) : null;
  const record = pinnedJSON(registration, registrationSha256);
  validateFreshRegistration(record);
  if (frozen && !frozen.record.registrations.some(ref => ref.profile_id === record.profile_id &&
      ref.path === registration && ref.sha256 === registrationSha256)) fail('selected_registration_not_frozen');
  if (out !== record.study_out) fail('fresh_output_binding_mismatch');
  if (execute) assertFreshOutput(out);
  else {
    try {
      const stat = lstatSync(out);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_artifact');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (let parent = path.dirname(out); ; parent = path.dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_artifact_ancestor');
    if (parent === path.dirname(parent)) break;
  }
  if (!same(record.source_version, currentSourceVersion())) fail('stale_source_version');
  const history = Object.fromEntries(Object.keys(FRESH_HISTORICAL_EVIDENCE).map(key => [key, historical(key)]));
  const baseline = history.parent_approval.source_sha256, archive = history.source_archive;
  if (!same(Object.keys(baseline).sort(), [...DRIVER_SOURCES].sort()) || archive.complete !== true || archive.missing.length ||
      !same(archive.saved, DRIVER_SOURCES.map(file => ({ file, sha256: baseline[file] }))) ||
      !same(history.execution_bindings.source_sha256, baseline)) fail('historical_source_archive_mismatch');
  for (const file of DRIVER_SOURCES) {
    if (sha256(bytes(path.join(path.dirname(FRESH_HISTORICAL_EVIDENCE.source_archive.path), file))) !== baseline[file]) fail('historical_source_archive_mismatch');
  }
  const ref = record.source_lineage.verification, verification = pinnedJSON(ref.path, ref.sha256);
  exact(verification, ['schema', 'source_version', 'changes', 'checks'], 'invalid_focused_verification');
  if (verification.schema !== 'real-use-focused-verification/v1' || !same(verification.source_version, record.source_version) ||
      !same(verification.changes, record.source_lineage.changes) || !Array.isArray(verification.checks) || !verification.checks.length) fail('focused_verification_binding_mismatch');
  for (const check of verification.checks) {
    exact(check, ['command', 'exit_code', 'evidence'], 'invalid_focused_check');
    exact(check.evidence, ['path', 'sha256'], 'invalid_focused_check_evidence');
    if (typeof check.command !== 'string' || !check.command.trim() || check.exit_code !== 0 || !digest(check.evidence.sha256) ||
        typeof check.evidence.path !== 'string' || !path.isAbsolute(check.evidence.path) ||
        !path.resolve(check.evidence.path).startsWith(path.resolve(TEMP) + path.sep) ||
        sha256(bytes(check.evidence.path)) !== check.evidence.sha256) fail('focused_verification_failed');
  }
  const controls = Object.fromEntries(Object.entries(CONTROL_FILES).map(([key, file]) => [key, pinnedJSON(path.join(TEMP, file), PINS[key])]));
  // Driver exceptions cannot mask worker/checker/image/policy dependency changes.
  const dependencies = { ...controls.checker.source_hashes, ...controls.followup.current_source_sha256 };
  for (const entry of controls.runtime.binding.implementation_sources) dependencies[path.relative(REPO, path.resolve(HERE, entry.source)).replaceAll('\\', '/')] = entry.sha256;
  const graderIntegration = loadGraderIntegrationAmendment(dependencies);
  checkSources(graderIntegration.sourceHashes);
  const sourceHashes = { ...graderIntegration.sourceHashes, ...record.source_version.source_sha256 };
  checkSources(sourceHashes);
  const original = history.prereg, runtime = controls.runtime.binding;
  checkSnapshot(runtime.snapshot_root, original.snapshot_manifest_sha256);
  if (runtime.image !== original.runtime_image || runtime.snapshot_manifest_sha256 !== original.snapshot_manifest_sha256 ||
      sha256(JSON.stringify(runtime.runtime_policy)) !== runtime.runtime_policy_sha256 ||
      sha256(JSON.stringify(runtime.compile_policy)) !== runtime.compile_policy_sha256 ||
      controls.followup.build_receipt_sha256 !== PINS.checker || controls.followup.cleanup !== 'confirmed_absent' ||
      controls.followup.actual_latest_per_control.passed !== 13 || controls.followup.actual_latest_per_control.failed !== 0) fail('control_binding_mismatch');
  const manifest = freeze(structuredClone(record.manifest));
  const handle = freeze({ manifest, out, original, amendment: history.amendment, binding_sha256: registrationSha256,
    registration: record, registration_raw: bytes(registration).toString('utf8'), grader_integration: graderIntegration.metadata,
    freeze_ref: frozen?.ref ?? null, freeze_raw: frozen?.raw ?? null, registration_pair: frozen?.record.registrations ?? null });
  if (profileRole(record.profile_id) === 'compat' && probeCheckpointSha256 !== undefined) fail('unexpected_probe_checkpoint');
  const prerequisite = execute && profileRole(record.profile_id) === 'workflows' ? verifyProbePrerequisite(record, probeCheckpointSha256, frozen) : null;
  approvals.set(handle, { sourceHashes, controls, operator: history.execution_bindings.operator, original, manifest,
    registration: record, registrationPath: registration, registrationSha256, out, executable: execute,
    freezeRef: frozen?.ref ?? null, registrationPair: frozen?.record.registrations ?? null, frozenRegistrations: frozen?.registrations ?? null,
    prerequisite, probeCheckpointSha256, cursor: 0, episodes: [], settlements: [], pending: null,
    nonces: new Set(), sessions: new Set(prerequisite?.session_ids ?? []),
    assistantIDs: new Set(prerequisite?.assistant_ids ?? []), checkpoint: null, halted: false });
  return handle;
}

export async function requireBridgeAPI() {
  const api = await import('./bridge.mjs');
  if (api.ADMISSION_API !== BRIDGE_API || typeof api.isOwnedBridge !== 'function' || typeof api.startAuditBridge !== 'function') fail('genuine_live_bridge_unavailable');
  return api;
}
function stateFor(approved) { return approvals.get(approved) ?? fail('approved_artifacts_not_owned'); }
export function bridgeOptions(approved, item, task) {
  const state = stateFor(approved), b = state.controls.runtime.binding;
  ({ item, task } = snapshotEpisodeInputs(state.manifest, state.cursor, item, task));
  if (state.registration) assertFreshContinuation(state);
  return freeze({ ...state.operator, condition: item.condition, snapshotRoot: b.snapshot_root,
    snapshotHash: b.snapshot_manifest_sha256, image: b.image, dockerExecutable: b.docker_executable, endpoint: b.endpoint,
    runId: state.manifest.run_id, episodeId: item.episode_id, effectiveVariant: 'default',
    ...(state.registration ? { profileId: state.registration.profile_id, protocolHash: state.manifest.protocol_hash,
      registrationDigest: state.registrationSha256 } : {}),
    contextAudit: { prompt: promptFor(task), promptHash: sha256(promptFor(task)), nativeTmpRelative: state.operator.nativeTmpRelative } });
}

async function inspectImages(state) {
  const { createDockerTransport } = await import('../../v3/arxivlean/lib/eval-sandbox.mjs');
  const b = state.controls.runtime.binding, c = state.controls.checker;
  const transport = createDockerTransport({ endpoint: b.endpoint, dockerExecutable: b.docker_executable });
  for (const image of [b.image, c.export_worker_image_id, c.checker_image_id]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) fail('immutable_image_required');
    const result = await transport(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (result.code !== 0 || result.failure || result.signal || result.stdout.trim() !== image || result.client_config_cleanup !== 'confirmed_removed') fail('current_image_inspection_failed');
  }
}
function checkedBindings(bridge, state, item, task) {
  const value = bridge.getBindings();
  // This projection must come from the private branded bridge state, not RPC/model
  // input or caller-set properties. Startup/context booleans alone never suffice.
  if (!value || value.schema !== BRIDGE_API || value.active !== true || value.run_id !== state.manifest.run_id ||
      value.episode_id !== item.episode_id || value.condition !== item.condition || value.model !== item.model || value.variant !== 'default' ||
      value.prompt_sha256 !== sha256(promptFor(task)) || !/^[a-zA-Z0-9-]{16,128}$/.test(value.nonce ?? '') ||
      !path.isAbsolute(value.workspace ?? '') || value.snapshot_sha256 !== state.original.snapshot_manifest_sha256 ||
      !same(value.source_sha256, Object.fromEntries(DRIVER_SOURCES.filter(file => /\/(bridge\.mjs|stage\.mjs|runtime-plugin\.js|cli-builtins\.json)$/.test(file)).map(file => [file, state.sourceHashes[file]]))) ||
      value.startup_audit !== 'passed' || value.context_abort_audit !== 'passed' ||
      !/^[a-f0-9]{64}$/.test(value.context_evidence_sha256 ?? '')) fail('active_bridge_binding_mismatch');
  return freeze(structuredClone(value));
}

export async function admitEpisode({ manifest, item, task, bridge, approvedArtifacts }) {
  const state = stateFor(approvedArtifacts);
  if (!state.registration) fail('historical_execution_forbidden');
  assertFreshContinuation(state);
  if (manifest !== state.manifest || state.halted || state.pending || budgetStop(state.episodes, manifest.budgets,
        { schedule: manifest.schedule, unknownCostPolicy: manifest.budgets.unknown_cost_policy })) fail('admission_schedule_or_budget_blocked');
  // Bind to authoritative manifest values before even the dynamic-import await.
  ({ item, task } = snapshotEpisodeInputs(state.manifest, state.cursor, item, task));
  state.pending = Symbol('admitting'); // Fence concurrent mint attempts before awaits.
  try {
    const api = await requireBridgeAPI();
    if (!api.isOwnedBridge(bridge)) fail('genuine_owned_bridge_required');
    checkSources(state.sourceHashes);
    checkSnapshot(state.controls.runtime.binding.snapshot_root, state.original.snapshot_manifest_sha256);
    await bridge.audit(); await bridge.auditContext();
    const binding = checkedBindings(bridge, state, item, task);
    if (binding.profile_id !== manifest.profile_id || binding.protocol_hash !== manifest.protocol_hash ||
        binding.registration_sha256 !== state.registrationSha256) fail('fresh_bridge_binding_mismatch');
    if (state.nonces.has(binding.nonce)) fail('bridge_nonce_reused');
    await inspectImages(state);
    assertFreshContinuation(state); // Recheck after awaited audits/image inspection, before minting.
    const capability = Object.freeze(Object.create(null));
    if (!path.isAbsolute(bridge.root ?? '') || !path.resolve(binding.workspace).startsWith(path.resolve(bridge.root) + path.sep)) fail('owned_evidence_root_mismatch');
    const record = { bridge, api, binding, evidenceRoot: path.resolve(bridge.root), state, item, task, used: false, finished: false };
    capabilities.set(capability, record); state.pending = capability; state.nonces.add(binding.nonce);
    return capability;
  } catch (error) { state.halted = true; throw error; }
}
export function consumeEpisodeCapability(capability, bridge, bindings) {
  const record = capabilities.get(capability);
  if (!record || record.used || record.bridge !== bridge || !record.api.isOwnedBridge(bridge) ||
      record.state.pending !== capability || !same(bindings, record.binding) || !same(bridge.getBindings(), record.binding)) fail('invalid_or_consumed_episode_capability');
  assertFreshContinuation(record.state);
  record.used = true;
  return record.binding;
}
export function assertCapabilityConsumed(capability) {
  if (capabilities.get(capability)?.used !== true) fail('bridge_did_not_consume_capability');
}
export async function dispatchAdmittedEpisode(capability, bridge, item, task) {
  const record = capabilities.get(capability);
  if (!record?.used || record.dispatched || record.bridge !== bridge || !record.api.isOwnedBridge(bridge) ||
      !same(item, record.item) || !same(task, record.task) || !same(bridge.getBindings(), record.binding)) fail('invalid_dispatch_capability');
  assertFreshContinuation(record.state);
  record.dispatched = true;
  const descriptor = await bridge.dispatch({ item: record.item, task: record.task }), launch = descriptor?.launch;
  if (!Object.isFrozen(descriptor) || !Object.isFrozen(launch) || !Object.isFrozen(launch?.args) || !Object.isFrozen(launch?.env) ||
      launch.timeoutMs !== record.state.manifest.budgets.timeout_ms || launch.cwd !== record.binding.workspace ||
      !Array.isArray(launch.args) || !launch.args.includes('--server') || launch.args.includes('--standalone') ||
      !nativePromptTransportMatch(launch, promptFor(record.task), { model: record.item.model }) || typeof descriptor.launcherFactory !== 'function') fail('owned_dispatch_descriptor_mismatch');
  const b = record.binding;
  assertFreshContinuation(record.state);
  return Object.freeze({ launch, launcherFactory: (...args) => {
    assertFreshContinuation(record.state); return descriptor.launcherFactory(...args);
  }, episodeBindings: freeze({
    run_id: b.run_id, episode_id: b.episode_id, nonce: b.nonce, workspace: b.workspace, model: b.model, variant: b.variant,
    prompt_sha256: b.prompt_sha256, snapshot_sha256: b.snapshot_sha256, source_sha256: b.source_sha256,
    context_evidence_sha256: b.context_evidence_sha256, protocol_hash: record.state.manifest.protocol_hash,
    profile_id: record.state.manifest.profile_id, registration_sha256: record.state.registrationSha256 }) });
}
export async function finishAdmittedEpisode(capability, bridge, facts) {
  const record = capabilities.get(capability);
  if (!record || !record.used || !record.dispatched || record.finished || record.bridge !== bridge || !record.api.isOwnedBridge(bridge)) fail('invalid_finish_capability');
  if (!same({ ...bridge.getBindings(), active: record.binding.active }, record.binding)) fail('finish_owned_binding_changed');
  facts = snapshotFinishFacts(facts, record.binding.prompt_sha256, { fresh: Boolean(record.state.registration) });
  record.finished = true;
  if (facts.solver_deadline !== undefined && (Date.now() >= facts.solver_deadline || facts.signal?.aborted)) fail('fresh_finish_deadline');
  const result = await bridge.finish({ observedSessionIDs: facts.observed_session_ids, observedModels: facts.observed_models,
    promptSha256: facts.prompt_sha256, ...facts, signal: facts.signal });
  checkSources(record.state.sourceHashes);
  const id = result?.identity_validation, guard = result?.guard, cleanup = result?.cleanup;
  if (id?.status !== 'validated' || id.model !== record.item.model || id.variant !== 'default' ||
      typeof id.session_id !== 'string' || !/^ses_[A-Za-z0-9_-]+$/.test(id.session_id) ||
      id.prompt_sha256 !== record.binding.prompt_sha256 || guard?.status !== 'passed' || guard.nonce !== record.binding.nonce ||
      guard.context_evidence_sha256 !== record.binding.context_evidence_sha256 || cleanup?.confirmed !== true ||
      !['server', 'daemon', 'cli'].every(key => cleanup[key]?.confirmed === true && cleanup[key].active_processes === 0) ||
       cleanup.cli.status !== 'confirmed_absent' || cleanup.cli.process_tree_containment !== true ||
       !digest(cleanup.cli.ownership_sha256) ||
      facts.observed_models.some(model => model !== id.model) || facts.observed_session_ids.some(session => session !== id.session_id)) fail('bridge_finalization_unconfirmed');
  if (record.state.sessions.has(id.session_id)) fail('native_session_reused');
  if (facts.captured_assistant_message_ids.some(id => record.state.assistantIDs.has(id))) fail('native_assistant_identity_reused');
  const native = validateNativeCompletionData(result, facts);
  if (native.native_recorded_usage.steps !== facts.captured_assistant_message_ids.length) fail('native_capture_step_correspondence_mismatch');
  const evidenceFile = path.resolve(native.completion_evidence.evidence_path);
  if (!path.isAbsolute(native.completion_evidence.evidence_path) || !evidenceFile.startsWith(record.evidenceRoot + path.sep) ||
      !/^[A-Za-z0-9_.-]*evidence[A-Za-z0-9_.-]*\.json$/.test(path.basename(evidenceFile))) fail('owned_native_evidence_path_mismatch');
  validateNativeArtifactData(pinnedJSON(evidenceFile, native.completion_evidence.evidence_sha256), result, record.binding, facts);
  // Never persist the bridge's arbitrary object, credentials or diagnostic payload.
  const receipt = freeze({ identity_validation: { status: 'validated', model: id.model, variant: id.variant, session_id: id.session_id,
    prompt_sha256: id.prompt_sha256 }, guard: { status: 'passed', nonce: guard.nonce, context_evidence_sha256: guard.context_evidence_sha256 },
    cleanup: { confirmed: true, server: { confirmed: true, active_processes: 0 }, daemon: { confirmed: true, active_processes: 0 },
      cli: { status: 'confirmed_absent', confirmed: true, active_processes: 0, process_tree_containment: true,
         ownership_sha256: cleanup.cli.ownership_sha256 } }, ...native });
  record.state.sessions.add(id.session_id); record.receipt = receipt; record.facts = facts;
  facts.captured_assistant_message_ids.forEach(id => record.state.assistantIDs.add(id));
  finalizations.set(receipt, { episode_id: record.item.episode_id, prompt_sha256: record.binding.prompt_sha256,
    item: record.item, state: record.state, used: false }); return receipt;
}
export const isFinalizationReceipt = receipt => finalizations.has(receipt);
export function consumeFinalizationReceipt(receipt, item, promptHash) {
  const record = finalizations.get(receipt);
  if (!record || record.used || record.episode_id !== item.episode_id || record.prompt_sha256 !== promptHash ||
      receipt.identity_validation.model !== item.model || !same(item, record.item)) return false;
  record.used = true; return true;
}
export function settleEpisodeAdmission(approved, episode) {
  const state = stateFor(approved), record = capabilities.get(state.pending);
  if (!record?.used || !record.finished) fail('admission_settlement_mismatch');
  const file = path.join(approved.out, 'episodes', `${record.item.episode_id}.json`);
  // The owned terminal is authoritative, not a mutable capture return value.
  const persisted = JSON.parse(bytes(file, Infinity));
  const settled = snapshotSettledEpisode(episode, record.item, persisted);
  if (settled.status === 'completed' && (!record.receipt || finalizations.get(record.receipt)?.used !== true ||
      !same(settled.usage, record.receipt.native_recorded_usage) || !same(settled.completion_evidence, record.receipt.completion_evidence) ||
      !same(settled.tool_evidence, record.receipt.tool_evidence) || !same(settled.identity_validation, record.receipt.identity_validation) ||
      !same(settled.guard, record.receipt.guard))) fail('settlement_native_receipt_mismatch');
  state.settlements.push({ record, terminal: { path: file, sha256: sha256(bytes(file, Infinity)) } });
  state.episodes.push(settled); state.cursor++; state.pending = null;
  state.halted = Boolean(budgetStop(state.episodes, state.manifest.budgets, { schedule: state.manifest.schedule,
    unknownCostPolicy: state.manifest.budgets.unknown_cost_policy }));
}

const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens'];
// Data validation only: neither this helper nor serialized output mints a receipt.
export function validateNativeCompletionData(result, facts) {
  const completion = result?.completion_evidence, usage = result?.native_recorded_usage, tools = result?.tool_evidence;
  exact(completion, ['schema', 'basis', 'policy', 'kind', 'timestamp_basis', 'cli_complete', 'witness_sha256', 'post_release_bindings_sha256',
    'native_snapshot_sha256', 'final_text_sha256', 'native_message_id', 'pricing_sha256', 'native_usage_sha256', 'evidence_path', 'evidence_sha256'], 'invalid_native_completion_evidence');
  const timestamp = completion.timestamp_basis;
  exact(timestamp, ['closed_at_ms', 'idle_at_ms', 'witness_present'], 'invalid_native_timestamp_basis');
  if (!Number.isSafeInteger(timestamp.closed_at_ms) || timestamp.closed_at_ms < 0 ||
      !Number.isSafeInteger(timestamp.idle_at_ms) || timestamp.idle_at_ms < 0 || timestamp.idle_at_ms > timestamp.closed_at_ms ||
      typeof timestamp.witness_present !== 'boolean' ||
      (facts.cli_closed_at !== undefined && timestamp.closed_at_ms > facts.cli_closed_at)) fail('native_timestamp_basis_mismatch');
  if (!['cli_terminal', 'native_preclose_witness', 'native_timestamped_snapshot'].includes(completion.kind) ||
      (completion.kind === 'cli_terminal') !== completion.cli_complete ||
      (timestamp.witness_present ? !digest(completion.witness_sha256) : completion.witness_sha256 !== null) ||
      (completion.kind === 'native_preclose_witness' && !timestamp.witness_present) ||
      (completion.kind === 'native_timestamped_snapshot' && (timestamp.witness_present || completion.witness_sha256 !== null)))
    fail('native_completion_kind_mismatch');
  if (completion.schema !== 'real-use-completion-evidence/v1' || completion.policy !== 'native-platform-v1' ||
      !['cli_terminal', 'native_corroborated'].includes(completion.basis) || typeof completion.cli_complete !== 'boolean' ||
      completion.cli_complete !== facts.native_closure_clean || (completion.basis === 'cli_terminal') !== completion.cli_complete ||
      !['post_release_bindings_sha256', 'final_text_sha256', 'pricing_sha256', 'native_usage_sha256', 'evidence_sha256'].every(key => digest(completion[key])) ||
      !Array.isArray(completion.native_snapshot_sha256) || completion.native_snapshot_sha256.length !== 2 ||
      !completion.native_snapshot_sha256.every(digest) || completion.native_snapshot_sha256[0] !== completion.native_snapshot_sha256[1] ||
      completion.final_text_sha256 !== facts.final_text_sha256 || !facts.captured_assistant_message_ids.includes(completion.native_message_id) ||
      typeof completion.evidence_path !== 'string' || result.upstream_usage_complete !== 'unknown' || result.billed_usd !== null) fail('native_completion_binding_mismatch');
  exact(usage, [...TOKEN_FIELDS, 'cost_usd', 'steps', 'completeness'], 'invalid_native_usage');
  exact(usage.completeness, ['status', 'episode_complete', 'scope'], 'invalid_native_usage_completeness');
  if (!TOKEN_FIELDS.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0) ||
      !TOKEN_FIELDS.some(key => usage[key] > 0) || !Number.isSafeInteger(usage.steps) || usage.steps < 1 || usage.steps > 200 ||
      !Number.isFinite(usage.cost_usd) || usage.cost_usd < 0 || usage.completeness.status !== 'platform_recorded_total' ||
      usage.completeness.episode_complete !== true || typeof usage.completeness.scope !== 'string' ||
      usage.completeness.scope.length > 256 || sha256(usage) !== completion.native_usage_sha256) fail('native_usage_incomplete');
  if (!Array.isArray(tools) || tools.length > 200) fail('native_tool_evidence_invalid');
  const calls = new Set();
  for (const tool of tools) {
    exact(tool, ['name', 'call_id', 'native_assistant_id', 'input_sha256', 'output_sha256', 'status'], 'native_tool_evidence_invalid');
    if (!['name', 'call_id', 'native_assistant_id'].every(key => typeof tool[key] === 'string' && tool[key].length > 0 && tool[key].length <= 256) ||
        !digest(tool.input_sha256) || !digest(tool.output_sha256) || tool.status !== 'completed' || calls.has(tool.call_id) ||
        !facts.captured_assistant_message_ids.includes(tool.native_assistant_id)) fail('native_tool_evidence_invalid');
    calls.add(tool.call_id);
  }
  return freeze(structuredClone({ completion_evidence: completion, native_recorded_usage: usage, tool_evidence: tools,
    upstream_usage_complete: 'unknown', billed_usd: null }));
}

// Exact allowlisted artifact emitted by the reviewed native bridge. This is still
// data-only validation; finalization additionally requires the live bridge brand.
export function validateNativeArtifactData(artifact, receipt, binding, facts) {
  validateNativeCompletionData(receipt, facts);
  exact(artifact, ['schema', 'profile_id', 'protocol_hash', 'registration_sha256', 'run_id', 'episode_id', 'nonce', 'incarnation',
    'session_id', 'prompt_sha256', 'snapshot_manifest_sha256', 'source_sha256', 'completion_evidence', 'post_release_bindings',
    'witness', 'seal', 'native_snapshot', 'native_recorded_usage', 'pricing', 'tool_evidence', 'upstream_usage_complete', 'billed_usd'], 'invalid_native_artifact_keys');
  const completion = receipt.completion_evidence, { evidence_path, evidence_sha256, ...embedded } = completion;
  if (artifact.schema !== 'real-use-native-completion-artifact/v1' ||
      !['profile_id', 'protocol_hash', 'registration_sha256', 'run_id', 'episode_id', 'nonce', 'prompt_sha256'].every(key => artifact[key] === binding[key]) ||
      artifact.session_id !== receipt.identity_validation.session_id || artifact.snapshot_manifest_sha256 !== binding.snapshot_sha256 ||
      !same(artifact.source_sha256, binding.source_sha256) || !same(artifact.completion_evidence, embedded) ||
      !same(artifact.native_recorded_usage, receipt.native_recorded_usage) || !same(artifact.tool_evidence, receipt.tool_evidence) ||
      artifact.upstream_usage_complete !== 'unknown' || artifact.billed_usd !== null ||
      sha256(artifact.native_recorded_usage) !== completion.native_usage_sha256 || sha256(artifact.pricing) !== completion.pricing_sha256 ||
      sha256(artifact.post_release_bindings) !== completion.post_release_bindings_sha256 ||
      completion.native_snapshot_sha256.some(hash => hash !== sha256(artifact.native_snapshot)) ||
      (artifact.witness === null ? completion.witness_sha256 !== null : sha256(artifact.witness) !== completion.witness_sha256)) fail('native_artifact_binding_mismatch');
  const modelHash = sha256({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default' });
  exact(artifact.pricing, ['schema', 'source', 'model_sha256', 'rates'], 'invalid_native_pricing');
  exact(artifact.pricing.rates, ['input', 'output', 'cache_read', 'cache_write'], 'invalid_native_pricing');
  if (artifact.pricing.schema !== 'real-use-native-pricing/v1' || artifact.pricing.source !== 'owned-selected-model-public-catalog' ||
      artifact.pricing.model_sha256 !== modelHash || !Object.values(artifact.pricing.rates).every(value => Number.isFinite(value) && value >= 0)) fail('invalid_native_pricing');
  const list = artifact.post_release_bindings, seenIDs = new Set(), seenEvents = new Set();
  if (!Array.isArray(list) || list.length !== receipt.native_recorded_usage.steps || list.length > 200 ||
      !same(list.map(value => value.native_assistant_id), facts.captured_assistant_message_ids) ||
      typeof artifact.incarnation !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(artifact.incarnation)) fail('native_artifact_correspondence_mismatch');
  for (const [index, value] of list.entries()) {
    exact(value, ['ordinal', 'release_digest', 'event_id', 'event_sha256', 'native_assistant_id', 'incarnation', 'session_sha256',
      'prompt_sha256', 'model_sha256', 'basis', 'identity_sha256'], 'invalid_native_post_release_binding');
    if (value.ordinal !== index + 1 || value.basis !== 'post_context_release_step_start' || value.incarnation !== artifact.incarnation ||
        value.session_sha256 !== sha256(artifact.session_id) || value.prompt_sha256 !== binding.prompt_sha256 || value.model_sha256 !== modelHash ||
        !['release_digest', 'event_sha256', 'identity_sha256'].every(key => digest(value[key])) ||
        typeof value.event_id !== 'string' || !value.event_id.length || value.event_id.length > 256 ||
        !/^msg_[A-Za-z0-9_-]+$/.test(value.native_assistant_id) || seenIDs.has(value.native_assistant_id) || seenEvents.has(value.event_id)) fail('native_artifact_correspondence_mismatch');
    seenIDs.add(value.native_assistant_id); seenEvents.add(value.event_id);
  }
  exact(artifact.seal, ['phase', 'ordinal', 'released', 'model_requests', 'active_tools', 'violations', 'records_sha256'], 'invalid_native_seal');
  if (artifact.seal.phase !== 'sealed' || ['ordinal', 'released', 'model_requests'].some(key => artifact.seal[key] !== list.length) ||
      artifact.seal.active_tools !== 0 || artifact.seal.violations !== 0 || !digest(artifact.seal.records_sha256)) fail('native_artifact_seal_mismatch');
  const snapshot = artifact.native_snapshot;
  exact(snapshot, ['session_id', 'session_sha256', 'rows', 'inbox_count', 'child_count', 'final_message_id', 'final_text_sha256', 'idle_at_ms'], 'invalid_native_snapshot');
  const userIndex = snapshot.rows?.[0]?.type === 'agent-switched' ? 1 : 0;
  if (snapshot.session_id !== artifact.session_id || !digest(snapshot.session_sha256) || snapshot.inbox_count !== 0 || snapshot.child_count !== 0 ||
      snapshot.final_message_id !== completion.native_message_id || snapshot.final_text_sha256 !== facts.final_text_sha256 ||
      !Number.isSafeInteger(snapshot.idle_at_ms) || snapshot.idle_at_ms !== completion.timestamp_basis.idle_at_ms ||
      snapshot.idle_at_ms > completion.timestamp_basis.closed_at_ms || !Array.isArray(snapshot.rows) ||
       snapshot.rows.length !== list.length + 2 + userIndex || snapshot.rows[userIndex]?.type !== 'user' || snapshot.rows.at(-1)?.type !== 'idle' ||
       snapshot.rows.some((row, index) => row.type === 'agent-switched' && index !== 0) ||
      !same(snapshot.rows.filter(row => row.type === 'assistant').map(row => row.id), facts.captured_assistant_message_ids)) fail('native_artifact_snapshot_mismatch');
  const rowIDs = new Set();
  for (const row of snapshot.rows) {
    exact(row, ['id', 'type', 'sha256'], 'invalid_native_snapshot_row');
    if (typeof row.id !== 'string' || row.id.length > 256 || rowIDs.has(row.id) || !['agent-switched', 'user', 'assistant', 'idle'].includes(row.type) || !digest(row.sha256)) fail('invalid_native_snapshot_row');
    rowIDs.add(row.id);
  }
  if (artifact.witness !== null) {
    const witness = artifact.witness;
    exact(witness, ['event_id', 'created', 'received_at_ms', 'received_after_closure', 'seq', 'session_sha256', 'incarnation', 'prompt_sha256'], 'invalid_native_witness');
    if (typeof witness.event_id !== 'string' || !witness.event_id.length || witness.event_id.length > 256 || seenEvents.has(witness.event_id) ||
        !Number.isSafeInteger(witness.seq) || !Number.isSafeInteger(witness.created) || !Number.isSafeInteger(witness.received_at_ms) ||
        witness.created < snapshot.idle_at_ms || witness.created > completion.timestamp_basis.closed_at_ms || witness.received_at_ms < witness.created ||
        witness.received_after_closure !== (witness.received_at_ms > completion.timestamp_basis.closed_at_ms) ||
        (completion.kind === 'native_preclose_witness' && witness.received_after_closure === true) ||
        witness.session_sha256 !== sha256(artifact.session_id) || witness.incarnation !== artifact.incarnation || witness.prompt_sha256 !== binding.prompt_sha256) fail('native_artifact_witness_mismatch');
  } else if (completion.kind === 'native_preclose_witness') fail('native_artifact_witness_missing');
  return true;
}

function assertFreshContinuation(state) {
  if (!state.executable) fail('preview_not_executable');
  if (state.halted || (state.cursor >= 2 && !state.checkpoint)) fail('first_pair_continuation_fenced');
  const frozen = revalidateRegistrationFreeze(state);
  if (sha256(bytes(state.registrationPath)) !== state.registrationSha256 || !same(state.registration.source_version, currentSourceVersion())) fail('stale_registration_or_source');
  checkSources(state.sourceHashes);
  validateFreshRegistration(state.registration);
  const ref = state.registration.source_lineage.verification;
  if (sha256(bytes(ref.path)) !== ref.sha256) fail('focused_verification_binding_mismatch');
  for (const check of pinnedJSON(ref.path, ref.sha256).checks) {
    if (sha256(bytes(check.evidence.path)) !== check.evidence.sha256) fail('focused_verification_failed');
  }
  // Admission independently enforces the prerequisite, not merely the loader's
  // earlier assessment. Preview handles cannot become executable or substitute
  // a JSON success flag for the immutable, externally bound probe artifacts.
  if (profileRole(state.manifest.profile_id) === 'workflows') {
    if (!state.prerequisite || !digest(state.probeCheckpointSha256)) fail('completed_probe_prerequisite_required');
    const current = verifyProbePrerequisite(state.registration, state.probeCheckpointSha256, frozen);
    if (!same(current, state.prerequisite)) fail('probe_prerequisite_changed');
  }
  if (state.checkpoint && sha256(bytes(state.checkpoint.path)) !== state.checkpoint.sha256) fail('first_pair_checkpoint_changed');
}
export function assertStudyContinuation(approved) { assertFreshContinuation(stateFor(approved)); }
function persistExclusive(file, value) {
  const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n'), fd = openSync(file, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < raw.length) { const count = writeSync(fd, raw, offset, raw.length - offset); if (!count) fail('checkpoint_short_write'); offset += count; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (!bytes(file).equals(raw)) fail('checkpoint_persistence_mismatch');
  return freeze({ path: file, sha256: sha256(raw) });
}
const COMPAT_SOURCE = 'preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md';
// Pure predicates shared by real checkpoint creation/replay and tests. A result
// saying passed is not authority; creation additionally requires consumed brands.
export function evaluateFirstPairCheckpoint(manifest, episodes, cleanups) {
  const failures = new Set(), checks = {};
  const check = (name, value) => { checks[name] = Boolean(value); if (!value) failures.add(name); };
  const profile = Object.hasOwn(FRESH_PROFILES, manifest.profile_id) && FRESH_PROFILES[manifest.profile_id];
  check('closed_profile', Boolean(profile && manifest.run_id === profile.run_id && manifest.model === profile.protocol.live_model &&
    manifest.protocol_hash === sha256(profile.protocol) && manifest.budgets.max_cost_usd === profile.protocol.max_cost_usd &&
    manifest.budgets.max_episodes === profile.protocol.max_episodes));
  check('exact_first_pair', Array.isArray(episodes) && episodes.length === 2 && episodes.every((episode, index) =>
    Object.keys(manifest.schedule[index]).every(key => episode[key] === manifest.schedule[index][key])));
  const sessions = episodes.map(episode => episode.identity_validation?.session_id);
  check('distinct_fresh_sessions', sessions.length === 2 && sessions.every(id => typeof id === 'string' && /^ses_[A-Za-z0-9_-]+$/.test(id)) && sessions[0] !== sessions[1]);
  const assistantGroups = episodes.map(episode => [...new Set([episode.completion_evidence?.native_message_id,
    ...(episode.tool_evidence ?? []).map(tool => tool.native_assistant_id)])]);
  check('distinct_native_assistant_ids', assistantGroups.length === 2 && assistantGroups.flat().every(id => typeof id === 'string' && /^msg_[A-Za-z0-9_-]+$/.test(id)) &&
    new Set(assistantGroups.flat()).size === assistantGroups.flat().length);
  check('operational_delivery', episodes.length === 2 && episodes.every(episode => episode.status === 'completed' &&
    episode.operational_classification === 'completed_answer' && episode.finalization?.status === 'validated_owned_receipt' &&
    episode.protocol_hash === manifest.protocol_hash && episode.identity_validation?.status === 'validated' &&
    episode.identity_validation.model === manifest.model && episode.identity_validation.variant === 'default' &&
    episode.identity_validation.prompt_sha256 === sha256(promptFor(manifest.tasks.find(task => task.id === episode.task_id) ?? { prompt: '' })) &&
    episode.guard?.status === 'passed' && episode.safety_failure !== true && episode.model_mismatch !== true &&
    episode.timeout !== true && !episode.capture_error && !episode.resource_failure && !episode.spawn_error &&
    !episode.capture_scope_error && !episode.provider_errors && !episode.extraction_failures && episode.exit_code === 0));
  check('all_owned_cleanup', episodes.length === 2 && episodes.every((episode, index) => {
    const cleaned = cleanups[index]?.cleanup;
    return cleanups[index]?.episode_id === episode.episode_id && cleaned?.confirmed === true && episode.cleanup?.confirmed === true &&
      ['server', 'daemon', 'cli'].every(key => cleaned[key]?.confirmed === true && cleaned[key].active_processes === 0) &&
      cleaned.cli.status === 'confirmed_absent' && cleaned.cli.process_tree_containment === true;
  }));
  check('complete_platform_accounting', episodes.length === 2 && episodes.every(episode => {
    try {
      validateNativeCompletionData({ ...episode, native_recorded_usage: episode.usage }, {
        native_closure_clean: episode.completion_evidence?.cli_complete,
        final_text_sha256: episode.final_text_sha256,
        captured_assistant_message_ids: [episode.completion_evidence?.native_message_id, ...(episode.tool_evidence ?? []).map(tool => tool.native_assistant_id)],
      });
      return sha256(episode.final_text ?? episode.text ?? '') === episode.final_text_sha256;
    } catch { return false; }
  }));
  const cost = checks.complete_platform_accounting ? episodes.reduce((sum, episode) => sum + episode.usage.cost_usd, 0) : null;
  check('below_profile_soft_threshold', Number.isFinite(cost) && cost < manifest.budgets.max_cost_usd);
  check('consistent_configured_pricing', episodes.length === 2 && digest(episodes[0].completion_evidence?.pricing_sha256) &&
    episodes[0].completion_evidence.pricing_sha256 === episodes[1].completion_evidence?.pricing_sha256);
  return freeze({ passed: failures.size === 0, checks, failure_codes: [...failures], accounting: {
    scope: 'OpenCode-recorded not provider billing', total_cost_usd: cost,
    complete_episodes: checks.complete_platform_accounting ? 2 : 0, attempted_episodes: episodes.length,
    threshold_usd: manifest.budgets.max_cost_usd, upstream_usage_complete: 'unknown', billed_usd: null } });
}

function captureBindings(out, item, episode, receipt, binding, captureSourceHash, facts) {
  const files = {}, suffixes = { events: 'events.ndjson', extraction: 'extraction.ndjson', stderr: 'stderr.txt', answer: 'answer.txt' };
  for (const [name, suffix] of Object.entries(suffixes)) {
    const file = path.join(out, 'episodes', `${item.episode_id}.${suffix}`), ref = episode.artifacts?.[name], raw = bytes(file);
    if (ref?.path !== file || ref.bytes !== raw.length || ref.sha256 !== sha256(raw)) fail('checkpoint_capture_artifact_mismatch');
    files[name] = { path: file, sha256: sha256(raw) };
  }
  if (files.answer.sha256 !== receipt.completion_evidence.final_text_sha256 || !same(episode.completion_evidence, receipt.completion_evidence) ||
      episode.capture_source_sha256 !== captureSourceHash || episode.protocol_hash !== binding.protocol_hash ||
      !same(episode.usage, receipt.native_recorded_usage) || !same(episode.tool_evidence, receipt.tool_evidence) ||
      !same(episode.identity_validation, receipt.identity_validation) || !same(episode.guard, receipt.guard) ||
      receipt.guard.nonce !== binding.nonce || receipt.guard.context_evidence_sha256 !== binding.context_evidence_sha256 ||
      receipt.identity_validation.prompt_sha256 !== binding.prompt_sha256 || !same(episode.cleanup?.bridge, receipt.cleanup) ||
      receipt.cleanup?.confirmed !== true || !['server', 'daemon', 'cli'].every(key => receipt.cleanup[key]?.confirmed === true && receipt.cleanup[key].active_processes === 0) ||
      receipt.cleanup.cli.status !== 'confirmed_absent' || receipt.cleanup.cli.process_tree_containment !== true || !digest(receipt.cleanup.cli.ownership_sha256)) fail('checkpoint_receipt_binding_mismatch');
  const native = receipt.completion_evidence;
  exact(facts, ['captured_assistant_message_ids', 'cli_closed_at', 'native_closure_clean', 'solver_deadline', 'final_text_sha256', 'capture_usage_sha256'], 'invalid_checkpoint_capture_facts');
  if (!Number.isSafeInteger(facts.cli_closed_at) || !Number.isSafeInteger(facts.solver_deadline) || facts.cli_closed_at > facts.solver_deadline ||
      facts.final_text_sha256 !== episode.final_text_sha256 || !digest(facts.capture_usage_sha256) ||
      !episode.capture_usage || sha256(episode.capture_usage) !== facts.capture_usage_sha256) fail('checkpoint_capture_facts_mismatch');
  validateNativeCompletionData(receipt, facts);
  const nativeBytes = bytes(native.evidence_path, 256 * 1024);
  if (sha256(nativeBytes) !== native.evidence_sha256) fail('checkpoint_native_artifact_mismatch');
  validateNativeArtifactData(JSON.parse(nativeBytes), receipt, binding, facts);
  captureToolCorrespondence(bytes(files.events.path).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)), receipt);
  return files;
}
function checkSetupBinding(start, admitted, item, binding) {
  const projection = Object.fromEntries(['run_id', 'episode_id', 'nonce', 'workspace', 'model', 'variant', 'prompt_sha256',
    'snapshot_sha256', 'source_sha256', 'context_evidence_sha256', 'protocol_hash', 'profile_id', 'registration_sha256'].map(key => [key, binding[key]]));
  if (![start, admitted].every(record => Object.keys(item).every(key => record?.[key] === item[key])) ||
      !Number.isFinite(Date.parse(start.started_at)) || admitted.capability !== 'opaque-consumed' || admitted.fixture_only !== false ||
      !same(admitted.episode_bindings, projection)) fail('checkpoint_setup_binding_mismatch');
}
function captureToolCorrespondence(events, receipt) {
  if (!Array.isArray(events) || events.length > 100000) fail('probe_capture_events_invalid');
  const calls = events.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'completed');
  if (calls.length !== receipt.tool_evidence.length) fail('native_capture_tool_count_mismatch');
  const normalize = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };
  return receipt.tool_evidence.map(tool => {
    const matching = calls.filter(event => event.part.id === tool.call_id && event.part.messageID === tool.native_assistant_id &&
      event.sessionID === receipt.identity_validation.session_id && event.part.tool === tool.name);
    if (matching.length !== 1) fail('probe_native_capture_call_mismatch');
    const event = matching[0], input = event.part.state.input, output = normalize(event.part.state.output);
    // Native normalized tool result is its single text part. Hash those exact
    // bytes; parse JSON separately only to inspect approved-source scope.
    if (sha256(input) !== tool.input_sha256 || typeof event.part.state.output !== 'string' ||
        sha256(event.part.state.output) !== tool.output_sha256) fail('probe_native_capture_hash_mismatch');
    return { name: tool.name, input, output, index: events.indexOf(event) };
  });
}
export function validateProbeToolCorrespondence(events, receipt, binding) {
  const matched = captureToolCorrespondence(events, receipt);
  const list = matched.find(tool => tool.name === 'approved_list' && same(tool.input, {}));
  const read = matched.find(tool => tool.name === 'approved_read' && same(tool.input, { path: COMPAT_SOURCE, offset: 5, limit: 1 }));
  if (!list || !read || list.index >= read.index || list.output?.manifest_sha256 !== binding.snapshot_sha256 ||
      read.output?.manifest_sha256 !== binding.snapshot_sha256 || read.output.path !== COMPAT_SOURCE ||
      !Array.isArray(list.output.sources) || !list.output.sources.some(source => source.path === COMPAT_SOURCE && digest(source.sha256)) ||
      !Array.isArray(read.output.lines) || read.output.lines.length !== 1 || read.output.lines[0].line !== 5) fail('probe_required_tools_missing');
  return true; // Data only, never a checkpoint or capability brand.
}
function checkProbeTools(capture, receipt, binding) {
  const events = bytes(capture.events.path).toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return validateProbeToolCorrespondence(events, receipt, binding);
}

export function persistFirstPairCheckpoint(approved) {
  const state = stateFor(approved);
  if (!state.registration || !state.executable || state.cursor !== 2 || state.pending || state.checkpoint) fail('checkpoint_not_owned_or_reused');
  checkSources(state.sourceHashes);
  revalidateRegistrationFreeze(state);
  const cleanups = [], artifacts = [], failures = [];
  for (const [index, settled] of state.settlements.entries()) {
    const { record, terminal } = settled, item = state.manifest.schedule[index], receipt = record.receipt;
    const prefix = path.join(approved.out, 'setup', String(index).padStart(2, '0'));
    const cleanup = JSON.parse(bytes(`${prefix}.cleanup.json`)); cleanups.push(cleanup);
    const entry = { episode_id: item.episode_id, terminal,
      setup_start: { path: `${prefix}.start.json`, sha256: sha256(bytes(`${prefix}.start.json`)) },
      setup_admitted: { path: `${prefix}.admitted.json`, sha256: sha256(bytes(`${prefix}.admitted.json`)) },
      setup_cleanup: { path: `${prefix}.cleanup.json`, sha256: sha256(bytes(`${prefix}.cleanup.json`)) },
      binding: record.binding, evidence_root: record.evidenceRoot, receipt: receipt ?? null, capture: null,
      capture_facts: record.facts ? { captured_assistant_message_ids: record.facts.captured_assistant_message_ids,
        cli_closed_at: record.facts.cli_closed_at, native_closure_clean: record.facts.native_closure_clean, solver_deadline: record.facts.solver_deadline,
        final_text_sha256: record.facts.final_text_sha256, capture_usage_sha256: sha256(record.facts.capture_usage) } : null };
    try {
      if (!receipt || finalizations.get(receipt)?.used !== true || finalizations.get(receipt).state !== state) fail('checkpoint_consumed_receipt_required');
      checkSetupBinding(pinnedJSON(entry.setup_start.path, entry.setup_start.sha256),
        pinnedJSON(entry.setup_admitted.path, entry.setup_admitted.sha256), item, record.binding);
      const episode = pinnedJSON(terminal.path, terminal.sha256);
      entry.capture = captureBindings(approved.out, item, episode, receipt, record.binding, state.sourceHashes['bench/v4/real-use/run.mjs'], entry.capture_facts);
      if (profileRole(state.manifest.profile_id) === 'compat') checkProbeTools(entry.capture, receipt, record.binding);
    } catch (error) { failures.push(/^[a-z_]+$/.test(error.message ?? '') ? error.message : 'checkpoint_evidence_validation_failed'); }
    artifacts.push(entry);
  }
  const predicate = evaluateFirstPairCheckpoint(state.manifest, state.episodes, cleanups);
  const checkpoint = { schema: 'real-use-first-pair-checkpoint/v1', profile_id: state.manifest.profile_id, run_id: state.manifest.run_id,
    freeze_sha256: state.freezeRef.sha256, registration_pair: state.registrationPair,
    registration_sha256: state.registrationSha256, registration_hash: sha256(state.registration), protocol_hash: state.manifest.protocol_hash,
    source_version: state.registration.source_version, episode_ids: state.manifest.schedule.slice(0, 2).map(item => item.episode_id),
    ...predicate, passed: predicate.passed && !failures.length, failure_codes: [...predicate.failure_codes, ...failures], artifacts };
  const ref = persistExclusive(path.join(approved.out, 'first-pair-checkpoint.json'), checkpoint);
  if (!checkpoint.passed) { state.halted = true; return freeze({ ...ref, passed: false }); }
  // Authority is set only after successful durable, exclusive persistence.
  state.checkpoint = ref;
  return freeze({ ...ref, passed: true });
}

// Data predicate only; a passing JSON object cannot unlock private continuation.
export function validateCheckpointFreezeBinding(checkpoint, freezeSha256, registrationPair) {
  exact(checkpoint, ['schema', 'profile_id', 'run_id', 'registration_sha256', 'registration_hash', 'protocol_hash', 'source_version',
    'episode_ids', 'passed', 'checks', 'failure_codes', 'accounting', 'artifacts', 'freeze_sha256', 'registration_pair'], 'invalid_probe_checkpoint');
  if (!digest(freezeSha256) || checkpoint.freeze_sha256 !== freezeSha256 || !same(checkpoint.registration_pair, registrationPair)) fail('probe_checkpoint_freeze_mismatch');
  return true;
}
function verifyProbePrerequisite(main, checkpointSha256, frozen) {
  if (!digest(checkpointSha256)) fail('externally_bound_probe_checkpoint_required');
  const requirement = main.prerequisite_probe, out = requirement.study_out;
  const checkpoint = pinnedJSON(requirement.checkpoint_path, checkpointSha256);
  validateCheckpointFreezeBinding(checkpoint, frozen.ref.sha256, frozen.record.registrations);
  if (sha256(bytes(path.join(out, 'freeze-record.json'), 64 * 1024)) !== frozen.ref.sha256) fail('probe_persisted_freeze_mismatch');
  const probePath = path.join(out, 'registration.json'), probeBytes = bytes(probePath), probe = JSON.parse(probeBytes);
  validateFreshRegistration(probe);
  if (sha256(probeBytes) !== frozen.record.registrations[0].sha256 || !same(main, frozen.registrations[1])) fail('wrong_frozen_probe_or_main');
  // Both specifications share the pre-probe freeze/source/evidence. The main
  // registration is never rewritten with hashes of later probe outcomes.
  if (probe.profile_id !== requirement.profile_id || probe.run_id !== requirement.run_id || probe.study_out !== out ||
      probe.created_at !== main.created_at || !same(probe.source_version, main.source_version) ||
      !same(probe.source_lineage, main.source_lineage)) fail('wrong_probe_registration');
  if (checkpoint.schema !== 'real-use-first-pair-checkpoint/v1' || checkpoint.profile_id !== probe.profile_id || checkpoint.run_id !== probe.run_id ||
      checkpoint.registration_sha256 !== sha256(probeBytes) || checkpoint.registration_hash !== sha256(probe) ||
      checkpoint.protocol_hash !== probe.manifest.protocol_hash || !same(checkpoint.source_version, main.source_version) ||
      !same(checkpoint.episode_ids, probe.manifest.schedule.map(item => item.episode_id)) || !Array.isArray(checkpoint.artifacts) ||
      checkpoint.artifacts.length !== 2) fail('probe_checkpoint_binding_mismatch');
  if (new Set(checkpoint.artifacts.map(entry => entry.evidence_root)).size !== 2 ||
      new Set(checkpoint.artifacts.map(entry => entry.binding?.nonce)).size !== 2) fail('probe_ownership_reused');
  const episodes = [], cleanups = [];
  for (const [index, entry] of checkpoint.artifacts.entries()) {
    exact(entry, ['episode_id', 'terminal', 'setup_start', 'setup_admitted', 'setup_cleanup', 'binding', 'evidence_root',
      'receipt', 'capture', 'capture_facts'], 'invalid_probe_checkpoint_artifact');
    exact(entry.receipt, ['identity_validation', 'guard', 'cleanup', 'completion_evidence', 'native_recorded_usage',
      'tool_evidence', 'upstream_usage_complete', 'billed_usd'], 'invalid_probe_checkpoint_receipt');
    const item = probe.manifest.schedule[index], prefix = path.join(out, 'setup', String(index).padStart(2, '0'));
    const expected = { terminal: path.join(out, 'episodes', `${item.episode_id}.json`), setup_start: `${prefix}.start.json`,
      setup_admitted: `${prefix}.admitted.json`, setup_cleanup: `${prefix}.cleanup.json` };
    const decoded = {};
    for (const [key, file] of Object.entries(expected)) {
      exact(entry[key], ['path', 'sha256'], 'invalid_probe_artifact_reference');
      if (entry[key]?.path !== file || !digest(entry[key].sha256)) fail('probe_artifact_path_mismatch');
      decoded[key] = pinnedJSON(file, entry[key].sha256);
    }
    const binding = entry.binding, receipt = entry.receipt;
    if (entry.episode_id !== item.episode_id || binding?.schema !== BRIDGE_API || binding.active !== true ||
        binding.startup_audit !== 'passed' || binding.context_abort_audit !== 'passed' || !digest(binding.context_evidence_sha256) ||
        binding.episode_id !== item.episode_id || binding.run_id !== probe.run_id || binding.condition !== item.condition ||
        binding.model !== probe.manifest.model || binding.variant !== 'default' || binding.profile_id !== probe.profile_id ||
        binding.protocol_hash !== probe.manifest.protocol_hash || binding.registration_sha256 !== checkpoint.registration_sha256 ||
        binding.prompt_sha256 !== sha256(promptFor(probe.manifest.tasks[0])) ||
        binding.snapshot_sha256 !== historical('prereg').snapshot_manifest_sha256 ||
        !same(binding.source_sha256, Object.fromEntries(DRIVER_SOURCES.filter(file => /\/(bridge\.mjs|stage\.mjs|runtime-plugin\.js|cli-builtins\.json)$/.test(file)).map(file => [file, main.source_version.source_sha256[file]]))) ||
        decoded.setup_start.episode_id !== item.episode_id || decoded.setup_admitted.episode_id !== item.episode_id ||
        !path.isAbsolute(entry.evidence_root ?? '') || path.dirname(path.resolve(entry.evidence_root)) !== path.resolve(TEMP) ||
        !path.isAbsolute(binding.workspace ?? '') || !path.resolve(binding.workspace).startsWith(path.resolve(entry.evidence_root) + path.sep) ||
        !path.resolve(receipt?.completion_evidence?.evidence_path ?? '').startsWith(path.resolve(entry.evidence_root) + path.sep)) fail('probe_owned_binding_mismatch');
    const capture = captureBindings(out, item, decoded.terminal, receipt, binding, main.source_version.source_sha256['bench/v4/real-use/run.mjs'], entry.capture_facts);
    checkSetupBinding(decoded.setup_start, decoded.setup_admitted, item, binding);
    if (!same(capture, entry.capture)) fail('probe_capture_binding_mismatch');
    checkProbeTools(capture, receipt, binding);
    episodes.push(snapshotSettledEpisode(decoded.terminal, item)); cleanups.push(decoded.setup_cleanup);
  }
  const predicate = evaluateFirstPairCheckpoint(probe.manifest, episodes, cleanups);
  if (!predicate.passed || checkpoint.passed !== true || checkpoint.failure_codes.length ||
      !same(predicate.checks, checkpoint.checks) || !same(predicate.accounting, checkpoint.accounting)) fail('probe_operational_prerequisite_failed');
  if (episodes.some(episode => !Number.isFinite(Date.parse(episode.started_at)) || Date.parse(frozen.record.created_at) >= Date.parse(episode.started_at))) fail('registrations_not_frozen_before_probe');
  return freeze({ path: requirement.checkpoint_path, sha256: checkpointSha256, registration_sha256: checkpoint.registration_sha256,
    freeze_sha256: frozen.ref.sha256, registration_pair: frozen.record.registrations,
    session_ids: episodes.map(episode => episode.identity_validation.session_id),
    assistant_ids: [...new Set(episodes.flatMap(episode => [episode.completion_evidence.native_message_id, ...episode.tool_evidence.map(tool => tool.native_assistant_id)]))] });
}
