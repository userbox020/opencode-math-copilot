// Operator-only synthetic smoke. This records evidence, never amends admission
// authority or dispatches inference. Test seams are parameters, not CLI overrides.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, parseArgs, sha256 } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = Object.freeze({
  tempRoot: 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode',
  fixtureRoot: 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\eval-checker-g004-grade-cli-YqdTTY',
  buildReceipt: 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\eval-checker-g004-789fe1d19ce243fda0851cb8601e7712\\build-receipt.json',
  dockerExecutable: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  corpusRoot: 'C:/_Work/__OPENAI_MATH/math',
  gradeFile: path.join(HERE, 'grade.mjs'),
  adapterFile: path.join(HERE, 'checker-adapter.mjs'),
});
const FIXTURE = 'operator gold positive; synthetic captured episode; NOT a model solve or study score';
const TASK = 'lean-cancellation-repair';
const ADAPTER = 'bench/v4/real-use/checker-adapter.mjs';
const ARTIFACTS = Object.freeze({
  summary: 'smoke-summary.json',
  results: 'captured-synthetic/evaluation/private/checker-results.json',
  requests: 'captured-synthetic/evaluation/private/checker-requests.json',
  blind: 'captured-synthetic/evaluation/blind.json',
});
const same = (a, b) => canonical(a) === canonical(b);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const json = (io, file) => JSON.parse(io.readFileSync(file, 'utf8'));
const writeJSON = (io, file, value) => io.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function options(argv) {
  const args = parseArgs(argv, ['--out', '--attempts', '--retry-delay-ms']);
  requireThat(args['--out'], '--out required');
  const integer = (value, minimum, label) => {
    requireThat(/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum, `${label}: invalid integer`);
    return Number(value);
  };
  return {
    out: args['--out'],
    attempts: integer(args['--attempts'] ?? '2', 1, '--attempts'),
    retryDelayMs: integer(args['--retry-delay-ms'] ?? '5000', 0, '--retry-delay-ms'),
  };
}

export function validateOutput(out, { io = fs, tempRoot = DEFAULTS.tempRoot } = {}) {
  requireThat(typeof out === 'string' && path.isAbsolute(out) && !out.includes('\0') &&
    !out.split(/[\\/]/).includes('..') &&
    (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(out)), '--out must be an absolute local path');
  const root = path.resolve(tempRoot), target = path.resolve(out);
  requireThat(inside(root, target), '--out outside approved temp root');
  // Resolve every existing ancestor; reject junction escapes, including a fresh
  // leaf under a pre-existing redirect. Never accept even an empty output root.
  let ancestor = target;
  for (;;) {
    try {
      io.lstatSync(ancestor);
      requireThat(ancestor !== target, '--out already exists');
      const real = io.realpathSync(ancestor), approved = io.realpathSync(root);
      requireThat(real === approved || inside(approved, real), '--out parent escapes approved temp root');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return target;
}

export function copyFixture(root, { io = fs, fixtureRoot = DEFAULTS.fixtureRoot } = {}) {
  io.mkdirSync(root, { mode: 0o700 });
  const captured = path.join(root, 'captured-synthetic');
  // Reject linked inputs rather than copying a link that could target the fixture.
  const unlinked = file => {
    const stat = io.lstatSync(file);
    requireThat(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'unsafe fixture entry');
    if (stat.isDirectory()) for (const name of io.readdirSync(file)) unlinked(path.join(file, name));
  };
  unlinked(path.join(fixtureRoot, 'captured-synthetic'));
  unlinked(path.join(fixtureRoot, 'evaluator-gold.json'));
  io.cpSync(path.join(fixtureRoot, 'captured-synthetic'), captured, { recursive: true, errorOnExist: true, force: false });
  io.copyFileSync(path.join(fixtureRoot, 'evaluator-gold.json'), path.join(root, 'evaluator-gold.json'));
  io.rmSync(path.join(captured, 'evaluation'), { recursive: true, force: true });
}

function fixtureEpisode(root, io) {
  const captured = path.join(root, 'captured-synthetic');
  const manifest = json(io, path.join(captured, 'manifest.json'));
  const files = io.readdirSync(path.join(captured, 'episodes')).filter(name => name.endsWith('.json'));
  requireThat(files.length === 1, 'exactly one captured episode required');
  const episode = json(io, path.join(captured, 'episodes', files[0]));
  requireThat(manifest.run_id === 'operator_checker_cli_positive' &&
    manifest.model === 'fixture/no-provider-call' && episode.model === manifest.model &&
    episode.fixture_kind === 'operator positive control; synthetic capture, not a model solve' &&
    episode.status === 'completed' && episode.task_id === TASK &&
    episode.episode_id?.startsWith(`operator_checker_cli_positive.${TASK}.`) &&
    manifest.schedule.some(item => item.episode_id === episode.episode_id), 'not the synthetic no-provider fixture');
  return episode.episode_id;
}

function packet(root, io) {
  const artifacts = Object.fromEntries(['results', 'requests', 'blind'].map(key => [key, json(io, path.join(root, ARTIFACTS[key]))]));
  requireThat(Object.values(artifacts).every(records => Array.isArray(records) && records.length === 1), 'exactly one graded episode required');
  return { result: artifacts.results[0], requestRecord: artifacts.requests[0], blind: artifacts.blind[0] };
}

function validateBindings(data, context) {
  const { result, requestRecord, blind } = data, request = requestRecord.request, receipt = result.receipt;
  const { build, adapterHash, episodeId, run } = context;
  const policy = build.challenges?.[TASK];
  const images = { runtime: build.runtime_image_id, core: build.core_image_id, export: build.export_worker_image_id, checker: build.checker_image_id };
  requireThat(run.providerCalls === 0, 'provider calls not confirmed absent');
  requireThat(build.schema === 'eval-checker-build/v1' && build.status === 'images_built' &&
    !build.cleanup_unconfirmed?.length && Object.values(images).every(image => /^sha256:[a-f0-9]{64}$/.test(image)) &&
    build.source_hashes?.[ADAPTER] === adapterHash, 'build receipt mismatch');
  requireThat(result.episode_id === episodeId && result.episode_id === requestRecord.episode_id &&
    result.blind_id === blind.blind_id && blind.schema === 'real-use-blind/v1' &&
    blind.task?.id === TASK && blind.checker_required === true, 'episode binding mismatch');
  requireThat(request?.schema === 'real-use-checker-request/v1' && typeof request.code === 'string' &&
    sha256(request.code) === request.code_sha256 && sha256(request.policy) === request.policy_sha256 &&
    request.policy_sha256 === policy?.policy_sha256, 'request policy/code mismatch');
  requireThat(receipt?.schema === 'real-use-checker-receipt/v1' && receipt.task_id === TASK &&
    receipt.evidence === 'local-docker' && receipt.adapter_sha256 === adapterHash &&
    same(receipt.images, images) && receipt.challenge_source_sha256 === policy.challenge_source_sha256 &&
    receipt.challenge_export_sha256 === policy.challenge_export_sha256, 'receipt build binding mismatch');
  const binding = { code_sha256: request.code_sha256, policy_sha256: request.policy_sha256 };
  requireThat([receipt, result.checker, blind.checker].every(item => item &&
    item.code_sha256 === binding.code_sha256 && item.policy_sha256 === binding.policy_sha256) &&
    same(blind.checker_binding, binding), 'checker binding mismatch');
  return { receipt, images, binding };
}

// Fail closed: a timeout string in stderr is not evidence. Only the adapter's
// bound worker outcomes qualify, and every created worker must be absent.
export function retryableTimeout(receipt) {
  if (receipt?.status !== 'unavailable' || receipt.cleanup !== 'confirmed_absent') return false;
  const a = receipt.outcomes?.export, b = receipt.outcomes?.check;
  const timedOut = worker => worker?.status === 'unavailable' && worker.failure === 'timeout' &&
    worker.reason === 'timeout' && worker.cleanup === 'confirmed_absent';
  if (timedOut(a) && b === null) return true;
  return a?.status === 'exported' && a.cleanup === 'confirmed_absent' &&
    a.exit_code === 0 && a.signal === null && a.failure === null && timedOut(b);
}

export function assembleSummary(data, context) {
  const { receipt, images, binding } = validateBindings(data, context);
  requireThat(context.run.code === 0 && !context.run.signal && !context.run.error, 'grade CLI did not exit cleanly');
  requireThat(receipt.status === 'accepted' && data.result.checker.status === 'accepted' &&
    data.blind.checker.status === 'accepted' && data.blind.candidate_status === 'candidate', 'checker not accepted');
  requireThat(receipt.cleanup === 'confirmed_absent', 'checker cleanup unconfirmed');
  for (const [role, status, image] of [['export', 'exported', images.export], ['check', 'accepted', images.checker]]) {
    const outcome = receipt.outcomes?.[role];
    requireThat(outcome?.status === status && outcome.image === image && outcome.cleanup === 'confirmed_absent' &&
      outcome.exit_code === 0 && outcome.signal === null && outcome.failure === null &&
      outcome.state?.Running === false && outcome.state.ExitCode === 0 && outcome.state.OOMKilled === false,
    `${role} acceptance/cleanup failed`);
  }
  const root = path.resolve(context.out);
  return {
    schema: 'real-use-grade-cli-smoke/v1', fixture: FIXTURE, cli_exit: context.run.code,
    checker_status: receipt.status, ...binding, images, adapter_sha256: receipt.adapter_sha256,
    grade_source_sha256: context.gradeHash, build_receipt: path.resolve(context.buildReceipt),
    build_receipt_sha256: sha256(context.buildBytes),
    private_result: path.join(root, ARTIFACTS.results), blind_packet: path.join(root, ARTIFACTS.blind),
    checker_work: path.join(root, 'private-checker-work'), cleanup: receipt.cleanup, no_provider_calls: true,
  };
}

function runGrade({ args, config }) {
  // Exactly one fixed grade entrypoint; no configurable module, shell, or solver.
  const run = spawnSync(process.execPath, [config.gradeFile, ...args], {
    cwd: HERE, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  return { code: run.status, signal: run.signal, error: run.error?.message,
    stdout: run.stdout ?? '', stderr: run.stderr ?? '', providerCalls: 0 };
}

export async function main(argv, { io = fs, runner = runGrade, config = DEFAULTS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), print = console.log } = {}) {
  const opts = options(argv), out = validateOutput(opts.out, { io, tempRoot: config.tempRoot });
  const buildBytes = io.readFileSync(config.buildReceipt), build = JSON.parse(buildBytes);
  const gradeHash = sha256(io.readFileSync(config.gradeFile)), adapterHash = sha256(io.readFileSync(config.adapterFile));
  io.mkdirSync(path.dirname(out), { recursive: true });
  io.mkdirSync(out, { mode: 0o700 });
  const attempts = [];
  const finish = (exitCode, facts = {}) => {
    const result = { schema: 'real-use-checker-smoke-result/v1', exit_code: exitCode,
      attempt_count: attempts.length, ...facts, attempts };
    writeJSON(io, path.join(out, 'checker-smoke-result.json'), result);
    print(JSON.stringify(result, null, 2));
    return result;
  };
  for (let number = 1; number <= opts.attempts; number++) {
    const root = path.join(out, `attempt-${number}`);
    let run, data, retry = false, failure;
    try {
      copyFixture(root, { io, fixtureRoot: config.fixtureRoot });
      const episodeId = fixtureEpisode(root, io);
      const args = ['--checker-build-receipt', config.buildReceipt,
        '--checker-work-dir', path.join(root, 'private-checker-work'),
        '--docker-executable', config.dockerExecutable, '--corpus-root', config.corpusRoot,
        '--gold', path.join(root, 'evaluator-gold.json'), '--out', path.join(root, 'captured-synthetic')];
      run = await runner({ args, config, root, attempt: number });
      io.writeFileSync(path.join(root, 'cli.stdout.log'), run.stdout ?? '', { flag: 'wx' });
      io.writeFileSync(path.join(root, 'cli.stderr.log'), run.stderr ?? '', { flag: 'wx' });
      requireThat(sha256(io.readFileSync(config.gradeFile)) === gradeHash &&
        sha256(io.readFileSync(config.adapterFile)) === adapterHash &&
        io.readFileSync(config.buildReceipt).equals(buildBytes), 'sources/build changed during smoke');
      data = packet(root, io);
      const context = { out, build, buildBytes, buildReceipt: config.buildReceipt, gradeHash, adapterHash, episodeId, run };
      validateBindings(data, context);
      if (!run.signal && !run.error && [0, 1].includes(run.code) &&
          data.result.checker.status === 'grader_unavailable' && data.blind.checker.status === 'grader_unavailable' &&
          retryableTimeout(data.result.receipt)) {
        retry = true;
        throw new Error('checker_transport_timeout');
      }
      const summary = assembleSummary(data, context);
      // Only a completely validated attempt is promoted. Failed attempt trees
      // remain private evidence; the validator receives its historical layout.
      for (const name of ['captured-synthetic', 'private-checker-work', 'evaluator-gold.json']) {
        io.renameSync(path.join(root, name), path.join(out, name));
      }
      writeJSON(io, path.join(out, ARTIFACTS.summary), summary);
      attempts.push({ attempt: number, cli_exit: run.code, status: 'accepted', failure: null });
      return finish(0, {
        artifacts: Object.fromEntries(Object.entries(ARTIFACTS).map(([key, relative]) =>
          [key, { path: path.join(out, relative), sha256: sha256(io.readFileSync(path.join(out, relative))) }])),
        adapter_sha256: summary.adapter_sha256, policy_sha256: summary.policy_sha256,
        grade_source_sha256: summary.grade_source_sha256,
      });
    } catch (error) { failure = error.message; }
    attempts.push({ attempt: number, cli_exit: run?.code ?? null, status: 'failed', failure,
      retryable: retry, checker_status: data?.result?.receipt?.status ?? null,
      cleanup: data?.result?.receipt?.cleanup ?? null, outcomes: data?.result?.receipt?.outcomes ?? null });
    if (!retry || number === opts.attempts) return finish(1);
    await sleep(opts.retryDelayMs);
  }
}

// Shared CLI boundary lets tests check nonzero exits without spawning a process.
export async function cli(argv, dependencies) {
  try { return (await main(argv, dependencies)).exit_code; }
  catch (error) { (dependencies?.print ?? console.error)(error.message); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await cli(process.argv.slice(2));
}
