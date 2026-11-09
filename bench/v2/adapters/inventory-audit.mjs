import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, json, sha256, validateProfile } from '../lib.mjs';

export const F_CORE_TOOLS = ['read', 'glob', 'grep', 'shell'];
export const STATIC_BLOCKER = 'static-equivalent: no supported session-free effective tool inventory endpoint was found in OpenCode 2.0.29; runtime inventory remains unverified';
const same = (one, two) => JSON.stringify([...one].sort()) === JSON.stringify([...two].sort());
const matches = (pattern, value) => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(value);

// Deliberately bounded to the staged rule grammar. Resource-specific permissions
// and wildcard allows cannot establish an exact catalog and fail closed.
export function normalizePermissions(rules, names, policy = false) {
  assert(Array.isArray(rules) && rules.length, 'audit_failed: missing permission rules');
  for (const rule of rules) {
    assert(rule && typeof rule.action === 'string' && typeof rule.resource === 'string' && ['allow', 'deny'].includes(rule.effect), 'audit_failed: unsupported permission rule');
    const pattern = policy ? rule.resource : rule.action;
    assert(policy ? rule.action === 'tool.use' : rule.resource === '*', 'audit_failed: unsupported permission scope');
    assert(rule.effect !== 'allow' || (!pattern.includes('*') && names.includes(pattern)), `audit_failed: unbounded or unknown allow ${pattern}`);
  }
  assert(rules[0].effect === 'deny' && (policy ? rules[0].resource : rules[0].action) === '*', 'audit_failed: missing default deny');
  return names.filter(name => rules.findLast(rule => matches(policy ? rule.resource : rule.action, name))?.effect === 'allow');
}

// Only Node runs here, never opencode/run, a session endpoint, or a tool callback.
// Fresh env + cwd ensure imports/setup do not use the evaluator's HOME/config.
export function startPluginProbe(plan) {
  const child = spawn(process.execPath, [path.join(plan.workspace, '.audit/inventory-probe.mjs'), plan.workspace, plan.plugin ?? ''], {
    cwd: plan.workspace, env: plan.environment, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', closed = false;
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) reject(new Error('audit_failed: probe output limit')); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.once('close', code => {
      closed = true;
      if (code !== 0) return reject(new Error(stderr || `plugin_load_error: probe exit ${code}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('audit_failed: malformed plugin response')); }
    });
  });
  return { result, async close() {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      if (closed) return; // The trusted setup functions never spawn descendants.
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: 5000, encoding: 'utf8' });
      assert(!killed.error && killed.status === 0, 'audit_failed: probe process-tree cleanup failed');
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!closed) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('audit_failed: probe cleanup timeout')), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } };
}

// Non-inference runtime proof: start the real server with the staged environment
// and observe the staged plugin entry in the server's `loading plugin` log.
// This proves the real loader accepted the entry; it does not snapshot the
// filtered Code Mode catalog by itself (the static permission audit supplies it).
export function startServerProbe(plan, { spawn: spawnImpl = spawn, timeoutMs = 25000 } = {}) {
  const expected = plan.plugin ? pathToFileURL(path.join(plan.workspace, plan.plugin)).href : null;
  const child = spawnImpl(plan.command.executable, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: plan.workspace, env: plan.environment, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', settled = false, closed = false, port = null, password = null, requested = false, configOk = false;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`audit_failed: runtime server timeout${output ? `: ${output.slice(-2000)}` : ''}`));
    }, timeoutMs);
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const check = () => {
      const normalized = output.replaceAll('\\', '/');
      const pluginLoaded = normalized.includes('loading plugin') && normalized.includes(expected);
      if (expected ? pluginLoaded : configOk) finish({ loaded: true, entrypoint: expected, log: output.slice(-8000) });
    };
    const onData = chunk => {
      output = (output + chunk).slice(-64000);
      port ||= /server listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      password ||= /server password ([^\s]+)/.exec(output)?.[1];
      check();
      // OpenCode 2.0.29 loads project plugins lazily on the first API request.
      if (port && password && !requested) {
        requested = true;
        const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
        fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: auth }, signal: AbortSignal.timeout(5000) })
          .then(response => {
            if (!response.ok) throw new Error(`config request ${response.status}`);
            configOk = true;
            check();
          })
          .catch(error => {
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`audit_failed: runtime config request failed: ${error.message}`)); }
          });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => { closed = true; if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`audit_failed: runtime server exited ${code}`)); } });
  });
  return { result, async close() {
    if (!child.pid) return true;
    if (process.platform === 'win32') {
      if (closed) return true;
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: 5000, encoding: 'utf8' });
      return !killed.error && killed.status === 0;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') return false; }
    return true;
  } };
}

export async function auditInventory(plan, { checkWorkspace, startProbe = startPluginProbe, startServer = startServerProbe, timeoutMs = 15000 } = {}) {
  const expected = [...plan.requested_tools, ...(plan.core_tools ?? []), ...plan.transport_tools].sort();
  const report = {
    schema: 'math-opencode-inventory-audit/v1', profile: plan.condition_id,
    guarantee: 'static-equivalent', status: 'failed', runtime_verified: false,
    supported: false, isolation_verified: false, workspace: plan.workspace,
    workspace_tree: plan.hashes.workspace_tree, expected_tools: expected, observed_tools: null,
    registered_tools: null, plugin: null, plugin_loaded: false, cleanup: false, execution_blocker: STATIC_BLOCKER,
  };
  let probe, server, timer, runtimeTimer;
  try {
    assert(typeof checkWorkspace === 'function', 'audit_failed: workspace checker required');
    checkWorkspace(plan);
    const profile = validateProfile(json(path.join(plan.workspace, 'profile.json')));
    assert(profile.id === plan.condition_id && same(profile.effective_tools, plan.requested_tools) && sha256(profile) === plan.hashes.profile, 'audit_failed: profile mismatch');
    assert(same(plan.core_tools ?? [], profile.id === 'F' ? F_CORE_TOOLS : []) && same(plan.transport_tools, profile.id === 'A' ? [] : ['execute']), 'audit_failed: adapter inventory mismatch');
    assert(plan.environment.OPENCODE_CONFIG === path.join(plan.workspace, '.opencode/opencode.json'), 'audit_failed: config outside staging');
    assert(typeof plan.home === 'string' && path.isAbsolute(plan.home), 'audit_failed: external home required');
    const relativeHome = path.relative(plan.workspace, plan.home);
    assert(relativeHome.startsWith('..') || path.isAbsolute(relativeHome), 'audit_failed: home must be outside the workspace');
    assert(existsSync(path.join(plan.home, 'data')) && existsSync(path.join(plan.home, 'config')), 'audit_failed: external home missing');
    if (plan.auth_provisioned) assert(existsSync(path.join(plan.home, 'data/opencode/auth.json')), 'audit_failed: provisioned auth missing');
    for (const [key, expectedPath] of Object.entries({
      HOME: plan.home, USERPROFILE: plan.home,
      XDG_CONFIG_HOME: path.join(plan.home, 'config'),
      XDG_DATA_HOME: path.join(plan.home, 'data'),
      XDG_STATE_HOME: path.join(plan.home, 'state'),
      XDG_CACHE_HOME: path.join(plan.home, 'cache'),
      OPENCODE_CONFIG_DIR: path.join(plan.home, 'config'),
    })) assert(plan.environment[key] === expectedPath, `audit_failed: non-staged ${key}`);
    const config = json(plan.environment.OPENCODE_CONFIG);
    assert(sha256(config) === plan.hashes.config, 'audit_failed: config mismatch');
    const plugin = plan.plugin ? pathToFileURL(path.join(plan.workspace, plan.plugin)).href : null;
    assert(plan.plugin === (profile.id === 'A' ? null : profile.id === 'B' ? '.opencode/plugins/generic-tools.js' : '.opencode/plugins/math-toolkit.js'), 'audit_failed: wrong staged plugin');
    if (plan.provider_plugin) {
      assert(config.plugins.length === 1 && config.plugins[0]?.package === plan.provider_plugin, 'audit_failed: unexpected provider plugin entry');
      assert(existsSync(path.join(plan.workspace, 'node_modules', plan.provider_plugin, 'package.json')), 'audit_failed: provider package missing');
    } else {
      assert(same(config.plugins, []), 'audit_failed: explicit plugin entries must be empty; staged discovery is authoritative');
    }
    assert(profile.id !== 'A' || plugin === null, 'audit_failed: A must not load a math plugin');
    probe = startProbe(plan);
    const loaded = await Promise.race([probe.result, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('audit_failed: plugin audit timeout')), timeoutMs);
    })]);
    assert(loaded && loaded.plugin === plugin && Array.isArray(loaded.tools) && loaded.tools.every(name => typeof name === 'string'), 'audit_failed: invalid staged plugin response');
    report.plugin = loaded.plugin;
    report.registered_tools = loaded.tools;
    assert(new Set(loaded.tools).size === loaded.tools.length && same(loaded.tools, profile.effective_tools), 'audit_failed: extra or missing plugin tool');
    assert(profile.id === 'F' || !loaded.tools.some(name => name.startsWith('math_')), 'audit_failed: math_* forbidden in A/B');
    // Core tools here are an explicit adapter allowlist, not a claimed exhaustive
    // OpenCode registration snapshot. Unknown/wildcard allows are rejected above.
    const catalog = [...loaded.tools, ...F_CORE_TOOLS, 'execute'];
    const permissions = normalizePermissions(config.agents?.benchmark?.permissions, catalog);
    const policies = normalizePermissions(config.policies, catalog, true);
    report.observed_tools = permissions.filter(name => policies.includes(name)).sort();
    assert(same(permissions, expected) && same(policies, expected) && same(report.observed_tools, expected), 'audit_failed: extra or missing effective tool');
    report.status = 'passed';
    if (startServer) {
      server = startServer(plan);
      const runtime = await Promise.race([server.result, new Promise((_, reject) => {
        runtimeTimer = setTimeout(() => reject(new Error('audit_failed: runtime server timeout')), timeoutMs);
      })]);
      assert(runtime?.loaded === true, 'audit_failed: server did not load the staged plugin');
      report.guarantee = 'runtime-plugin-load';
      report.runtime_verified = true;
      report.supported = true;
      report.isolation_verified = true;
      report.catalog_basis = 'static-permissions+plugin-load';
      report.plugin_loaded = plan.plugin !== null;
      report.runtime_entrypoint = runtime.entrypoint ?? null;
      report.runtime_log = runtime.log ?? null;
      report.execution_blocker = null;
    }
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  } finally {
    clearTimeout(timer);
    clearTimeout(runtimeTimer);
    let cleanup = true;
    try { await probe?.close(); } catch (error) { cleanup = false; report.error ??= error.message; }
    try { if (server) cleanup = (await server.close()) && cleanup; } catch (error) { cleanup = false; report.error ??= error.message; }
    report.cleanup = cleanup;
    if (!cleanup) { report.status = 'failed'; report.error ??= 'audit_failed: cleanup failed'; }
    try { checkWorkspace?.(plan); }
    catch (error) { report.status = 'failed'; report.error = error.message; }
    if (report.status !== 'passed') report.runtime_verified = false;
  }
  return report;
}
