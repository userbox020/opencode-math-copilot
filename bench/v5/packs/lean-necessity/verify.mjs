import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isMain, readTasks, sha256 } from '../../external/schema.mjs';
import {
  ALLOWED_AXIOMS, DIR, FIXTURES, assertCanonicalTasks, serialize,
} from './build.mjs';

export const IMAGE = 'opencode-math-lean';
export const VOLUME = 'opencode-math-lean';
const TIMEOUT_MS = 120000;
const invoke = (args, timeout = 30000) => {
  const result = spawnSync('docker', args, {
    shell: false, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status, signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '',
  };
};
function requireSuccess(result, args) {
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(`Docker prerequisite/execution failed:\ndocker ${args.join(' ')}\n${serialize(result)}`);
  }
  return result.stdout.trim();
}

function containerRun(image, command, directory, timeout = TIMEOUT_MS) {
  const name = `lean-necessity-${randomUUID()}`;
  const args = [
    'run', '--rm', '--name', name, '--pull=never', '--network', 'none',
    '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--mount', `type=volume,src=${VOLUME},dst=/work,readonly`,
    ...(directory ? ['--mount', `type=bind,src=${directory},dst=/check,readonly`] : []),
    '-w', '/work/math/lean', image, ...command,
  ];
  const result = invoke(args, timeout);
  if (result.error || result.signal || result.status === null) {
    // Kill only this invocation's container if the client timed out or was interrupted.
    invoke(['rm', '--force', name]);
  }
  return { result, args };
}

function prerequisites() {
  const inspect = ['image', 'inspect', '--format', '{{.Id}}', IMAGE];
  const imageId = requireSuccess(invoke(inspect), inspect);
  const volumeArgs = ['volume', 'inspect', '--format', '{{.Name}}', VOLUME];
  requireSuccess(invoke(volumeArgs), volumeArgs);
  // Version/hash collection is not a Lean proof check. Never pull/build/download.
  const command = ['sh', '-c', [
    'set -eu',
    'printf "LEAN_VERSION="; lean --version',
    'printf "CORPUS_COMMIT="; git -C /work/math rev-parse HEAD',
    'printf "MATHLIB_COMMIT="; git -C /work/math/lean/.lake/packages/mathlib rev-parse HEAD',
    'printf "MANIFEST_SHA256="; sha256sum /work/math/lean/lake-manifest.json',
  ].join('\n')];
  const { result, args } = containerRun(imageId, command, null, 30000);
  const output = requireSuccess(result, args);
  const field = name => {
    const match = output.match(new RegExp(`^${name}=(.+)$`, 'm'));
    if (!match) throw new Error(`Missing Docker provenance: ${name}`);
    return match[1];
  };
  return {
    image: IMAGE, image_id: imageId, volume: VOLUME,
    lean_version: field('LEAN_VERSION'),
    corpus_commit: field('CORPUS_COMMIT'),
    mathlib_commit: field('MATHLIB_COMMIT'),
    lake_manifest_sha256: field('MANIFEST_SHA256').split(/\s+/)[0],
    network: 'none', volume_readonly: true, check_mount_readonly: true,
    timeout_ms: TIMEOUT_MS,
  };
}

export function checkSource(f) {
  if (!f.code.startsWith('import Mathlib\n')) throw new Error('Unsupported imports');
  const prefix = [
    'import Mathlib',
    'set_option autoImplicit false',
    `def GoldExpected : Prop := ${f.expectedType}`,
  ];
  const body = f.code.slice('import Mathlib\n'.length).trimEnd().split('\n');
  const lines = [...prefix, ...body, `#print axioms ${f.theorem}`];
  const witnessLine = lines.length + 1;
  lines.push(
    `theorem GoldWitness : GoldExpected := ${f.theorem}`,
    '#print axioms GoldWitness',
  );
  return {
    source: `${lines.join('\n')}\n`,
    bodyStart: prefix.length + 1,
    bodyEnd: prefix.length + body.length,
    witnessLine,
  };
}

function axiomsFor(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...output.matchAll(new RegExp(
    `['‘]${escaped}['’] (?:depends on axioms:\\s*\\[([^\\]]*)\\]|does not depend on any axioms)`, 'g',
  ))];
  if (matches.length !== 1) throw new Error(`Missing/ambiguous #print axioms output for ${name}`);
  const axioms = (matches[0][1] ?? '').split(',').map(s => s.trim()).filter(Boolean).sort();
  if (axioms.some(a => !/^[A-Za-z_][\w.]*$/.test(a))) throw new Error('Unrecognized axiom output');
  return axioms;
}

export function assess(f, result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`Docker/Lean execution failure (not a proof verdict): ${serialize(result)}`);
  }
  const layout = checkSource(f);
  const output = `${result.stdout}\n${result.stderr}`;
  const errors = [...output.matchAll(/^\/check\/Check\.lean:(\d+):(\d+): error: ([^\n]*)/gm)]
    .map(m => ({ line: Number(m[1]), column: Number(m[2]), message: m[3] }));
  if ((result.status === 0 && errors.length) || (result.status === 1 && !errors.length)) {
    throw new Error(`Unrecognized Lean failure/output: ${output}`);
  }
  if (errors.some(e => !(
    (e.line >= layout.bodyStart && e.line <= layout.bodyEnd) ||
    e.line === layout.witnessLine
  ))) throw new Error(`Import, harness, or environment failure: ${output}`);

  const sourceErrors = errors.filter(e => e.line <= layout.bodyEnd);
  const witnessErrors = errors.filter(e => e.line === layout.witnessLine);
  const targetAxioms = axiomsFor(output, f.theorem);
  const witnessAxioms = axiomsFor(output, 'GoldWitness');
  const forbidden = [...new Set([...targetAxioms, ...witnessAxioms])]
    .filter(a => !ALLOWED_AXIOMS.includes(a)).sort();
  let verdict = 'INVALID';
  let reasonCode;
  if (sourceErrors.length) {
    if (f.reasonCode !== 'compilation-failure' || !/omega/i.test(output)) {
      throw new Error(`Unexpected submitted-code failure: ${output}`);
    }
    reasonCode = 'compilation-failure';
  } else if (witnessErrors.length) {
    if (witnessErrors.some(e => !/type mismatch/i.test(e.message))) {
      throw new Error(`Unexpected target-check failure: ${output}`);
    }
    reasonCode = f.reasonCode === 'shadowed-definition' ? 'shadowed-definition' : 'target-mismatch';
  } else if (forbidden.includes('sorryAx')) {
    reasonCode = 'sorry-axiom';
  } else if (forbidden.length) {
    reasonCode = 'extra-axiom';
  } else {
    if (/\bsorry\b|\bsorryAx\b/.test(f.code)) throw new Error('Placeholder in accepted source');
    verdict = 'VALID';
    reasonCode = 'accepted';
  }
  if (verdict !== f.verdict || reasonCode !== f.reasonCode) {
    throw new Error(`${f.id}: unexpected verdict/reason ${verdict}/${reasonCode}`);
  }
  if (reasonCode === 'extra-axiom' &&
      serialize(forbidden) !== serialize(['Submission.addition_identity'])) {
    throw new Error('Unexpected extra axiom');
  }
  if (reasonCode === 'sorry-axiom' && serialize(forbidden) !== serialize(['sorryAx'])) {
    throw new Error('Unexpected placeholder axiom dependencies');
  }
  return {
    verdict, reason_code: reasonCode, reason: f.reason,
    submitted_code_compiles: sourceErrors.length === 0,
    stated_target_matches: sourceErrors.length === 0 && witnessErrors.length === 0,
    target_axioms: targetAxioms, witness_axioms: witnessAxioms, errors,
  };
}

export function validateEvidence(tasks, gold) {
  assertCanonicalTasks(tasks);
  if (gold.schema !== 'lean-necessity-gold/v1' || gold.status !== 'verified' ||
      gold.tasks_sha256 !== sha256(serialize(tasks)) ||
      gold.check_count !== FIXTURES.length || gold.checks?.length !== FIXTURES.length) {
    throw new Error('Missing, stale, or incomplete Docker gold evidence');
  }
  for (const [i, f] of FIXTURES.entries()) {
    const row = gold.checks[i];
    if (row.id !== f.id || row.code !== f.code || row.expected_type !== f.expectedType ||
        row.code_sha256 !== sha256(f.code) ||
        row.check_source_sha256 !== sha256(checkSource(f).source) ||
        serialize(row.assessment) !== serialize(assess(f, row.execution))) {
      throw new Error(`Tampered or stale evidence: ${f.id}`);
    }
  }
  return true;
}

export function verify() {
  const { tasks, hash } = readTasks(path.join(DIR, 'tasks.json'));
  assertCanonicalTasks(tasks);
  const environment = prerequisites();
  const checks = [];
  // Owned temp directory stays inside the only authorized write boundary.
  const temporary = fs.mkdtempSync(path.join(DIR, '.check-'));
  try {
    for (const f of FIXTURES) {
      const { source } = checkSource(f);
      fs.writeFileSync(path.join(temporary, 'Check.lean'), source);
      const { result, args } = containerRun(
        environment.image_id, ['lake', 'env', 'lean', '/check/Check.lean'], temporary,
      );
      let assessment;
      try {
        assessment = assess(f, result);
      } catch (error) {
        throw new Error(`${f.id}\ndocker ${args.join(' ')}\n${serialize(result)}\n${error.message}`);
      }
      checks.push({
        id: f.id, imports: f.imports, theorem: f.theorem, expected_type: f.expectedType,
        code: f.code, code_sha256: sha256(f.code), check_source_sha256: sha256(source),
        execution: result, assessment,
      });
      console.log(`${f.id}: ${assessment.verdict} (${assessment.reason_code})`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const gold = {
    schema: 'lean-necessity-gold/v1', status: 'verified',
    method: 'Direct Docker lake env lean with pre-elaborated target witness and #print axioms; no plugin verifier.',
    environment, allowed_axioms: ALLOWED_AXIOMS,
    tasks_sha256: hash, check_count: checks.length, checks,
  };
  validateEvidence(tasks, gold);
  // Publish only after every actual check agrees. No partial verified artifact.
  fs.writeFileSync(path.join(DIR, 'gold.json'), serialize(gold));
  return gold;
}

if (isMain(import.meta.url)) {
  try {
    const gold = verify();
    console.log(JSON.stringify({
      status: gold.status, checks: gold.check_count, environment: gold.environment,
      tasks_sha256: gold.tasks_sha256,
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
