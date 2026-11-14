import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFreshOutput, canonical, loadEpisodes, parseArgs, readJSON, sha256, shuffled, validateGold } from './lib.mjs';

function neutralInput(task, answer, gold) {
  // Allowlist projection: never spread an episode into a decision/checker input.
  return structuredClone({
    task: { id: task.id, category: task.category, family: task.family, prompt: task.prompt },
    answer, rubric: gold.rubric, reference_sources: gold.reference_sources,
    ...(Object.hasOwn(gold, 'expected_result') ? { expected_result: gold.expected_result } : {}),
    ...(gold.lean ? { lean: gold.lean } : {}),
  });
}

export function checkerRequest(answer, lean) {
  const matches = [...answer.matchAll(/```([^\r\n`]*)\r?\n([\s\S]*?)```/g)]
    .filter(match => /^lean4?$/i.test(match[1].trim()));
  const target = lean.theorem ? new RegExp(`\\btheorem\\s+${lean.theorem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : null;
  const targeted = target ? matches.filter(match => target.test(match[2])) : [];
  const selected = targeted.length ? targeted : matches;
  if (selected.length !== 1) return null;
  const code = selected[0][2].replace(/\r\n?/g, '\n');
  const policy = {
    schema: 'real-use-checker-policy/v1', theorem: lean.theorem, expected_type: lean.expected_type,
    imports: [...lean.imports], allowed_axioms: [...lean.allowed_axioms],
    positive_control_sha256: sha256(lean.positive_control),
    isolation: 'independent A compile/export then B fixed-target comparison, closed-axiom audit and kernel replay; network disabled; no corpus mount; evaluator-fixed target',
  };
  return { schema: 'real-use-checker-request/v1', code, code_sha256: sha256(code), policy, policy_sha256: sha256(policy) };
}

export async function checkAnswer(answer, lean, { checker, verifyReceipt } = {}) {
  const request = checkerRequest(answer, lean);
  if (!checker || !verifyReceipt) return { status: 'grader_unavailable', reason: 'trusted_checker_adapter_unavailable' };
  if (!request) return { status: 'not_checked', reason: 'exactly_one_lean_block_required' };
  // Only an out-of-band trusted checker may return receipts; printed model receipts
  // are never inspected. The adapter owns isolation and positive/negative controls.
  let receipt;
  try { receipt = await checker(structuredClone(request)); }
  catch { return { status: 'grader_unavailable', reason: 'checker_transport_error' }; }
  if (!receipt || receipt.schema !== 'real-use-checker-receipt/v1' ||
      receipt.code_sha256 !== request.code_sha256 || receipt.policy_sha256 !== request.policy_sha256 ||
      !['accepted', 'rejected', 'unavailable'].includes(receipt.status)) throw new Error('receipt_binding_invalid');
  if (await verifyReceipt(structuredClone(receipt), structuredClone(request)) !== true) throw new Error('receipt_untrusted');
  return {
    status: receipt.status === 'unavailable' ? 'grader_unavailable' : receipt.status,
    code_sha256: request.code_sha256, policy_sha256: request.policy_sha256,
  };
}

export async function evaluateAnswer(task, answer, gold, adapters = {}) {
  if (typeof answer !== 'string') throw new Error('answer must be complete text');
  const input = neutralInput(task, answer, gold);
  const checker = gold.lean ? await checkAnswer(input.answer, input.lean, adapters) : { status: 'not_applicable' };
  let exact = false;
  if (Object.hasOwn(input, 'expected_result')) {
    if (typeof input.expected_result === 'string') exact = answer.trim() === input.expected_result.trim();
    else {
      try { exact = canonical(JSON.parse(answer)) === canonical(input.expected_result); } catch {}
    }
  }
  // A matching symbolic value or accepted Lean target is only candidate evidence;
  // correctness still requires the evaluator-only rubric and an identified review.
  const result = { status: exact || checker.status === 'accepted' ? 'candidate' : 'pending_rubric', checker };
  if (adapters.decide) result.adjudication = await adapters.decide(structuredClone({ ...input, checker }));
  return result;
}

export async function exportBlind(tasks, gold, episodes, adapters = {}, seed = randomUUID()) {
  validateGold(gold, tasks);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const goldById = new Map(gold.map(entry => [entry.task_id, entry]));
  const seen = new Set();
  const records = [], entries = [], checkerRequests = [], checkerResults = [];
  for (const episode of shuffled(episodes, seed)) {
    if (!taskById.has(episode.task_id) || !episode.episode_id || seen.has(episode.episode_id)) throw new Error('unknown/duplicate episode');
    seen.add(episode.episode_id);
    if (episode.status !== 'completed') continue;
    const task = taskById.get(episode.task_id), entry = goldById.get(episode.task_id);
    const answer = episode.text;
    let verifiedReceipt;
    const scopedAdapters = adapters.verifyReceipt ? { ...adapters, verifyReceipt: async (receipt, request) => {
      const snapshot = structuredClone(receipt);
      const verified = await adapters.verifyReceipt(receipt, request);
      if (verified === true) verifiedReceipt = snapshot;
      return verified;
    } } : adapters;
    const result = await evaluateAnswer(task, answer, entry, scopedAdapters);
    const request = entry.lean ? checkerRequest(answer, entry.lean) : null;
    if (entry.lean) {
      if (request) checkerRequests.push({ episode_id: episode.episode_id, request });
    }
    const blind_id = randomUUID();
    records.push({
      schema: 'real-use-blind/v1', blind_id,
      task: { id: task.id, category: task.category, family: task.family, prompt: task.prompt },
      answer, rubric: structuredClone(entry.rubric), reference_sources: structuredClone(entry.reference_sources),
      checker: result.checker, candidate_status: result.status,
      checker_required: Boolean(entry.lean),
      checker_binding: request ? { code_sha256: request.code_sha256, policy_sha256: request.policy_sha256 } : null,
      imperfect_blinding: /plugin[-_ ](?:on|off)|MATH_TOOLKIT|with(?:out)? (?:the )?(?:math )?plugin/i.test(answer),
    });
    entries.push({ blind_id, episode_id: episode.episode_id });
    if (verifiedReceipt) {
      // Evaluator-private provenance, associated after checking. No episode
      // metadata goes to the checker, and no reusable authenticator is exported.
      const keys = ['schema', 'request_id', 'task_id', 'status', 'evidence', 'code_sha256', 'policy_sha256',
        'challenge_source_sha256', 'challenge_export_sha256', 'candidate_export_sha256', 'adapter_sha256',
        'protocol_sha256', 'primitive_list_sha256', 'limits_sha256', 'pins', 'images', 'outcomes', 'cleanup'];
      const receipt = Object.fromEntries(keys.filter(key => Object.hasOwn(verifiedReceipt, key)).map(key => [key, verifiedReceipt[key]]));
      checkerResults.push({ blind_id, episode_id: episode.episode_id, checker: result.checker, receipt });
    }
  }
  return { records, private_map: { schema: 'real-use-unblind/v1', entries }, checker_requests: checkerRequests, checker_results: checkerResults };
}

// Records are evaluator-owned exports, never solver receipts or reviewer fields.
export function reviewCorrectness(review, record, task = record?.task) {
  const formal = record?.checker_required === true || ['formal', 'lean'].includes(task?.category);
  if (!formal) return review.correctness;
  const checker = record?.checker, binding = record?.checker_binding;
  const bound = binding && ['code_sha256', 'policy_sha256'].every(key =>
    /^[a-f0-9]{64}$/.test(binding[key]) && checker?.[key] === binding[key]);
  if (!bound || !['accepted', 'rejected'].includes(checker?.status)) return 'unscorable';
  if (review.correctness === 'pass' && checker.status !== 'accepted') return 'unscorable';
  return review.correctness;
}

export function validateReviews(reviews, records) {
  if (!Array.isArray(reviews)) throw new Error('reviews must be an array');
  const ids = new Set(records.map(record => record.blind_id));
  const byId = new Map(records.map(record => [record.blind_id, record]));
  if (ids.size !== records.length) throw new Error('duplicate blind_id');
  const seen = new Set();
  for (const review of reviews) {
    if (!review || !ids.has(review.blind_id) || seen.has(review.blind_id)) throw new Error('unknown/duplicate review');
    seen.add(review.blind_id);
    const keys = ['schema', 'blind_id', 'correctness', 'evidence', 'reviewer_kind', 'reviewer_identity', 'notes'];
    if (Object.keys(review).some(key => !keys.includes(key)) || review.schema !== 'real-use-review/v1' ||
        !['pass', 'fail', 'unscorable'].includes(review.correctness) ||
        !['adequate', 'inadequate', 'not_applicable'].includes(review.evidence) ||
        !['human', 'model'].includes(review.reviewer_kind) ||
        typeof review.reviewer_identity !== 'string' || !review.reviewer_identity.trim() ||
        typeof review.notes !== 'string' || !review.notes.trim()) throw new Error('invalid typed review');
    if (review.correctness === 'pass' && reviewCorrectness(review, byId.get(review.blind_id)) !== 'pass') {
      throw new Error('formal pass requires accepted trusted code/policy-bound checker result');
    }
  }
  return reviews;
}

export function unblindReviews(reviews, records, privateMap) {
  validateReviews(reviews, records);
  if (privateMap?.schema !== 'real-use-unblind/v1' || !Array.isArray(privateMap.entries) || privateMap.entries.length !== records.length) {
    throw new Error('invalid unblind map');
  }
  const byBlind = new Map(), episodeIds = new Set();
  const expected = new Set(records.map(record => record.blind_id));
  for (const item of privateMap.entries) {
    if (!expected.has(item.blind_id) || byBlind.has(item.blind_id) || typeof item.episode_id !== 'string' || episodeIds.has(item.episode_id)) {
      throw new Error('unblind map must be bijective');
    }
    byBlind.set(item.blind_id, item.episode_id); episodeIds.add(item.episode_id);
  }
  const recordsById = new Map(records.map(record => [record.blind_id, record]));
  return reviews.map(review => ({ ...review, correctness: reviewCorrectness(review, recordsById.get(review.blind_id)),
    episode_id: byBlind.get(review.blind_id) }));
}

function referenceFile(root, relative) {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') ||
      relative.includes(':') || relative.split('/').includes('..')) throw new Error('unsafe corpus-relative reference path');
  const file = realpathSync(path.resolve(root, relative));
  const resolved = path.relative(root, file);
  if (!resolved || resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
    throw new Error('reference escapes corpus root');
  }
  return file;
}

function absoluteLocal(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..') ||
      (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value))) throw new Error(`${label}: absolute local path required`);
  return path.resolve(value);
}

function regularFile(file, label) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}: regular unlinked file required`);
  return realpathSync(file);
}

function resolvedLocation(location) {
  let parent = path.resolve(location);
  const suffix = [];
  for (;;) {
    try { lstatSync(parent); return path.join(realpathSync(parent), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
      suffix.push(path.basename(parent)); parent = path.dirname(parent);
    }
  }
}
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// The factory seam is evaluator/test-owned, never a CLI module/command override.
export async function main(argv, { adapterFactory } = {}) {
  const checkerFlags = ['--checker-build-receipt', '--checker-work-dir', '--docker-executable'];
  const args = parseArgs(argv, ['--out', '--gold', '--corpus-root', ...checkerFlags]);
  const checkerCount = checkerFlags.filter(key => Object.hasOwn(args, key)).length;
  if (checkerCount && checkerCount !== checkerFlags.length) throw new Error('checker flags are all-or-none: --checker-build-receipt --checker-work-dir --docker-executable');
  if (!args['--out'] || !args['--gold']) throw new Error('--out and evaluator-only --gold required');
  const outPath = path.resolve(args['--out']);
  const outStat = lstatSync(outPath);
  if (!outStat.isDirectory() || outStat.isSymbolicLink()) throw new Error('unsafe captured-run directory');
  const out = realpathSync(outPath), evaluationDir = path.join(out, 'evaluation');
  assertFreshOutput(evaluationDir); // Refuse existing packets before any checker execution.
  const manifest = readJSON(regularFile(path.join(out, 'manifest.json'), 'manifest'));
  if (manifest.public_tasks_hash !== sha256(manifest.tasks)) throw new Error('public task hash mismatch');
  const goldFile = path.resolve(args['--gold']);
  const gold = validateGold(readJSON(goldFile), manifest.tasks);
  const hasReferences = gold.some(entry => entry.reference_sources.length);
  if (hasReferences && !args['--corpus-root']) throw new Error('--corpus-root required for corpus-relative references');
  const corpusRoot = hasReferences ? realpathSync(path.resolve(args['--corpus-root'])) : null;
  for (const entry of gold) for (const reference of entry.reference_sources) {
    const bytes = readFileSync(referenceFile(corpusRoot, reference.path));
    if (sha256(bytes) !== reference.sha256) throw new Error(`reference hash mismatch: ${entry.task_id}`);
  }
  const episodes = loadEpisodes(out, manifest).map(episode => ({
    ...episode,
    text: episode.status === 'completed' ? readFileSync(regularFile(path.join(out, 'episodes', `${episode.episode_id}.answer.txt`), 'answer'), 'utf8') : '',
  }));
  let adapters = {}, checkerWork;
  if (checkerCount) {
    const receipt = regularFile(absoluteLocal(args['--checker-build-receipt'], 'checker receipt'), 'checker receipt');
    const executable = regularFile(absoluteLocal(args['--docker-executable'], 'Docker executable'), 'Docker executable');
    const requestedWork = absoluteLocal(args['--checker-work-dir'], 'checker work directory');
    assertFreshOutput(requestedWork);
    const parent = realpathSync(path.dirname(requestedWork));
    if (!lstatSync(parent).isDirectory()) throw new Error('checker work parent must be an existing directory');
    checkerWork = path.join(parent, path.basename(requestedWork));
    assertFreshOutput(checkerWork);
    const workspace = resolvedLocation(absoluteLocal(manifest.workspace, 'manifest solver workspace'));
    if ([checkerWork, receipt, executable, out].some(file => inside(workspace, file)) || inside(checkerWork, workspace)) throw new Error('evaluator checker paths must be outside solver workspace');
    // Validate every frozen policy/request before starting the first container.
    const { resolveRequest } = await import('./checker/policies.mjs');
    for (const entry of gold) if (entry.lean) resolveRequest(checkerRequest('```lean\n' + entry.lean.positive_control + '\n```', entry.lean));
    for (const episode of episodes) if (episode.status === 'completed') {
      const lean = gold.find(entry => entry.task_id === episode.task_id)?.lean;
      const request = lean && checkerRequest(episode.text, lean);
      if (request) resolveRequest(request);
    }
    const factory = adapterFactory ?? (await import('./checker-adapter.mjs')).createCheckerAdapter;
    // Constructor validates immutable image/build/source digests without Docker.
    const trusted = factory({ buildReceipt: receipt, dockerExecutable: executable, workDirectory: path.join(checkerWork, 'eval-checker-g004-transport') });
    if (typeof trusted?.checker !== 'function' || typeof trusted?.verifyReceipt !== 'function') throw new Error('invalid evaluator checker adapter');
    adapters = { checker: trusted.checker, verifyReceipt: trusted.verifyReceipt };
  }
  mkdirSync(evaluationDir, { mode: 0o700 }); // Atomic, non-overwriting reservation.
  mkdirSync(path.join(evaluationDir, 'private'), { mode: 0o700 });
  if (checkerWork) {
    mkdirSync(checkerWork, { mode: 0o700 });
    mkdirSync(path.join(checkerWork, 'eval-checker-g004-transport'), { mode: 0o700 });
  }
  const result = await exportBlind(manifest.tasks, gold, episodes, adapters);
  writeFileSync(path.join(evaluationDir, 'blind.json'), JSON.stringify(result.records, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(evaluationDir, 'private', 'unblind.json'), JSON.stringify(result.private_map, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(evaluationDir, 'private', 'checker-requests.json'), JSON.stringify(result.checker_requests, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(evaluationDir, 'private', 'checker-results.json'), JSON.stringify(result.checker_results, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Prepared ${result.records.length} blind responses; ${checkerCount ? 'evaluator checker enabled' : 'Lean checker adapter unavailable'}. Share only blind.json with reviewers, never private/ or checker work artifacts.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
