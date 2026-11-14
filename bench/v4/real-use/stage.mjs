// Trusted-host staging only. No credentials are opened/copied; no DB path is changed.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT, MODEL_REF, PLUGIN_ID, SYSTEM, HOOK_REVIEW, makeRequestTemplate, hash, namesFor, permissionsFor, freeze, isNativeCompletionProfile } from './runtime-plugin.js';

export const APPROVED_TEMP = 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode';
const INSTALLED_MODULES = 'C:\\_Work\\__OPENAI_MATH\\.opencode\\node_modules';
const local = value => {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || /[:*?"<>|\x00-\x1f]/.test(value.slice(2))) throw new Error('absolute_local_path_required');
  return path.win32.normalize(value);
};

// Resolve the actual platform package, not npm's PowerShell/CMD wrapper. Never install.
export function resolveTrustedExecutable(cliPackageDir) {
  const root = local(cliPackageDir);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@opencode/cli' || manifest.version !== '2.0.29') throw new Error('cli_version_mismatch');
  const require = createRequire(path.join(root, 'package.json'));
  const name = process.arch === 'arm64' ? '@opencode/cli-windows-arm64' : '@opencode/cli-windows-x64-baseline';
  if (manifest.optionalDependencies?.[name] !== '2.0.29') throw new Error('platform_package_unavailable');
  const packageFile = require.resolve(`${name}/package.json`);
  const platform = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (platform.name !== name || platform.version !== '2.0.29') throw new Error('platform_version_mismatch');
  const executable = realpathSync(path.join(path.dirname(packageFile), 'bin', 'opencode.exe'));
  if (!lstatSync(executable).isFile()) throw new Error('executable_unavailable');
  return freeze({ executable, sha256: hash(readFileSync(executable)), version: platform.version });
}

export function cleanEnvironment(root, inherited = process.env) {
  // An explicitly selected native DB cannot silently be replaced by the default.
  // Inspect only presence, never its value or the database itself.
  if (Object.hasOwn(inherited, 'OPENCODE_DB')) throw new Error('native_db_locator_requires_operator_approval');
  // Only named non-secret OS path values are consulted, not enumerated/copied.
  const originalHome = local(inherited.USERPROFILE || inherited.HOME);
  const dataHome = inherited.XDG_DATA_HOME ? local(inherited.XDG_DATA_HOME) : path.win32.join(originalHome, '.local', 'share');
  const systemRoot = local(inherited.SystemRoot || inherited.SYSTEMROOT || 'C:\\Windows');
  return { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: path.win32.parse(systemRoot).root.slice(0, 2),
    ComSpec: path.win32.join(systemRoot, 'System32', 'cmd.exe'), PATH: path.win32.join(systemRoot, 'System32'),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    XDG_CONFIG_HOME: path.join(root, 'config-home'), XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: dataHome,
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
    OPENCODE_CONFIG_DIR: path.join(root, 'config'), OPENCODE_CONFIG: path.join(root, 'native.json'),
    OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' };
}

export function nativeConfig(condition, entryPath) {
  const permissions = permissionsFor(condition);
  const model = { providerID: MODEL_REF.providerID, model: MODEL_REF.id, variant: MODEL_REF.variant };
  // Empty arrays aren't merge resets: discovery is disabled and config home is fresh.
  return { model, default_agent: AGENT, update: 'disable', share: 'disabled', warming: false,
    snapshots: false, compaction: { auto: false }, formatter: false, lsp: false,
    permissions, agents: { [AGENT]: { mode: 'primary', model, system: SYSTEM, permissions } },
    // Strings are enablement selectors; external declarations use ConfigPlugin.Entry.
    plugins: [{ package: pathToFileURL(entryPath).href }] };
}

function installedContracts() {
  // Explicit public implementation/type files only. Never discover/read credential or configuration files.
  const files = ['@opencode/plugin/package.json', '@opencode/plugin/dist/source.js', '@opencode/plugin/dist/source.bun.js',
    '@opencode/plugin/dist/promise/adapter.js', '@opencode/plugin/dist/promise/session.d.ts', '@opencode/plugin/dist/promise/tool.d.ts',
    '@opencode/plugin/dist/promise/rpc.d.ts', '@opencode/schema/dist/rpc.d.ts', '@opencode/schema/dist/config.js',
    '@opencode/schema/dist/config/plugin.js', '@opencode/schema/dist/permission.js', '@opencode/schema/dist/location.js',
    '@opencode/protocol/dist/groups/rpc.js', '@opencode/protocol/dist/groups/location.js',
    '@opencode/plugin/node_modules/@opencode/client/dist/chunks/contract-8ye1ye6f.js'];
  return { schema: 'real-use-installed-contracts/v1', session_hook_order_review: HOOK_REVIEW,
    sources: files.map(file => ({ file, sha256: hash(readFileSync(path.join(INSTALLED_MODULES, file))) })) };
}

export function stageAudit({ condition, cliPackageDir, approvedPlugins = [], snapshotHash = null,
  snapshotRoot, image, dockerExecutable, endpoint = 'npipe:////./pipe/docker_engine', inherited = process.env, output, contextAudit, runId, episodeId, effectiveVariant,
  profileId, protocolHash, registrationDigest } = {}) {
  namesFor(condition);
  const fresh = [profileId, protocolHash, registrationDigest].some(value => value !== undefined);
  if (fresh && (!isNativeCompletionProfile(profileId, protocolHash) || !/^[a-f0-9]{64}$/.test(registrationDigest ?? ''))) throw new Error('invalid_episode_profile');
  if ((runId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) || (episodeId !== undefined && !/^[A-Za-z0-9_.-]{1,200}$/.test(episodeId)) ||
      (effectiveVariant !== undefined && effectiveVariant !== 'default')) throw new Error('invalid_episode_binding');
  if (Object.hasOwn(inherited, 'OPENCODE_DB')) throw new Error('native_db_locator_requires_operator_approval');
  if (snapshotHash !== null && !/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error('invalid_snapshot_hash');
  const withBackend = snapshotRoot !== undefined || image !== undefined || dockerExecutable !== undefined;
  if (withBackend && (!snapshotHash || !/^sha256:[a-f0-9]{64}$/.test(image ?? '') ||
      !/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint))) throw new Error('invalid_frozen_backend_configuration');
  if (withBackend) { local(snapshotRoot); local(dockerExecutable); }
  if (contextAudit && (Object.keys(contextAudit).some(key => !['prompt', 'promptHash', 'nativeTmpRelative'].includes(key)) ||
      typeof contextAudit.prompt !== 'string' || hash(contextAudit.prompt) !== contextAudit.promptHash ||
      typeof contextAudit.nativeTmpRelative !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(contextAudit.nativeTmpRelative))) throw new Error('context_preflight_configuration_required');
  const cli = resolveTrustedExecutable(cliPackageDir);
  // Optional explicit output is still constrained to a NEW owned approved-temp child.
  let root;
  if (output) {
    root = local(output);
    if (path.win32.dirname(root).toLowerCase() !== APPROVED_TEMP.toLowerCase() || !(fresh ? /^real-use-bridge-g00[56]-[A-Za-z0-9_-]+$/ : /^real-use-bridge-g004-[A-Za-z0-9_-]+$/).test(path.win32.basename(root))) throw new Error('output_not_owned');
    mkdirSync(root); // EEXIST also refuses files, links and previous runs.
  } else root = mkdtempSync(path.join(APPROVED_TEMP, `real-use-bridge-${fresh ? profileId.slice(0, 4) : 'g004'}-`));
  for (const name of ['home', 'roaming', 'local', 'config-home', 'state', 'cache', 'tmp', 'config', 'workspace', 'assets']) mkdirSync(path.join(root, name));
  mkdirSync(path.join(root, 'config', 'plugins'));
  const env = cleanEnvironment(root, inherited);
  const write = (file, value) => writeFileSync(path.join(root, file), value, { flag: 'wx', mode: 0o600 });
  const runtime = readFileSync(fileURLToPath(new URL('./runtime-plugin.js', import.meta.url)));
  write('assets/runtime-plugin.js', runtime);
  write('assets/package.json', '{"type":"module"}\n');
  const entryPath = path.join(root, 'config', 'plugins', 'entry.js');
  const entry = withBackend
    ? `import { Plugin } from '@opencode/plugin';\nimport { createFrozenRuntimePlugin } from '../../assets/runtime-plugin.js';\nimport options from '../../assets/bindings.json' with { type: 'json' };\nimport operator from '../../assets/operator.json' with { type: 'json' };\nexport default await createFrozenRuntimePlugin(Plugin, options, operator);\n`
    : `import { Plugin } from '@opencode/plugin';\nimport { createRuntimePlugin } from '../../assets/runtime-plugin.js';\nimport options from '../../assets/bindings.json' with { type: 'json' };\nexport default createRuntimePlugin(Plugin, options);\n`;
  write('config/plugins/entry.js', entry);
  const config = nativeConfig(condition, entryPath);
  const configBytes = JSON.stringify(config, null, 2) + '\n';
  write('native.json', configBytes);
  const cwd = path.join(root, 'workspace');
  const bindings = { condition, nonce: randomUUID(), project_sha256: hash(cwd), snapshot_sha256: snapshotHash,
    ...(fresh ? { profile_id: profileId, protocol_hash: protocolHash, registration_sha256: registrationDigest } : {}),
    run_id: runId ?? 'audit-only', episode_id: episodeId ?? condition,
    runtime_sha256: hash(runtime), config_sha256: hash(configBytes), cli_sha256: cli.sha256, entryPath, configPath: path.join(root, 'native.json'),
    approvedPlugins: [...approvedPlugins, { id: PLUGIN_ID, source_type: 'local', source_sha256: hash(entry) }] };
  if (contextAudit) bindings.requestTemplate = makeRequestTemplate({ sessionID: `ses_${randomUUID()}`, messageID: `msg_${randomUUID()}`,
    prompt: contextAudit.prompt, promptHash: contextAudit.promptHash, directory: cwd, projectDirectory: cwd,
    tmp: path.join(root, contextAudit.nativeTmpRelative), localDate: new Date().toDateString(), platform: process.platform });
  let operator = null;
  if (withBackend) {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const sourceFiles = ['bench/v4/real-use/runtime-tools.mjs', 'bench/v4/real-use/runtime-backend.mjs',
      'bench/v4/real-use/lib/snapshot-tools.mjs', 'bench/v3/arxivlean/lib/eval-sandbox.mjs',
      '.opencode/plugins/math-toolkit/lib/search.js', '.opencode/plugins/math-toolkit/lib/format.js',
      '.opencode/plugins/math-toolkit/scripts/math_compute.py'];
    const assetRoot = path.join(root, 'assets', 'frozen');
    mkdirSync(assetRoot);
    const sources = sourceFiles.map(file => {
      const bytes = readFileSync(path.join(repo, file));
      const target = path.join(assetRoot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      return { file, sha256: hash(bytes) };
    });
    write('assets/frozen/package.json', '{"type":"module"}\n');
    sources.push({ file: 'package.json', sha256: hash('{"type":"module"}\n') });
    mkdirSync(path.join(root, 'private'));
    operator = { assetRoot, sources, sourceGraphHash: hash(sources),
      snapshotRoot: local(snapshotRoot), expectedManifestHash: snapshotHash,
      backend: { image, dockerExecutable: local(dockerExecutable), endpoint,
        owner: { runId: `audit-${bindings.nonce}`, episodeId: condition, nonce: bindings.nonce },
        ledgerPath: path.join(root, 'private', 'backend-ledger.jsonl') } };
    bindings.backend_sha256 = operator.sourceGraphHash;
    write('assets/operator.json', JSON.stringify(operator, null, 2) + '\n');
    // Cleanup runs through the same owned launcher and exact frozen module/endpoint,
    // with fresh TEMP inside this stage; no second backend/process implementation.
    write('assets/cleanup.mjs', `import operator from './operator.json' with { type: 'json' };\nimport { cleanupFrozenBackend } from './runtime-plugin.js';\ntry { const result = await cleanupFrozenBackend(operator); console.log(JSON.stringify(result)); } catch { console.log(JSON.stringify({status:'unconfirmed',ledger_integrity:'unknown'})); process.exitCode=1; }\n`);
  }
  write('assets/bindings.json', JSON.stringify(bindings, null, 2) + '\n');
  write('installed-contracts.json', JSON.stringify(installedContracts(), null, 2) + '\n');
  // Never persist the environment: it contains the native data-root selection.
  return freeze({ root, cwd, env, cli, bindings, config, operator,
    contextPreflight: contextAudit ? { nativeTmp: path.join(root, contextAudit.nativeTmpRelative) } : null, production_admission: false });
}
