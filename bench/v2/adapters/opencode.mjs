import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMON_PROMPT, ROOT, assert, assertWorkspace, json, loadProfiles, parseArgs, prepareWorkspace, serialize, sha256 } from '../lib.mjs';
import { GENERIC_TOOL_NAMES } from './generic-runtime.mjs';
import { auditInventory, F_CORE_TOOLS, STATIC_BLOCKER } from './inventory-audit.mjs';

const REPO = path.resolve(ROOT, '../..');
const AGENT = 'benchmark';
const PRIVATE = /^(grading|grader|correct_final|answer|answers|expected_final|reference_answer|private)$/i;
const rule = (action, effect) => ({ action, resource: '*', effect });

function publicValue(value) {
  if (Array.isArray(value)) return value.filter(item => !isPrivate(item)).map(publicValue);
  if (value && typeof value === 'object') {
    assert(!isPrivate(value), 'Private value in public task input');
    return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE.test(key)).map(([key, item]) => [key, publicValue(item)]));
  }
  return value;
}
function isPrivate(value) {
  return value && typeof value === 'object' && (value.private === true || value.public === false || value.visibility === 'private' || value.access === 'private');
}
export function sanitizeTask(task) {
  assert(task && typeof task.id === 'string' && /^[\w.-]+$/.test(task.id), 'Invalid task id');
  assert(typeof task.prompt === 'string' && typeof task.type === 'string', 'Task needs public prompt/type');
  assert(!isPrivate(task), 'Task is marked private');
  return {
    id: task.id, type: task.type, prompt: task.prompt, answer_contract: publicValue(task.answer_contract),
    excerpts: (task.excerpts ?? []).filter(item => !isPrivate(item)).map(item => {
      // No arbitrary paths or nested private metadata from the evaluator are copied.
      assert(['document', 'locator', 'text'].every(key => typeof item[key] === 'string'), 'Invalid public excerpt');
      return { document: item.document, locator: item.locator, text: item.text };
    }),
  };
}

function put(directory, relative, content, files) {
  const target = path.join(directory, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: 'wx' });
  files[relative.replaceAll('\\', '/')] = sha256(content);
}

function copyTree(source, destination, directory, files) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `isolation_failure: linked runtime asset ${entry.name}`);
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || /^(test|tests|__tests__|docs|examples)$/i.test(entry.name)) continue;
    const relative = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(path.join(source, entry.name), relative, directory, files);
    else if (/\.(?:js|mjs|cjs|json|wasm|py)$/.test(entry.name)) put(directory, relative, readFileSync(path.join(source, entry.name)), files);
  }
}

function stagePlugin(directory, files) {
  const source = path.join(REPO, '.opencode/plugins');
  put(directory, '.opencode/plugins/math-toolkit.js', readFileSync(path.join(source, 'math-toolkit.js')), files);
  put(directory, '.opencode/plugins/math-toolkit/main.js', readFileSync(path.join(source, 'math-toolkit/main.js')), files);
  copyTree(path.join(source, 'math-toolkit/lib'), '.opencode/plugins/math-toolkit/lib', directory, files);
  for (const script of ['math_compute.py', 'build-index.mjs']) {
    put(directory, `.opencode/plugins/math-toolkit/scripts/${script}`, readFileSync(path.join(source, 'math-toolkit/scripts', script)), files);
  }
  // Deliberately do not copy the repository's corpus, generated indexes, tests or answers.
  // No fake toy index is substituted for the full corpus. Missing indexes remain unavailable.
  stageDependencies(directory, files, ['@opencode/plugin', 'unpdf']);
  return '.opencode/plugins/math-toolkit.js';
}

function stageGenericPlugin(directory, files) {
  // OpenCode 2.0.29 auto-discovers immediate .js plugins; the runtime stays in a subdirectory.
  put(directory, '.opencode/plugins/generic-tools.js', readFileSync(new URL('./generic-tools.mjs', import.meta.url)), files);
  put(directory, '.opencode/plugins/lib/generic-runtime.mjs', readFileSync(new URL('./generic-runtime.mjs', import.meta.url)), files);
  put(directory, '.opencode/plugins/generic/compute.py', readFileSync(path.join(REPO, '.opencode/plugins/math-toolkit/scripts/math_compute.py')), files);
  stageDependencies(directory, files, ['@opencode/plugin']);
  return '.opencode/plugins/generic-tools.js';
}

function stageDependencies(directory, files, names) {
  const visited = new Set();
  function dependency(name) {
    if (visited.has(name)) return;
    assert(/^(@[\w.-]+\/)?[\w.-]+$/.test(name), 'Invalid dependency name');
    visited.add(name);
    const source = path.join(REPO, 'node_modules', name);
    assert(existsSync(path.join(source, 'package.json')), `unsupported-profile: missing local runtime dependency ${name}; install repository dependencies first`);
    assert(!lstatSync(source).isSymbolicLink(), `isolation_failure: linked dependency ${name}`);
    const metadata = json(path.join(source, 'package.json'));
    copyTree(source, `node_modules/${name}`, directory, files);
    for (const child of Object.keys(metadata.dependencies ?? {})) dependency(child);
  }
  names.forEach(dependency);
}

export function assertPreparedWorkspace(plan) {
  const found = [];
  const directories = new Set(['home', 'cache', 'tmp']);
  for (const name of Object.keys(plan.files)) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      assert(!entry.isSymbolicLink(), `isolation_failure: symlink ${name}`);
      if (entry.isDirectory()) {
        assert(directories.has(name), `isolation_failure: unexpected directory ${name}`);
        visit(path.join(directory, entry.name), name + '/');
      } else {
        assert(Object.hasOwn(plan.files, name), `isolation_failure: unexpected file ${name}`);
        assert(sha256(readFileSync(path.join(directory, entry.name))) === plan.files[name], `isolation_failure: changed file ${name}`);
        found.push(name);
      }
    }
  }
  visit(plan.workspace);
  assert(found.length === Object.keys(plan.files).length, 'isolation_failure: missing file');
}

export function buildConfig(profile) {
  // OpenCode 2.0.29 @opencode/schema: policies and permissions are ordered rule arrays.
  // Schema acceptance is NOT proof that denied tools disappear from the model catalog.
  const names = [...profile.effective_tools, ...(profile.id === 'F' ? F_CORE_TOOLS : []), ...(profile.id !== 'A' ? ['execute'] : [])];
  return {
    update: 'disable', share: 'disabled', snapshots: false, warming: false,
    default_agent: AGENT, skills: [], instructions: [],
    plugins: [],
    policies: [rule('tool.use', 'deny'), ...names.map(name => ({ action: 'tool.use', resource: name, effect: 'allow' }))],
    agents: { [AGENT]: { mode: 'primary', system: COMMON_PROMPT, permissions: [rule('*', 'deny'), ...names.map(name => rule(name, 'allow'))] } },
  };
}

export function unsupportedReasons(profile) {
  const reasons = ['OpenCode 2.0.29 source supports deny-based catalog filtering, but the effective runtime inventory and exclusive config/session isolation have not been audited. Managed config and host access require evaluator-controlled containment.'];
  if (profile.id === 'B') reasons.push('B has an exact four-tool local generic plugin plus execute transport; runtime filtering/containment and installed Python/SymPy/native Lean availability remain unaudited.');
  if (profile.id === 'F') reasons.push('F stages the local 16-tool plugin and dependencies and permits its execute transport, but runtime filtering is unaudited. The full corpus/indexes and Lean toolchain are not public task inputs and are not mounted; excerpt JSON is not a native plugin corpus.');
  return reasons;
}

function resolveExecutable(environment) {
  for (const directory of (environment.PATH ?? environment.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const base = directory.replace(/^"|"$/g, '');
    // Windows npm cmd/ps1 shims cannot be spawned safely with shell:false.
    const candidates = process.platform === 'win32'
      ? [path.join(base, 'opencode.exe'), path.join(base, 'node_modules/@opencode/cli/bin/opencode.exe')]
      : [path.join(base, 'opencode')];
    for (const candidate of candidates) if (existsSync(candidate) && lstatSync(candidate).isFile()) return path.resolve(candidate);
  }
  return 'opencode';
}

export function prepareEpisode({ task, profile, model, executable, environment = process.env }) {
  assert(typeof model === 'string' && /^[^\s/]+\/[^\s]+$/.test(model), '--model must be provider/model');
  const safeTask = sanitizeTask(task);
  const prepared = prepareWorkspace(safeTask, profile);
  const directory = prepared.directory;
  try {
    // Reuse the v2 exact public-file audit before adding adapter-controlled runtime assets.
    assertWorkspace(directory, prepared.files);
    const files = Object.fromEntries(Object.entries(prepared.files).map(([name, content]) => [name, sha256(content)]));
    put(directory, 'package.json', serialize({ private: true, type: 'module' }), files);
    put(directory, '.audit/inventory-probe.mjs', readFileSync(new URL('./inventory-probe.mjs', import.meta.url)), files);
    const config = buildConfig(profile);
    const plugin = profile.id === 'F' ? stagePlugin(directory, files) : profile.id === 'B' ? stageGenericPlugin(directory, files) : null;
    if (profile.id === 'B') assert(JSON.stringify(profile.effective_tools) === JSON.stringify(GENERIC_TOOL_NAMES), 'Generic plugin inventory mismatch');
    // Project discovery is confined to this fresh workspace; the staged .opencode/plugins
    // directory is auto-discovered. No global config is present in the redirected HOME.
    assert(config.plugins.length === 0, 'Explicit plugin entries are not used; staged discovery is authoritative');
    put(directory, '.opencode/opencode.json', serialize(config), files);
    const env = {};
    for (const [key, aliases] of Object.entries({ PATH: ['PATH', 'Path'], PATHEXT: ['PATHEXT'], SystemRoot: ['SystemRoot', 'SYSTEMROOT'], WINDIR: ['WINDIR'], COMSPEC: ['COMSPEC', 'ComSpec'] })) {
      const value = aliases.map(alias => environment[alias]).find(Boolean);
      if (value) env[key] = value;
    }
    Object.assign(env, prepared.environment, {
      XDG_DATA_HOME: path.join(directory, 'home/data'), XDG_STATE_HOME: path.join(directory, 'home/state'),
      APPDATA: path.join(directory, 'home/roaming'), LOCALAPPDATA: path.join(directory, 'home/local'),
      TMP: path.join(directory, 'tmp'), TEMP: path.join(directory, 'tmp'),
      OPENCODE_CONFIG_DIR: path.join(directory, 'home/config'),
      OPENCODE_CONFIG: path.join(directory, '.opencode/opencode.json'),
      MATH_TOOLKIT_DISABLE_EXTRAS: '1', MATH_TOOLKIT_DISABLE_PDF_CACHE: '1',
    });
    const prompt = `${COMMON_PROMPT}\n\nPublic task:\n${prepared.files['task.json']}\n${profile.corpus_access ? 'Public excerpts, if any, are in corpus/excerpts.json.' : 'No corpus or tools are available.'}`;
    const args = ['run', '--model', model, '--agent', AGENT, '--format', 'json', '--standalone', '--', prompt];
    const plan = {
      schema: 'math-opencode-plan/v1', simulated: false, mode: 'dry-run', task_id: task.id, task_type: task.type,
      condition_id: profile.id, model_id: model, workspace: directory,
      command: { executable: executable ?? resolveExecutable(environment), args, cwd: directory, shell: false }, environment: env, config,
      requested_tools: profile.effective_tools, effective_tools: profile.id === 'B' ? [...GENERIC_TOOL_NAMES] : null,
      inventory_status: profile.id === 'B' ? 'staged-plugin-exact' : 'unverified',
      inventory_supported: profile.id === 'B', runtime_inventory_status: 'unverified',
      transport_tools: profile.id !== 'A' ? ['execute'] : [],
      core_tools: profile.id === 'F' ? [...F_CORE_TOOLS] : [],
      plugin, files, hashes: { public_payload: prepared.payloadHash, public_task: sha256(prepared.files['task.json']), profile: sha256(profile), config: sha256(config), workspace_tree: sha256(files) },
      supported: unsupportedReasons(profile).length === 0, diagnostics: unsupportedReasons(profile),
      isolation: { fresh_workspace: true, environment_allowlist: true, prior_session: false, global_config: 'redirected; runtime audit pending', os_sandbox: false },
    };
    assertPreparedWorkspace(plan);
    return plan;
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

// Recognizes the text/step_finish NDJSON envelope only. Unknown installed CLI formats
// fail closed; raw captures are retained for a later version-specific parser.
export function parseOutput(stdout) {
  const events = [];
  try {
    for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
      const event = JSON.parse(line);
      assert(event && typeof event === 'object' && typeof event.type === 'string', 'Invalid event envelope');
      events.push(event);
    }
    assert(events.length, 'Empty event stream');
    assert(!events.some(event => event.type === 'error'), 'CLI emitted error event');
    const lastFinish = events.findLastIndex(event => event.type === 'step_finish');
    let messageID, finalText, usage;
    if (lastFinish >= 0) {
      assert(['stop', 'end_turn'].includes(events[lastFinish].part?.reason), 'Missing successful final step_finish');
      assert(!events.slice(lastFinish + 1).some(event => ['text', 'step_start', 'tool_use'].includes(event.type)), 'Output after final step_finish');
      messageID = events[lastFinish].part?.messageID;
      assert(typeof messageID === 'string' && messageID.length, 'Missing final messageID');
      finalText = events.slice(0, lastFinish).filter(event => event.type === 'text' && event.part?.messageID === messageID).map(event => {
        assert(typeof event.part?.text === 'string', 'Malformed assistant text event');
        return event.part.text;
      }).join('');
      usage = events.filter(event => event.type === 'step_finish').map(event => ({ tokens: event.part?.tokens ?? null, cost: event.part?.cost ?? null }));
    } else {
      // A no-tool answer can end with a text event and no step_finish in 2.0.29.
      // Accept the final text but never invent usage; the study runner treats
      // missing usage as an operational failure, not an under-budget success.
      const texts = events.filter(event => event.type === 'text' && typeof event.part?.text === 'string');
      assert(texts.length, 'Missing final assistant text');
      messageID = texts[texts.length - 1].part?.messageID;
      assert(typeof messageID === 'string' && messageID.length, 'Missing final messageID');
      finalText = texts.filter(event => event.part?.messageID === messageID).map(event => event.part.text).join('');
      usage = null;
    }
    assert(finalText.trim(), 'Missing final assistant text');
    const final = JSON.parse(finalText);
    assert(final && !Array.isArray(final) && typeof final === 'object' && typeof final.type === 'string', 'Missing typed JSON final');
    return { status: 'candidate_ready', final, final_text: finalText, events, usage, usage_source: usage ? 'unvalidated-cli-events' : 'unavailable-no-step-finish', error: null };
  } catch (error) {
    return { status: 'extraction_failure', final: null, final_text: null, events, usage: null, error: error.message };
  }
}

export function executeEpisode(plan, { allowExecution = false, invoke = spawnSync, audit = null } = {}) {
  assert(allowExecution === true, 'execution_not_authorized: --execute also requires MATH_BENCH_ALLOW_EXECUTE=1');
  // No CLI flag can turn a proposed profile into an audited profile. The injectable
  // audit seam is for evaluator integration and inference-free tests, not a user assertion.
  assert(audit?.status === 'passed' && audit?.runtime_verified === true && audit?.guarantee === 'runtime-verified' &&
    audit?.supported === true && audit?.isolation_verified === true && audit?.profile === plan.condition_id &&
    audit?.workspace === plan.workspace && audit?.workspace_tree === plan.hashes.workspace_tree && audit?.cleanup === true &&
    JSON.stringify([...(audit?.observed_tools ?? [])].sort()) === JSON.stringify([...plan.requested_tools, ...plan.core_tools, ...plan.transport_tools].sort()),
  `unsupported-profile ${plan.condition_id}: ${audit?.execution_blocker ?? STATIC_BLOCKER}`);
  assertPreparedWorkspace(plan);
  const start = performance.now();
  let result;
  try {
    result = invoke(plan.command.executable, plan.command.args, {
      cwd: plan.workspace, env: plan.environment, shell: false, encoding: 'utf8',
      windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) { result = { status: null, error, stdout: '', stderr: '' }; }
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const parsed = result.status === 0 && !result.error ? parseOutput(stdout) : {
    status: 'execution_failure', final: null, events: [], usage: null,
    error: result.error?.message ?? `OpenCode exit ${result.status}`,
  };
  return {
    schema: 'math-opencode-candidate/v1', simulated: false, task_id: plan.task_id,
    condition_id: plan.condition_id, model_id: plan.model_id, ...parsed,
    duration_ms: performance.now() - start, exit_code: result.status, stdout, stderr,
    hashes: { ...plan.hashes, stdout: sha256(stdout), stderr: sha256(stderr) },
    verification: { status: plan.task_type === 'formal' ? 'pending' : 'not-requested', receipt: null },
    graded: false,
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env, { startProbe } = {}) {
  const options = parseArgs(argv.filter(arg => arg !== '--audit'), ['--profile', '--task', '--tasks', '--model', '--out', '--dry-run', '--execute']);
  options['--audit'] = argv.includes('--audit');
  assert(!(options['--dry-run'] && options['--execute']), 'Choose --dry-run or --execute, not both');
  assert(!(options['--audit'] && options['--execute']), '--audit exits without inference; do not combine with --execute');
  assert(options['--profile'] && options['--model'] && options['--out'], '--profile, --model and --out are required');
  assert(options['--task'] || options['--tasks'], '--task or --tasks is required');
  if (options['--execute']) assert(environment.MATH_BENCH_ALLOW_EXECUTE === '1', 'execution_not_authorized: --execute also requires MATH_BENCH_ALLOW_EXECUTE=1');
  const profile = loadProfiles().find(profile => profile.id === options['--profile']);
  assert(profile, 'Unknown profile; choose A, B or F');
  const tasks = json(path.resolve(options['--tasks'] ?? path.join(ROOT, 'fixtures/tasks.json')));
  assert(Array.isArray(tasks) && tasks.length, '--tasks must contain a nonempty JSON task array');
  assert(new Set(tasks.map(task => task.id)).size === tasks.length, 'Duplicate task ids');
  const selected = options['--task'] ? tasks.filter(task => task.id === options['--task']) : tasks;
  assert(selected.length, 'Task not found');
  const out = path.resolve(options['--out']);
  mkdirSync(out, { recursive: true });
  let unsupported = false;
  let auditFailed = false;
  for (const task of selected) {
    const plan = prepareEpisode({ task, profile, model: options['--model'], environment });
    try {
    const destination = path.join(out, path.basename(plan.workspace));
    mkdirSync(destination);
    let audit;
    if (options['--audit'] || options['--execute']) {
      audit = await auditInventory(plan, { checkWorkspace: assertPreparedWorkspace, startProbe });
      plan.runtime_inventory_status = audit.guarantee;
      plan.audit_status = audit.status;
      plan.diagnostics.unshift(audit.execution_blocker);
      writeFileSync(path.join(destination, 'audit.json'), serialize(audit), { flag: 'wx' });
      auditFailed ||= audit.status !== 'passed';
    }
    writeFileSync(path.join(destination, 'plan.json'), serialize(plan), { flag: 'wx' });
    const { files, environment: childEnvironment, ...display } = plan;
    if (options['--audit']) console.log(JSON.stringify({ profile: profile.id, status: audit.status, guarantee: audit.guarantee,
      expected_tools: audit.expected_tools, observed_tools: audit.observed_tools, plugin_loaded_from_staging: audit.plugin !== null && audit.status === 'passed',
      cleanup: audit.cleanup, execution_blocker: audit.execution_blocker, ...(audit.error ? { error: audit.error } : {}) }));
    else console.log(serialize({ ...display, environment: childEnvironment, file_count: Object.keys(files).length, manifest: path.join(destination, 'plan.json') }));
    if (options['--execute']) {
      const candidate = executeEpisode(plan, { allowExecution: true, audit });
      writeFileSync(path.join(destination, 'candidate.json'), serialize(candidate), { flag: 'wx' });
    }
    unsupported ||= !plan.supported;
    } finally {
      if (options['--audit'] || options['--execute']) rmSync(plan.workspace, { recursive: true, force: true });
    }
  }
  return auditFailed ? 1 : unsupported ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
