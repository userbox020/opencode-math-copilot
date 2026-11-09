import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERIC_TOOL_NAMES = ['corpus_search', 'read_excerpt', 'compute', 'lean_check'];
const OPERATIONS = ['simplify', 'factor', 'expand', 'solve', 'diff', 'integrate', 'limit', 'series', 'evalf', 'det', 'eigenvalues'];
const IMPORTS = ['Init', 'Init.Data.Nat.Basic', 'Init.Data.Int.Basic', 'Init.Data.List.Basic'];
const check = (condition, message) => { if (!condition) throw new Error(message); };
function argsOnly(args, allowed) {
  check(args && typeof args === 'object' && !Array.isArray(args), 'Expected an argument object');
  check(Object.keys(args).every(key => allowed.includes(key)), 'Unknown argument; arbitrary file paths are not supported');
}
function text(value, name, max) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'), `${name} must contain 1-${max} characters`);
  return value;
}
function integer(value, fallback, min, max) {
  value ??= fallback;
  check(Number.isInteger(value) && value >= min && value <= max, `Expected integer in ${min}-${max}`);
  return value;
}
function identifier(value) {
  text(value, 'Excerpt identifier', 1024);
  check(!path.isAbsolute(value) && !/^[a-z]:/i.test(value) && !value.replaceAll('\\', '/').split('/').some(part => part === '..' || /^(?:graders?|answers?|correct_final|private)(?:\.|$)/i.test(part)), 'Private/path-traversal identifiers are forbidden');
  return value;
}
function regular(root, relative, directory = false) {
  let current = root;
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    current = path.join(current, part);
    check(!lstatSync(current).isSymbolicLink(), 'Linked workspace paths are forbidden');
  }
  const stat = lstatSync(current);
  check(directory ? stat.isDirectory() : stat.isFile(), 'Unexpected workspace file type');
  return current;
}
function corpus(root) {
  const file = regular(root, 'corpus/excerpts.json');
  check(lstatSync(file).size <= 2 * 1024 * 1024, 'Public corpus exceeds 2 MiB');
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  check(Array.isArray(rows) && rows.length <= 2000, 'Public corpus must contain at most 2000 excerpts');
  return rows.map(row => {
    argsOnly(row, ['document', 'locator', 'text']);
    identifier(row.document); identifier(row.locator); text(row.text, 'Excerpt text', 100000);
    return { document: row.document, locator: row.locator, text: row.text };
  });
}
function findNative(name, environment) {
  for (const base of (environment.PATH ?? environment.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(base.replace(/^"|"$/g, ''), name + (process.platform === 'win32' ? '.exe' : ''));
    try {
      const resolved = realpathSync(candidate);
      // Elan shims can install toolchains. Only a preinstalled native compiler is allowed.
      if (/(?:^|[\\/])\.elan[\\/]bin[\\/]/i.test(candidate) || /(?:^|[\\/])elan(?:\.exe)?$/i.test(resolved)) continue;
      if (lstatSync(resolved).isFile()) return resolved;
    } catch { /* Missing PATH entries are ordinary. */ }
  }
  return null;
}
function childEnvironment(root, environment) {
  const env = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC']) if (environment[key]) env[key] = environment[key];
  if (!env.PATH && environment.Path) env.PATH = environment.Path;
  return { ...env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'home/roaming'), LOCALAPPDATA: path.join(root, 'home/local'),
    TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'home'), XDG_DATA_HOME: path.join(root, 'home/data'),
    XDG_STATE_HOME: path.join(root, 'home/state'), XDG_CACHE_HOME: path.join(root, 'cache') };
}
function execution(result) {
  if (result.error) return result.error.code === 'ETIMEDOUT' ? 'timeout' : 'error';
  return result.status === 0 ? 'completed' : 'failed';
}

// This deliberately supports a small declarative fragment, not arbitrary Lean
// metaprogramming. No strings, comments, commands, custom syntax, IO or evaluators.
export function leanSource(args) {
  argsOnly(args, ['code', 'imports', 'timeoutMs']);
  const code = text(args.code, 'Lean code', 8000).trim();
  const imports = args.imports ?? ['Init'];
  check(Array.isArray(imports) && imports.length <= 4 && imports.every(name => IMPORTS.includes(name)), 'Only allowlisted Init imports are supported');
  const match = /^(?:theorem [A-Za-z][A-Za-z0-9_]*|example)\s*:\s*([^\r\n]+?)\s*:=\s*by\s+([\s\S]+)$/.exec(code);
  check(match, 'Expected one theorem/example with a single-line type and a bounded by proof');
  check(/^[A-Za-z0-9_ .():=+*\/<>,|\-∀∃∧∨¬→↔≤≥≠ℕℤ]+$/.test(match[1]) && !/--|\/\*|\*\/|\b(?:by|where|let|do|match|unsafe|IO)\b/.test(match[1]), 'Unsupported Lean type syntax');
  const tactics = match[2].split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  check(tactics.length > 0 && tactics.length <= 40 && tactics.every(line => /^(?:trivial|rfl|decide|assumption|constructor|simp|intro(?: [A-Za-z][A-Za-z0-9_]*)+|exact (?:True\.intro|[A-Za-z][A-Za-z0-9_]*))$/.test(line)), 'Unsupported Lean tactic; executable commands/metaprograms are forbidden');
  return imports.map(name => `import ${name}\n`).join('') + code + '\n';
}

export function createGenericExecutors({ directory, environment = process.env, invoke = spawnSync, find = findNative, worker = fileURLToPath(new URL('./generic/compute.py', import.meta.url)) }) {
  check(typeof directory === 'string' && path.isAbsolute(directory), 'An explicit episode workspace is required');
  const root = directory;
  // Read the one public file once; no tool-supplied filesystem location is ever used.
  const excerpts = corpus(root);
  const env = childEnvironment(root, environment);
  const run = (executable, args, cwd, timeout) => invoke(executable, args, {
    cwd, env, shell: false, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 128 * 1024,
  });
  return {
    corpus_search(args = {}) {
      argsOnly(args, ['query', 'limit']);
      const query = text(args.query, 'query', 500).toLowerCase();
      const limit = integer(args.limit, 5, 1, 10);
      const matches = excerpts.filter(row => `${row.document}\n${row.locator}\n${row.text}`.toLowerCase().includes(query));
      return { scope: 'public-excerpts-only', exhaustive_inventory: false, total_matches: matches.length,
        excerpts: matches.slice(0, limit).map(row => ({ ...row, text: row.text.slice(0, 2000), truncated: row.text.length > 2000 })) };
    },
    read_excerpt(args = {}) {
      argsOnly(args, ['document', 'locator', 'maxChars']);
      identifier(args.document); identifier(args.locator);
      const max = integer(args.maxChars, 4000, 1, 8000);
      const row = excerpts.find(row => row.document === args.document && row.locator === args.locator);
      check(row, 'Excerpt not found in public corpus');
      return { ...row, text: row.text.slice(0, max), truncated: row.text.length > max, scope: 'public-excerpts-only' };
    },
    compute(args = {}) {
      argsOnly(args, ['operation', 'expression', 'variable', 'matrix', 'point', 'order', 'timeoutMs']);
      check(OPERATIONS.includes(args.operation), 'Unsupported compute operation');
      const timeout = integer(args.timeoutMs, 5000, 100, 10000);
      const { timeoutMs, ...payload } = args;
      check(JSON.stringify(payload).length <= 20000, 'Compute arguments exceed 20000 characters');
      const python = find('python3', environment) ?? find('python', environment);
      if (!python) return { status: 'missing-tool', error: 'Preinstalled Python 3 and SymPy are required' };
      check(path.resolve(worker) === path.join(root, '.opencode/plugins/generic/compute.py'), 'Worker must be the staged fixed allowlist worker');
      regular(root, '.opencode/plugins/generic/compute.py');
      const result = run(python, ['-I', '-B', worker, JSON.stringify(payload)], root, timeout);
      const status = execution(result);
      if (status !== 'completed') return { status, error: 'Bounded compute worker did not complete' };
      try {
        const response = JSON.parse(result.stdout);
        check(typeof response.ok === 'boolean', 'Invalid worker response');
        return response.ok ? { status: 'completed', result: String(response.result).slice(0, 16000) }
          : { status: 'rejected', error: String(response.error).slice(0, 1000) };
      } catch { return { status: 'error', error: 'Invalid compute worker response' }; }
    },
    lean_check(args = {}) {
      const source = leanSource(args);
      const timeout = integer(args.timeoutMs, 5000, 100, 10000);
      const lean = find('lean', environment);
      const base = { verification: 'not-performed', receipt: null, scope: 'compiler-check-only' };
      if (!lean) return { ...base, status: 'missing-tool', compilation: 'not-run', error: 'Preinstalled native Lean required; no elan download or lake build is performed' };
      const tmp = regular(root, 'tmp', true);
      const working = mkdtempSync(path.join(tmp, 'generic-lean-'));
      try {
        const file = path.join(working, 'Snippet.lean');
        writeFileSync(file, source, { flag: 'wx' });
        const result = run(lean, ['--threads=1', '--memory=256', file], working, timeout);
        const status = execution(result);
        return { ...base, status, compilation: status === 'completed' ? 'compiled' : 'failed', exit_code: result.status,
          stdout: String(result.stdout ?? '').slice(0, 16000), stderr: String(result.stderr ?? '').slice(0, 4000) };
      } finally { rmSync(working, { recursive: true, force: true }); }
    },
  };
}

const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
export const GENERIC_INPUTS = {
  corpus_search: object({ query: { type: 'string', minLength: 1, maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['query']),
  read_excerpt: object({ document: { type: 'string' }, locator: { type: 'string' }, maxChars: { type: 'integer', minimum: 1, maximum: 8000 } }, ['document', 'locator']),
  compute: object({ operation: { type: 'string', enum: OPERATIONS }, expression: { type: 'string', maxLength: 2000 },
    variable: { type: 'string' }, matrix: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    point: { type: ['string', 'number'] }, order: { type: 'integer', minimum: 1, maximum: 50 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 } }, ['operation']),
  lean_check: object({ code: { type: 'string', maxLength: 8000 }, imports: { type: 'array', items: { type: 'string', enum: IMPORTS } },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 } }, ['code']),
};
