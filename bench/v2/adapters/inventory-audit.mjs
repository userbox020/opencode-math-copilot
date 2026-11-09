import { spawn, spawnSync } from 'node:child_process';
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

export async function auditInventory(plan, { checkWorkspace, startProbe = startPluginProbe, timeoutMs = 15000 } = {}) {
  const expected = [...plan.requested_tools, ...(plan.core_tools ?? []), ...plan.transport_tools].sort();
  const report = {
    schema: 'math-opencode-inventory-audit/v1', profile: plan.condition_id,
    guarantee: 'static-equivalent', status: 'failed', runtime_verified: false,
    supported: false, isolation_verified: false, workspace: plan.workspace,
    workspace_tree: plan.hashes.workspace_tree, expected_tools: expected, observed_tools: null,
    registered_tools: null, plugin: null, cleanup: false, execution_blocker: STATIC_BLOCKER,
  };
  let probe, timer;
  try {
    assert(typeof checkWorkspace === 'function', 'audit_failed: workspace checker required');
    checkWorkspace(plan);
    const profile = validateProfile(json(path.join(plan.workspace, 'profile.json')));
    assert(profile.id === plan.condition_id && same(profile.effective_tools, plan.requested_tools) && sha256(profile) === plan.hashes.profile, 'audit_failed: profile mismatch');
    assert(same(plan.core_tools ?? [], profile.id === 'F' ? F_CORE_TOOLS : []) && same(plan.transport_tools, profile.id === 'A' ? [] : ['execute']), 'audit_failed: adapter inventory mismatch');
    assert(plan.environment.OPENCODE_CONFIG === path.join(plan.workspace, '.opencode/opencode.json'), 'audit_failed: config outside staging');
    for (const [key, relative] of Object.entries({ HOME: 'home', USERPROFILE: 'home', XDG_CONFIG_HOME: 'home',
      XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'home/data', XDG_STATE_HOME: 'home/state', OPENCODE_CONFIG_DIR: 'home/config' })) {
      assert(plan.environment[key] === path.join(plan.workspace, relative), `audit_failed: non-staged ${key}`);
    }
    const config = json(plan.environment.OPENCODE_CONFIG);
    assert(sha256(config) === plan.hashes.config, 'audit_failed: config mismatch');
    const plugin = plan.plugin ? pathToFileURL(path.join(plan.workspace, plan.plugin)).href : null;
    assert(plan.plugin === (profile.id === 'A' ? null : profile.id === 'B' ? '.opencode/plugins/generic-tools.js' : '.opencode/plugins/math-toolkit.js'), 'audit_failed: wrong staged plugin');
    assert(same(config.plugins, []), 'audit_failed: explicit plugin entries must be empty; staged discovery is authoritative');
    assert(plan.environment.OPENCODE_CONFIG_PROJECT_DISABLE === undefined, 'audit_failed: project discovery must be confined to the staged workspace');
    assert(profile.id !== 'A' || plugin === null, 'audit_failed: A must not load a plugin');
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
  } catch (error) { report.error = error.message; }
  finally {
    clearTimeout(timer);
    try { await probe?.close(); report.cleanup = true; }
    catch (error) { report.status = 'failed'; report.error = error.message; }
    try { checkWorkspace?.(plan); }
    catch (error) { report.status = 'failed'; report.error = error.message; }
  }
  return report;
}
