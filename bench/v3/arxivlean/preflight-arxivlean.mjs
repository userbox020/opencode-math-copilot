#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompilerSandbox, IMAGE_ID, POLICY, POLICY_HASH, sha256 } from './lib/eval-sandbox.mjs';
import { CONDITIONS, TOOLSET, registerEvalTools, assertCondition } from './eval-tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SOURCES = ['bench/v3/arxivlean/lib/eval-sandbox.mjs', 'bench/v3/arxivlean/eval-tools.js', 'bench/v3/arxivlean/preflight-arxivlean.mjs', 'bench/v3/arxivlean/run-arxivlean.mjs', 'bench/v3/arxivlean/grade-arxivlean.mjs', 'docker/eval-lean.Dockerfile'];
export const MISSING_CONTROLS = Object.freeze([
  'final_session_tool_registration_manifests_and_parity',
  'model_host_tools_and_execute_denied_in_integrated_runner',
  'gold_separation_in_integrated_pipeline',
  'independently_reviewed_immutable_runtime_provenance',
  'independent_trusted_checker_separation',
  'independent_checker_positive_control',
  'independent_checker_negative_wrong_target_control',
  'independent_checker_negative_axiom_control',
  'independent_checker_forged_output_and_process_failure_controls',
  'integrated_backend_admission',
]);

// Readiness is evidence about this pipeline, not a solver's ability to solve a research task.
// There is deliberately no argument accepting caller-provided "passed" controls.
export async function preflight(options = {}, testDependencies) {
  if (Object.keys(options).some(k => !['image', 'tasks', 'runControls', 'signal'].includes(k))) throw new Error('unknown_preflight_option');
  const { image = null, tasks = path.join(HERE, 'tasks/arxivlean-smoke5.json'), runControls = false, signal } = options;
  const testOnly = testDependencies !== undefined;
  const sourceHashes = Object.fromEntries(SOURCES.map(file => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]));
  let taskHash = null;
  const missing = [...MISSING_CONTROLS];
  try { const bytes = fs.readFileSync(tasks); JSON.parse(bytes); taskHash = sha256(bytes); }
  catch { missing.push('readable_task_manifest'); }
  const config = { conditions: CONDITIONS, toolset: TOOLSET, image, policy_sha256: POLICY_HASH, task_sha256: taskHash };
  const controls = {};
  const registrations = [];
  if (IMAGE_ID.test(image ?? '')) {
    // Exercise real adapter registration; this is NOT the inventory of an isolated model session.
    for (const condition of CONDITIONS) {
      const tools = [];
      const receipt = await registerEvalTools({ tool: { transform: async fn => fn({ add: tool => tools.push({ name: tool.name, input: tool.input, options: tool.options }) }) } }, { condition, image });
      registrations.push({ ...receipt, actual_adapter_tools: tools, sha256: sha256(JSON.stringify(tools)) });
    }
    controls.adapter_registration_parity = { status: registrations[0].sha256 === registrations[1].sha256 ? 'passed' : 'failed', scope: 'adapter only; final session not assessed' };
  } else missing.push('operator_selected_immutable_image_id');

  let runtime = { image_id: image, status: 'not_inspected', provenance: 'not_authenticated' };
  if (runControls && IMAGE_ID.test(image ?? '')) {
    const backend = testOnly ? testDependencies.backend : createCompilerSandbox({ image });
    try { runtime = { ...runtime, ...await backend.inspectImage(), status: 'inspected', evidence: testOnly ? 'test-only' : 'local-docker' }; }
    catch (error) { runtime = { ...runtime, status: 'blocked', reason: error.message }; }
    if (runtime.status === 'inspected') {
      const probes = [
        ['compile_positive', 'import Init\ntheorem evalControl : True := True.intro\n', 'compiled'],
        ['compile_negative', 'import Init\ntheorem evalControl : False := True.intro\n', 'error'],
        ['read_only_root', 'import Init\n#eval IO.FS.writeFile "/opt/eval-boundary-probe" "probe"\n', 'error'],
      ];
      for (const [name, code, expected] of probes) {
        const result = await backend.compile({ code }, { signal });
        const passed = result.status === expected && result.cleanup === 'confirmed_absent' && (expected !== 'error' || result.reason === 'compiler_nonzero');
        controls[name] = { status: passed ? 'passed' : 'failed', evidence: testOnly ? 'test-only' : 'local-docker', proof: 'not_assessed', result };
      }
    }
  }
  for (const name of ['compile_positive', 'compile_negative', 'read_only_root']) {
    controls[name] ??= { status: 'not_run', proof: 'not_assessed' };
    if (controls[name].status !== 'passed') missing.push(name);
  }
  if (runtime.status !== 'inspected') missing.push('local_runtime_inspection');
  for (const name of MISSING_CONTROLS) controls[name] = { status: 'BLOCKED', reason: 'No independently validated integrated implementation/evidence is installed' };
  controls.math_compute = { status: 'BLOCKED', reason: 'No pinned contained SymPy backend installed; not registered in either condition' };
  if (testOnly) missing.push('test_only_evidence_not_admissible');
  return {
    schema: 'arxivlean-readiness/v1', generated_at: new Date().toISOString(), status: 'BLOCKED', production_ready: false,
    evidence: testOnly ? 'test-only' : 'local-preflight',
    hashes: { sources: sourceHashes, source_sha256: sha256(JSON.stringify(sourceHashes)), config_sha256: sha256(JSON.stringify(config)), task_sha256: taskHash, image_id: image, policy_sha256: POLICY_HASH },
    config, policy: POLICY, runtime, registrations, controls, missing_controls: missing,
    limitation: 'Compilation and local container probes do not certify proofs or adversarial safety. Labels and caller JSON are not runtime provenance.',
  };
}

export function assertReadiness(receipt, expected, { condition, now = Date.now(), maxAgeMs = 300000 } = {}) {
  assertCondition(condition);
  if (receipt?.schema !== 'arxivlean-readiness/v1') throw new Error('invalid_readiness_schema');
  const timestamp = Date.parse(receipt.generated_at);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxAgeMs) throw new Error('stale_readiness');
  for (const key of ['source_sha256', 'config_sha256', 'task_sha256', 'image_id', 'policy_sha256']) {
    if (!expected?.[key] || receipt.hashes?.[key] !== expected[key]) throw new Error(`readiness_mismatch:${key}`);
  }
  // Intentionally unconditional: no JSON, signature-looking field, mock, or stdout can
  // bypass the missing implementation. Replace only with reviewed pipeline integration.
  throw new Error('admission_blocked: independent checker and integrated runtime unavailable');
}

async function main(argv) {
  const options = {};
  let output;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run-controls') options.runControls = true;
    else if (['--image', '--tasks', '--out'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      if (arg === '--out') output = path.resolve(value); else options[arg.slice(2)] = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (output && fs.existsSync(output)) throw new Error('fresh_readiness_output_required');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const receipt = await preflight({ ...options, signal: controller.signal });
    const text = JSON.stringify(receipt, null, 2) + '\n';
    if (output) fs.writeFileSync(output, text, { flag: 'wx' });
    process.stdout.write(text);
    process.exitCode = 2; // BLOCKED, never pass-skips.
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
