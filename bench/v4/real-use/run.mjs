import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, ftruncateSync, linkSync, openSync, readFileSync, unlinkSync, writeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { consumeFinalizationReceipt, nativePromptTransportMatch } from './admission.mjs';
import { isNativeCompletionProfile, hash, freeze, nativeMessageID } from './runtime-plugin.js';
import {
  assertFreshOutput, executionGate, makeManifest, parseArgs, parseEventLine,
  promptFor, PROTOCOL, PROTOCOL_HASH, readJSON, redactText, sanitize, sha256, textPart, usageFromSteps, validatePublic,
} from './lib.mjs';

export const CAPTURE_LIMITS = Object.freeze({ maxLineBytes: 8 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024, cleanupMs: 25000, finalizeMs: 60000 });

// Diagnostic-only exact codes; never used for admission, accounting or success.
// bridge.mjs's diagnostic allowlist is private. Consolidate when a shared list is exported.
const FINALIZATION_REASON_CODES = Object.freeze(new Set([
  'unknown_failure', 'finalization_timeout', 'untrusted_finalization_receipt', 'finalization_ineligible',
  'rpc_http_failure', 'rpc_failed', 'guard_rejected', 'pending_timeout', 'solver_deadline', 'timeout',
  'native_closure_incomplete', 'capture_setup_failed', 'capture_callback_failed', 'line_limit', 'output_limit',
  'model_mismatch', 'host_cleanup', 'cli_closed_rejected', 'revoke_failed', 'signal_aborted',
  'live_solver_deadline_or_closure', 'live_release_after_stop', 'live_monitor_timeout', 'live_rpc_envelope_rejected',
  'live_guard_status_rejected', 'live_inventory_changed', 'live_session_scope_changed', 'live_inbox_rejected', 'live_user_store_changed',
  'native_history_rejected', 'live_pending_rejected', 'live_projection_mismatch', 'live_release_rejected', 'live_launcher_failed',
  'live_finish_identity_rejected', 'live_finish_guard_rejected', 'live_finish_guard_changed', 'live_finish_cleanup_unconfirmed',
  'live_fresh_session_rejected', 'live_fresh_session_not_empty', 'live_arm_rejected', 'live_admission_audit_missing',
  'diagnostic_write_failed', 'diagnostic_write_timeout', 'live_dispatch_binding_rejected',
  'native_preclosure_witness_or_binding_missing', 'native_complete_interval_rejected', 'native_final_answer_mismatch',
  'native_recorded_usage_missing', 'native_usage_aggregate_mismatch', 'native_pricing_missing', 'native_pricing_ambiguous',
  'native_session_completion_rejected', 'native_tool_completion_rejected', 'native_seal_evidence_rejected', 'native_seal_changed',
  'native_inspection_deadline', 'native_evidence_cap', 'native_cli_closure_ineligible', 'native_finish_facts_rejected',
  'native_observer_failed', 'native_message_page_rejected', 'native_message_interval_rejected', 'native_message_cursor_rejected',
  'native_message_page_cap', 'native_child_scope_rejected', 'native_assistant_identity_rejected', 'native_step_mapping_rejected',
  'native_release_correspondence_unresolved', 'native_success_witness_rejected', 'native_activity_after_success',
  'native_ephemeral_shape_rejected', 'native_event_correspondence_rejected', 'native_snapshots_changed',
  'native_observer_reconnected', 'native_activity_after_seal', 'native_recovery_or_auxiliary_observed',
  'native_release_ack_ambiguous', 'native_continuation_unbound', 'native_host_seal_reused', 'native_continuation_not_settled_tool_step',
  'native_observer_connect_timeout', 'native_observer_disconnected', 'native_usage_baseline_or_pricing_rejected',
  'native_zero_usage_ambiguous', 'native_missing_rate_or_zero_ambiguous', 'native_zero_cost_ambiguous', 'native_usage_overflow',
  'native_completion_correspondence_missing', 'native_cli_tool_correspondence_rejected', 'native_finish_owned_cli_mismatch',
  'native_inspection_revoked', 'native_baseline_not_zero_fresh', 'native_cli_prompt_argument_rejected',
  'native_store_history_rejected', 'native_store_user_rejected', 'native_store_agent_selection_rejected', 'native_store_placeholder_rejected',
  'native_pending_state_rejected', 'native_pending_template_rejected', 'native_message_binding_rejected',
  'context_abort_certificate_rejected', 'nonlocal_rpc_rejected', 'invalid_audit_phase',
  'invalid_finish_observations', 'invalid_fresh_finish_facts', 'invalid_finish_capability', 'finish_owned_binding_changed',
  'fresh_finish_deadline', 'bridge_finalization_unconfirmed', 'native_session_reused', 'native_assistant_identity_reused',
  'native_capture_step_correspondence_mismatch', 'owned_native_evidence_path_mismatch',
  'invalid_native_completion_evidence', 'invalid_native_timestamp_basis', 'native_timestamp_basis_mismatch',
  'native_completion_kind_mismatch', 'native_completion_evidence_rejected', 'native_completion_binding_mismatch',
  'invalid_native_usage', 'invalid_native_usage_completeness', 'native_usage_incomplete', 'native_tool_evidence_invalid',
  'invalid_native_artifact_keys', 'native_artifact_binding_mismatch', 'invalid_native_pricing',
  'native_artifact_correspondence_mismatch', 'invalid_native_post_release_binding', 'invalid_native_seal', 'native_artifact_seal_mismatch',
  'invalid_native_snapshot', 'native_artifact_snapshot_mismatch', 'invalid_native_snapshot_row',
  'invalid_native_witness', 'native_artifact_witness_mismatch', 'native_artifact_witness_missing',
  'invalid_settled_episode', 'invalid_settled_usage', 'invalid_execution_bindings', 'invalid_source_version', 'invalid_driver_source_set',
  'invalid_registration_keys', 'invalid_fresh_profile_identity', 'invalid_source_lineage', 'invalid_verification_reference',
  'invalid_freeze_artifact_path', 'invalid_freeze_encoding', 'invalid_two_registration_freeze', 'invalid_frozen_registration_reference',
  'invalid_focused_verification', 'invalid_focused_check', 'invalid_focused_check_evidence',
  'invalid_or_consumed_episode_capability', 'invalid_dispatch_capability', 'invalid_checkpoint_capture_facts',
  'invalid_probe_checkpoint', 'invalid_probe_checkpoint_artifact', 'invalid_probe_checkpoint_receipt', 'invalid_probe_artifact_reference',
]));
function finalizationReasonCode(error) {
  try { const code = error?.message; return FINALIZATION_REASON_CODES.has(code) ? code : 'unknown_failure'; }
  catch { return 'unknown_failure'; }
}

// Evaluator-only callback API, NOT admission or a sandbox. The CLI cannot reach
// this function. The final adapter must supply frozen owned-server flags, exact stdin and
// the synchronous createOwnedLauncher-compatible factory; never accept either
// from a model argument, readiness JSON, or a shell-command string.
export async function captureEpisode({ launcherFactory, launch, item, task, directory, limits = {}, finalize, setupMs = 0, profileId, protocolHash }) {
  const fresh = isNativeCompletionProfile(profileId, protocolHash);
  if ((profileId !== undefined || protocolHash !== undefined) && !fresh) throw new Error('invalid_capture_profile');
  if ((finalize !== undefined && typeof finalize !== 'function') || !Number.isFinite(setupMs) || setupMs < 0) throw new Error('invalid_capture_finalizer');
  const prompt = promptFor(task);
  if (typeof launcherFactory !== 'function' || !Object.isFrozen(launch) || !Object.isFrozen(launch?.args) ||
      !Object.isFrozen(launch?.env) || !path.isAbsolute(launch?.executable ?? '') || !path.isAbsolute(launch?.cwd ?? '') ||
      !launch.env || !Array.isArray(launch.args) || !launch.args.every(arg => typeof arg === 'string') ||
      launch.args.includes('--standalone') || !nativePromptTransportMatch(launch, prompt, { model: item.model }) ||
      !Number.isSafeInteger(launch.timeoutMs) || launch.timeoutMs < 1 || launch.timeoutMs > PROTOCOL.timeout_ms ||
      typeof launch.owner !== 'string' || !launch.owner || !/^[a-zA-Z0-9_.-]+$/.test(item?.episode_id ?? '') ||
      item.task_id !== task.id || !path.isAbsolute(directory)) throw new Error('frozen_trusted_owned_launch_required');
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !Object.hasOwn(CAPTURE_LIMITS, key))) throw new Error('invalid_capture_limits');
  const caps = { ...CAPTURE_LIMITS, ...limits };
  for (const key of Object.keys(caps)) if (!Number.isSafeInteger(caps[key]) || caps[key] < 1 || caps[key] > CAPTURE_LIMITS[key]) throw new Error('invalid_capture_limits');
  const paths = Object.fromEntries(Object.entries({ start: 'start.json', episode: 'json', events: 'events.ndjson', extraction: 'extraction.ndjson', stderr: 'stderr.txt', answer: 'answer.txt' })
    .map(([key, suffix]) => [key, path.join(directory, `${item.episode_id}.${suffix}`)]));
  Object.values(paths).forEach(assertFreshOutput);
  const started = Date.now(), started_at = new Date(started).toISOString();
  const bindings = { prompt_sha256: sha256(prompt), protocol_hash: fresh ? protocolHash : PROTOCOL_HASH, ...(fresh ? { profile_id: profileId } : {}), task_sha256: sha256(task),
    capture_source_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    launch_descriptor_sha256: sha256({ executable: launch.executable, cwd: launch.cwd, owner: launch.owner, timeoutMs: launch.timeoutMs,
      prompt_sha256: sha256(prompt), stdin_sha256: launch.stdin_sha256,
      argument_policy: 'owned descriptor; prompt stdin and credential-bearing argv/env omitted' }) };
  writeFileSync(paths.start, JSON.stringify({ ...item, started_at, ...bindings }) + '\n', { flag: 'wx', mode: 0o600 });
  const terminalTemp = path.join(directory, `${item.episode_id}.terminal-${randomUUID()}.tmp`);
  const artifacts = {}, closeErrors = [], steps = [], toolEvents = [], models = new Set(), sessions = new Set();
  const assistantIDs = new Set(), capturedTools = [];
  let toolEvidenceInvalid = false, closureInspectable = false, cliClosedAt = null;
  const utf8 = fresh ? new TextDecoder('utf-8', { fatal: true }) : null;
  const controller = new AbortController();
  let terminalFD, launcher, timer, exit = null, cleanup = { confirmed: false, error: 'owned_launcher_not_created' };
  let line = 0, eventCount = 0, failures = 0, providerErrors = 0, inputBytes = 0;
  let message = null, stderrTail = '', timedOut = false, sealed = false, accepting = true;
  let captureError = null, resourceFailure = null, spawnError = null, modelMismatch = false, interfaceBlocked = false;
  let streamClosed = false, pendingSteps = 0, lastInferenceEvent = null, finishReason = null;
  let solverStarted = null, solverEnded = null, abortFinalization, streamsFlushed = false, nativeClosureClean = false, solverDeadline = null;
  const diagnosticEvents = [];
  let diagnosticDropped = 0, stepStarts = 0, cancellationCause = null, lastSessionHash = null, lastMessageHash = null;
  let captureObservationFailure = false, finalizationObservation = 'not_attempted';
  const diagnosticTypes = new Set(['step_start', 'step_finish', 'text', 'tool_use', 'error']);
  const diagnosticReasons = new Set(['stop', 'tool-calls', 'length', 'content-filter', 'error', 'unknown']);
  const cancellationReasons = new Set(['timeout', 'native_closure_incomplete', 'capture_setup_failed', 'capture_callback_failed', 'line_limit', 'output_limit', 'model_mismatch']);
  function captureDiagnostics() {
    const value = { schema: 'real-use-capture-diagnostics/v1', authority: 'none; untrusted CLI observations, not native identity or admission',
      capture_source_sha256: bindings.capture_source_sha256, prompt_sha256: bindings.prompt_sha256, model_sha256: sha256(item.model),
      session_sha256: lastSessionHash, message_sha256: lastMessageHash, at_ms: Date.now(), solver_deadline_ms: solverDeadline,
      step_starts: stepStarts, step_finishes: steps.length, pending_steps: pendingSteps, stream_closed: streamClosed,
      native_closure_clean: streamsFlushed ? nativeClosureClean : null,
      terminal_step_finish_observed: lastInferenceEvent === 'step_finish' && finishReason === 'stop',
      last_inference_event: diagnosticTypes.has(lastInferenceEvent) ? lastInferenceEvent : null,
      last_finish_reason: diagnosticReasons.has(finishReason) ? finishReason : null, provider_errors: providerErrors, extraction_failures: failures,
      cancellation_cause: cancellationCause, usage_coverage: usageFromSteps(steps).coverage,
      finalization: finalizationObservation, native_wait: 'unknown; only owned bridge can observe', upstream_cause: 'unknown',
      bridge_observation_failed: captureObservationFailure, events: diagnosticEvents.map(row => ({ ...row })),
      events_dropped: diagnosticDropped, truncated: diagnosticDropped > 0, max_records: 64, max_bytes: 16384 };
    while (Buffer.byteLength(JSON.stringify(value)) > value.max_bytes && value.events.length) {
      value.events.shift(); value.events_dropped++; value.truncated = true;
    }
    return value;
  }
  function observeCapture() {
    try { launcher?.observeCapture?.({ ...captureDiagnostics(), ...(fresh ? { captured_tool_evidence: toolEvidenceInvalid ? null : capturedTools.map(row => ({ ...row })) } : {}) }); } catch { captureObservationFailure = true; }
  }
  let stopResolve;
  const stopped = new Promise(resolve => { stopResolve = resolve; });
  function abortBridge() {
    if (!abortFinalization && typeof finalize?.abort === 'function') abortFinalization = Promise.resolve().then(() => finalize.abort()).catch(() => null);
  }
  function stop(reason) {
    cancellationCause ??= cancellationReasons.has(reason) ? reason : 'unknown';
    observeCapture(); controller.abort(reason); stopResolve(null); abortBridge();
  }
  function write(name, text) {
    const artifact = artifacts[name], bytes = Buffer.from(text);
    if (artifact.bytes + bytes.length > caps.maxOutputBytes) { resourceFailure ??= 'artifact_output_limit'; throw new Error('artifact_output_limit'); }
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(artifact.fd, bytes, offset, bytes.length - offset, artifact.bytes);
      if (!n) throw new Error('capture_short_write');
      artifact.hash.update(bytes.subarray(offset, offset + n)); artifact.bytes += n; offset += n;
    }
  }
  function extraction(reason) { failures++; write('extraction', JSON.stringify(reason) + '\n'); }
  function consumeLine(value, stream) {
    if (stream === 'stderr') {
      const safe = redactText(value); write('stderr', safe + '\n'); stderrTail = (stderrTail + safe + '\n').slice(-4000); return;
    }
    const parsed = parseEventLine(value, ++line);
    if (parsed.failure) extraction(parsed.failure);
    if (!parsed.event) return;
    const event = parsed.event;
    if (fresh && ['step_start', 'step_finish', 'text', 'tool_use'].includes(event.type)) {
      const id = event.part?.messageID;
      if (nativeMessageID(id) && assistantIDs.size < 200) assistantIDs.add(id);
      else if (!nativeMessageID(id) || !assistantIDs.has(id)) extraction({ reason: 'native_assistant_id_missing_or_limit' });
    }
    write('events', JSON.stringify(event) + '\n'); eventCount++;
    if (['step_start', 'step_finish', 'text', 'tool_use'].includes(event.type)) lastInferenceEvent = event.type;
    if (event.type === 'step_start') { pendingSteps++; stepStarts++; }
    const part = textPart(event);
    if (part) {
      if (part.message_id !== null && message !== null && part.message_id !== message) {
        ftruncateSync(artifacts.answer.fd, 0); artifacts.answer.bytes = 0; artifacts.answer.hash = createHash('sha256');
      }
      message = part.message_id ?? message; write('answer', part.text);
      if (typeof part.message_id === 'string') lastMessageHash = sha256(part.message_id);
    }
    if (event.type === 'step_finish') {
      const step = event.part ?? event; steps.push({ tokens: step.tokens, cost: step.cost });
      pendingSteps = Math.max(0, pendingSteps - 1); finishReason = step.reason ?? null;
    }
    if (event.type === 'tool_use') {
      const tool = event.part ?? event;
      toolEvents.push({ tool: tool.tool ?? null, call_id: tool.callID ?? tool.id ?? null,
        status: tool.state?.status ?? tool.status ?? null, event_line: eventCount, stream_line: line });
      if (fresh) {
        const state = tool.state;
        if (capturedTools.length >= 200 || state?.status !== 'completed' || typeof state.output !== 'string' ||
            !state.input || typeof state.input !== 'object' || Array.isArray(state.input) || !nativeMessageID(tool.messageID) ||
            typeof tool.id !== 'string' || capturedTools.some(row => row.call_id === tool.id)) toolEvidenceInvalid = true;
        else capturedTools.push({ name: tool.tool, call_id: tool.id, native_assistant_id: tool.messageID,
          input_sha256: hash(state.input), output_sha256: hash(state.output), status: 'completed' });
      }
      interfaceBlocked ||= /permission.?denied|tool.{0,40}(?:blocked|not.allowed|not.found)|unknown.tool/i.test(String(tool.state?.error ?? tool.error ?? ''));
    }
    if (event.type === 'error') {
      providerErrors++;
      interfaceBlocked ||= /permission.?denied|tool.{0,40}(?:blocked|not.allowed|not.found)|unknown.tool/i.test(JSON.stringify(event.error ?? ''));
    }
    for (const info of [event, event.info, event.part].filter(Boolean)) {
      if (typeof info.sessionID === 'string') { sessions.add(info.sessionID); lastSessionHash = sha256(info.sessionID); }
      if (typeof info.providerID === 'string' && typeof info.modelID === 'string') {
        const observed = `${info.providerID}/${info.modelID}`; models.add(observed);
        if (observed !== item.model) { modelMismatch = true; stop('model_mismatch'); }
      }
      // Native Ref is providerID/id under a typed event's model field, never
      // arbitrary tool input/output text or a tool-call's id.
      if (event.type !== 'tool_use' && info.model && typeof info.model.providerID === 'string' && typeof info.model.id === 'string') {
        const observed = `${info.model.providerID}/${info.model.id}`; models.add(observed);
        if (observed !== item.model || (info.model.variant !== undefined && info.model.variant !== 'default')) { modelMismatch = true; stop('model_mismatch'); }
      }
    }
    if (diagnosticTypes.has(event.type)) {
      if (diagnosticEvents.length === 64) { diagnosticEvents.shift(); diagnosticDropped++; }
      diagnosticEvents.push({ observed_at_ms: Date.now(),
        native_timestamp_ms: Number.isSafeInteger(event.timestamp) && event.timestamp >= 0 ? event.timestamp : null,
        type: event.type, step_ordinal: stepStarts, finished_steps: steps.length,
        finish_reason: event.type === 'step_finish' && diagnosticReasons.has(finishReason) ? finishReason : null });
    }
    if (fresh) observeCapture();
  }
  const streams = Object.fromEntries(['stdout', 'stderr'].map(name => [name, { decoder: new StringDecoder('utf8'), buffer: '', bytes: 0, dropped: false }]));
  function decoded(stream, text, final = false) {
    const state = streams[stream];
    let offset = 0;
    while (offset < text.length && !state.dropped) {
      const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline;
      const piece = text.slice(offset, end);
      if (state.bytes + Buffer.byteLength(piece) > caps.maxLineBytes) {
        state.buffer = ''; state.bytes = 0; state.dropped = true; resourceFailure ??= 'line_limit';
        extraction({ reason: 'line_limit', stream }); accepting = false; stop('line_limit'); return;
      }
      state.buffer += piece; state.bytes += Buffer.byteLength(piece); offset = end + 1;
      if (newline >= 0) {
        const value = state.buffer.replace(/\r$/, ''); state.buffer = ''; state.bytes = 0;
        consumeLine(value, stream); // A failed callback must never replay this line during flush.
      }
    }
    if (final && state.buffer && !state.dropped) {
      const value = state.buffer.replace(/\r$/, ''); state.buffer = ''; state.bytes = 0;
      consumeLine(value, stream);
    }
  }
  function callback(stream, chunk) {
    if (sealed || !accepting) return;
    try {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new Error('capture_requires_bytes');
      const bytes = Buffer.from(chunk), remaining = Math.max(0, caps.maxOutputBytes - inputBytes);
      if (stream === 'stdout') utf8?.decode(bytes, { stream: true });
      inputBytes += bytes.length;
      decoded(stream, streams[stream].decoder.write(bytes.subarray(0, remaining)));
      if (bytes.length > remaining) { resourceFailure ??= 'output_limit'; accepting = false; stop('output_limit'); }
    } catch {
      captureError ??= 'capture_callback_failed'; accepting = false; stop('capture_callback_failed');
    }
  }
  function flushStreams() {
    if (streamsFlushed) return;
    streamsFlushed = true;
    const completeNDJSON = streams.stdout.buffer.length === 0;
    try { utf8?.decode(); } catch { captureError ??= 'capture_utf8_invalid'; }
    for (const [name, state] of Object.entries(streams)) {
      try { decoded(name, state.decoder.end(), true); } catch { captureError ??= 'capture_flush_failed'; }
    }
    closureInspectable = streamClosed && exit?.exit_code === 0 && !exit?.timeout && !exit?.spawn_error && completeNDJSON &&
      !controller.signal.aborted && !failures && !providerErrors && !captureError && !resourceFailure && !modelMismatch &&
      (!fresh || (!interfaceBlocked && !toolEvidenceInvalid && !captureObservationFailure));
    nativeClosureClean = closureInspectable && pendingSteps === 0 && lastInferenceEvent === 'step_finish' && finishReason === 'stop';
  }
  async function boundedCleanup() {
    if (!launcher || typeof launcher.cleanupOwned !== 'function') return { confirmed: false, error: 'owned_cleanup_unavailable' };
    let deadline;
    try {
      const receipt = await Promise.race([
        Promise.resolve().then(() => launcher.cleanupOwned()),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('owned_cleanup_timeout')), caps.cleanupMs); }),
      ]);
      if (!exit && receipt?.exit_code !== undefined) exit = receipt;
      return sanitize(receipt?.cleanup ?? { confirmed: false, error: 'owned_cleanup_receipt_missing' });
    } catch (error) { return { confirmed: false, error: error?.message === 'owned_cleanup_timeout' ? 'owned_cleanup_timeout' : 'owned_cleanup_failed' }; }
    finally { clearTimeout(deadline); }
  }
  try { // Keep the terminal descriptor protected through result assembly, too.
  try {
    terminalFD = openSync(terminalTemp, 'wx', 0o600);
    for (const name of ['events', 'extraction', 'stderr', 'answer']) artifacts[name] = { fd: openSync(paths[name], 'wx', 0o600), bytes: 0, hash: createHash('sha256') };
    solverStarted = Date.now();
    solverDeadline = solverStarted + launch.timeoutMs;
    timer = setTimeout(() => { timedOut = true; stop('timeout'); }, launch.timeoutMs);
    launcher = launcherFactory(launch, { onStdout: bytes => callback('stdout', bytes), onStderr: bytes => callback('stderr', bytes), signal: controller.signal });
    if (!launcher || !launcher.closed || typeof launcher.closed.then !== 'function' || typeof launcher.cleanupOwned !== 'function') throw new Error('invalid_owned_launcher');
    const closed = Promise.resolve(launcher.closed).then(result => {
      cliClosedAt = Date.now(); exit = result; streamClosed = true; flushStreams(); observeCapture();
      if (!nativeClosureClean && !(fresh && closureInspectable && finalize)) stop('native_closure_incomplete');
      return result;
    }, () => { spawnError = 'owned_launcher_closed_rejected'; flushStreams(); stop('native_closure_incomplete'); return null; });
    await Promise.race([closed, stopped]);
  } catch (error) { spawnError = error?.message === 'invalid_owned_launcher' ? 'invalid_owned_launcher' : 'owned_launcher_or_capture_setup_failed'; stop('capture_setup_failed'); }
  finally {
    solverEnded = Date.now();
    cleanup = await boundedCleanup();
    sealed = true; // Late callbacks after unconfirmed cleanup must not touch closed FDs.
    flushStreams();
    observeCapture();
    for (const [name, artifact] of Object.entries(artifacts)) {
      try { closeSync(artifact.fd); } catch { closeErrors.push(name); }
    }
  }
  let finalText = '';
  try { if (artifacts.answer) finalText = readFileSync(paths.answer, 'utf8'); } catch { captureError ??= 'answer_read_failed'; }
  const ownership = sanitize(exit?.ownership ?? launcher?.status ?? null);
  const ownershipValid = ownership?.owner === launch.owner && ownership?.job_assigned === true && ownership?.kill_on_close === true;
  const cleanupConfirmed = cleanup.confirmed === true && cleanup.active_processes === 0 && cleanup.files_removed !== false;
  const safetyFailure = !cleanupConfirmed || !ownershipValid || closeErrors.length > 0 || modelMismatch;
  timedOut ||= exit?.timeout === true; spawnError ??= exit?.spawn_error ?? null;
  const dsmlArtifact = toolEvents.length === 0 && /[|｜]DSML[|｜]|<\/?DSML|<\|(?:tool_call|function_call)/i.test(finalText);
  const classification = !cleanupConfirmed ? 'cleanup_failure' : !ownershipValid ? 'ownership_unconfirmed' : closeErrors.length || captureError ? 'capture_failure'
    : timedOut ? 'timeout' : resourceFailure ? 'resource_failure' : spawnError ? 'spawn_failure' : modelMismatch ? 'model_mismatch'
      : interfaceBlocked ? 'interface_call_blocked' : dsmlArtifact ? 'interface_text_artifact' : providerErrors ? 'provider_error'
        : exit?.exit_code !== 0 ? 'nonzero_exit' : failures ? 'extraction_failure' : !finalText.trim() ? 'empty_answer' : 'completed_answer';
  const artifactRecords = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, { path: paths[name], bytes: artifact.bytes, sha256: artifact.hash.digest('hex') }]));
  const usageReasons = [];
  if (classification !== 'completed_answer') usageReasons.push(classification);
  if (!streamClosed) usageReasons.push('stream_completion_unconfirmed');
  if (!nativeClosureClean) usageReasons.push('native_closure_incomplete');
  if (pendingSteps) usageReasons.push('unfinished_step');
  if (lastInferenceEvent !== 'step_finish' || finishReason !== 'stop') usageReasons.push('terminal_step_finish_missing');
  const usage = usageFromSteps(steps, { complete: usageReasons.length === 0, reasons: usageReasons });
  const result = {
    ...item, schema: 'real-use-episode/v1', started_at, duration_ms: Date.now() - started, ...bindings,
    status: classification === 'completed_answer' ? 'completed' : 'failed', operational_classification: classification,
    completion_scope: 'process delivery only; not model/session identity validation or mathematical correctness',
    exit_code: exit?.exit_code ?? null, signal: exit?.signal ?? null, timeout: timedOut, spawn_error: spawnError,
    ownership, ownership_sha256: sha256(ownership), cleanup, safety_failure: safetyFailure, fd_close_errors: closeErrors,
    capture_error: captureError, resource_failure: resourceFailure, model_mismatch: modelMismatch, provider_errors: providerErrors,
    extraction_failures: failures, captured_events: eventCount, input_bytes: inputBytes, stderr_tail: stderrTail,
    final_text: finalText, text: finalText, answer_path: paths.answer, answer_bytes: artifacts.answer?.bytes ?? 0,
    final_text_sha256: sha256(finalText), artifacts: artifactRecords, episode_path: paths.episode,
    tool_count: toolEvents.length, tools: toolEvents.map(event => event.tool).filter(Boolean), tool_events: toolEvents,
    usage, usage_completeness: usage.completeness,
    ...(fresh ? { capture_usage: structuredClone(usage), capture_classification: classification,
      capture_completeness: structuredClone(usage.completeness), completion_basis: null, upstream_usage_complete: 'unknown', billed_usd: null } : {}),
    identity_validation: { status: 'unavailable', requested_model: item.model, observed_models: [...models], observed_session_ids: [...sessions], reason: 'owned_guard_identity_not_bound' },
  };
  if (fresh) { result.status = 'failed'; result.operational_classification = 'finalization_required'; }
  if (finalize) {
    finalizationObservation = 'pending';
    const finalController = new AbortController(); let deadline;
    if (!(nativeClosureClean || (fresh && closureInspectable)) || controller.signal.aborted || classification !== 'completed_answer') finalController.abort();
    const facts = Object.freeze({ observed_session_ids: Object.freeze([...sessions]), observed_models: Object.freeze([...models]),
      prompt_sha256: bindings.prompt_sha256, timeout: timedOut, cli_cleanup: freeze(structuredClone(cleanup)), solver_deadline: solverDeadline,
      native_closure_clean: nativeClosureClean, signal: finalController.signal,
      ...(fresh ? { final_text: finalText, final_text_sha256: sha256(finalText), captured_assistant_message_ids: Object.freeze([...assistantIDs]),
        cli_closed_at: cliClosedAt, capture_usage: freeze(structuredClone(usage)) } : {}) });
    try {
      const receipt = await Promise.race([
        Promise.resolve().then(() => finalize(facts)),
        new Promise((_, reject) => { deadline = setTimeout(() => { finalController.abort(); abortBridge(); reject(new Error('finalization_timeout')); },
          Math.max(1, Math.min(caps.finalizeMs, (solverDeadline ?? Date.now()) - Date.now()))); }),
      ]);
      if (!consumeFinalizationReceipt(receipt, item, bindings.prompt_sha256)) throw new Error('untrusted_finalization_receipt');
      if (fresh && (finalController.signal.aborted || controller.signal.aborted || Date.now() >= solverDeadline || safetyFailure ||
          classification !== 'completed_answer' || !receipt.completion_evidence || !receipt.native_recorded_usage)) throw new Error('finalization_ineligible');
      result.identity_validation = receipt.identity_validation; result.guard = receipt.guard;
      result.cleanup = { ...cleanup, cli: cleanup, bridge: receipt.cleanup, confirmed: cleanupConfirmed && receipt.cleanup.confirmed };
      result.finalization = { status: 'validated_owned_receipt' };
      finalizationObservation = 'validated_owned_receipt';
      if (fresh) {
        result.status = 'completed'; result.operational_classification = 'completed_answer';
        result.completion_scope = 'native-platform-v1; OpenCode-recorded completion, not correctness or provider billing';
        result.completion_evidence = receipt.completion_evidence; result.completion_basis = receipt.completion_evidence.basis;
        result.tool_evidence = receipt.tool_evidence; result.usage = receipt.native_recorded_usage;
        result.usage_completeness = receipt.native_recorded_usage.completeness;
      }
    } catch (error) {
      finalController.abort(); abortBridge();
      const reason_code = finalizationReasonCode(error);
      const reason = reason_code === 'finalization_timeout' ? 'finalization_timeout'
        : reason_code === 'untrusted_finalization_receipt' ? 'untrusted_finalization_receipt' : 'finalization_failed';
      result.finalization = { status: 'unconfirmed', reason, reason_code };
      finalizationObservation = reason;
      result.status = 'failed'; result.operational_classification = 'finalization_failure'; result.safety_failure = true;
      result.cleanup = { ...cleanup, cli: cleanup, bridge: { confirmed: false }, confirmed: false };
      result.usage = usageFromSteps(steps, { reasons: [...usageReasons, reason] }); result.usage_completeness = result.usage.completeness;
    } finally { clearTimeout(deadline); if (fresh) solverEnded = Date.now(); }
  }
  observeCapture();
  result.capture_diagnostics = captureDiagnostics();
  result.timings = { setup_ms: setupMs, solver_ms: solverStarted === null ? 0 : solverEnded - solverStarted,
    cleanup_ms: Date.now() - solverEnded, end_to_end_ms: setupMs + Date.now() - started };
  result.duration_ms = Date.now() - started;
  if (terminalFD === undefined) throw new Error('terminal_artifact_unavailable');
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n'); let offset = 0;
  while (offset < bytes.length) { const count = writeSync(terminalFD, bytes, offset, bytes.length - offset); if (!count) throw new Error('terminal_short_write'); offset += count; }
  fsyncSync(terminalFD);
  closeSync(terminalFD); terminalFD = undefined;
  // Hard-link publication is atomic and fails if the destination already exists,
  // unlike a replacing rename on Windows. Failed writes retain owned temp/start
  // evidence; the loader never interprets a temp file as a completed episode.
  linkSync(terminalTemp, paths.episode);
  unlinkSync(terminalTemp);
  return result;
  } finally { clearTimeout(timer); if (terminalFD !== undefined) closeSync(terminalFD); }
}

export function prepare(argv, environment = process.env) {
  const args = parseArgs(argv, ['--model', '--tasks', '--out', '--workspace', '--seed', '--repeats',
    '--max-episodes', '--max-cost-usd', '--readiness', '--execute', '--dry-run']);
  if (args['--execute'] && args['--dry-run']) throw new Error('choose --execute or --dry-run');
  if (args['--execute'] && environment.REAL_USE_ALLOW_EXECUTE !== '1') {
    throw new Error('execution_not_authorized: --execute and REAL_USE_ALLOW_EXECUTE=1 required');
  }
  for (const name of ['--model', '--tasks', '--out', '--workspace']) if (!args[name]) throw new Error(`${name} required explicitly`);
  const out = path.resolve(args['--out']);
  assertFreshOutput(out);
  const tasks = validatePublic(readJSON(args['--tasks']));
  if (tasks.length !== 10) throw new Error('this preparation track requires exactly 10 public workflows');
  const manifest = makeManifest(tasks, {
    model: args['--model'], workspace: args['--workspace'], seed: args['--seed'] ?? 'real-use-v1',
    repeats: Number(args['--repeats'] ?? 1),
    max_episodes: args['--max-episodes'] === undefined ? PROTOCOL.max_episodes : Number(args['--max-episodes']),
    max_cost_usd: args['--max-cost-usd'] === undefined ? PROTOCOL.max_cost_usd : Number(args['--max-cost-usd']),
  });
  if (args['--execute']) executionGate({
    execute: true, environment, workspace: args['--workspace'],
    ...manifest.budgets, readiness: args['--readiness'] ? readJSON(args['--readiness']) : null,
  }, manifest);
  // No mkdir, manifest persistence, credentials, plugin discovery, or process launch in preview.
  return { mode: 'dry-run', execution: 'BLOCKED: authenticated isolation/parity adapter unavailable', out, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(prepare(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(redactText(error?.message ?? 'capture_failed')); process.exitCode = 1; }
}
