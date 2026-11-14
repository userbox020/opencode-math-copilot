// Thin sequential controller over the existing capture/bridge implementation.
// There is no provider client, command-string input, resume or retry path here.
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFreshOutput, budgetStop, parseArgs, promptFor, sha256 } from './lib.mjs';
import { captureEpisode } from './run.mjs';
import { admitEpisode, assertCapabilityConsumed, assertStudyContinuation, bridgeOptions, dispatchAdmittedEpisode, finishAdmittedEpisode, loadRegisteredArtifacts,
  persistFirstPairCheckpoint, requireBridgeAPI, settleEpisodeAdmission, snapshotEpisodeInputs, snapshotFinishFacts, snapshotSettledEpisode } from './admission.mjs';

export const HELP = 'node bench/v4/real-use/execute.mjs [--dry-run | --execute] --registration ABS_FILE --registration-sha256 APPROVED_SHA256 --out EXACT_REGISTERED_PATH [--freeze-record ABS_FILE --freeze-sha256 HEX] [--probe-checkpoint-sha256 APPROVED_SHA256]\nExecution requires --freeze-record and --freeze-sha256 binding BOTH closed registrations before the probe. Preview may omit them and remains non-authorizing. Main additionally requires the externally approved probe checkpoint digest for the SAME freeze. REAL_USE_ALLOW_EXECUTE=1 and genuine owned admission remain mandatory; no retries/resume/fallback.';
function persist(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600);
  try {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); let offset = 0;
    while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) throw new Error('controller_short_write'); offset += n; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  linkSync(temp, file); unlinkSync(temp);
}
async function bounded(operation, ms, reason) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
  finally { clearTimeout(timer); }
}
const cleanupConfirmed = result => result?.confirmed === true && ['server', 'daemon'].every(key =>
  result[key]?.confirmed === true && result[key]?.active_processes === 0);
const cleanupProjection = (result, fixture) => ({ confirmed: cleanupConfirmed(result) && (fixture ||
  (result?.cli?.confirmed === true && result.cli.active_processes === 0 && result.cli.status === 'confirmed_absent' && result.cli.process_tree_containment === true)),
  server: { confirmed: result?.server?.confirmed === true, active_processes: result?.server?.active_processes === 0 ? 0 : null },
  daemon: { confirmed: result?.daemon?.confirmed === true, active_processes: result?.daemon?.active_processes === 0 ? 0 : null },
  ...(result?.cli ? { cli: { confirmed: result.cli.confirmed === true, active_processes: result.cli.active_processes === 0 ? 0 : null,
    status: result.cli.status, process_tree_containment: result.cli.process_tree_containment === true } } : {}) });

async function drive({ manifest, out, provenance, registrationRaw, freezeRaw, beforeSetup, firstPairCheckpoint, startBridge, admit, consumed, dispatch, finish, settle, capture, cleanupMs = 60000, fixture = false }) {
  beforeSetup?.(); // Revalidate after module awaits and before output reservation.
  assertFreshOutput(out);
  mkdirSync(out); // Atomic reservation; a racing existing directory is never reused.
  const episodes = [], setups = []; let stop = null, active = null;
  try {
    mkdirSync(path.join(out, 'episodes')); mkdirSync(path.join(out, 'setup'));
    if (freezeRaw !== undefined) persist(path.join(out, 'freeze-record.json'), freezeRaw);
    persist(path.join(out, 'manifest.json'), manifest);
    persist(path.join(out, 'execution-amendments.json'), provenance);
    if (registrationRaw !== undefined) {
      persist(path.join(out, 'registration.json'), registrationRaw);
      persist(path.join(out, 'execution-bindings.json'), provenance);
    }
    persist(path.join(out, 'execution-start.json'), { schema: 'real-use-execution-start/v1', run_id: manifest.run_id,
      started_at: new Date().toISOString(), schedule_sha256: sha256(manifest.schedule), fixture_only: fixture });
    for (const [index, item] of manifest.schedule.entries()) {
      stop = budgetStop(episodes, manifest.budgets, { schedule: manifest.schedule, unknownCostPolicy: manifest.budgets.unknown_cost_policy });
      if (stop) break;
      beforeSetup?.(); // Private fence checked BEFORE any next setup artifact.
      const task = manifest.tasks.find(task => task.id === item.task_id), started = Date.now();
      const prefix = path.join(out, 'setup', String(index).padStart(2, '0'));
      const setup = { ...item, index, started_at: new Date(started).toISOString(), status: 'started' };
      persist(`${prefix}.start.json`, setup); setups.push(setup);
      let cleanupPromise, capability, episode;
      const cleanupOnce = () => cleanupPromise ??= bounded(() => active.cleanup(), cleanupMs, 'bridge_cleanup_timeout')
        .then(result => cleanupProjection(result, fixture), () => ({ confirmed: false, error: 'bridge_cleanup_unconfirmed' }));
      try {
        active = await startBridge(item, task);
        if (!active || !['audit', 'auditContext', 'admit', 'dispatch', 'finish', 'cleanup'].every(key => typeof active[key] === 'function')) throw new Error('bridge_contract_unavailable');
        // Admission exclusively owns startup/context audits. Never submit a
        // second context prompt here, even when the bridge is not memoized.
        capability = await admit(item, task, active);
        await active.admit(capability); consumed(capability);
        const descriptor = await dispatch(capability, active, item, task);
        // dispatch must only return a frozen descriptor/factory. Actual solver work
        // starts inside capture, after all setup evidence has been persisted.
        const setupMs = Date.now() - started;
        persist(`${prefix}.admitted.json`, { ...item, setup_ms: setupMs, capability: 'opaque-consumed',
          episode_bindings: descriptor.episodeBindings ?? null, fixture_only: fixture });
        const finalize = async facts => {
          try { return await finish(capability, active, facts); }
          finally { if (!(await cleanupOnce()).confirmed) throw new Error('bridge_cleanup_unconfirmed'); }
        };
        finalize.abort = cleanupOnce; // Starts server/daemon cleanup immediately on CLI abort.
        episode = await capture({ launch: descriptor.launch, launcherFactory: descriptor.launcherFactory,
          item, task, directory: path.join(out, 'episodes'), finalize, setupMs,
          ...(manifest.profile_id ? { profileId: manifest.profile_id, protocolHash: manifest.protocol_hash,
            registrationDigest: provenance.registration_sha256 } : {}) });
        episode = snapshotSettledEpisode(episode, item);
        episodes.push(episode); settle(episode);
        setup.status = 'captured';
      } catch {
        // Never serialize thrown bridge/transport messages: they may include auth.
        setup.status = 'failed'; setup.failure = 'setup_dispatch_capture_or_finalization_failed';
        setup.safety_failure = true; stop = 'safety_failure';
        persist(`${prefix}.failure.json`, { ...setup, elapsed_ms: Date.now() - started });
      } finally {
        if (active) {
          const cleanup = await cleanupOnce();
          persist(`${prefix}.cleanup.json`, { episode_id: item.episode_id, cleanup, end_to_end_ms: Date.now() - started });
          if (!cleanup.confirmed) {
            stop = 'safety_failure';
            if (episode) episodes[episodes.length - 1] = snapshotSettledEpisode({ ...episode, safety_failure: true }, item);
          }
          active = null;
        }
      }
      // Evaluate accounting/operational evidence before max_episodes can mask a
      // failed two-episode probe. The callback owns durable checkpoint authority.
      if (episodes.length === 2 && firstPairCheckpoint) {
        const checkpoint = await firstPairCheckpoint();
        if (checkpoint.passed !== true) stop = 'first_pair_checkpoint_failed';
      }
      if (stop) break;
      stop = budgetStop(episodes, manifest.budgets, { schedule: manifest.schedule, unknownCostPolicy: manifest.budgets.unknown_cost_policy });
      if (stop) break;
    }
    stop ??= 'schedule_complete';
  } catch {
    stop = 'controller_artifact_failure';
  } finally {
    // A persistence exception cannot bypass ownership cleanup. No retry or next
    // dispatch is permitted if cleanup or even the stop record is uncertain.
    if (active) {
      try { await bounded(() => active.cleanup(), cleanupMs, 'bridge_cleanup_timeout'); } catch { /* fenced below */ }
      stop = 'safety_failure'; active = null;
    }
    persist(path.join(out, 'execution-stop.json'), { schema: 'real-use-execution-stop/v1', run_id: manifest.run_id,
      stopped_at: new Date().toISOString(), reason: stop ?? 'controller_artifact_failure', fixture_only: fixture,
      captured_episodes: episodes.length, attempted_setups: setups.length,
      schedule_sha256: sha256(manifest.schedule), episodes: episodes.map(episode => ({ episode_id: episode.episode_id,
        status: episode.status, safety_failure: episode.safety_failure === true })),
      setup_failures: setups.filter(setup => setup.status === 'failed').map(setup => setup.episode_id) });
  }
  return { out, reason: stop, captured_episodes: episodes.length, attempted_setups: setups.length, fixture_only: fixture };
}

export async function executeStudy(options, environment = process.env) {
  if (options.execute !== true || environment.REAL_USE_ALLOW_EXECUTE !== '1') throw new Error('execution_not_authorized');
  if (!options.registration || options.prereg || options.amendment || options.approvedArtifacts) throw new Error('historical_execution_forbidden');
  const approved = loadRegisteredArtifacts(options), { manifest, out } = approved;
  // Check the actual module before staging or reserving outputs. No substitute
  // callback/module-path option exists in this production entry point.
  const api = await requireBridgeAPI();
  const provenance = { schema: 'real-use-registered-execution/v1', profile_id: manifest.profile_id, run_id: manifest.run_id,
    registration_sha256: approved.binding_sha256, source_version: approved.registration.source_version,
    source_lineage: approved.registration.source_lineage, control_bindings: approved.registration.control_bindings,
    exposure: approved.registration.exposure, prerequisite_probe: approved.registration.prerequisite_probe,
    freeze_record_path: approved.freeze_ref.path, freeze_sha256: approved.freeze_ref.sha256,
    registration_digests: Object.fromEntries(approved.registration_pair.map(ref => [ref.profile_id, ref.sha256])),
    probe_checkpoint_sha256: options.probeCheckpointSha256 ?? null, grader_integration: approved.grader_integration };
  return drive({ manifest, out, provenance, registrationRaw: approved.registration_raw, freezeRaw: approved.freeze_raw,
    beforeSetup: () => assertStudyContinuation(approved), firstPairCheckpoint: () => persistFirstPairCheckpoint(approved),
    startBridge: (item, task) => api.startAuditBridge(bridgeOptions(approved, item, task)),
    admit: (item, task, bridge) => admitEpisode({ manifest, item, task, bridge, approvedArtifacts: approved }),
    consumed: assertCapabilityConsumed, dispatch: dispatchAdmittedEpisode, finish: finishAdmittedEpisode,
    settle: episode => settleEpisodeAdmission(approved, episode), capture: captureEpisode });
}

// Exercise the same sequencing/finally logic without access to production brands.
// Not reachable from argv, cannot use the preregistered run ID, and never imports
// or constructs a production bridge. Test callbacks are operator code, not input.
export async function executeFixtureSchedule({ manifest, out, startBridge, capture, cleanupMs = 20, firstPairCheckpoint }) {
  if (!process.env.NODE_TEST_CONTEXT || !manifest.run_id?.startsWith('fixture-') || manifest.schedule.length !== 20 ||
      new Set(manifest.schedule.map(item => item.episode_id)).size !== 20) throw new Error('test_fixture_only');
  let next = 0; const caps = new WeakMap();
  return drive({ manifest, out, fixture: true, cleanupMs, firstPairCheckpoint, provenance: { fixture_only: true, production_authority: false }, startBridge, capture,
    admit: async (item, task, bridge) => {
      const input = snapshotEpisodeInputs(manifest, next, item, task);
      await bridge.audit(); await bridge.auditContext();
      const cap = Object.freeze({ fixture_only: true }); caps.set(cap, { bridge, ...input, used: false }); return cap;
    },
    consumed: cap => { const record = caps.get(cap); if (!record || record.used) throw new Error('fixture_capability_reused'); record.used = true; next++; },
    dispatch: (cap, bridge) => { const record = caps.get(cap); if (record?.bridge !== bridge) throw new Error('fixture_binding_mismatch'); return bridge.dispatch({ item: record.item, task: record.task }); },
    finish: async (cap, bridge, facts) => {
      const record = caps.get(cap); if (record?.bridge !== bridge) throw new Error('fixture_binding_mismatch');
      const snapshot = snapshotFinishFacts(facts, sha256(promptFor(record.task)));
      return bridge.finish(snapshot);
    },
    settle: () => {} });
}

export async function main(argv, environment = process.env) {
  if (argv.length === 1 && argv[0] === '--help') return { help: HELP };
  const args = parseArgs(argv, ['--registration', '--registration-sha256', '--freeze-record', '--freeze-sha256', '--probe-checkpoint-sha256', '--out', '--execute', '--dry-run']);
  if (args['--execute'] && args['--dry-run']) throw new Error('choose_execute_or_dry_run');
  if (args['--execute'] && environment.REAL_USE_ALLOW_EXECUTE !== '1') throw new Error('execution_not_authorized');
  for (const flag of ['--registration', '--registration-sha256', '--out']) if (!args[flag]) throw new Error('explicit_binding_paths_required');
  if (!path.isAbsolute(args['--registration']) || !path.isAbsolute(args['--out'])) throw new Error('absolute_binding_paths_required');
  const options = { registration: args['--registration'], registrationSha256: args['--registration-sha256'],
    freezeRecord: args['--freeze-record'], freezeSha256: args['--freeze-sha256'],
    probeCheckpointSha256: args['--probe-checkpoint-sha256'], out: args['--out'], execute: args['--execute'] === true };
  if (options.execute) return executeStudy(options, environment);
  const approved = loadRegisteredArtifacts(options);
  const requirement = approved.registration.prerequisite_probe;
  return { mode: 'dry-run', admission: 'not_assessed', manifest: approved.manifest, out: approved.out, provider_calls: 0,
    registration_freeze: approved.freeze_ref ? { status: 'validated_data_only', ...approved.freeze_ref, registrations: approved.registration_pair }
      : { status: 'pending_not_assessed' },
    prerequisite_probe: requirement ? { status: 'pending_not_assessed', profile_id: requirement.profile_id,
      run_id: requirement.run_id, study_out: requirement.study_out, checkpoint_path: requirement.checkpoint_path } : { status: 'not_required' } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch { console.error('execution_blocked_or_failed; inspect owned setup/stop evidence if output was reserved'); process.exitCode = 1; }
}
