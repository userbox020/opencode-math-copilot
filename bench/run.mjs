import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  model: 'opencode-go/deepseek-v4.1-flash',
  problems: path.join(root, 'bench/problems.json'),
  repeats: 1,
  timeout: 180,
};
const flags = new Set(['standalone', 'json', 'md', 'dry-run']);
const values = new Set(['model', 'problems', 'repeats', 'timeout']);

function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--')) throw new Error(`Unexpected argument: ${args[i]}`);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = ['repeats', 'timeout'].includes(key) ? Number(value) : value;
    } else throw new Error(`Unknown option: --${key}`);
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 1) {
    throw new Error('--repeats must be a positive integer');
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
}

function resolveCommand() {
  if (process.platform !== 'win32') return { command: 'opencode', prefix: [] };
  // Node cannot execute .cmd files with shell:false. Resolve the installed
  // Windows shim to its native executable (or npm JavaScript entry point).
  const dirs = (process.env.PATH || '').split(path.delimiter)
    .map((dir) => dir.replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, 'opencode.exe');
    if (existsSync(exe)) return { command: exe, prefix: [] };
    const shim = path.join(dir, 'opencode.cmd');
    if (!existsSync(shim)) continue;
    const contents = readFileSync(shim, 'utf8');
    const native = contents.match(/"%dp0%[\\/]([^"\r\n]+\.exe)"/i);
    const candidates = [
      ...(native ? [path.resolve(dir, native[1])] : []),
      path.join(dir, 'node_modules/@opencode/cli/bin/opencode.exe'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { command: candidate, prefix: [] };
    }
    const js = path.join(dir, 'node_modules/opencode-ai/bin/opencode');
    if (existsSync(js)) return { command: process.execPath, prefix: [js] };
    throw new Error(`Cannot resolve ${shim} to an executable with shell:false`);
  }
  throw new Error('opencode.cmd or opencode.exe not found on PATH');
}

function score(problem, output) {
  const text = output.toLowerCase();
  return problem.keywords.every((word) => text.includes(word.toLowerCase()))
    && (!problem.anyKeywords || problem.anyKeywords.some((word) => text.includes(word.toLowerCase())));
}

function displayCommand(command, args) {
  return [command, ...args].map((arg) => JSON.stringify(arg)).join(' ');
}

function main() {
  parseArgs();
  const problems = JSON.parse(readFileSync(path.resolve(options.problems), 'utf8'));
  if (!Array.isArray(problems) || !problems.length) throw new Error('Problems must be a nonempty array');
  for (const problem of problems) {
    const words = (value) => Array.isArray(value) && value.every((word) => typeof word === 'string' && word.length);
    if (!problem.id || typeof problem.prompt !== 'string' || !problem.prompt
      || !words(problem.keywords)
      || (problem.anyKeywords !== undefined && (!words(problem.anyKeywords) || !problem.anyKeywords.length))
      || (!problem.keywords.length && !problem.anyKeywords)) {
      throw new Error(`Invalid problem: ${problem.id ?? '(missing id)'}`);
    }
  }
  const conditions = [
    { name: 'with plugin', cwd: root },
    { name: 'without plugin', cwd: path.join(os.tmpdir(), 'opencode-math-bench-no-plugin') },
  ];
  let executable;
  let resolutionError;
  try { executable = resolveCommand(); } catch (error) { resolutionError = error.message; }
  if (!options['dry-run']) {
    const configDir = path.join(conditions[1].cwd, '.opencode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'opencode.json'), `${JSON.stringify({
      $schema: 'https://opencode.ai/config.json', plugins: [],
    }, null, 2)}\n`);
  }
  const results = [];
  for (const problem of problems) {
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      for (const condition of conditions) {
        const args = ['run', '--model', options.model, '--agent', 'build', '--format', 'default'];
        if (options.standalone) args.push('--standalone');
        args.push(problem.prompt);
        if (options['dry-run']) {
          console.log(`[${condition.name}] ${problem.id} #${repeat} cwd=${condition.cwd}`);
          console.log(displayCommand(process.platform === 'win32' ? 'opencode.cmd' : 'opencode', args));
          if (executable && process.platform === 'win32') {
            console.log(`  shell:false target: ${displayCommand(executable.command, executable.prefix)}`);
          }
          continue;
        }
        const started = performance.now();
        let child;
        try {
          if (resolutionError) throw new Error(resolutionError);
          child = spawnSync(executable.command, [...executable.prefix, ...args], {
            cwd: condition.cwd,
            shell: false,
            encoding: 'utf8',
            timeout: options.timeout * 1000,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          });
        } catch (error) {
          child = { error, status: null };
        }
        const stdout = child.stdout || '';
        const stderr = child.stderr || '';
        const output = `${stdout}\n${stderr}`;
        results.push({
          problem: problem.id, condition: condition.name, repeat,
          durationMs: Math.round(performance.now() - started),
          exitCode: child.status ?? null,
          signal: child.signal ?? null,
          error: child.error?.message ?? null,
          timedOut: child.error?.code === 'ETIMEDOUT',
          score: !child.error && child.status === 0 && score(problem, output),
          stdout, stderr, output,
        });
      }
    }
  }
  if (options['dry-run']) {
    if (resolutionError) console.log(`Resolution warning: ${resolutionError}`);
    console.log(`Dry run: ${problems.length * options.repeats * conditions.length} commands; no inference or files written.`);
    return;
  }
  const rows = results.map((result) => ({
    problem: result.problem, condition: result.condition, repeat: result.repeat,
    seconds: (result.durationMs / 1000).toFixed(2),
    exit: result.exitCode ?? 'error', score: result.score ? 'PASS' : 'FAIL',
  }));
  console.table(rows);
  const summary = conditions.map(({ name }) => {
    const runs = results.filter((result) => result.condition === name);
    return {
      condition: name, passed: runs.filter((run) => run.score).length, total: runs.length,
      errors: runs.filter((run) => run.error || run.exitCode !== 0).length,
      meanDurationMs: Math.round(runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length),
    };
  });
  const summaryLines = summary.map((item) => `${item.condition}: ${item.passed}/${item.total} passed, ${item.errors} errors, ${(item.meanDurationMs / 1000).toFixed(2)}s mean`);
  console.log(summaryLines.join('\n'));
  if (options.json || options.md) {
    const dir = path.join(root, 'bench/results');
    mkdirSync(dir, { recursive: true });
    if (options.json) writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify({
      createdAt: new Date().toISOString(), options, conditions, problems, summary, results,
    }, null, 2)}\n`);
    if (options.md) {
      const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
      const lines = [
        '# Math plugin benchmark', '', `Model: ${cell(options.model)}`, '',
        '| Problem | Condition | Repeat | Seconds | Exit | Score |',
        '| --- | --- | --- | --- | --- | --- |',
        ...rows.map((row) => `| ${Object.values(row).map(cell).join(' | ')} |`),
        '', ...summaryLines, '',
      ];
      writeFileSync(path.join(dir, 'latest.md'), lines.join('\n'));
    }
  }
}

try { main(); } catch (error) {
  console.error(`Benchmark configuration error: ${error.message}`);
  process.exitCode = 1;
}
