// No-completion trusted-host bridge. Process ownership is delegated to the shared
// Windows launcher; neither component is a filesystem/network sandbox.
import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile as writeDiagnosticFile } from 'node:fs/promises';
import path from 'node:path';
import { RPC_ID, AGENT, TITLE, MODEL, MODEL_REF, VARIANT_CHOICE, DISPATCH_PROOF, MODEL_IDENTITY_TEMPLATE, withModelIdentity, hash, permissionsFor, namesFor, DEFINITIONS, canonical, diagnosticShape, validDiagnosticShape, nativeMessageID, withNativeMessage, inspectNativeUserArtifact, guardBinding, freeze, projectNativeHistory, isNativeCompletionProfile } from './runtime-plugin.js';
import { stageAudit, resolveTrustedExecutable } from './stage.mjs';
import { createOwnedLauncher } from './trusted-launch.mjs';

const MAX_RESPONSE = 256 * 1024;
// Canonical digest of the independent parent-provided bridge-provenance-g004.json,
// not of a first-observed runtime inventory.
const APPROVED_PROVENANCE_SHA256 = '9efb28d3e242fc55ee94cb6653eca533a735daacd238da89c75547a87265bc63';
const same = (a, b) => canonical(a) === canonical(b);
const fail = code => { throw new Error(code); };
const ownedBridges = new WeakMap();
export const ADMISSION_API = 'real-use-owned-live-bridge/v1';
export const isOwnedBridge = handle => ownedBridges.has(handle);

const DIAGNOSTIC_STAGES = new Set(['audit', 'admitting', 'admitted', 'dispatch', 'running', 'status_rpc', 'pending', 'inventory',
  'session_scope', 'native_history', 'bind_rpc', 'released', 'cli_terminal', 'cancellation', 'deadline', 'finish', 'native_wait',
  'cleanup', 'revoked', 'context', 'context_continuation', 'bind', 'model.request', 'http.request', 'experimental.ws.handshake',
  'experimental.ws.send', 'transport_unknown', 'permission', 'tool', 'tool_settled', 'deny', 'armed', 'unknown']);
const DIAGNOSTIC_REASONS = new Set(['observed', 'unknown_failure', 'rpc_http_failure', 'rpc_failed', 'guard_rejected', 'pending_timeout',
  'solver_deadline', 'timeout', 'native_closure_incomplete', 'capture_setup_failed', 'capture_callback_failed', 'line_limit', 'output_limit',
  'model_mismatch', 'host_cleanup', 'cli_closed', 'cli_closed_rejected', 'revoke_failed', 'signal_aborted', 'native_wait_completed',
  'live_solver_deadline_or_closure', 'live_release_after_stop', 'live_monitor_timeout', 'live_rpc_envelope_rejected',
  'live_guard_status_rejected', 'live_inventory_changed', 'live_session_scope_changed', 'live_inbox_rejected', 'live_user_store_changed',
  'native_history_rejected', 'live_pending_rejected', 'live_projection_mismatch', 'live_release_rejected', 'live_launcher_failed',
  'live_finish_identity_rejected', 'live_finish_guard_rejected', 'live_finish_guard_changed', 'live_finish_cleanup_unconfirmed',
  'live_fresh_session_rejected', 'live_fresh_session_not_empty', 'live_arm_rejected', 'live_admission_audit_missing', 'diagnostic_write_failed', 'diagnostic_write_timeout',
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
  'native_inspection_revoked', 'native_baseline_not_zero_fresh', 'native_unknown_durable_event',
  'native_observer_not_connected', 'native_observation_cap', 'native_event_byte_cap', 'native_event_serialization_rejected',
  'native_event_data_rejected', 'native_event_id_rejected', 'native_event_timestamp_rejected',
  'native_event_timestamp_before_creation', 'native_event_timestamp_after_receipt',
  'native_duplicate_event_id', 'native_event_id_cap', 'native_durable_session_rejected',
  'native_durable_sequence_rejected', 'native_durable_version_rejected']);
const safeUnknownEventType = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value);
const diagnosticNumber = (v, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= maximum ? v : null;
const diagnosticTimestampDelta = v => Number.isFinite(v) ? Math.trunc(Math.max(-600000, Math.min(600000, v))) : null;
const diagnosticHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : null;
const diagnosticStage = v => DIAGNOSTIC_STAGES.has(v) ? v : 'unknown';
export function diagnosticReason(error) {
  let value; try { value = typeof error === 'string' ? error : error?.message; } catch { return 'unknown_failure'; }
  if (DIAGNOSTIC_REASONS.has(value)) return value;
  return typeof value === 'string' && /^local_rpc_http_(?:401|403|404|409|429|500|502|503|504)(?:_rpc_[a-z_]+)?$/.test(value) ? 'rpc_http_failure' : 'unknown_failure';
}

// Data only: null means unknown/unavailable, never an implicit negative. No IDs,
// payloads, free text or authority are retained. Keep the first failure, not a
// later cleanup/finish rejection that would obscure its cause.
export function projectFinalizationDiagnostics(error, state = {}) {
  const bool = value => typeof value === 'boolean' ? value : null;
  const present = value => value === null ? false : value && typeof value === 'object' ? true : null;
  const correspondence = state.correspondence, witness = correspondence?.witness;
  const closedAt = diagnosticNumber(correspondence?.closed_at_ms ?? state.closedAt);
  const relative = value => diagnosticNumber(value) !== null && closedAt !== null && Number.isSafeInteger(value - closedAt) ? value - closedAt : null;
  const created = relative(witness?.created), received = relative(witness?.received_at_ms);
  const ledger = Array.isArray(correspondence?.ledger) ? correspondence.ledger : null;
  const recovery = correspondence?.observer_reason === 'native_recovery_or_auxiliary_observed';
  const observerEventTypes = recovery && Array.isArray(correspondence?.observer_event_types)
    ? [...new Set(correspondence.observer_event_types.slice(0, 8).filter(safeUnknownEventType))].sort() : [];
  const value = { schema: 'real-use-finalization-diagnostics/v1', authority: 'none', unknown_values: null,
    rejection_code: diagnosticReason(error),
    observer_reason: correspondence?.observer_reason == null ? null : diagnosticReason(correspondence.observer_reason),
    observer_event_type: recovery && safeUnknownEventType(correspondence?.observer_event_type) ? correspondence.observer_event_type : null,
    observer_event_types: observerEventTypes.length ? observerEventTypes : null,
    timestamp_delta_ms: ['native_event_timestamp_before_creation', 'native_event_timestamp_after_receipt'].includes(correspondence?.observer_reason)
      ? diagnosticTimestampDelta(correspondence?.timestamp_delta_ms) : null,
    unknown_event_types: Array.isArray(correspondence?.unknown_event_types)
      ? [...new Set(correspondence.unknown_event_types.slice(0, 8).filter(safeUnknownEventType))] : null,
    ignored_unknown_events: diagnosticNumber(correspondence?.ignored_unknown_events, 10000),
    stage: ['facts', 'eligibility', 'seal', 'snapshot', 'validation', 'evidence_write', 'cleanup'].includes(state.stage) ? state.stage : 'unknown',
    cli_closed_at_ms: closedAt, cli_complete: bool(state.cliComplete),
    witness: { present: present(witness), preclose: witness === null ? false : created !== null && received !== null ? created <= 0 && received <= 0 : null,
      created_relative_to_closure_ms: created, received_relative_to_closure_ms: received },
    ledger_count: ledger ? diagnosticNumber(ledger.length, 200) : null,
    ledger: ledger ? ledger.slice(-16).map(row => ({ ordinal: diagnosticNumber(row?.ordinal, 200),
      acknowledged: bool(row?.acknowledged), step_start_received: present(row?.event), assistant_bound: present(row?.binding),
      continuation_settled: bool(row?.settled) })) : null,
    ledger_truncated: ledger ? ledger.length > 16 : null,
    snapshot_read_number: diagnosticNumber(state.snapshotReadNumber, 2),
    seal: { phase: ['armed', 'pending', 'released', 'sealed', 'revoked'].includes(state.seal?.phase) ? state.seal.phase : 'unknown',
      ...Object.fromEntries(['ordinal', 'released', 'model_requests', 'violations', 'tool_calls', 'active_tools'].map(key => [key, diagnosticNumber(state.seal?.[key], 10000)])) },
    native_completion_evidence_written: bool(state.evidenceWritten), max_bytes: 4096, max_ledger_records: 16 };
  while (Buffer.byteLength(JSON.stringify(value) + '\n') > 4096 && value.ledger?.length) { value.ledger.shift(); value.ledger_truncated = true; }
  return freeze(value);
}

// Start the exclusive write without awaiting it. Callers must proceed directly
// to owned cleanup; a hung/rejected diagnostic write cannot buy inference time.
export function persistFinalizationDiagnostics(file, snapshot, writer = writeDiagnosticFile) {
  let timer;
  try {
    const bytes = JSON.stringify(snapshot) + '\n';
    if (Buffer.byteLength(bytes) > 4096) return Promise.resolve('write_failed');
    const writing = Promise.resolve(writer(file, bytes, { flag: 'wx', mode: 0o600 })).then(() => 'written', () => 'write_failed');
    return Promise.race([writing, new Promise(resolve => { timer = setTimeout(() => resolve('write_timeout'), 250); })])
      .finally(() => clearTimeout(timer));
  } catch { return Promise.resolve('write_failed'); }
}
const diagnosticPending = value => value && typeof value === 'object' ? {
  ordinal: diagnosticNumber(value.ordinal, 200), message_sha256: diagnosticHash(value.message_sha256),
  messages_sha256: diagnosticHash(value.messages_sha256), digest: diagnosticHash(value.digest),
} : null;
// Only an authenticated owned RPC response reaches this projection in production.
// The projection is data, not an admission/finalization receipt or a truth oracle.
export function projectGuardDiagnostics(value, identity) {
  if (!identity || !/^[a-f0-9-]{36}$/.test(identity.incarnation ?? '') ||
      !['session_sha256', 'prompt_sha256', 'model_sha256'].every(key => diagnosticHash(identity[key])) ||
      !value || value.schema !== 'real-use-native-guard-diagnostics/v1' || value.purpose !== 'production' ||
      value.incarnation !== identity.incarnation || value.session_sha256 !== identity.session_sha256 ||
      value.prompt_sha256 !== identity.prompt_sha256 || value.model_sha256 !== identity.model_sha256) return null;
  const count = key => diagnosticNumber(value[key], 10000);
  return { incarnation: identity.incarnation, session_sha256: identity.session_sha256, prompt_sha256: identity.prompt_sha256,
    model_sha256: identity.model_sha256, message_sha256: diagnosticHash(value.message_sha256),
    phase: ['armed', 'pending', 'released', 'revoked'].includes(value.phase) ? value.phase : 'unknown',
    ordinal: count('ordinal'), released: count('released'), model_requests: count('model_requests'), violations: count('violations'),
    tool_calls: count('tool_calls'), active_tools: count('active_tools'),
    transport_counts: Object.fromEntries(['model', 'http', 'ws_handshake', 'ws_send'].map(key => [key, diagnosticNumber(value.transport_counts?.[key], 10000)])),
    stage: diagnosticStage(value.stage), at_ms: diagnosticNumber(value.at_ms), solver_deadline_ms: diagnosticNumber(value.solver_deadline_ms),
    pending: diagnosticPending(value.pending), last_pending: diagnosticPending(value.last_pending),
    last_failure: value.last_failure ? { stage: diagnosticStage(value.last_failure.stage), reason: diagnosticReason(value.last_failure.reason),
      at_ms: diagnosticNumber(value.last_failure.at_ms), ordinal: diagnosticNumber(value.last_failure.ordinal, 200) } : null,
    records_count: count('records_count'), records_sha256: diagnosticHash(value.records_sha256),
    records_truncated: value.records_truncated === true || (Array.isArray(value.records) && value.records.length > 32) ? true
      : value.records_truncated === false && Array.isArray(value.records) ? false : null,
    records: Array.isArray(value.records) ? value.records.slice(-32).map(row => ({ ordinal: diagnosticNumber(row?.ordinal, 200),
      ...Object.fromEntries(['messages_sha256', 'system_sha256', 'tools_sha256', 'session_sha256', 'model_sha256'].map(key => [key, diagnosticHash(row?.[key])])) })) : null };
}

function projectCaptureDiagnostics(value) {
  if (!value || value.schema !== 'real-use-capture-diagnostics/v1') return null;
  return { schema: value.schema, capture_source_sha256: diagnosticHash(value.capture_source_sha256),
    prompt_sha256: diagnosticHash(value.prompt_sha256), model_sha256: diagnosticHash(value.model_sha256),
    at_ms: diagnosticNumber(value.at_ms), solver_deadline_ms: diagnosticNumber(value.solver_deadline_ms),
    step_starts: diagnosticNumber(value.step_starts), step_finishes: diagnosticNumber(value.step_finishes), pending_steps: diagnosticNumber(value.pending_steps),
    stream_closed: typeof value.stream_closed === 'boolean' ? value.stream_closed : null,
    native_closure_clean: typeof value.native_closure_clean === 'boolean' ? value.native_closure_clean : null,
    terminal_step_finish_observed: typeof value.terminal_step_finish_observed === 'boolean' ? value.terminal_step_finish_observed : null,
    provider_errors: diagnosticNumber(value.provider_errors), extraction_failures: diagnosticNumber(value.extraction_failures),
    cancellation_cause: value.cancellation_cause === null ? null : diagnosticReason(value.cancellation_cause),
    usage_coverage: Object.fromEntries(['input_tokens', 'output_tokens', 'cost_usd'].map(key => [key, diagnosticNumber(value.usage_coverage?.[key])])),
    finalization: ['not_attempted', 'pending', 'validated_owned_receipt', 'finalization_timeout', 'untrusted_finalization_receipt', 'finalization_failed'].includes(value.finalization)
      ? value.finalization : 'unknown',
    upstream_cause: 'unknown', authority: 'none; CLI observations are not native guard evidence' };
}

export function createProductionDiagnostics(sourceHashes) {
  const source_sha256 = Object.fromEntries(['bridge.mjs', 'stage.mjs', 'runtime-plugin.js', 'cli-builtins.json', 'run.mjs'].map(file =>
    [`bench/v4/real-use/${file}`, diagnosticHash(sourceHashes?.[`bench/v4/real-use/${file}`])]));
  let identity = {}, guard = null, guardObservedAt = null, capture = null, nativeWait = 'not_attempted', dropped = 0, finalization = null;
  const events = [], createdAt = Date.now();
  const telemetry = {
    bind(value) { identity = { incarnation: typeof value.incarnation === 'string' && /^[a-f0-9-]{36}$/.test(value.incarnation) ? value.incarnation : null,
      ...Object.fromEntries(['session_sha256', 'prompt_sha256', 'model_sha256'].map(key => [key, diagnosticHash(value[key])])) }; },
    event(stage, reason = 'observed', ordinal = null) {
      if (events.length === 64) { events.shift(); dropped++; }
      events.push({ at_ms: Date.now(), stage: diagnosticStage(stage), reason: diagnosticReason(reason), ordinal: diagnosticNumber(ordinal, 200) });
    },
    guard(value) { const projected = projectGuardDiagnostics(value, identity); if (projected) { guard = projected; guardObservedAt = Date.now(); } },
    capture(value) { capture = projectCaptureDiagnostics(value); },
    nativeWait(value) { nativeWait = ['not_attempted', 'pending', 'completed', 'failed', 'aborted'].includes(value) ? value : 'unknown'; },
    finalizationFailure(error, state) { return finalization ??= projectFinalizationDiagnostics(error, state); },
    snapshot() {
      const value = { schema: 'real-use-production-diagnostics/v1', authority: 'none; evaluator-owned observations only',
        created_at_ms: createdAt, snapshot_at_ms: Date.now(), source_sha256, identity, identity_scope: 'expected-owned-session-model-prompt', events: structuredClone(events),
        events_dropped: dropped, truncated: dropped > 0 || guard?.records_truncated === true,
        max_event_records: 64, max_guard_records: 32, max_bytes: 65536,
        guard: guard && structuredClone(guard), guard_observed_at_ms: guardObservedAt,
        guard_evidence_scope: guard ? 'last-projected-authenticated-owned-RPC; may precede terminal failure' : 'unavailable',
        capture: capture && structuredClone(capture), native_wait: nativeWait, finalization, upstream_cause: 'unknown' };
      // Fixed projections are already bounded; retain an explicit byte-cap fallback.
      if (Buffer.byteLength(JSON.stringify(value)) > 65536) { value.events = []; value.guard = null; value.capture = null; value.truncated = true; }
      return freeze(value);
    },
    // Initiate the exclusive bounded write BEFORE server termination, never await
    // disk or a diagnostic RPC while an inference process remains alive. The final
    // checkpoint is awaited only in cleanup's finally, after termination starts.
    persist(file, timeoutMs = 250, writer = writeDiagnosticFile) {
      const bytes = JSON.stringify(telemetry.snapshot()) + '\n';
      let timer, operation;
      try { operation = writer(file, bytes, { flag: 'wx', mode: 0o600 }); } catch { operation = Promise.reject(null); }
      const writing = Promise.resolve(operation).then(
        () => ({ status: 'written', path: file, sha256: hash(bytes) }), () => ({ status: 'write_failed', path: file, sha256: null }));
      return Promise.race([writing, new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'write_timeout', path: file, sha256: null }), Math.min(250, Math.max(1, timeoutMs))); })])
        .finally(() => clearTimeout(timer));
    },
  };
  return Object.freeze(telemetry);
}

// Narrow lifecycle primitives shared with no-inference fixtures; neither mints authority.
export async function cleanupOwnedCLI(child, launched, timeoutMs = 25000) {
  if (!launched) return { status: 'not_started', confirmed: true, active_processes: 0 };
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(() => child.cleanupOwned()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]);
    const confirmed = result?.cleanup?.confirmed === true && result.cleanup.active_processes === 0 &&
      result.ownership?.job_assigned === true && result.ownership.kill_on_close === true;
    return { status: confirmed ? 'confirmed_absent' : 'unconfirmed', confirmed,
      active_processes: result?.cleanup?.active_processes ?? null, process_tree_containment: confirmed,
      ownership_sha256: result?.ownership_sha256 ?? null };
  } catch { return { status: 'unconfirmed', confirmed: false, active_processes: null }; }
  finally { clearTimeout(timer); }
}

export function createSolverDeadline(timeoutMs, onStop) {
  const deadline = Date.now() + timeoutMs, controller = new AbortController(), releaseController = new AbortController();
  let cliClosed = false;
  const stop = () => { if (!controller.signal.aborted) { controller.abort(); releaseController.abort(); onStop(); } };
  const timer = setTimeout(stop, timeoutMs);
  return { deadline, signal: controller.signal, releaseSignal: releaseController.signal, stop,
    closeCLI() { cliClosed = true; releaseController.abort(); },
    check(release = false) {
      if (controller.signal.aborted || Date.now() >= deadline || (release && cliClosed)) {
        stop(); fail('live_solver_deadline_or_closure');
      }
    },
    disarm() { clearTimeout(timer); },
  };
}

export function validateFinishIdentity(observedSessionIDs, observedModels, sessionID, nativeGuardIdentity) {
  if (!Array.isArray(observedSessionIDs) || !observedSessionIDs.length || observedSessionIDs.some(id => id !== sessionID) ||
      !Array.isArray(observedModels) || observedModels.some(model => model !== MODEL) || nativeGuardIdentity !== true) fail('live_finish_identity_rejected');
}

export function nativePromptBytes(prompt) {
  if (typeof prompt !== 'string' || !prompt.length || prompt.includes('\0') || Buffer.byteLength(prompt) > 1024 * 1024)
    fail('native_cli_prompt_stdin_rejected');
  // With no positional message arguments the pinned CLI reads stdin unchanged,
  // including whitespace, punctuation-bearing negative tokens and a trailing LF.
  return Buffer.from(prompt);
}

export function verifyAbortCertificate(audit, stage, template, startupIncarnation, nativeIdleObserved = false) {
  if (audit.incarnation !== startupIncarnation || audit.abort_count !== 1 || audit.requests !== 1 || audit.guard_state !== 'bound-abort' ||
      !audit.inventory_passed || audit.last_request?.reasons.length !== 0 ||
      !same(audit.abort_record, { abort_committed: true, request_ordinal: 1, ...guardBinding(stage.bindings, startupIncarnation, template) }) ||
      Object.entries(audit.guard_counts).some(([name, count]) => count !== (name === 'context' ? 1 : 0))) fail('context_abort_certificate_rejected');
  return { schema: 'real-use-trusted-guard-certificate/v1', scope: 'trusted-guard-pinned-source-session-inference-prevented',
    incarnation: startupIncarnation, binding_sha256: hash(guardBinding(stage.bindings, startupIncarnation, template)),
    abort_committed: true, native_idle_observed: nativeIdleObserved === true, independent_failure_observed: false, complete_replay_claimed: false,
    traffic_measurement_claimed: false, auth_http_may_precede: true, stateless_generate_covered: false, cleanup_confirmed: false };
}

export function validateNativeStore(message, history, inbox, template) {
  const projection = inspectNativeUserArtifact(message?.data, template);
  if (!Array.isArray(history?.data) || !Array.isArray(inbox?.data) || inbox.data.length || history.data.length < 1 || history.data.length > 3 ||
      history.data.filter(item => item.type === 'user').length !== 1 || history.data.filter(item => item.type === 'agent-switched').length > 1 ||
      history.data.filter(item => item.type === 'assistant').length > 1 || new Set(history.data.map(item => item.id)).size !== history.data.length) fail('native_store_history_rejected');
  const user = history.data.find(item => item.type === 'user');
  if (!same(inspectNativeUserArtifact(user, template), projection)) fail('native_store_user_rejected');
  // A running empty assistant placeholder is not model-facing conversation history.
  for (const item of history.data.filter(item => item.type !== 'user')) {
    // Installed SessionMessage.AgentSelected (session-message.js:33-38), emitted
    // by the explicit CLI --agent selection. This is not model-facing history:
    // the guard still requires exactly the authorized single user message.
    if (item.type === 'agent-switched') {
      if (!nativeMessageID(item.id) || item.agent !== AGENT || item.previous !== AGENT ||
          Object.keys(item).some(key => !['id', 'type', 'time', 'metadata', 'agent', 'previous'].includes(key)) ||
          (item.metadata !== undefined && !same(item.metadata, {})) || !same(Object.keys(item.time ?? {}), ['created']) || !Number.isFinite(item.time.created) ||
          history.data.indexOf(item) > history.data.indexOf(user)) fail('native_store_agent_selection_rejected');
      continue;
    }
    if (item.type !== 'assistant' || !nativeMessageID(item.id) || item.id === template.messageID ||
        Object.keys(item).some(key => !['id', 'type', 'time', 'metadata', 'agent', 'model', 'content'].includes(key)) ||
        item.agent !== AGENT || !same(item.model, MODEL_REF) || !same(item.content, []) || history.data.indexOf(item) < history.data.indexOf(user) ||
        (item.metadata !== undefined && !same(item.metadata, {})) || !same(Object.keys(item.time ?? {}), ['created']) || !Number.isFinite(item.time.created)) fail('native_store_placeholder_rejected');
  }
  return projection;
}

export function validateBuiltinRegistry(registry, cliHash) {
  // This file is an independent review artifact, NEVER generated from observed IDs.
  const fields = ['schema', 'scope', 'version', 'cli_sha256', 'cli_hash_independently_checked_by_parent', 'source_commit', 'source_tree',
    'source_urls', 'builtin_ids', 'classification', 'identity_fragment_template', 'identity_fragment_order', 'catalog_display_name_source',
    'dispatch_scope', 'input_repair', 'can_authorize_model_run'];
  if (!registry || registry.schema !== 'real-use-cli-provenance/v1' || registry.version !== '2.0.29' ||
      hash(registry) !== APPROVED_PROVENANCE_SHA256 ||
      !same(Object.keys(registry).sort(), fields.sort()) || registry.cli_sha256 !== cliHash ||
      registry.cli_hash_independently_checked_by_parent !== true || registry.can_authorize_model_run !== false ||
      registry.source_commit !== '042d0832f5f3a73eaa039a58a7d565776f6d4290' || registry.source_tree !== '6561fbef5ec3ba5c3a83082f086c78015424cfd9' ||
      !Array.isArray(registry.source_urls) || registry.source_urls.length !== 5 ||
      registry.source_urls.some(url => typeof url !== 'string' || !url.startsWith('https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/')) ||
      registry.identity_fragment_template !== MODEL_IDENTITY_TEMPLATE ||
      !Array.isArray(registry.builtin_ids) || registry.builtin_ids.length !== 88 || new Set(registry.builtin_ids).size !== 88 ||
      registry.builtin_ids.some(id => typeof id !== 'string' || !/^opencode\.[a-z0-9.-]+$/.test(id))) fail('approved_builtin_provenance_required');
  return registry;
}

const builtinRecords = registry => registry.builtin_ids.map(id => ({ id, source_type: 'builtin', source_sha256: registry.cli_sha256 }));

function builtinRegistry(cliHash) {
  let bytes;
  try { bytes = readFileSync(new URL('./cli-builtins.json', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (bytes.length > 65536) fail('approved_builtin_provenance_required');
  let value;
  try { value = JSON.parse(bytes); } catch { fail('approved_builtin_provenance_required'); }
  return validateBuiltinRegistry(value, cliHash);
}

export function contextSubmissionGate(startup, stage, registry) {
  if (!registry) fail('approved_builtin_registry_missing');
  validateBuiltinRegistry(registry, stage.cli.sha256);
  if (!stage.operator || !stage.bindings.requestTemplate || !stage.contextPreflight) fail('context_preflight_configuration_required');
  if (!startup.config_audit?.passed || !startup.startup_audit?.inventory_passed || !startup.startup_audit.backend_available ||
      startup.startup_audit.runtime_evidence?.admission !== 'not_assessed' || startup.startup_audit.production_admission !== false ||
      startup.startup_audit.dispatch_proof !== DISPATCH_PROOF || startup.model_metadata?.exact_model_present !== true ||
      !same(stage.bindings.approvedPlugins.filter(item => item.source_type === 'builtin').sort((a, b) => a.id.localeCompare(b.id)),
        builtinRecords(registry).sort((a, b) => a.id.localeCompare(b.id)))) fail('context_startup_not_approved');
  if (stage.config.warming !== false || stage.config.compaction?.auto !== false) fail('auxiliary_requests_not_disabled');
  return true;
}

// Names from the installed 2.0.29 SessionEvent schema; no raw unknown type values.
const LOG_TYPES = new Set(('created agent.selected model.selected moved renamed metadata.updated permissions viewed message.content.updated usage.recorded usage.updated deleted forked inbox.delivered inbox.enqueued inbox.cancelled inbox.delivery.changed execution.started execution.succeeded execution.failed execution.interrupted instructions.updated synthetic skill.activated shell.started shell.ended step.started step.streamed step.ended step.failed text.started text.delta text.ended reasoning.started reasoning.delta reasoning.ended tool.input.started tool.input.delta tool.input.ended tool.called tool.progress tool.success tool.failed retry.scheduled compaction.started compaction.delta compaction.ended compaction.failed revert.staged revert.cleared revert.committed').split(' ').map(name => `session.${name}`));
const logReject = (diagnostic, reason, code = 'malformed_session_log') => {
  diagnostic.rejection_reason = reason;
  fail(code);
};
export function checkLogTransport(status, contentType, diagnostic) {
  diagnostic.http_status = status;
  diagnostic.content_type = typeof contentType !== 'string' ? 'missing' :
    contentType.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream' ? 'event-stream' : 'other';
  diagnostic.byte_count = 0;
  diagnostic.frame_count = 0;
  diagnostic.events = [];
  diagnostic.rejection_reason = null;
  if (status !== 200) logReject(diagnostic, 'http_status', 'session_log_http_rejected');
  if (diagnostic.content_type !== 'event-stream') logReject(diagnostic, 'content_type', 'session_log_content_type_rejected');
}

export function summarizeSessionLog(text, sessionID, diagnostic = {}, after = -1) {
  const counts = {}, forbidden = [], maxEvents = 256;
  diagnostic.byte_count = Buffer.byteLength(text);
  diagnostic.events = [];
  diagnostic.rejection_reason = null;
  if (diagnostic.byte_count > MAX_RESPONSE) logReject(diagnostic, 'byte_limit', 'session_log_limit');
  // SSE line endings include CR alone; strip at most one initial BOM and one
  // optional space after the field colon. EOF is NOT a dispatching blank line.
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n').split('\n\n');
  const unfinished = blocks.pop();
  const frames = blocks.map(block => block.split('\n').filter(line => line === 'data' || line.startsWith('data:'))
    .map(line => line === 'data' ? '' : line.slice(5).replace(/^ /, '')).join('\n')).filter(data => data.length);
  diagnostic.frame_count = frames.length;
  if (frames.length > maxEvents) logReject(diagnostic, 'frame_limit', 'session_log_limit');
  const events = [];
  let previous = after;
  for (const data of frames) {
    let event;
    try { event = JSON.parse(data); } catch {
      diagnostic.events.push({ json_parse_failed: true, byte_count: Buffer.byteLength(data), sha256: hash(data) });
      logReject(diagnostic, 'json_parse');
    }
    const boundary = event?.type === 'log.synced';
    const safeSeq = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    diagnostic.events.push({ outer: diagnosticShape(event), event_type: boundary ? 'log.synced' : LOG_TYPES.has(event?.type) ? event.type : 'unrecognized',
      durable_seq: safeSeq(event?.durable?.seq), previous_seq: previous, synced_seq: safeSeq(event?.seq),
      aggregate_matches: (boundary ? event?.aggregateID : event?.durable?.aggregateID) === sessionID,
      error_type: ['unknown', 'UnknownError', 'AuthenticationError', 'APIError'].includes(event?.data?.error?.type) ? event.data.error.type : 'unrecognized',
      guard_marker_present: typeof event?.data?.error?.message === 'string' && event.data.error.message.includes('real_use_audit_only_dispatch_blocked') });
    if (!boundary) previous = safeSeq(event?.durable?.seq);
    events.push(event);
  }
  if (unfinished && /(?:^|\n)data(?::|$)/.test(unfinished)) logReject(diagnostic, 'unterminated_frame');
  let seq = after, synced = false, guardError = false, failure = false, authenticationFailure = false;
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) logReject(diagnostic, 'outer_shape');
    if (event.type === 'log.synced') {
      if (event.aggregateID !== sessionID) logReject(diagnostic, 'boundary_aggregate');
      if (synced) logReject(diagnostic, 'duplicate_boundary');
      if (event.seq === undefined ? seq !== -1 : !Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq < seq) logReject(diagnostic, 'boundary_watermark');
      synced = true; continue;
    }
    if (synced) logReject(diagnostic, 'event_after_boundary');
    if (!LOG_TYPES.has(event.type)) logReject(diagnostic, 'unsupported_event_type');
    if (event.durable?.aggregateID !== sessionID) logReject(diagnostic, 'event_aggregate');
    if (!Number.isSafeInteger(event.durable.seq) || event.durable.seq < 0) logReject(diagnostic, 'sequence_type');
    // Pinned bus: first sequence is zero; non-persisted/filtered payloads leave gaps.
    if (event.durable.seq <= seq) logReject(diagnostic, 'sequence_reorder');
    seq = event.durable.seq;
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    if (/^session\.(?:usage\.|text\.|reasoning\.|tool\.|step\.(?:streamed|ended)$|execution\.succeeded$)/.test(event.type)) forbidden.push(event.type);
    if (['session.step.failed', 'session.execution.failed'].includes(event.type)) {
      failure = true;
      guardError ||= typeof event.data?.error?.message === 'string' && event.data.error.message.includes('real_use_audit_only_dispatch_blocked');
      authenticationFailure ||= [401, 403].includes(event.data?.error?.status) || /auth|credential/i.test(event.data?.error?.type ?? '');
    }
  }
  if (!synced) logReject(diagnostic, 'missing_boundary', 'session_log_incomplete');
  return { complete: true, evidence_scope: 'historical-retained-payload-only', abort_evidence: 'insufficient_retained_payload',
    event_counts: counts, usage_events: (counts['session.usage.recorded'] ?? 0) + (counts['session.usage.updated'] ?? 0),
    forbidden_inference_events: forbidden.length, execution_failed: failure, guard_error_observed: guardError,
    authentication_failure_observed: authenticationFailure };
}

// Incremental SSE framing shared by the live monitor and chunk-boundary tests.
// Raw frame text is discarded immediately after projecting the bounded evidence.
export function createSSEDecoder(onEvent, diagnostic, { maxBytes = MAX_RESPONSE, maxFrames = 256, maxFrameBytes = MAX_RESPONSE } = {}) {
  let line = '', data = [], skipLF = false, first = true, bytes = 0, frames = 0, frameBytes = 0;
  const endLine = () => {
    if (!line) {
      if (data.length) {
        const text = data.join('\n'); data = [];
        if (++frames > maxFrames) logReject(diagnostic, 'frame_limit', 'session_log_limit');
        diagnostic.frame_count = frames;
        let event;
        try { event = JSON.parse(text); } catch {
          diagnostic.json_failure = { byte_count: Buffer.byteLength(text), sha256: hash(text) };
          logReject(diagnostic, 'json_parse');
        }
        onEvent(event);
      }
      frameBytes = 0;
    } else if (line === 'data' || line.startsWith('data:')) {
      frameBytes += Buffer.byteLength(line);
      if (frameBytes > maxFrameBytes) logReject(diagnostic, 'byte_limit', 'session_log_limit');
      data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
    }
    line = '';
  };
  return {
    push(text) {
      bytes += Buffer.byteLength(text); diagnostic.byte_count = bytes;
      if (bytes > maxBytes) logReject(diagnostic, 'byte_limit', 'session_log_limit');
      for (const character of text) {
        if (first) { first = false; if (character === '\uFEFF') continue; }
        if (skipLF) { skipLF = false; if (character === '\n') continue; }
        if (character === '\r') { endLine(); skipLF = true; }
        else if (character === '\n') endLine();
        else { line += character; if (line.length > maxFrameBytes) logReject(diagnostic, 'byte_limit', 'session_log_limit'); }
      }
    },
    finish() { if (line.length || data.length) logReject(diagnostic, 'unterminated_frame'); },
  };
}

export function createLiveCapture(sessionID, messageID, diagnostic = {}) {
  let cursor = -1;
  const summary = { evidence_scope: 'owned-live-monitor-before-prompt', initial_sync: false, baseline_watermark: null,
    submission_started: false, bound_message_event: false, terminal_guard_failure: false, event_counts: {},
    usage_events: 0, forbidden_inference_events: 0, historical_replay_claimed: false, owned_monitor_end: 'open' };
  diagnostic.events = [];
  return {
    get summary() { return structuredClone(summary); },
    submitted() {
      if (!summary.initial_sync || summary.submission_started) fail('session_log_monitor_not_ready');
      summary.submission_started = true;
    },
    accept(event) {
      if (diagnostic.events.length >= 256) logReject(diagnostic, 'frame_limit', 'session_log_limit');
      const boundary = event?.type === 'log.synced';
      const known = LOG_TYPES.has(event?.type);
      const seq = boundary ? event.seq : event?.durable?.seq;
      const scopeMatches = (boundary ? event?.aggregateID : event?.durable?.aggregateID) === sessionID;
      const dataScope = event?.data?.sessionID === sessionID;
      const marker = typeof event?.data?.error?.message === 'string' && event.data.error.message.includes('real_use_audit_only_dispatch_blocked');
      const messageMatches = event?.data?.inboxID === messageID;
      diagnostic.events.push({ event_type: boundary ? 'log.synced' : known ? event.type : 'unrecognized',
        seq: Number.isSafeInteger(seq) && seq >= 0 ? seq : null, previous_seq: cursor,
        aggregate_matches: scopeMatches, data_session_matches: dataScope, message_matches: messageMatches,
        guard_marker_present: marker, phase: summary.initial_sync ? 'live' : 'initial-replay' });
      if (!event || typeof event !== 'object' || Array.isArray(event)) logReject(diagnostic, 'outer_shape');
      if (!scopeMatches) logReject(diagnostic, 'event_aggregate');
      if (boundary) {
        if (summary.initial_sync) logReject(diagnostic, 'duplicate_boundary');
        if (seq === undefined ? cursor !== -1 : !Number.isSafeInteger(seq) || seq < 0 || seq < cursor) logReject(diagnostic, 'boundary_watermark');
        cursor = seq ?? -1; summary.baseline_watermark = seq ?? null; summary.initial_sync = true;
        return 'ready';
      }
      if (!known) logReject(diagnostic, 'unsupported_event_type');
      if (!Number.isSafeInteger(seq) || seq < 0 || seq <= cursor) logReject(diagnostic, 'sequence_reorder');
      cursor = seq;
      if (!dataScope) logReject(diagnostic, 'data_session_mismatch');
      if (!summary.initial_sync) return 'historical'; // Never count replay as live abort evidence.
      if (!summary.submission_started) logReject(diagnostic, 'event_before_submission');
      if (summary.terminal_guard_failure) logReject(diagnostic, 'event_after_terminal');
      summary.event_counts[event.type] = (summary.event_counts[event.type] ?? 0) + 1;
      if (/^session\.usage\./.test(event.type)) summary.usage_events++;
      if (/^session\.(?:usage\.|text\.|reasoning\.|tool\.|shell\.|compaction\.|retry\.|step\.(?:streamed|ended)$|execution\.succeeded$)/.test(event.type)) {
        summary.forbidden_inference_events++;
        logReject(diagnostic, 'forbidden_live_event');
      }
      if (['session.inbox.enqueued', 'session.inbox.delivered'].includes(event.type)) {
        if (!messageMatches) logReject(diagnostic, 'message_binding');
        summary.bound_message_event = true;
      }
      if (event.type === 'session.execution.failed') {
        if (!marker) logReject(diagnostic, 'terminal_not_guard_failure');
        if (!summary.bound_message_event) logReject(diagnostic, 'missing_bound_message');
        summary.terminal_guard_failure = true;
        return 'terminal';
      }
      return 'live';
    },
    end(verified) {
      if (verified && (!summary.initial_sync || !summary.submission_started || !summary.terminal_guard_failure ||
          !summary.bound_message_event || summary.usage_events || summary.forbidden_inference_events)) fail('session_log_live_evidence_incomplete');
      summary.owned_monitor_end = verified ? 'intentional-after-terminal-wait-rpc' : 'intentional-unverified-cleanup';
      return structuredClone(summary);
    },
  };
}

export async function monitorSessionLog(fetchResponse, sessionID, messageID, diagnostic, timeoutMs = 30000) {
  const controller = new AbortController();
  const capture = createLiveCapture(sessionID, messageID, diagnostic);
  let resolveReady, rejectReady, resolveTerminal, rejectTerminal, reader, stopping = false, failure;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const terminal = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
  // Rejections may precede the caller awaiting the terminal promise.
  void ready.catch(() => {}); void terminal.catch(() => {});
  const reject = error => { failure = error; diagnostic.monitor_failure = error.message; rejectReady(error); rejectTerminal(error); };
  const timer = setTimeout(() => { reject(new Error('session_log_live_timeout')); controller.abort(); }, timeoutMs);
  const pump = (async () => {
    try {
      const response = await fetchResponse(controller.signal);
      checkLogTransport(response.status, response.headers.get('Content-Type'), diagnostic);
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const parser = createSSEDecoder(event => {
        const state = capture.accept(event);
        if (state === 'ready') resolveReady();
        if (state === 'terminal') resolveTerminal();
      }, diagnostic);
      while (!stopping) {
        const { value, done } = await reader.read();
        if (done) {
          if (stopping) break;
          parser.push(decoder.decode()); parser.finish();
          fail('session_log_live_unexpected_eof');
        }
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!stopping) reject(new Error(/^(?:session_log_|malformed_session_log)[a-z0-9_]*$/.test(error.message) ? error.message : 'session_log_live_transport_failed'));
    }
  })();
  const close = async verified => {
    stopping = true; clearTimeout(timer); controller.abort();
    try { await reader?.cancel(); } catch { /* Owned monitor only; never interrupt the Session. */ }
    await pump;
    if (verified && failure) throw failure;
    return capture.end(verified);
  };
  try { await ready; } catch (error) { await close(false); throw error; }
  return { submitted: () => capture.submitted(), terminal, close, snapshot: () => capture.summary };
}

async function collectContextAudit(stage, owned, startup, nativeCLI = false) {
  const result = { schema: 'real-use-context-audit/v1', status: 'blocked', submission_attempted: false,
    session_creation_attempted: false, session_bound: false,
    production_admission: false, auth_http_may_precede: true, stateless_generate_covered: false,
    serialized_http_observed: false, session_inference_aborted: null, request_audit: null, log_summary: null, log_diagnostic: {}, blocker: null,
    effective_variant: MODEL_REF.variant, variant_choice: VARIANT_CHOICE, control: nativeCLI ? 'native-cli-mid-binding-abort' : 'direct-guard-abort' };
  let cli, base;
  try {
    contextSubmissionGate(startup, stage, builtinRegistry(stage.cli.sha256));
    result.builtin_provenance_sha256 = APPROVED_PROVENANCE_SHA256;
    let template = withModelIdentity(stage.bindings.requestTemplate, startup.model_metadata.catalog_display_name);
    result.template_sha256 = hash(template);
    result.catalog_identity_sha256 = hash(template.system[1].text);
    base = await owned.ready;
    // Values are compared with independently staged values, never learned by accepting
    // arbitrary context text. Fresh owned workspace has no repository/instruction files.
    const location = await owned.json(base, '/api/location');
    if (location?.directory !== stage.cwd || location.project?.directory !== stage.cwd ||
        location.project?.canonical !== stage.cwd || !lstatSync(stage.contextPreflight.nativeTmp).isDirectory() ||
        template.local_date !== new Date().toDateString()) fail('context_environment_preflight_failed');
    const sessionID = template.sessionID;
    const started = Date.now();
    result.session_creation_attempted = true;
    const created = await owned.json(base, '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id: sessionID, title: TITLE, agent: AGENT, model: MODEL_REF,
      // Inherit the audited agent's schema-selection policy. The runtime evaluate
      // hook independently denies every invocation, including these approved tools.
      location: { directory: stage.cwd },
    }) });
    if (created?.data?.id !== sessionID || created.data.parentID !== undefined || created.data.location?.directory !== stage.cwd ||
        !Number.isFinite(created.data.time?.created) || created.data.time.created < started) fail('fresh_session_binding_failed');
    result.session_bound = true;
    const history = await owned.json(base, `/api/session/${sessionID}/context`);
    if (!Array.isArray(history?.data) || history.data.length !== 0) fail('fresh_session_history_not_empty');
    const inbox = await owned.json(base, `/api/session/${sessionID}/inbox`);
    if (!Array.isArray(inbox?.data) || inbox.data.length !== 0) fail('fresh_session_inbox_not_empty');
    const incarnation = startup.startup_audit.incarnation, invocation = randomUUID();
    const rpc = (method, input) => owned.json(base, `/api/rpc/${RPC_ID}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
    const binding = await owned.json(base, `/api/rpc/${RPC_ID}/bindContext`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { nonce: stage.bindings.nonce, incarnation, mode: nativeCLI ? 'native-cli' : 'direct', invocation_token: invocation,
        template_sha256: hash(template), catalog_display_name: startup.model_metadata.catalog_display_name } }) });
    if (!same(binding, { output: { bound: true, incarnation, binding_sha256: hash(guardBinding(stage.bindings, incarnation, template)), template_sha256: hash(template), production_admission: false } })) fail('context_binding_failed');
    if (template.local_date !== new Date().toDateString()) fail('context_date_changed');
    result.submission_attempted = true;
    if (nativeCLI) {
      cli = owned.launchCLI(base, sessionID, template.messages[0].content[0].text);
      let pending;
      const deadline = Date.now() + 15000;
      do {
        const response = await rpc('pending', { nonce: stage.bindings.nonce, incarnation });
        if (!response?.output || response.output.incarnation !== incarnation || !['armed-native-cli-binding', 'pending-first-context'].includes(response.output.state)) fail('native_pending_state_rejected');
        pending = response.output.pending;
        if (pending) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      if (!pending || !same(Object.keys(pending).sort(), ['message_id', 'session_sha256', 'request_ordinal', 'digest', 'template_sha256'].sort()) ||
          !nativeMessageID(pending.message_id) || pending.request_ordinal !== 1 || pending.session_sha256 !== hash(sessionID) || !/^[a-f0-9]{64}$/.test(pending.digest)) fail('native_pending_binding_unavailable');
      template = withNativeMessage(template, pending.message_id);
      if (pending.template_sha256 !== hash(template)) fail('native_pending_template_rejected');
      const message = await owned.json(base, `/api/session/${sessionID}/message/${template.messageID}`);
      const nativeHistory = await owned.json(base, `/api/session/${sessionID}/context`);
      const nativeInbox = await owned.json(base, `/api/session/${sessionID}/inbox`);
      result.native_store_diagnostic = { message: diagnosticShape(message?.data), history: Array.isArray(nativeHistory?.data) ?
        nativeHistory.data.slice(0, 8).map(item => ({ type: ['user', 'assistant', 'system', 'synthetic', 'idle'].includes(item.type) ? item.type : 'unexpected', shape: diagnosticShape(item) })) : null,
        inbox_count: Array.isArray(nativeInbox?.data) ? nativeInbox.data.length : null };
      const projection = validateNativeStore(message, nativeHistory, nativeInbox, template);
      result.native_artifact = { message_sha256: hash(template.messageID), projection_sha256: hash(projection), scoped_user_verified: true,
        history_count: nativeHistory.data.length, inbox_count: nativeInbox.data.length, request_ordinal: 1, pending_digest: pending.digest,
        empty_files_only: message.data.files === undefined || same(message.data.files, []),
        locked_agent_selection_count: nativeHistory.data.filter(item => item.type === 'agent-switched').length };
      const released = await rpc('bindLiveMessage', { nonce: stage.bindings.nonce, incarnation, episode_id: stage.bindings.condition,
        session_id: sessionID, message_id: template.messageID, prompt_sha256: template.prompt_sha256, invocation_token: invocation,
        digest: pending.digest, store_projection: projection });
      if (!same(released, { output: { accepted: true, production_admission: false, incarnation, message_sha256: hash(template.messageID) } })) fail('native_message_binding_rejected');
      result.template_sha256 = hash(template);
    } else {
      const submitted = await owned.json(base, `/api/session/${sessionID}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: template.messageID, text: template.messages[0].content[0].text, metadata: {}, resume: true }) });
      if (submitted?.data?.id !== template.messageID || submitted.data.sessionID !== sessionID) fail('prompt_message_binding_failed');
    }
    let observed;
    const abortDeadline = Date.now() + 15000;
    do {
      observed = validateAuditEnvelope(await rpc('audit', { nonce: stage.bindings.nonce }), stage, 'context');
      if (observed.abort_count || observed.guard_state === 'revoked') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < abortDeadline);
    verifyAbortCertificate(observed, stage, template, incarnation);
    result.abort_observed_before_wait = true;
    await owned.json(base, `/api/experimental/session/${sessionID}/wait`, { method: 'POST' });
    const envelope = await owned.json(base, `/api/rpc/${RPC_ID}/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { nonce: stage.bindings.nonce } }) });
    const audit = validateAuditEnvelope(envelope, stage, 'context');
    result.request_audit = { requests: audit.requests, last_request: audit.last_request, guard_counts: audit.guard_counts, dispatch_proof: audit.dispatch_proof,
      incarnation: audit.incarnation, abort_count: audit.abort_count, abort_record: audit.abort_record, guard_state: audit.guard_state };
    result.native_wait_completed = true;
    if (audit.requests !== 1) fail('infrastructure_blocked_before_context');
    if (!audit.inventory_passed || audit.last_request.reasons.length || audit.last_request.session_sha256 !== hash(sessionID)) fail('context_template_mismatch');
    if (Object.entries(audit.guard_counts).some(([name, count]) => count !== (name === 'context' ? 1 : 0))) fail('context_abort_evidence_incomplete');
    result.certificate = verifyAbortCertificate(audit, stage, template, incarnation, true);
    result.session_inference_aborted = true;
    result.status = 'trusted-guard-context-audit-passed';
  } catch (error) {
    result.blocker = /^(?:approved_builtin_|context_|native_|fresh_session_|prompt_message_|session_log_|malformed_|authentication_|infrastructure_|local_rpc_)[a-z0-9_]+$/.test(error.message)
      ? error.message : 'context_audit_infrastructure_blocked';
    if (nativeCLI && base) {
      try {
        const final = validateAuditEnvelope(await owned.json(base, `/api/rpc/${RPC_ID}/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: { nonce: stage.bindings.nonce } }) }), stage, 'context');
        result.request_audit = { requests: final.requests, last_request: final.last_request, guard_counts: final.guard_counts,
          incarnation: final.incarnation, abort_count: final.abort_count, abort_record: final.abort_record, guard_state: final.guard_state };
      } catch { result.final_diagnostic_unavailable = true; }
    }
  } finally {
    if (cli) result.cli_control = await cli.close();
    if (result.cli_control && !result.cli_control.cleanup.confirmed) { result.status = 'blocked'; result.blocker = 'native_cli_cleanup_unconfirmed'; }
  }
  return result;
}

export function inspectConfigEntries(entries, stage) {
  if (!Array.isArray(entries)) fail('malformed_config_metadata');
  const owned = file => typeof file === 'string' && path.relative(stage.root, file) !== '..' && !path.relative(stage.root, file).startsWith(`..${path.sep}`) && !path.isAbsolute(path.relative(stage.root, file));
  const expected = structuredClone(stage.config);
  const model = { providerID: MODEL_REF.providerID, model: MODEL_REF.id, variant: MODEL_REF.variant };
  expected.model = model;
  expected.agents['math-eval'].model = model;
  const documents = entries.filter(item => item.type === 'document');
  const native = documents.filter(item => item.path === stage.bindings.configPath);
  const passed = native.length === 1 && same(native[0].info, expected) &&
    documents.every(item => item.path === stage.bindings.configPath || (owned(item.path) && Object.keys(item.info ?? {}).length === 0)) &&
    entries.every(item => item.type === 'document' || (item.type === 'directory' && owned(item.path)));
  return { passed, document_count: documents.length, native_document_matches: native.length === 1 && same(native[0].info, expected),
    // This binds the resolved native documents, not a claim about unobserved core defaults.
    resolved_native_config_sha256: passed ? hash(expected) : null };
}

export function validateAuditEnvelope(body, stage, phase = 'startup') {
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'output')) fail('malformed_rpc_envelope');
  const audit = body.output;
  const keys = ['schema', 'mode', 'production_admission', 'nonce', 'condition', 'project_sha256', 'config_sha256', 'runtime_sha256', 'cli_sha256', 'snapshot_sha256', 'backend_sha256', 'backend_available', 'runtime_evidence', 'runtime_version', 'effective_permissions', 'permission_hook', 'tools', 'plugins', 'reasons', 'inventory_passed', 'requests', 'last_request', 'dispatch_proof', 'guard_counts', 'template_bound', 'auth_http_may_precede', 'stateless_generate_covered', 'incarnation', 'abort_count', 'abort_record', 'guard_state'];
  if (!audit || typeof audit !== 'object' || Array.isArray(audit) || !same(Object.keys(audit).sort(), keys.sort()) || audit.schema !== 'real-use-bridge-audit/v1' || audit.mode !== 'audit-only' || audit.production_admission !== false || audit.permission_hook !== 'deny-all-audit-only' || audit.dispatch_proof !== DISPATCH_PROOF || audit.auth_http_may_precede !== true || audit.stateless_generate_covered !== false) fail('malformed_rpc_audit');
  for (const key of ['nonce', 'condition', 'project_sha256', 'config_sha256', 'runtime_sha256', 'cli_sha256', 'snapshot_sha256']) if (audit[key] !== stage.bindings[key]) fail('audit_binding_mismatch');
  if (!/^[a-f0-9-]{36}$/.test(audit.incarnation ?? '') || ![0, 1].includes(audit.abort_count) ||
      !['audit-only', 'binding', 'armed-direct', 'armed-native-cli-binding', 'pending-first-context', 'bound-abort', 'revoked'].includes(audit.guard_state)) fail('malformed_guard_identity');
  if (audit.abort_count === 0 && audit.abort_record !== null) fail('malformed_abort_record');
  if (audit.abort_count === 1) {
    const record = audit.abort_record;
    const digestFields = ['session_sha256', 'message_sha256', 'prompt_sha256', 'template_sha256', 'model_sha256', 'tool_sha256', 'config_sha256', 'runtime_sha256', 'cli_sha256', 'project_sha256'];
    const fields = ['abort_committed', 'request_ordinal', 'incarnation', 'nonce', 'agent', 'source_graph_sha256', 'snapshot_sha256', ...digestFields];
    if (!record || !same(Object.keys(record).sort(), fields.sort()) || record.abort_committed !== true || record.request_ordinal !== 1 ||
        record.incarnation !== audit.incarnation || record.nonce !== stage.bindings.nonce || record.agent !== AGENT ||
        digestFields.some(key => !/^[a-f0-9]{64}$/.test(record[key])) ||
        ['source_graph_sha256', 'snapshot_sha256'].some(key => record[key] !== null && !/^[a-f0-9]{64}$/.test(record[key]))) fail('malformed_abort_record');
  }
  if (!Array.isArray(audit.tools) || !Array.isArray(audit.plugins) || !Array.isArray(audit.reasons) || audit.reasons.some(reason => typeof reason !== 'string' || !/^[a-z_]+(?::[A-Za-z0-9_./:@-]{1,200})?$/.test(reason))) fail('malformed_rpc_inventory');
  // Nothing copied from arbitrary third-party RPC payloads is trusted for persistence.
  const hookNames = ['context', 'model.request', 'http.request', 'experimental.ws.handshake', 'experimental.ws.send', 'compaction', 'generate', 'title'];
  if (!audit.guard_counts || !same(Object.keys(audit.guard_counts).sort(), hookNames.sort()) ||
      Object.values(audit.guard_counts).some(count => !Number.isSafeInteger(count) || count < 0 || count > 1000) ||
      typeof audit.template_bound !== 'boolean' || audit.guard_counts.context !== audit.requests) fail('malformed_rpc_guard_counts');
  if (phase === 'startup') {
    if (audit.requests !== 0 || audit.last_request !== null || audit.template_bound || audit.abort_count || audit.guard_state !== 'audit-only' || Object.values(audit.guard_counts).some(count => count !== 0)) fail('unexpected_request_during_startup');
  } else if (phase === 'context') {
    if (![0, 1].includes(audit.requests) || !audit.template_bound) fail('malformed_context_audit');
    if (audit.requests === 0 && audit.last_request !== null) fail('malformed_context_audit');
    if (audit.requests === 1) {
      const r = audit.last_request;
      const fields = ['agent', 'model_matches', 'model_diagnostic', 'first_message_diagnostic', 'session_sha256', 'session_matches', 'system_matches', 'history_matches', 'system_part_sha256', 'message_id_sha256', 'tool_schema_sha256', 'tool_names', 'reasons'];
      if (!r || !same(Object.keys(r).sort(), fields.sort()) || ![AGENT, 'unexpected'].includes(r.agent) ||
          ['model_matches', 'session_matches', 'system_matches', 'history_matches'].some(key => typeof r[key] !== 'boolean') ||
          !/^[a-f0-9]{64}$/.test(r.session_sha256 ?? '') ||
          ![r.system_part_sha256, r.message_id_sha256].every(values => Array.isArray(values) && values.length <= 32 && values.every(value => value === null || /^[a-f0-9]{64}$/.test(value))) ||
          !r.tool_schema_sha256 || Object.entries(r.tool_schema_sha256).some(([key, value]) => !/^[A-Za-z0-9_./:@-]{1,200}$/.test(key) || (value !== null && !/^[a-f0-9]{64}$/.test(value))) ||
          !Array.isArray(r.tool_names) || r.tool_names.length > 1000 || r.tool_names.some(name => !/^[A-Za-z0-9_./:@-]{1,200}$/.test(name)) ||
          !Array.isArray(r.reasons) || r.reasons.some(reason => !['agent_mismatch', 'model_mismatch', 'session_mismatch', 'system_template_unapproved', 'history_template_unapproved', 'request_tools_mismatch', 'template_not_bound', 'repeated_context_request'].includes(reason))) fail('malformed_context_audit');
      const d = r.model_diagnostic;
      if (!d || !same(Object.keys(d).sort(), ['shape', 'providerID_equals_expected', 'id_equals_expected', 'variant_is_undefined'].sort()) ||
          !validDiagnosticShape(d.shape) || ['providerID_equals_expected', 'id_equals_expected', 'variant_is_undefined'].some(key => typeof d[key] !== 'boolean')) fail('malformed_context_diagnostic');
      const m = r.first_message_diagnostic;
      if (!m || !same(Object.keys(m).sort(), ['shape', 'metadata_shape', 'content_matches', 'content', 'metadata_empty_or_absent'].sort()) ||
          !validDiagnosticShape(m.shape) || !validDiagnosticShape(m.metadata_shape) || typeof m.content_matches !== 'boolean' || typeof m.metadata_empty_or_absent !== 'boolean' ||
          !Array.isArray(m.content) || m.content.length > 8 || m.content.some(p => !same(Object.keys(p).sort(), ['shape', 'text_sha256', 'difference', 'text_matches', 'text_matches_dash_prefix'].sort()) ||
            !validDiagnosticShape(p.shape) || (p.text_sha256 !== null && !/^[a-f0-9]{64}$/.test(p.text_sha256)) || typeof p.text_matches !== 'boolean' || typeof p.text_matches_dash_prefix !== 'boolean')) fail('malformed_message_diagnostic');
      for (const p of m.content) if (p.difference !== null && (!p.difference || !same(Object.keys(p.difference).sort(), ['observed_length', 'expected_length', 'common_prefix', 'common_suffix', 'expected_is_substring'].sort()) ||
        typeof p.difference.expected_is_substring !== 'boolean' || ['observed_length', 'expected_length', 'common_prefix', 'common_suffix'].some(k => !Number.isSafeInteger(p.difference[k]) || p.difference[k] < 0 || p.difference[k] > 131072))) fail('malformed_message_diagnostic');
    }
  } else fail('invalid_audit_phase');
  if (stage.operator) {
    const evidence = audit.runtime_evidence;
    const fields = ['backend_id', 'image', 'evidence', 'policy_sha256', 'worker_sha256', 'docker_endpoint_sha256', 'owner_sha256',
      'image_inspection_sha256', 'image_inspected', 'admission', 'can_authorize_model_run', 'inventory_sha256', 'source_graph_sha256', 'sources'];
    if (!audit.backend_available || audit.backend_sha256 !== stage.bindings.backend_sha256 || !evidence ||
        !same(Object.keys(evidence).sort(), fields.sort()) || !/^[a-f0-9-]{36}$/.test(evidence.backend_id) ||
        evidence.image !== stage.operator.backend.image || evidence.evidence !== 'local-docker' ||
        evidence.image_inspected !== true || evidence.admission !== 'not_assessed' || evidence.can_authorize_model_run !== false ||
        evidence.owner_sha256 !== hash(stage.operator.backend.owner) || evidence.docker_endpoint_sha256 !== hash(stage.operator.backend.endpoint) ||
        evidence.source_graph_sha256 !== stage.operator.sourceGraphHash || !same(evidence.sources, stage.operator.sources) ||
        ['policy_sha256', 'worker_sha256', 'image_inspection_sha256', 'inventory_sha256'].some(key => !/^[a-f0-9]{64}$/.test(evidence[key]))) fail('audit_backend_evidence_mismatch');
  } else if (audit.backend_available !== false || audit.backend_sha256 !== null || audit.runtime_evidence !== null) fail('unexpected_backend_during_startup');
  for (const tool of audit.tools) {
    if (!same(Object.keys(tool).sort(), ['id', 'name', 'normalized_name', 'schema', 'schema_sha256', 'options', 'matches'].sort()) || !/^[A-Za-z0-9_./:@-]{1,200}$/.test(tool.id) || !/^[A-Za-z0-9_./:@-]{1,200}$/.test(tool.name) || tool.normalized_name !== tool.id || typeof tool.matches !== 'boolean') fail('malformed_rpc_tool');
    if (tool.matches) {
      if (!DEFINITIONS[tool.name] || tool.id !== tool.name || !same(tool.schema, DEFINITIONS[tool.name].input) || tool.schema_sha256 !== hash(tool.schema) || !same(tool.options, { codemode: false, permission: tool.name })) fail('rpc_tool_mismatch');
    } else if (tool.schema !== null || tool.schema_sha256 !== null || tool.options !== null) fail('malformed_rejected_tool');
  }
  for (const plugin of audit.plugins) {
    if (!same(Object.keys(plugin).sort(), ['id', 'source_type', 'source_sha256', 'active', 'approved'].sort()) || !/^[A-Za-z0-9_./:@-]{1,200}$/.test(plugin.id) || !['builtin', 'local', 'sdk', 'package', 'invalid'].includes(plugin.source_type) || (plugin.source_sha256 !== null && !/^[a-f0-9]{64}$/.test(plugin.source_sha256)) || typeof plugin.active !== 'boolean' || typeof plugin.approved !== 'boolean') fail('malformed_rpc_plugin');
    const approved = stage.bindings.approvedPlugins.some(item => item.id === plugin.id && item.source_type === plugin.source_type && item.source_sha256 === plugin.source_sha256);
    if (approved !== plugin.approved) fail('rpc_plugin_approval_mismatch');
  }
  const policyMatches = same(audit.effective_permissions, permissionsFor(audit.condition));
  if (!policyMatches && audit.effective_permissions !== null) fail('malformed_rpc_permissions');
  const pass = audit.reasons.length === 0 && audit.runtime_version === '2.0.29' && policyMatches &&
    same(audit.tools.map(tool => tool.name).sort(), namesFor(audit.condition).sort()) && audit.tools.every(tool => tool.matches) &&
    same(audit.plugins.map(plugin => plugin.id).sort(), stage.bindings.approvedPlugins.map(plugin => plugin.id).sort()) && audit.plugins.every(plugin => plugin.approved && plugin.active);
  if (audit.inventory_passed !== pass) fail('rpc_inventory_verdict_mismatch');
  return structuredClone(audit);
}

export async function cleanupStagedRuntime(stage) {
  if (!stage.operator) return { status: 'not_configured' };
  try { lstatSync(stage.operator.backend.ledgerPath); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'not_created' }; throw error; }
  let stdout = '', bytes = 0;
  const launcher = createOwnedLauncher({ executable: process.execPath,
    args: [path.join(stage.root, 'assets', 'cleanup.mjs')], cwd: stage.cwd, env: stage.env,
    owner: `real-use-cleanup-${stage.bindings.nonce}`, timeoutMs: 60000, tempRoot: path.join(stage.root, 'tmp'),
  }, { onStdout: chunk => { bytes += chunk.length; if (bytes > 16384) throw new Error('cleanup_output_limit'); stdout += chunk.toString('utf8'); },
    onStderr: () => {} });
  const processResult = await launcher.closed;
  let receipt;
  try { receipt = JSON.parse(stdout); } catch { receipt = null; }
  if (processResult.exit_code !== 0 || !processResult.cleanup.confirmed ||
      receipt?.schema !== 'real-use-bridge-backend-cleanup/v1' ||
      !same(Object.keys(receipt).sort(), ['schema', 'status', 'ledger_integrity', 'owned_entries', 'endpoint_sha256', 'source_graph_sha256'].sort()) ||
      !['confirmed_absent', 'unconfirmed'].includes(receipt.status) || !['complete', 'incomplete'].includes(receipt.ledger_integrity) ||
      (receipt.status === 'confirmed_absent' && receipt.ledger_integrity !== 'complete') ||
      !Number.isSafeInteger(receipt.owned_entries) || receipt.owned_entries < 0 || receipt.owned_entries > 200 ||
      receipt.endpoint_sha256 !== hash(stage.operator.backend.endpoint) || receipt.source_graph_sha256 !== stage.operator.sourceGraphHash) {
    return { status: 'unconfirmed', cleanup_process_confirmed: processResult.cleanup.confirmed === true };
  }
  return { ...receipt, cleanup_process_confirmed: true, ownership_sha256: processResult.ownership_sha256 };
}

async function localJSON(baseURL, route, cwd, init = {}, asSSE = false, routeProbe = false, fetchResponse = fetch) {
  const url = new URL(route, baseURL);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.origin !== baseURL || url.username || url.password) fail('nonlocal_rpc_rejected');
  url.searchParams.set('location[directory]', cwd);
  const response = await fetchResponse(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (routeProbe && (!response.ok || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? ''))) {
    void response.body?.cancel().catch(() => {});
    fail(response.ok ? 'route_json_error' : 'route_http_error');
  }
  if (asSSE) {
    try { checkLogTransport(response.status, response.headers.get('Content-Type'), asSSE); }
    catch (error) { await response.body?.cancel(); throw error; }
  }
  if (response.status === 204) return null;
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (asSSE) asSSE.byte_count = length;
    const maximum = route === '/api/model' ? 16 * 1024 * 1024 : /^\/api\/session\/ses_[A-Za-z0-9_-]+\/(?:context|message(?:\/msg_[A-Za-z0-9_-]+|\?[^\r\n]*)?)$/.test(route) ? 4 * 1024 * 1024 : MAX_RESPONSE;
    if (length > maximum) { await reader.cancel(); fail('rpc_response_too_large'); }
    chunks.push(value);
  }
  let body;
  if (asSSE) {
    if (!response.ok) fail(`local_rpc_http_${response.status}`);
    return Buffer.concat(chunks).toString('utf8');
  }
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('malformed_rpc_json'); }
  if (!response.ok) {
    const kind = ['rpc.unavailable', 'rpc.method_not_found', 'rpc.invalid_input', 'rpc.invalid_output', 'rpc.internal'].includes(body?.type) ? `_${body.type.replaceAll('.', '_')}` : '';
    fail(`local_rpc_http_${response.status}${kind}`);
  }
  return body;
}

// Shares the owned JSON transport and its byte/time limits; strict content-type
// checking is additive for this observational probe, not a change to other RPCs.
export function readRouteEnvelopeJSON(base, route, cwd, init = {}, fetchResponse = fetch) {
  return localJSON(base, route, cwd, init, false, true, fetchResponse);
}

const routeObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const routeKeys = value => Object.keys(value).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !/^(?:ses|msg)_/i.test(key)).sort().slice(0, 64);
function projectRouteEnvelope(name, value, sessionID) {
  if (!routeObject(value) || !Object.hasOwn(value, 'data')) fail('route_shape_error');
  if (name === 'session_detail') {
    if (!routeObject(value.data)) fail('route_shape_error');
    return { ok: true, data_keys: routeKeys(value.data) };
  }
  if (!Array.isArray(value.data) || value.data.length > 200) fail('route_shape_error');
  if (name === 'inbox') return { ok: true, data_length: value.data.length };
  const cursorExists = Object.hasOwn(value, 'cursor');
  if (cursorExists && !routeObject(value.cursor)) fail('route_shape_error');
  const nextPresent = cursorExists && Object.hasOwn(value.cursor, 'next');
  if (name === 'message_page') return { ok: true, data_length: value.data.length, cursor_exists: cursorExists,
    cursor_next_present: nextPresent, cursor_keys: cursorExists ? routeKeys(value.cursor) : [] };
  if (value.data.some(row => !routeObject(row) || !Object.hasOwn(row, 'id') || typeof row.id !== 'string' || row.id.length > 256)) fail('route_shape_error');
  return { ok: true, data_length: value.data.length, cursor_next_present: nextPresent,
    foreign_rows: value.data.filter(row => row.id !== sessionID).length };
}
function routeErrorCode(error) {
  try {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.message === 'route_timeout') return 'route_timeout';
    if (['route_http_error', 'route_json_error', 'route_shape_error'].includes(error?.message)) return error.message;
    if (error?.message === 'malformed_rpc_json') return 'route_json_error';
    if (error?.message === 'rpc_response_too_large') return 'route_shape_error';
  } catch { /* No arbitrary error properties escape. */ }
  return 'route_transport_error';
}

// Fixture-shareable data-only primitive. Only the genuine handle supplies the
// private lifecycle scope and owned authenticated reader; this grants no brand.
export function createRouteEnvelopeProbe(readJSON, eligibleSession, timeoutMs = 30000) {
  let used = false;
  return async () => {
    const sessionID = eligibleSession();
    if (typeof sessionID !== 'string' || !/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) fail('live_route_probe_ineligible');
    if (used) fail('live_route_probe_reused');
    used = true;
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('route_timeout'));
    }, Math.min(30000, Math.max(1, timeoutMs))); });
    const routes = { session_detail: `/api/session/${sessionID}`, message_page: `/api/session/${sessionID}/message?order=asc&limit=200`,
      inbox: `/api/session/${sessionID}/inbox`, children: `/api/session?parentID=${encodeURIComponent(sessionID)}&limit=1` };
    try {
      const rows = await Promise.all(Object.entries(routes).map(async ([name, route]) => {
        try {
          const value = await Promise.race([Promise.resolve().then(() => readJSON(route, { method: 'GET', signal: controller.signal })), timeout]);
          return [name, projectRouteEnvelope(name, value, sessionID)];
        } catch (error) { return [name, { ok: false, error_code: routeErrorCode(error) }]; }
      }));
      return freeze(Object.fromEntries(rows));
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

function ownAuditServer(stage, timeoutMs) {
  // Absolute trusted executable, fresh cwd, whitelist env. No shell, no Desktop attachment.
  if (hash(readFileSync(stage.cli.executable)) !== stage.cli.sha256) fail('cli_source_changed');
  // Fresh local RPC authentication, not native provider credentials. The installed
  // 2.0.29 client service-probe contract specifies Basic username "opencode".
  // Never read auth files/service registries or persist/log this generated secret.
  let password = randomBytes(32).toString('hex');
  // Raw native logs may contain endpoint/auth diagnostics. Never persist or print them.
  let window = '', rawBytes = 0;
  let settle;
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    settle = (error, url) => { if (settled) return; settled = true; error ? reject(error) : resolve(url); };
  });
  const capture = bytes => {
    rawBytes += bytes.length;
    window = (window + bytes.toString('utf8')).slice(-8192);
    const match = window.match(/http:\/\/127\.0\.0\.1:(\d{1,5})(?=[/\s\x1b]|$)/);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) settle(null, `http://127.0.0.1:${match[1]}`);
  };
  const launcher = createOwnedLauncher({ executable: stage.cli.executable,
    args: ['serve', '--hostname', '127.0.0.1', '--port', '0'], cwd: stage.cwd,
    env: { ...stage.env, OPENCODE_SERVER_PASSWORD: password }, timeoutMs,
    owner: `real-use-audit-${stage.bindings.nonce}`, tempRoot: path.join(stage.root, 'tmp'),
  }, { onStdout: capture, onStderr: capture });
  const timer = setTimeout(() => settle(new Error('owned_server_timeout')), timeoutMs);
  void launcher.closed.then(result => {
    clearTimeout(timer);
    settle(new Error(result.spawn_error ? 'owned_server_spawn_failed' : 'owned_server_exited_before_ready'));
  });
  return { ready, active: () => launcher.status.phase === 'running', descriptor(base, sessionID, prompt) {
    if (!password || launcher.status.phase !== 'running' || hash(readFileSync(stage.cli.executable)) !== stage.cli.sha256) fail('owned_server_not_active');
    const stdin = nativePromptBytes(prompt);
    // Buffer elements cannot be frozen in Node; the field is non-replaceable,
    // and admission/capture verify its exact bytes and digest before launch.
    return Object.freeze({ executable: stage.cli.executable,
      args: Object.freeze(['run', '--server', base, '--session', sessionID, '--model', `${MODEL}#default`, '--agent', AGENT, '--format', 'json']),
      stdin, stdin_sha256: hash(stdin),
      cwd: stage.cwd, env: freeze({ ...stage.env, OPENCODE_SERVER_PASSWORD: password }), timeoutMs: 300000,
      owner: `real-use-cli-${stage.bindings.nonce}`, tempRoot: path.join(stage.root, 'tmp') });
  }, launchCLI(base, sessionID, prompt) {
    if (hash(readFileSync(stage.cli.executable)) !== stage.cli.sha256) fail('cli_source_changed');
    let stdoutBytes = 0, stderrBytes = 0, buffer = '', invalidJSON = 0, lines = 0;
    const records = [];
    const consume = line => {
      if (!line.trim()) return;
      if (++lines > 256) throw new Error('native_cli_output_limit');
      let value; try { value = JSON.parse(line); } catch { invalidJSON++; return; }
      if (records.length < 16) records.push({ shape: diagnosticShape(value),
        type: ['session', 'error', 'text', 'step_start', 'step_finish', 'tool_use', 'finish'].includes(value?.type) ? value.type : 'unrecognized' });
    };
    const stdin = nativePromptBytes(prompt);
    const child = createOwnedLauncher(Object.freeze({ executable: stage.cli.executable,
      args: Object.freeze(['run', '--server', base, '--session', sessionID, '--model', `${MODEL_REF.providerID}/${MODEL_REF.id}#default`, '--agent', AGENT, '--format', 'json', '--title', TITLE]),
      stdin, stdin_sha256: hash(stdin),
      cwd: stage.cwd, env: freeze({ ...stage.env, OPENCODE_SERVER_PASSWORD: password }), timeoutMs: 30000,
      owner: `real-use-cli-${stage.bindings.nonce}`, tempRoot: path.join(stage.root, 'tmp') }), {
      onStdout: chunk => {
        stdoutBytes += chunk.length; if (stdoutBytes > MAX_RESPONSE) throw new Error('native_cli_output_limit');
        buffer += chunk.toString('utf8');
        let index; while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      },
      onStderr: chunk => { stderrBytes += chunk.length; if (stderrBytes > MAX_RESPONSE) throw new Error('native_cli_output_limit'); },
    });
    let closed;
    return { close: () => closed ??= (async () => {
      let timer;
      const natural = await Promise.race([child.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
      clearTimeout(timer);
      const process = await child.cleanupOwned();
      if (buffer) { try { consume(buffer); } catch { invalidJSON++; } buffer = ''; }
      return { native_cli_invoked: true, model_selector: `${MODEL_REF.providerID}/${MODEL_REF.id}#default`, requested_format: 'json',
        natural_exit_observed: natural, exit_code: process.exit_code, transport: natural ? 'exited' : 'not-exited-within-1500ms-terminated-owned',
        stdout_bytes: stdoutBytes, stderr_bytes_discarded: stderrBytes, json_lines: lines - invalidJSON, invalid_json_lines: invalidJSON,
        records, cleanup: process.cleanup, ownership_sha256: process.ownership_sha256 };
    })() };
  }, json: (base, route, init = {}, routeProbe = false) => localJSON(base, route, stage.cwd, {
    ...init, headers: { ...init.headers, Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  }, false, routeProbe), monitor: (base, sessionID, messageID, diagnostic) => monitorSessionLog(signal => {
    const url = new URL(`/api/experimental/session/${sessionID}/log?follow=true`, base);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.origin !== base || url.username || url.password) fail('nonlocal_rpc_rejected');
    url.searchParams.set('location[directory]', stage.cwd);
    return fetch(url, { signal, redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  }, sessionID, messageID, diagnostic), nativeEvents: (base, correspondence, onFailure) => observeNativeEvents(signal => {
    const url = new URL('/api/event', base);
    url.searchParams.set('location[directory]', stage.cwd);
    return fetch(url, { signal, redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  }, correspondence, onFailure), log: (base, sessionID, diagnostic) => localJSON(base, `/api/experimental/session/${sessionID}/log?follow=false`, stage.cwd, {
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  }, diagnostic), async close() {
    clearTimeout(timer); window = ''; password = '';
    const result = await launcher.cleanupOwned();
    const contained = result.cleanup.confirmed === true && result.ownership.job_assigned === true &&
      result.ownership.kill_on_close === true && result.cleanup.active_processes === 0;
    return { method: result.cleanup.method, pid: result.ownership.pid ?? null,
      helper_pid: result.ownership.helper_pid ?? null, confirmed: result.cleanup.confirmed === true,
      process_tree_containment: contained, active_processes: result.cleanup.active_processes,
      ownership_sha256: result.ownership_sha256, files_removed: result.cleanup.files_removed === true,
      native_log_bytes_discarded: rawBytes };
  } };
}

async function collectStartupAudit(stage, owned) {
  const result = { schema: 'real-use-startup-result/v1', condition: stage.bindings.condition,
    mode: 'audit-only', production_admission: false, startup_audit: null, status: 'blocked',
    prompt_sent: false, provider_http_verified_absent: false,
    blockers: [...(stage.operator ? [] : ['backend_not_integrated']), 'backend_checker_admission_not_granted'], cleanup: null };
  try {
    const base = await owned.ready;
    // Agent resolution settles boot transforms without creating a session/request.
    const agentMetadata = await owned.json(base, '/api/agent');
    if (!Array.isArray(agentMetadata?.data)) fail('malformed_agent_metadata');
    result.agent_ids = agentMetadata.data.map(item => typeof item.id === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(item.id) ? item.id : 'invalid-id');
    const configEntries = await owned.json(base, '/api/config');
    if (!Array.isArray(configEntries)) fail('malformed_config_metadata');
    result.config_audit = inspectConfigEntries(configEntries, stage);
    if (!result.config_audit.passed) result.blockers.push('resolved_native_config_mismatch');
    // Native loader diagnostics contain only safe identifiers/known failure categories.
    let pluginMetadata;
    const settlementDeadline = Date.now() + 30000;
    do {
      pluginMetadata = await owned.json(base, '/api/plugin');
      if (!Array.isArray(pluginMetadata?.data) || pluginMetadata.data.some(item => item.id === 'real-use-audit-guard' || item.state?.status === 'failed')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < settlementDeadline);
    if (!Array.isArray(pluginMetadata?.data)) fail('malformed_plugin_metadata');
    result.loader_inventory = pluginMetadata.data.map(item => ({
      id: typeof item.id === 'string' && /^[A-Za-z0-9_./:@-]{1,200}$/.test(item.id) ? item.id : 'missing-id',
      source_type: ['builtin', 'local', 'package', 'sdk'].includes(item.source?.type) ? item.source.type : 'invalid',
      state: item.state?.status === 'active' ? 'active' : 'failed',
      failure_kind: item.state?.status === 'active' ? null : ['runtime_source_mismatch', 'native_config_source_mismatch', 'invalid_runtime_options', 'invalid_runtime_binding', 'invalid_plugin_registry', 'invalid_nonce', 'frozen_asset_source_mismatch', 'runtime_factory_evidence_mismatch', 'invalid_frozen_backend', 'unknown_eval_image', 'docker_command_failed', 'manifest_hash_mismatch', 'Cannot find package', 'Cannot find module', 'ENOENT', 'SyntaxError'].find(code => String(item.state?.error).includes(code)) ?? 'unclassified-native-loader-failure',
    }));
    const response = await owned.json(base, `/api/rpc/${RPC_ID}/audit`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { nonce: stage.bindings.nonce } }) });
    const audit = validateAuditEnvelope(response, stage);
    result.startup_audit = audit;
    result.blockers.push(...audit.reasons);
    // Read-only metadata routes are intentionally not credential APIs. No catalog fetch.
    // Only presence of the exact route is retained, never provider endpoint/settings data.
    const models = await owned.json(base, '/api/model');
    if (!models || !Array.isArray(models.data)) fail('malformed_model_metadata');
    const selected = models.data.filter(model => model.providerID === 'opencode-go' && model.id === 'deepseek-v4.1-flash');
    const displayName = selected.length === 1 && typeof selected[0].name === 'string' && selected[0].name.length <= 256 &&
      selected[0].name.trim() && !/[\x00-\x1f\x7f]/.test(selected[0].name) ? selected[0].name : null;
    result.model_metadata = { exact_model_present: selected.length === 1, catalog_display_name: displayName,
      ...(isNativeCompletionProfile(stage.bindings.profile_id, stage.bindings.protocol_hash) ? { pricing: projectNativePricing(selected[0]) } : {}) };
    result.status = audit.inventory_passed && result.config_audit.passed ? 'startup-inventory-passed-admission-blocked' : 'startup-inventory-blocked';
  } catch (error) {
    // Only our enumerated error codes; native diagnostics must not leak into output.
    result.blockers.push(/^(?:malformed_|rpc_|audit_|unexpected_|local_rpc_|nonlocal_|owned_server_|cli_source_)[a-z0-9_]+$/.test(error.message) ? error.message : 'startup_audit_failed');
  }
  return result;
}

// Data-only parser. Only the private instance fed by createOwnedLauncher's actual
// stdout and closed promise is consulted by the genuine bridge. No exported
// helper/JSON/observeCapture callback can obtain or mutate that instance.
export function createOwnedCLIObservation({ launch, sessionID, promptSha256, sourceSha256 }) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, invalid = !diagnosticHash(promptSha256) || !diagnosticHash(sourceSha256), closed = false;
  let pending = null, current = null, last = null, reason = null, text = '', textMID = null;
  const ids = new Set(), tools = [], calls = new Set();
  const consume = line => {
    const event = JSON.parse(line), part = event?.part;
    if (!['step_start', 'step_finish', 'text', 'reasoning', 'tool_use'].includes(event?.type) || event.sessionID !== sessionID ||
        !part || !nativeMessageID(part.messageID) || (part.sessionID !== undefined && part.sessionID !== sessionID)) throw new Error();
    if (event.type === 'step_start') {
      if (pending || ids.has(part.messageID) || ids.size >= 200 || (current && reason !== 'tool-calls')) throw new Error();
      ids.add(part.messageID); current = pending = part.messageID; reason = null;
    } else {
      if (part.messageID !== current) throw new Error();
      if (event.type === 'step_finish') {
        if (pending !== current || !['stop', 'tool-calls'].includes(part.reason)) throw new Error();
        pending = null; reason = part.reason;
      } else if (event.type === 'text' || event.type === 'reasoning') {
        if (pending !== current || typeof part.text !== 'string') throw new Error();
        if (event.type === 'text') {
          if (textMID !== current) { text = ''; textMID = current; }
          text += part.text; if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error();
        }
      } else {
        const state = part.state;
        if (calls.has(part.id) || tools.length >= 200 || typeof part.id !== 'string' || !part.id.length || part.id.length > 200 ||
            typeof part.tool !== 'string' || state?.status !== 'completed' || typeof state.output !== 'string' ||
            !state.input || typeof state.input !== 'object' || Array.isArray(state.input)) throw new Error();
        calls.add(part.id); tools.push({ name: part.tool, call_id: part.id, native_assistant_id: current,
          input_sha256: hash(state.input), output_sha256: hash(state.output), status: 'completed' });
      }
    }
    if (event.type !== 'reasoning') last = event.type;
  };
  return Object.freeze({
    push(chunk) {
      if (closed) { invalid = true; return; }
      if (invalid) return;
      try {
        if (!(chunk instanceof Uint8Array)) throw new Error();
        bytes += chunk.byteLength; if (bytes > 128 * 1024 * 1024) throw new Error();
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error(); consume(line);
        }
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error();
      } catch { invalid = true; buffer = ''; text = ''; }
    },
    close(descriptor, result) {
      if (closed) invalid = true;
      closed = true;
      try { buffer += decoder.decode(); } catch { invalid = true; }
      if (descriptor !== launch || buffer.length || result?.exit_code !== 0 || result.timeout || result.spawn_error ||
          result.ownership?.owner !== launch.owner || result.ownership?.job_assigned !== true || result.ownership?.kill_on_close !== true) invalid = true;
      const valid = !invalid && ids.size > 0;
      return freeze({ valid, cli_complete: valid && pending === null && last === 'step_finish' && reason === 'stop',
        session_id: sessionID, prompt_sha256: promptSha256, source_sha256: sourceSha256,
        captured_assistant_message_ids: [...ids], final_text_sha256: hash(text), final_message_id: textMID,
        tool_evidence: structuredClone(tools) });
    },
  });
}

// Exact public session-event.js + session-status-event.js at pinned 042d0832 / 2.0.29.
// Ephemeral observations never advance durable seq, identity, usage or success.
const NATIVE_EPHEMERAL = new Set(['session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta',
  'session.tool.progress', 'session.usage.updated', 'session.compaction.delta', 'session.status', 'session.idle']);
const NATIVE_V2 = new Set(['session.deleted', 'session.forked', 'session.instructions.updated', 'session.tool.success', 'session.tool.failed']);
function validNativeIdleObservation(event) {
  if (!same(Object.keys(event).sort(), ['created', 'data', 'id', 'type'])) return false;
  const d = event.data;
  if (event.type === 'session.idle') return same(Object.keys(d), ['sessionID']);
  return event.type === 'session.status' && same(Object.keys(d).sort(), ['sessionID', 'status']) &&
    d.status && typeof d.status === 'object' && !Array.isArray(d.status) &&
    same(Object.keys(d.status), ['type']) && d.status.type === 'idle';
}
function validNativeEphemeral(event) {
  const d = event.data;
  if (event.durable !== undefined) return false;
  if (event.type === 'session.idle') return true;
  if (event.type === 'session.status') return ['busy', 'idle'].includes(d.status?.type);
  if (event.type === 'session.usage.updated') return Number.isFinite(d.cost) && d.cost >= 0 &&
    [d.tokens?.input, d.tokens?.output, d.tokens?.reasoning, d.tokens?.cache?.read, d.tokens?.cache?.write].every(v => Number.isFinite(v) && v >= 0);
  if (!nativeMessageID(d.assistantMessageID)) return false;
  if (event.type === 'session.tool.progress') return typeof d.id === 'string' && d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata);
  return typeof d.delta === 'string' && (event.type === 'session.tool.input.delta' ? typeof d.id === 'string' : Number.isSafeInteger(d.ordinal) && d.ordinal >= 0);
}

// Fresh native-platform-v1 observations. Exported helpers are data-only and cannot
// mint the private bridge/capability/finalization brands.
export function createNativeCorrespondence({ sessionID, incarnation, promptSha256, createdAt, condition }) {
  let connected = false, closedAt = null, failed = null, observerReason = null, timestampDelta = null, seq = -1, witness = null, observations = 0, ignoredUnknownEvents = 0;
  const ledger = [], eventIDs = new Set(), assistantIDs = new Set();
  const unknownEventTypes = new Set();
  let observerEventType = null;
  const reject = (code, reason = code, delta = null) => {
    failed ??= code;
    if (observerReason === null) { observerReason = diagnosticReason(reason); timestampDelta = diagnosticTimestampDelta(delta); }
    fail(code);
  };
  const rejectRecovery = type => {
    if (observerReason === null && safeUnknownEventType(type)) observerEventType = type;
    reject('native_recovery_or_auxiliary_observed');
  };
  const check = () => { if (failed) fail(failed); };
  return {
    check,
    fail: reject,
    accept(event, receivedAt = Date.now()) {
      check();
      if (event?.type === 'server.connected') { if (connected) reject('native_observer_reconnected'); connected = true; return; }
      // Filter other sessions before inspecting or retaining their data.
      if (event?.data?.sessionID !== sessionID) return;
      if (!connected) reject('native_activity_after_seal', 'native_observer_not_connected');
      if (++observations > 10000) reject('native_event_correspondence_rejected', 'native_observation_cap');
      let bytes;
      try { bytes = Buffer.byteLength(JSON.stringify(event)); }
      catch { reject('native_event_correspondence_rejected', 'native_event_serialization_rejected'); }
      if (bytes > MAX_RESPONSE) reject('native_event_correspondence_rejected', 'native_event_byte_cap');
      const recovery = /^session\.(?:retry\.|compaction\.|shell\.|skill\.|synthetic$|forked$|model\.selected$|location\.|execution\.(?:failed|interrupted)$|step\.failed$|tool\.failed$)/.test(event.type);
      if (!LOG_TYPES.has(event.type) && !NATIVE_EPHEMERAL.has(event.type)) {
        if (unknownEventTypes.size < 8 && safeUnknownEventType(event.type)) unknownEventTypes.add(event.type);
        if ('durable' in event) reject('native_unknown_durable_event');
        // Unknown observations cannot bypass recovery or terminal activity checks.
        if (closedAt !== null) reject('native_activity_after_seal');
        if (recovery) rejectRecovery(event.type);
        if (witness) reject('native_activity_after_success');
        ignoredUnknownEvents++; return;
      }
      if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data))
        reject('native_event_correspondence_rejected', 'native_event_data_rejected');
      if (typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_-]{1,100}$/.test(event.id))
        reject('native_event_correspondence_rejected', 'native_event_id_rejected');
      if (!Number.isFinite(event.created))
        reject('native_event_correspondence_rejected', 'native_event_timestamp_rejected');
      // This delivery-hygiene window is not completion authority: created values
      // still face exact bridge-owned closure and event-derived timing checks.
      // Tolerance prevents false rejects of legitimate deliveries, never admits a
      // different execution or out-of-order durable seq; identity/order stay exact.
      if (event.created < createdAt - 2000)
        reject('native_event_correspondence_rejected', 'native_event_timestamp_before_creation', event.created - createdAt);
      if (event.created > receivedAt + 2000)
        reject('native_event_correspondence_rejected', 'native_event_timestamp_after_receipt', event.created - receivedAt);
      // Only exact source-defined idle observations may trail success or seal.
      // They still consume the bounded observation budget, never durable authority.
      if (validNativeIdleObservation(event)) return;
      // A delayed success may corroborate only the already-bound execution, with
      // a native creation time no later than the immutable host closure.
      if (closedAt !== null && (event.type !== 'session.execution.succeeded' || event.created > closedAt ||
          !ledger.length || ledger.some(row => !row.acknowledged || !row.event || !row.binding))) reject('native_activity_after_seal');
      // Compaction remains disqualifying even when its delta is ephemeral.
      if (recovery ||
          (event.type === 'session.status' && event.data.status?.type === 'retry')) rejectRecovery(event.type);
      if (witness) reject('native_activity_after_success');
      if (NATIVE_EPHEMERAL.has(event.type)) {
        if (!validNativeEphemeral(event)) reject('native_ephemeral_shape_rejected');
        return; // No payload/ID retained and no durable-order/completeness claim.
      }
      if (eventIDs.has(event.id)) reject('native_event_correspondence_rejected', 'native_duplicate_event_id');
      if (eventIDs.size >= 10000) reject('native_event_correspondence_rejected', 'native_event_id_cap');
      if (event.durable?.aggregateID !== sessionID) reject('native_event_correspondence_rejected', 'native_durable_session_rejected');
      if (!Number.isSafeInteger(event.durable.seq) || event.durable.seq <= seq)
        reject('native_event_correspondence_rejected', 'native_durable_sequence_rejected');
      if (event.durable.version !== (NATIVE_V2.has(event.type) ? 2 : 1))
        reject('native_event_correspondence_rejected', 'native_durable_version_rejected');
      eventIDs.add(event.id); seq = event.durable.seq;
      if (event.type === 'session.step.started') {
        const row = ledger.at(-1), data = event.data;
        if (!row || row.event || !nativeMessageID(data.assistantMessageID) || assistantIDs.has(data.assistantMessageID) || data.agent !== AGENT ||
            !same(data.model, MODEL_REF) || event.durable.version !== 1 || !Number.isSafeInteger(data.started) || data.started < createdAt ||
            data.started > event.created || data.started < row.sent_at_ms || event.created < row.sent_at_ms || receivedAt < row.sent_at_ms) reject('native_step_mapping_rejected');
        assistantIDs.add(data.assistantMessageID);
        row.event = freeze({ id: event.id, created: event.created, received_at_ms: receivedAt, seq, version: 1,
          assistant_message_id: data.assistantMessageID, started: data.started, session_sha256: hash(sessionID), model_sha256: hash(data.model) });
      } else if (event.type === 'session.execution.succeeded') {
        const row = ledger.at(-1);
        if (!row?.event || event.durable.version !== 1 || event.created < row.event.created) reject('native_success_witness_rejected');
        witness = freeze({ event_id: event.id, created: event.created, received_at_ms: receivedAt,
          received_after_closure: closedAt !== null && receivedAt > closedAt, seq,
          session_sha256: hash(sessionID), incarnation, prompt_sha256: promptSha256 });
      }
    },
    beginRelease(ordinal, digest) {
      check();
      if (!connected || closedAt !== null || witness || ordinal !== ledger.length + 1 || ledger.length >= 200 || !diagnosticHash(digest) ||
          (ledger.length && (!ledger.at(-1).binding || !ledger.at(-1).settled))) reject('native_release_correspondence_unresolved');
      ledger.push({ ordinal, release_digest: digest, sent_at_ms: Date.now(), acknowledged: false, event: null, binding: null, settled: false });
    },
    acknowledge(ordinal) { check(); const row = ledger.at(-1);
      if (closedAt !== null || !row || row.ordinal !== ordinal || row.acknowledged) reject('native_release_ack_ambiguous'); row.acknowledged = true; },
    pendingLookup() { check(); const row = ledger.at(-1); return closedAt === null && row?.acknowledged && row.event && !row.binding ? structuredClone(row.event) : null; },
    bindAssistant(message) {
      check(); const row = ledger.at(-1);
      if (closedAt !== null || !row?.acknowledged || !row.event || row.binding || message?.id !== row.event.assistant_message_id ||
          message.type !== 'assistant' || message.agent !== AGENT || !same(message.model, MODEL_REF) || message.error !== undefined || message.retry !== undefined ||
          !Number.isFinite(message.time?.created) || message.time.created < row.sent_at_ms || message.time.created > row.event.created ||
          !Array.isArray(message.content) || message.content.length > 256) reject('native_assistant_identity_rejected');
      // Nonempty/already-completed content is valid here: this is a post-release
      // exact-ID lookup, never a placeholder/latest-assistant identity heuristic.
      row.binding = freeze({ ordinal: row.ordinal, release_digest: row.release_digest, event_id: row.event.id,
        event_sha256: hash(row.event), native_assistant_id: message.id, incarnation, session_sha256: hash(sessionID), prompt_sha256: promptSha256,
        model_sha256: hash(message.model), basis: 'post_context_release_step_start', identity_sha256: hash({ id: message.id, agent: message.agent, model: message.model, created: message.time.created }) });
    },
    settleContinuation(message) {
      check(); const row = ledger.at(-1);
      if (!row?.binding || message?.id !== row.binding.native_assistant_id) reject('native_continuation_unbound');
      try { validateSettledNativeToolStep(message, condition); } catch (error) { observerReason ??= diagnosticReason(error); throw error; }
      row.settled = true;
    },
    seal(at = Date.now()) { check(); if (closedAt !== null) reject('native_host_seal_reused'); closedAt = at; return this.snapshot(); },
    eligibleAtClosure(cliComplete) {
      check();
      // Inspection authorization only, never a completion verdict. Unique event
      // and assistant identities were bound by accept/bindAssistant before seal.
      if (!connected || closedAt === null || !ledger.length || ledger.some(row => !row.acknowledged || !row.event || !row.binding))
        reject('native_preclosure_witness_or_binding_missing');
      return true;
    },
    snapshot() { return freeze({ connected, closed_at_ms: closedAt, failure: failed, observer_reason: observerReason,
      observer_event_type: observerEventType, observer_event_types: observerEventType === null ? null : [observerEventType],
      timestamp_delta_ms: timestampDelta,
      unknown_event_types: [...unknownEventTypes], ignored_unknown_events: ignoredUnknownEvents, witness, ledger: structuredClone(ledger),
      bindings: ledger.filter(row => row.binding).map(row => row.binding), last_sequence: seq }); },
  };
}

export function validateSettledNativeToolStep(row, condition) {
  const tools = row?.content?.filter(part => part.type === 'tool');
  if (row?.type !== 'assistant' || row.agent !== AGENT || !same(row.model, MODEL_REF) || row.finish !== 'tool-calls' ||
      row.error !== undefined || row.retry !== undefined || !Number.isFinite(row.time?.completed) || !tools?.length ||
      tools.some(part => !namesFor(condition).includes(part.name) || part.executed === true || part.state?.status !== 'completed' || !Number.isFinite(part.time?.completed))) fail('native_continuation_not_settled_tool_step');
}

export async function observeNativeEvents(fetchResponse, correspondence, onFailure, timeoutMs = 5000) {
  const controller = new AbortController(); let stop = false, reader, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => { rejectReady(new Error('native_observer_connect_timeout')); controller.abort(); }, timeoutMs);
  const pump = (async () => {
    try {
      const response = await fetchResponse(controller.signal);
      checkLogTransport(response.status, response.headers.get('Content-Type'), {});
      reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
      const parser = createSSEDecoder(event => { correspondence.accept(event); if (event?.type === 'server.connected') { clearTimeout(timer); resolveReady(); } }, {},
        { maxBytes: 8 * 1024 * 1024, maxFrames: 10000, maxFrameBytes: MAX_RESPONSE });
      while (!stop) { const { value, done } = await reader.read(); if (done) { parser.push(decoder.decode()); parser.finish(); fail('native_observer_disconnected'); } parser.push(decoder.decode(value, { stream: true })); }
    } catch (error) {
      if (!stop) { rejectReady(new Error('native_observer_failed')); try { correspondence.fail('native_observer_failed', diagnosticReason(error)); } catch {} onFailure(); }
    }
  })();
  const close = async () => { stop = true; clearTimeout(timer); controller.abort(); try { await reader?.cancel(); } catch {} await pump; };
  try { await ready; } catch (error) { await close(); throw error; }
  return { close };
}

export function nativeChildrenRows(value) {
  if (!routeObject(value) || !Array.isArray(value.data)) fail('native_child_scope_rejected');
  // A terminal empty page can carry a next cursor; only returned rows prove children exist.
  return value.data;
}

export async function readNativeMessagePages(fetchPage) {
  const rows = [], ids = new Set(), cursors = new Set(); let cursor, bytes = 0;
  for (let page = 0; page < 4; page++) {
    const value = await fetchPage(cursor === undefined ? '?order=asc&limit=200' : `?limit=200&cursor=${encodeURIComponent(cursor)}`);
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > 4 * 1024 * 1024 || !Array.isArray(value?.data) || value.data.length > 200 || !value.cursor ||
        typeof value.cursor !== 'object' || Array.isArray(value.cursor) ||
        Object.keys(value.cursor).some(key => !['previous', 'next'].includes(key))) fail('native_message_page_rejected');
    // The native API emits a terminal empty page even with cursor.next present.
    // Stop at that sentinel, never follow it into a later populated page. A short
    // interval still fails assistant/interval counts; both planned snapshots must
    // independently validate and be equal, without waiting for future settlement.
    if (value.data.length === 0) return rows;
    for (const row of value.data) { if (!nativeMessageID(row?.id) || ids.has(row.id) || rows.length >= 512) fail('native_message_interval_rejected'); ids.add(row.id); rows.push(row); }
    if (value.cursor.next === undefined) return rows;
    cursor = value.cursor.next;
    if (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096 || cursors.has(cursor)) fail('native_message_cursor_rejected');
    cursors.add(cursor);
  }
  fail('native_message_page_cap');
}

const tokenFields = ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens'];
function nativeAmounts(row) {
  const t = row?.tokens, values = [t?.input, t?.output, t?.reasoning, t?.cache?.read, t?.cache?.write];
  if (!values.every(v => Number.isSafeInteger(v) && v >= 0) || !Number.isFinite(row?.cost) || row.cost < 0) fail('native_recorded_usage_missing');
  return { ...Object.fromEntries(tokenFields.map((key, i) => [key, values[i]])), cost_usd: row.cost };
}
export function projectNativePricing(model) {
  // Tier selection is not guessed. Unsupported/ambiguous configured price tiers
  // fail operationally; only the exact selected model's explicit base rates pass.
  if (model?.providerID !== MODEL_REF.providerID || model.id !== MODEL_REF.id || !Array.isArray(model.cost) || model.cost.length !== 1 || model.cost[0].tier !== undefined) fail('native_pricing_ambiguous');
  const c = model.cost[0], rates = { input: c.input, output: c.output, cache_read: c.cache?.read, cache_write: c.cache?.write };
  if (!Object.values(rates).every(v => Number.isFinite(v) && v >= 0)) fail('native_pricing_missing');
  return freeze({ schema: 'real-use-native-pricing/v1', source: 'owned-selected-model-public-catalog', model_sha256: hash(MODEL_REF), rates });
}
export function nativeRecordedUsage(assistants, aggregate, baseline, pricing) {
  const zero = nativeAmounts(baseline);
  if (Object.values(zero).some(value => value !== 0) || !assistants.length || pricing?.model_sha256 !== hash(MODEL_REF) ||
      !pricing.rates || !Object.values(pricing.rates).every(v => Number.isFinite(v) && v >= 0)) fail('native_usage_baseline_or_pricing_rejected');
  const sum = Object.fromEntries([...tokenFields, 'cost_usd'].map(key => [key, 0]));
  for (const row of assistants) {
    const amount = nativeAmounts(row);
    if (tokenFields.every(key => amount[key] === 0)) fail('native_zero_usage_ambiguous');
    const components = [[amount.input_tokens, pricing.rates.input], [amount.output_tokens + amount.reasoning_tokens, pricing.rates.output],
      [amount.cache_read_tokens, pricing.rates.cache_read], [amount.cache_write_tokens, pricing.rates.cache_write]];
    if (components.some(([tokens, rate]) => tokens > 0 && (!Number.isFinite(rate) || rate < 0))) fail('native_missing_rate_or_zero_ambiguous');
    if (amount.cost_usd === 0 && components.some(([tokens, rate]) => tokens > 0 && rate > 0)) fail('native_zero_cost_ambiguous');
    for (const key of Object.keys(sum)) { sum[key] += amount[key]; if (key === 'cost_usd' ? !Number.isFinite(sum[key]) : !Number.isSafeInteger(sum[key])) fail('native_usage_overflow'); }
  }
  const total = nativeAmounts(aggregate), tolerance = Math.max(1e-12, 1e-9 * Math.max(Math.abs(sum.cost_usd), Math.abs(total.cost_usd)));
  if (tokenFields.some(key => sum[key] !== total[key]) || Math.abs(sum.cost_usd - total.cost_usd) > tolerance) fail('native_usage_aggregate_mismatch');
  return freeze({ ...sum, steps: assistants.length, completeness: { status: 'platform_recorded_total', episode_complete: true, scope: 'OpenCode-recorded not billing' } });
}

export function validateNativeCompletionSnapshot({ session, rows, inbox, children }, { template, condition, cwd, correspondence, finalText, capturedAssistantIDs,
  captureToolEvidence, baseline, pricing, cliComplete }) {
  const { closed_at_ms: closedAt, ledger, bindings: bound, witness } = correspondence;
  if (correspondence.connected !== true || correspondence.failure || !Number.isSafeInteger(closedAt) || !ledger.length ||
      ledger.some((row, i) => !row.acknowledged || !row.event || !row.binding || row.ordinal !== i + 1 ||
        row.event.assistant_message_id !== row.binding.native_assistant_id || row.event.id !== row.binding.event_id ||
        row.binding.event_sha256 !== hash(row.event) || !same(row.binding, bound[i]) || (i + 1 < ledger.length && row.settled !== true)) ||
      bound.length !== ledger.length || new Set(bound.map(row => row.native_assistant_id)).size !== ledger.length ||
      new Set(bound.map(row => row.event_id)).size !== ledger.length ||
      (witness && witness.created > closedAt)) fail('native_completion_correspondence_missing');
  if (session?.id !== template.sessionID || session.agent !== AGENT || !same(session.model, MODEL_REF) || session.title !== TITLE ||
      !same(session.location, { directory: cwd }) || session.parentID !== undefined || session.fork !== undefined || session.revert !== undefined || session.subpath !== undefined ||
      (session.metadata !== undefined && !same(session.metadata, {})) || (session.permissions !== undefined && !same(session.permissions, [])) ||
      session.outcome !== 'succeeded' || !Number.isFinite(session.time?.idle) || session.time.idle > closedAt ||
      session.time.created !== baseline?.time?.created ||
      !Array.isArray(inbox) || inbox.length || !Array.isArray(children) || children.length) fail('native_session_completion_rejected');
  projectNativeHistory(rows, template, condition);
  const users = rows.filter(row => row.type === 'user'), assistants = rows.filter(row => row.type === 'assistant'), idles = rows.filter(row => row.type === 'idle');
  if (users.length !== 1 || assistants.length !== bound.length || idles.length !== 1 || rows.at(-1) !== idles[0] || idles[0].outcome !== 'succeeded' || idles[0].error !== undefined ||
      !Number.isFinite(idles[0].time?.created) || idles[0].time.created !== session.time.idle || session.time.idle < users[0].time.created ||
      users[0].time.created < baseline.time.created || (witness && (witness.created < session.time.idle || witness.created > closedAt)) ||
      assistants.some((row, i) => row.id !== bound[i].native_assistant_id || row.error !== undefined || row.retry !== undefined ||
        hash({ id: row.id, agent: row.agent, model: row.model, created: row.time.created }) !== bound[i].identity_sha256 ||
        row.time.created < users[0].time.created || !Number.isFinite(row.time?.completed) || row.time.completed < row.time.created ||
        row.time.completed < ledger[i].event.started || row.time.completed > closedAt || row.time.completed > session.time.idle ||
        (i + 1 < ledger.length && row.time.completed > ledger[i + 1].event.started))) fail('native_complete_interval_rejected');
  for (const row of assistants.slice(0, -1)) validateSettledNativeToolStep(row, condition);
  const final = assistants.at(-1);
  if (final.finish !== 'stop' || final.content.some(part => part.type === 'tool') || !Array.isArray(capturedAssistantIDs) || !capturedAssistantIDs.length ||
      !same(capturedAssistantIDs, bound.map(row => row.native_assistant_id)) ||
      typeof finalText !== 'string' || !Buffer.from(final.content.filter(part => part.type === 'text').map(part => part.text).join('')).equals(Buffer.from(finalText))) fail('native_final_answer_mismatch');
  const toolEvidence = [];
  for (const row of assistants) for (const part of row.content.filter(part => part.type === 'tool')) {
    if (part.state.status !== 'completed' || part.state.content.length !== 1 || part.state.content[0].type !== 'text' || !Number.isFinite(part.time.completed) ||
        part.time.completed > row.time.completed || part.time.completed < part.time.created) fail('native_tool_completion_rejected');
    toolEvidence.push({ name: part.name, call_id: part.id, native_assistant_id: row.id, input_sha256: hash(part.state.input),
      output_sha256: hash(part.state.content[0].text), status: 'completed' });
  }
  if (toolEvidence.length > 200 || !Array.isArray(captureToolEvidence) || captureToolEvidence.length !== toolEvidence.length) fail('native_cli_tool_correspondence_rejected');
  const key = row => JSON.stringify([row?.call_id, row?.native_assistant_id]);
  const capturedByCall = new Map(captureToolEvidence.map(row => [key(row), row]));
  if (capturedByCall.size !== captureToolEvidence.length || new Set(toolEvidence.map(key)).size !== toolEvidence.length ||
      toolEvidence.some(row => !same(row, capturedByCall.get(key(row))))) fail('native_cli_tool_correspondence_rejected');
  // Keep native invocation order in receipts; CLI arrival order is not execution order.
  const usage = nativeRecordedUsage(assistants, session, baseline, pricing);
  const safeSnapshot = { session_id: session.id, session_sha256: hash({ id: session.id, agent: session.agent, model: session.model, location: session.location,
    outcome: session.outcome, idle: session.time.idle, cost: session.cost, tokens: session.tokens }),
    rows: rows.map(row => ({ id: row.id, type: row.type, sha256: hash(row) })), inbox_count: 0, child_count: 0,
    final_message_id: final.id, final_text_sha256: hash(finalText), idle_at_ms: session.time.idle };
  return freeze({ snapshot: safeSnapshot, native_recorded_usage: usage, tool_evidence: toolEvidence, native_message_id: final.id });
}

// Data-only attribution after corroboration. A late observation remains in the
// correspondence state for contradiction detection, not in timestamped evidence.
export function projectNativeCompletionKind(correspondence, cliComplete, idleAt) {
  const closedAt = correspondence.closed_at_ms;
  const witness = correspondence.witness && (cliComplete || correspondence.witness.received_at_ms <= closedAt)
    ? correspondence.witness : null;
  return freeze({ kind: cliComplete ? 'cli_terminal' : witness ? 'native_preclose_witness' : 'native_timestamped_snapshot',
    timestamp_basis: { closed_at_ms: closedAt, idle_at_ms: idleAt, witness_present: witness !== null },
    witness_sha256: witness ? hash(witness) : null, witness });
}

export async function inspectNativeCompletion(readSnapshot, options, solverDeadline, signal, observe) {
  const progress = (stage, snapshotReadNumber) => { try { observe?.({ stage, snapshotReadNumber }); } catch { /* Diagnostics grant no authority. */ } };
  const budget = Math.min(2000, solverDeadline - Date.now());
  if (budget <= 0 || signal?.aborted) fail('native_inspection_deadline');
  const controller = new AbortController(), until = Date.now() + budget;
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const operation = (async () => {
    progress('snapshot', 1);
    const firstSnapshot = await readSnapshot(combined);
    progress('validation', 1);
    const first = validateNativeCompletionSnapshot(firstSnapshot, options);
    if (Date.now() >= until || combined.aborted) fail('native_inspection_deadline');
    progress('snapshot', 2);
    const secondSnapshot = await readSnapshot(combined);
    progress('validation', 2);
    const second = validateNativeCompletionSnapshot(secondSnapshot, options);
    if (Date.now() >= until || combined.aborted) fail('native_inspection_deadline');
    if (!same(first, second)) fail('native_snapshots_changed');
    return { ...second, native_snapshot_sha256: [hash(first.snapshot), hash(second.snapshot)] };
  })();
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('native_inspection_deadline')); }, budget); })]); }
  finally { clearTimeout(timer); controller.abort(); }
}

// Parent-only lifecycle contract. The returned handle never exposes native RPC
// credentials or a generic HTTP client. Only admission's private capability may
// arm production; descriptors do not start work until capture invokes the factory.
export function startAuditBridge(options) {
  const cli = resolveTrustedExecutable(options.cliPackageDir);
  const registry = builtinRegistry(cli.sha256);
  const stage = stageAudit({ ...options, approvedPlugins: registry ? builtinRecords(registry) : [] });
  const freshPolicy = isNativeCompletionProfile(stage.bindings.profile_id, stage.bindings.protocol_hash);
  const sources = freeze(Object.fromEntries(['bridge.mjs', 'stage.mjs', 'runtime-plugin.js', 'cli-builtins.json'].map(file =>
    [`bench/v4/real-use/${file}`, hash(readFileSync(new URL(file, import.meta.url)))])));
  const diagnostics = createProductionDiagnostics({ ...sources, 'bench/v4/real-use/run.mjs': hash(readFileSync(new URL('run.mjs', import.meta.url))) });
  const diagnosticReceipts = { before_cleanup: null, final: null };
  diagnostics.event('audit');
  const owned = ownAuditServer(stage, 600000);
  const audit = collectStartupAudit(stage, owned);
  let cleanup, contextAudit, contextMode, incarnation = null, startupResult, contextResult;
  let lifecycle = 'audit', sessionID, template, invocation, dispatched = false, launched = false, finished = false;
  let monitor, monitorStop = false, monitorFailure = false, completed = new Map(), boundOrdinal = 0, child, solverClock, cliRevocation;
  let correspondence, nativeObserver, nativeBaseline, nativeSeal, nativeClosedAt, ownedCLIObservation;
  const finalizationState = { stage: 'facts', snapshotReadNumber: 0, evidenceWritten: false };
  let finalizationWrite;
  const recordNativeFailure = error => {
    if (!freshPolicy) return;
    try {
      const snapshot = diagnostics.finalizationFailure(error, { ...finalizationState, closedAt: nativeClosedAt,
        correspondence: correspondence?.snapshot(), cliComplete: ownedCLIObservation?.cli_complete });
      finalizationWrite ??= persistFinalizationDiagnostics(path.join(stage.root, 'finalization-diagnostics.json'), snapshot);
    } catch { /* Best-effort observation must never delay or bypass owned cleanup. */ }
  };
  const started = Date.now();
  void audit.then(result => { startupResult = result; incarnation = result.startup_audit?.incarnation ?? null; });
  const rpc = async (method, input = {}, signal) => {
    try {
    const base = await owned.ready;
    if (method === 'bindEpisodeContext') {
      solverClock.check(true);
      if (cleanup || lifecycle !== 'running' || monitorStop || child.status.phase !== 'running') fail('live_release_after_stop');
    }
    const result = await owned.json(base, `/api/rpc/${RPC_ID}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      ...(method === 'bindEpisodeContext' ? { signal: solverClock.releaseSignal } : signal ? { signal } : {}),
      body: JSON.stringify({ input: { nonce: stage.bindings.nonce, incarnation, ...input } }) });
    if (!result || !same(Object.keys(result), ['output'])) fail('live_rpc_envelope_rejected');
    if (['episodeStatus', 'revokeEpisode', 'sealEpisode'].includes(method)) diagnostics.guard(result.output?.diagnostics);
    return result.output;
    } catch (error) {
      diagnostics.event(method === 'bindEpisodeContext' ? 'bind_rpc' : method === 'episodeStatus' ? 'status_rpc' : 'revoked', diagnosticReason(error),
        method === 'bindEpisodeContext' ? input.ordinal : null);
      throw error;
    }
  };
  const bindings = () => freeze({ schema: ADMISSION_API, active: !cleanup && owned.active(), run_id: stage.bindings.run_id,
    ...(freshPolicy ? { profile_id: stage.bindings.profile_id, protocol_hash: stage.bindings.protocol_hash, registration_sha256: stage.bindings.registration_sha256 } : {}),
    episode_id: stage.bindings.episode_id, condition: stage.bindings.condition, model: MODEL, variant: 'default', nonce: stage.bindings.nonce,
    workspace: stage.cwd, snapshot_sha256: stage.bindings.snapshot_sha256, source_sha256: sources,
    prompt_sha256: stage.bindings.requestTemplate?.prompt_sha256 ?? null,
    startup_audit: startupResult?.status === 'startup-inventory-passed-admission-blocked' ? 'passed' : 'blocked',
    context_abort_audit: contextResult?.status === 'trusted-guard-context-audit-passed' ? 'passed' : 'blocked',
    context_evidence_sha256: contextResult?.status === 'trusted-guard-context-audit-passed' ? hash(contextResult) : null });
  const status = async () => {
    const response = await rpc('episodeStatus');
    const { diagnostics: observationalOnly, ...value } = response ?? {};
    if (!value || !same(Object.keys(value).sort(), ['incarnation', 'purpose', 'phase', 'session_sha256', 'prompt_sha256', 'ordinal', 'released', 'model_requests', 'violations', 'tool_calls', 'active_tools', 'records', 'pending'].sort()) ||
        value.incarnation !== incarnation || value.purpose !== 'production' || value.session_sha256 !== hash(sessionID) ||
        value.prompt_sha256 !== template.prompt_sha256 || value.violations !== 0 || !['armed', 'pending', 'released', 'revoked', ...(freshPolicy ? ['sealed'] : [])].includes(value.phase) ||
        !Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || value.ordinal > 200 || !Array.isArray(value.records)) fail('live_guard_status_rejected');
    return value;
  };
  const inventory = async () => {
    const envelope = await owned.json(await owned.ready, `/api/rpc/${RPC_ID}/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { nonce: stage.bindings.nonce } }) });
    const current = validateAuditEnvelope(envelope, stage, 'context');
    if (!current.inventory_passed || current.incarnation !== incarnation || !same(current.abort_record, contextResult.request_audit.abort_record) ||
        current.guard_state !== 'bound-abort' || current.abort_count !== 1 || current.requests !== 1 ||
        Object.entries(current.guard_counts).some(([key, count]) => count !== (key === 'context' ? 1 : 0))) fail('live_inventory_changed');
  };
  const rejectLifecycle = code => { void handle.cleanup().catch(() => {}); fail(code); };
  const sessionScope = async () => {
    const current = await owned.json(await owned.ready, `/api/session/${sessionID}`);
    const value = current?.data;
    if (!value || value.id !== sessionID || value.parentID !== undefined || value.fork !== undefined || value.agent !== AGENT ||
        !same(value.model, MODEL_REF) || value.title !== TITLE || !same(value.location, { directory: stage.cwd }) ||
        value.revert !== undefined || value.subpath !== undefined || (value.metadata !== undefined && !same(value.metadata, {})) ||
        (value.permissions !== undefined && !same(value.permissions, []))) fail('live_session_scope_changed');
  };
  const nativeHistory = async mid => {
    const base = await owned.ready;
    const message = await owned.json(base, `/api/session/${sessionID}/message/${mid}`);
    const history = await owned.json(base, `/api/session/${sessionID}/context`);
    const inbox = await owned.json(base, `/api/session/${sessionID}/inbox`);
    const bound = withNativeMessage(template, mid);
    inspectNativeUserArtifact(message?.data, bound);
    if (!Array.isArray(inbox?.data) || inbox.data.length) fail('live_inbox_rejected');
    const projection = projectNativeHistory(history?.data, bound, stage.bindings.condition, completed);
    if (!same(history.data.find(row => row.id === mid), message.data)) fail('live_user_store_changed');
    return projection;
  };
  const watch = async () => {
    let observationStage = 'status_rpc', observationOrdinal = null;
    try {
      while (!monitorStop) {
        solverClock.check(true);
        if (!owned.active()) fail('live_monitor_timeout');
        if (freshPolicy) {
          correspondence.check();
          const next = correspondence.pendingLookup();
          if (next) {
            observationStage = 'native_history';
            const row = await owned.json(await owned.ready, `/api/session/${sessionID}/message/${next.assistant_message_id}`, { signal: solverClock.releaseSignal });
            correspondence.bindAssistant(row?.data);
          }
        }
        const value = await status();
        observationOrdinal = value.ordinal;
        if (value.pending) {
          observationStage = 'pending'; diagnostics.event(observationStage, 'observed', value.ordinal);
          const pending = value.pending;
          if (!same(Object.keys(pending).sort(), ['ordinal', 'message_id', 'messages_sha256', 'digest'].sort()) ||
              ![pending.messages_sha256, pending.digest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) ||
              pending.ordinal !== boundOrdinal + 1 || value.ordinal !== pending.ordinal || !nativeMessageID(pending.message_id) ||
               (template.messageID.startsWith('msg_') && nativeMessageID(template.messageID) && template.messageID !== pending.message_id)) fail('live_pending_rejected');
          if (freshPolicy && boundOrdinal) {
            const previous = correspondence.snapshot().bindings.at(-1);
            // A missing post-release event/lookup cannot be replaced by the
            // newest assistant or a count. Let the existing pending guard expire.
            if (!previous || previous.ordinal !== boundOrdinal) { await new Promise(resolve => setTimeout(resolve, 20)); continue; }
            const row = await owned.json(await owned.ready, `/api/session/${sessionID}/message/${previous.native_assistant_id}`, { signal: solverClock.releaseSignal });
            correspondence.settleContinuation(row?.data);
          }
          observationStage = 'inventory'; await inventory();
          observationStage = 'session_scope'; await sessionScope();
          observationStage = 'native_history';
          const projection = await nativeHistory(pending.message_id);
          if (hash(projection.messages) !== pending.messages_sha256) fail('live_projection_mismatch');
          solverClock.check(true);
          if (monitorStop || cleanup || lifecycle !== 'running' || child.status.phase !== 'running') fail('live_release_after_stop');
          observationStage = 'bind_rpc';
          if (freshPolicy) correspondence.beginRelease(pending.ordinal, pending.digest);
          const released = await rpc('bindEpisodeContext', { session_id: sessionID, message_id: pending.message_id, invocation_token: invocation,
            digest: pending.digest, ordinal: pending.ordinal, messages_sha256: pending.messages_sha256, solver_deadline: solverClock.deadline });
          if (!same(released, { bound: true, incarnation, ordinal: pending.ordinal })) fail('live_release_rejected');
          if (freshPolicy) correspondence.acknowledge(pending.ordinal);
          template = withNativeMessage(template, pending.message_id); completed = projection.completed; boundOrdinal++;
          diagnostics.event('released', 'observed', boundOrdinal);
        }
        observationStage = 'status_rpc';
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      diagnostics.event(observationStage, diagnosticReason(error), observationOrdinal);
      if (nativeClosedAt !== undefined) recordNativeFailure(error);
      monitorFailure = true; monitorStop = true;
      try { await handle.cleanup(); } catch { /* Remains an unconfirmed failure, never a validated finish. */ }
    }
  };
  const begin = nativeCLI => {
    if (cleanup) throw new Error('context_audit_after_cleanup');
    if (contextMode !== undefined && contextMode !== nativeCLI) throw new Error('context_audit_mode_already_bound');
    contextMode = nativeCLI;
    contextAudit ??= audit.then(startup => collectContextAudit(stage, owned, startup, nativeCLI)).then(result => { contextResult = result; return result; });
    return contextAudit.then(result => structuredClone(result));
  };
  const probeRouteEnvelopes = createRouteEnvelopeProbe((route, init) => owned.ready.then(base => owned.json(base, route, init, true)),
    () => !cleanup && lifecycle === 'admitted' && !dispatched ? sessionID : null);
  const handle = Object.freeze({ root: stage.root, mode: 'audit-only', production_admission: false,
    probeRouteEnvelopes,
    audit: async () => structuredClone(await audit), getBindings: bindings,
    async admit(capability) {
      if (cleanup || lifecycle !== 'audit') rejectLifecycle('live_admission_reused');
      lifecycle = 'admitting';
      diagnostics.event(lifecycle);
      try {
        const { consumeEpisodeCapability } = await import('./admission.mjs');
        consumeEpisodeCapability(capability, handle, bindings());
        if (!owned.active() || contextResult?.status !== 'trusted-guard-context-audit-passed') fail('live_admission_audit_missing');
        sessionID = `ses_${randomUUID()}`; invocation = randomUUID();
        template = freeze({ ...withModelIdentity(stage.bindings.requestTemplate, startupResult.model_metadata.catalog_display_name), sessionID });
        diagnostics.bind({ incarnation, session_sha256: hash(sessionID), prompt_sha256: template.prompt_sha256, model_sha256: hash(MODEL_REF) });
        const base = await owned.ready, now = Date.now();
        const created = await owned.json(base, '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          id: sessionID, title: TITLE, agent: AGENT, model: MODEL_REF, location: { directory: stage.cwd } }) });
        if (created?.data?.id !== sessionID || created.data.parentID !== undefined || created.data.location?.directory !== stage.cwd ||
            created.data.agent !== AGENT || !same(created.data.model, MODEL_REF) || created.data.title !== TITLE ||
             !Number.isFinite(created.data.time?.created) || created.data.time.created < now) fail('live_fresh_session_rejected');
        if (freshPolicy) {
          if (Object.values(nativeAmounts(created.data)).some(value => value !== 0) || created.data.outcome !== undefined || created.data.time.idle !== undefined) fail('native_baseline_not_zero_fresh');
          nativeBaseline = freeze({ cost: created.data.cost, tokens: structuredClone(created.data.tokens), time: { created: created.data.time.created } });
          correspondence = createNativeCorrespondence({ sessionID, incarnation, promptSha256: template.prompt_sha256, createdAt: created.data.time.created, condition: stage.bindings.condition });
        }
        for (const route of ['context', 'inbox']) {
          const empty = await owned.json(base, `/api/session/${sessionID}/${route}`);
          if (!same(empty?.data, [])) fail('live_fresh_session_not_empty');
        }
        const armed = await rpc('armEpisode', { session_id: sessionID, invocation_token: invocation, purpose: 'production',
          audit_binding_sha256: hash(contextResult.request_audit.abort_record), episode_id: stage.bindings.episode_id });
        if (!same(armed, { armed: true, incarnation, session_sha256: hash(sessionID), purpose: 'production' })) fail('live_arm_rejected');
        lifecycle = 'admitted';
        diagnostics.event(lifecycle);
      } catch (error) { diagnostics.event('admitting', diagnosticReason(error)); lifecycle = 'revoked'; await handle.cleanup(); throw error; }
    },
    async dispatch({ item, task }) {
      if (cleanup || lifecycle !== 'admitted' || dispatched) rejectLifecycle('live_dispatch_reused');
      dispatched = true;
      diagnostics.event('dispatch');
      const { promptFor } = await import('./lib.mjs');
      if (item.episode_id !== stage.bindings.episode_id || item.condition !== stage.bindings.condition || item.model !== MODEL ||
          hash(promptFor(task)) !== template.prompt_sha256) { await handle.cleanup(); fail('live_dispatch_binding_rejected'); }
      const launch = owned.descriptor(await owned.ready, sessionID, template.messages[0].content[0].text);
      if (freshPolicy) nativeObserver = await owned.nativeEvents(await owned.ready, correspondence, () => {
        if (nativeClosedAt !== undefined) recordNativeFailure(new Error('native_observer_failed'));
        monitorFailure = true; monitorStop = true; void handle.cleanup().catch(() => {});
      });
      return Object.freeze({ launch, launcherFactory(descriptor, callbacks) {
        if (descriptor !== launch || cleanup || launched || lifecycle !== 'admitted') rejectLifecycle('live_launch_reused');
         launched = true; lifecycle = 'running';
         diagnostics.event(lifecycle);
         solverClock = createSolverDeadline(launch.timeoutMs, () => {
           diagnostics.event('deadline', Date.now() >= solverClock.deadline ? 'solver_deadline' : 'live_solver_deadline_or_closure', boundOrdinal);
           monitorFailure = true; monitorStop = true; void handle.cleanup().catch(() => {});
         });
         callbacks.signal?.addEventListener('abort', () => diagnostics.event('cancellation', diagnosticReason(callbacks.signal.reason), boundOrdinal), { once: true });
          const rawCLI = freshPolicy ? createOwnedCLIObservation({ launch, sessionID, promptSha256: template.prompt_sha256,
            sourceSha256: sources['bench/v4/real-use/bridge.mjs'] }) : null;
          // This private callback is attached directly to the owned child stream,
          // before caller capture callbacks. It is never exposed on the handle.
          try { child = createOwnedLauncher(launch, rawCLI ? { ...callbacks, onStdout: bytes => {
            rawCLI.push(bytes); callbacks.onStdout(bytes);
          } } : callbacks); }
         catch { rejectLifecycle('live_launcher_failed'); }
         void child.closed.then(result => {
           diagnostics.event('cli_terminal', 'cli_closed', boundOrdinal);
           solverClock.closeCLI(); monitorStop = true;
           if (freshPolicy) {
              nativeClosedAt = Date.now();
              try {
                 finalizationState.stage = 'seal';
                 correspondence.seal(nativeClosedAt);
                 finalizationState.stage = 'facts';
                 ownedCLIObservation = rawCLI.close(launch, result);
                 if (!ownedCLIObservation.valid) fail('native_cli_closure_ineligible');
                 finalizationState.stage = 'eligibility';
                 correspondence.eligibleAtClosure(ownedCLIObservation.cli_complete);
               const remaining = Math.min(2000, solverClock.deadline - nativeClosedAt);
               if (remaining <= 0) fail('native_inspection_deadline');
                finalizationState.stage = 'seal';
                nativeSeal = rpc('sealEpisode', {}, AbortSignal.any([solverClock.signal, AbortSignal.timeout(remaining)])).then(sealed => {
                  const guard = sealed?.evidence;
                  finalizationState.seal = guard;
                 if (sealed?.sealed !== true || sealed.incarnation !== incarnation || guard?.phase !== 'sealed' || guard.active_tools !== 0 || guard.pending !== null ||
                     guard.violations !== 0 || guard.purpose !== 'production' || guard.incarnation !== incarnation || guard.session_sha256 !== hash(sessionID) ||
                     guard.prompt_sha256 !== template.prompt_sha256 || guard.ordinal !== boundOrdinal || guard.released !== boundOrdinal || guard.model_requests !== boundOrdinal ||
                     !Array.isArray(guard.records) || guard.records.length !== boundOrdinal || guard.records.some((record, i) => record.ordinal !== i + 1 ||
                       record.model_sha256 !== hash(MODEL_REF) || record.session_sha256 !== hash(sessionID))) fail('native_seal_evidence_rejected');
                 return guard;
               });
                void nativeSeal.catch(error => { finalizationState.stage = 'seal'; recordNativeFailure(error); monitorFailure = true; void handle.cleanup().catch(() => {}); });
              } catch (error) { recordNativeFailure(error); monitorFailure = true; void handle.cleanup().catch(() => {}); }
             return;
           }
           // A stopped CLI can never authorize another request. Clean terminal
           // evidence may still be inspected under the ORIGINAL solver deadline.
           cliRevocation = rpc('revokeEpisode').catch(() => { diagnostics.event('revoked', 'revoke_failed', boundOrdinal); monitorFailure = true; void handle.cleanup().catch(() => {}); });
         }, () => { diagnostics.event('cli_terminal', 'cli_closed_rejected', boundOrdinal); solverClock.stop(); });
         monitor = watch();
          // Do not expose the ChildProcess/EventEmitter: callers must not inject
          // synthetic stdout into the private observer through a public stream.
          return Object.freeze({ ...(freshPolicy ? { closed: child.closed, status: child.status, cleanupOwned: child.cleanupOwned } : child),
            observeCapture: value => diagnostics.capture(value) });
      } });
    },
    async finish({ observedSessionIDs, observedModels, promptSha256, signal, final_text, final_text_sha256,
      captured_assistant_message_ids, cli_closed_at, native_closure_clean, capture_usage, solver_deadline }) {
      if (finished) rejectLifecycle('live_finish_reused');
      finished = true;
      diagnostics.event('finish', signal?.aborted ? 'signal_aborted' : 'observed', boundOrdinal);
      const evidenceHash = bindings().context_evidence_sha256;
      try {
        if (freshPolicy) finalizationState.stage = 'facts';
        if (cleanup || !launched || monitorFailure || signal?.aborted || promptSha256 !== template.prompt_sha256) fail('live_finish_identity_rejected');
        if (!Array.isArray(observedSessionIDs) || !observedSessionIDs.length || observedSessionIDs.some(id => id !== sessionID) ||
            !Array.isArray(observedModels) || observedModels.some(model => model !== MODEL)) fail('live_finish_identity_rejected');
        if (freshPolicy) {
          if (!nativeSeal || !Number.isSafeInteger(cli_closed_at) || cli_closed_at < nativeClosedAt || cli_closed_at > nativeClosedAt + 1000 ||
              !Number.isSafeInteger(solver_deadline) || solver_deadline > solverClock.deadline || typeof final_text !== 'string' ||
              Buffer.byteLength(final_text) > 8 * 1024 * 1024 || hash(final_text) !== final_text_sha256 || !capture_usage ||
              !Array.isArray(captured_assistant_message_ids) || typeof native_closure_clean !== 'boolean') fail('native_finish_facts_rejected');
          if (!ownedCLIObservation?.valid || native_closure_clean !== ownedCLIObservation.cli_complete ||
              final_text_sha256 !== ownedCLIObservation.final_text_sha256 ||
              !same(captured_assistant_message_ids, ownedCLIObservation.captured_assistant_message_ids)) fail('native_finish_owned_cli_mismatch');
          const cliComplete = ownedCLIObservation.cli_complete;
          finalizationState.stage = 'eligibility';
          correspondence.eligibleAtClosure(cliComplete);
          const inspectionDeadline = Math.min(nativeClosedAt + 2000, solverClock.deadline, solver_deadline);
          const base = await owned.ready;
          let sealEvidence;
          const readSnapshot = async inspectionSignal => {
            finalizationState.stage = 'seal';
            sealEvidence ??= await nativeSeal;
            correspondence.check();
            const before = await status();
            finalizationState.seal = before;
            if (!same(before, sealEvidence)) fail('native_seal_changed');
            finalizationState.stage = 'snapshot';
            const session = await owned.json(base, `/api/session/${sessionID}`, { signal: inspectionSignal });
            const rows = await readNativeMessagePages(query => owned.json(base, `/api/session/${sessionID}/message${query}`, { signal: inspectionSignal }));
            const inbox = await owned.json(base, `/api/session/${sessionID}/inbox`, { signal: inspectionSignal });
            const children = await owned.json(base, `/api/session?parentID=${encodeURIComponent(sessionID)}&limit=1`, { signal: inspectionSignal });
            const childRows = nativeChildrenRows(children);
            finalizationState.stage = 'seal';
            const after = await status();
            finalizationState.seal = after;
            if (!same(after, sealEvidence)) fail('native_seal_changed');
            return { session: session?.data, rows, inbox: inbox?.data, children: childRows };
          };
           let correspondenceSnapshot = correspondence.snapshot();
          const inspected = await inspectNativeCompletion(readSnapshot, { template, condition: stage.bindings.condition, cwd: stage.cwd,
            correspondence: correspondenceSnapshot, finalText: final_text, capturedAssistantIDs: [...captured_assistant_message_ids],
            captureToolEvidence: ownedCLIObservation.tool_evidence, baseline: nativeBaseline, pricing: startupResult.model_metadata.pricing, cliComplete }, inspectionDeadline,
            signal ? AbortSignal.any([signal, solverClock.signal]) : solverClock.signal,
            progress => { Object.assign(finalizationState, progress); });
           correspondence.check(); solverClock.check();
           if (monitorFailure || cleanup) fail('native_inspection_revoked');
           // No additional read/wait: include a success already received during
           // the two planned reads, and check its native time against their idle.
           correspondenceSnapshot = correspondence.snapshot();
           if (correspondenceSnapshot.witness && (correspondenceSnapshot.witness.created > nativeClosedAt ||
               correspondenceSnapshot.witness.created < inspected.snapshot.idle_at_ms)) fail('native_success_witness_rejected');
           const { witness: evidenceWitness, ...kindEvidence } = projectNativeCompletionKind(correspondenceSnapshot, cliComplete, inspected.snapshot.idle_at_ms);
           const completion = { schema: 'real-use-completion-evidence/v1', basis: cliComplete ? 'cli_terminal' : 'native_corroborated',
             ...kindEvidence,
            policy: 'native-platform-v1', cli_complete: cliComplete,
            post_release_bindings_sha256: hash(correspondenceSnapshot.bindings), native_snapshot_sha256: inspected.native_snapshot_sha256,
            final_text_sha256, native_message_id: inspected.native_message_id, pricing_sha256: hash(startupResult.model_metadata.pricing), native_usage_sha256: hash(inspected.native_recorded_usage) };
          const evidencePath = path.join(stage.root, 'private', 'native-completion-evidence.json');
          const artifact = { schema: 'real-use-native-completion-artifact/v1', profile_id: stage.bindings.profile_id, protocol_hash: stage.bindings.protocol_hash,
            registration_sha256: stage.bindings.registration_sha256, run_id: stage.bindings.run_id, episode_id: stage.bindings.episode_id, nonce: stage.bindings.nonce,
            incarnation, session_id: sessionID, prompt_sha256: template.prompt_sha256, snapshot_manifest_sha256: stage.bindings.snapshot_sha256, source_sha256: sources,
            completion_evidence: completion, post_release_bindings: correspondenceSnapshot.bindings, witness: evidenceWitness,
            seal: { phase: sealEvidence.phase, ordinal: sealEvidence.ordinal, released: sealEvidence.released, model_requests: sealEvidence.model_requests,
              active_tools: sealEvidence.active_tools, violations: sealEvidence.violations, records_sha256: hash(sealEvidence.records) },
            native_snapshot: inspected.snapshot, native_recorded_usage: inspected.native_recorded_usage, pricing: startupResult.model_metadata.pricing,
            tool_evidence: inspected.tool_evidence, upstream_usage_complete: 'unknown', billed_usd: null };
          finalizationState.stage = 'evidence_write';
          const bytes = JSON.stringify(artifact) + '\n';
          if (Buffer.byteLength(bytes) > 256 * 1024 || Date.now() >= inspectionDeadline) fail('native_evidence_cap');
          finalizationState.evidenceWritten = null; // A failed write may have created a partial file.
          writeFileSync(evidencePath, bytes, { flag: 'wx', mode: 0o600 });
          finalizationState.evidenceWritten = true;
          if (Date.now() >= inspectionDeadline) fail('native_inspection_deadline');
          finalizationState.stage = 'cleanup';
          const cleaned = await handle.cleanup();
          if (!cleaned.confirmed || monitorFailure || signal?.aborted || solverClock.signal.aborted || Date.now() >= solverClock.deadline) fail('live_finish_cleanup_unconfirmed');
          return freeze({ identity_validation: { status: 'validated', model: MODEL, variant: 'default', session_id: sessionID, prompt_sha256: promptSha256 },
            guard: { status: 'passed', nonce: stage.bindings.nonce, context_evidence_sha256: evidenceHash },
            cleanup: { confirmed: true, server: cleaned.server, daemon: cleaned.daemon, cli: cleaned.cli },
            completion_evidence: { ...completion, evidence_path: evidencePath, evidence_sha256: hash(bytes) }, native_recorded_usage: inspected.native_recorded_usage,
            tool_evidence: inspected.tool_evidence, upstream_usage_complete: 'unknown', billed_usd: null });
        }
        solverClock.check();
        await cliRevocation;
        diagnostics.nativeWait('pending');
        try {
          await owned.json(await owned.ready, `/api/experimental/session/${sessionID}/wait`, { method: 'POST',
            signal: signal ? AbortSignal.any([signal, solverClock.signal]) : solverClock.signal });
          diagnostics.nativeWait('completed'); diagnostics.event('native_wait', 'native_wait_completed', boundOrdinal);
        } catch (error) {
          diagnostics.nativeWait(signal?.aborted || solverClock.signal.aborted ? 'aborted' : 'failed');
          diagnostics.event('native_wait', diagnosticReason(error), boundOrdinal); throw error;
        }
        solverClock.check();
        monitorStop = true; await monitor;
        const guard = await status();
        if (signal?.aborted || monitorFailure || !boundOrdinal || !['released', 'revoked'].includes(guard.phase) || guard.pending !== null || guard.active_tools !== 0 ||
            guard.ordinal !== boundOrdinal || guard.released !== boundOrdinal || guard.model_requests !== boundOrdinal || guard.records.length !== boundOrdinal) fail('live_finish_guard_rejected');
        const projection = await nativeHistory(template.messageID); completed = projection.completed;
        await inventory(); await sessionScope();
        const after = await status();
        if (!same(guard, after)) fail('live_finish_guard_changed');
        validateFinishIdentity(observedSessionIDs, observedModels, sessionID, projection.messages.some(row => row.role === 'assistant' && projection.completed.has(row.id)) &&
          guard.records.every((record, index) => record.ordinal === index + 1 && record.model_sha256 === hash(MODEL_REF) && record.session_sha256 === hash(sessionID)));
        solverClock.check();
        const cleaned = await handle.cleanup();
        if (!cleaned.confirmed) fail('live_finish_cleanup_unconfirmed');
        return freeze({ identity_validation: { status: 'validated', model: MODEL, variant: 'default', session_id: sessionID, prompt_sha256: promptSha256 },
          guard: { status: 'passed', nonce: stage.bindings.nonce, context_evidence_sha256: evidenceHash },
          cleanup: { confirmed: true, server: cleaned.server, daemon: cleaned.daemon, cli: cleaned.cli }, timing: { elapsed_ms: Date.now() - started } });
      } catch (error) { recordNativeFailure(error); diagnostics.event('finish', diagnosticReason(error), boundOrdinal); throw error; }
      finally { await handle.cleanup(); }
    },
    auditContext: () => begin(false), auditNativeCLIBinding: () => begin(true),
    cleanup: () => cleanup ??= (async () => {
      monitorStop = true; lifecycle = 'revoked';
      diagnostics.event('cleanup', 'host_cleanup', boundOrdinal);
      // Start all owned termination immediately; an unresponsive revoke RPC must
      // never buy inference time or hide the separately owned CLI Job Object.
      const cliCleanup = cleanupOwnedCLI(child, launched);
      const observerCleanup = nativeObserver?.close();
      if (sessionID && owned.active()) void rpc('revokeEpisode').catch(() => {});
      // Snapshot cached, validated owned evidence before killing; no diagnostic
      // fetch or disk wait can extend inference, even when the deadline expired.
      const beforeDiagnostic = diagnostics.persist(path.join(stage.root, 'production-diagnostics.before-cleanup.json'));
      const serverCleanup = owned.close();
      try {
      await observerCleanup;
      if (contextAudit) await contextAudit;
      const [processCleanup, cliProof] = await Promise.all([serverCleanup, cliCleanup]);
      const result = await audit;
      result.cleanup = processCleanup;
      result.cli_cleanup = cliProof;
      if (!cliProof.confirmed) { result.blockers.push('owned_cli_cleanup_unconfirmed'); result.status = 'blocked'; }
      if (!result.cleanup.process_tree_containment) { result.blockers.push('owned_cleanup_unconfirmed'); result.status = 'blocked'; }
      try { result.backend_cleanup = await cleanupStagedRuntime(stage); }
      catch { result.backend_cleanup = { status: 'unconfirmed' }; }
      if (stage.operator && !['confirmed_absent', 'not_created'].includes(result.backend_cleanup.status)) {
        result.blockers.push('backend_cleanup_unconfirmed'); result.status = 'blocked';
      }
      if (contextAudit) {
        result.context_audit = await contextAudit;
        if (!cliProof.confirmed || !result.cleanup.process_tree_containment || (stage.operator && !['confirmed_absent', 'not_created'].includes(result.backend_cleanup.status))) {
          result.context_audit.status = 'blocked'; result.context_audit.blocker = 'context_cleanup_unconfirmed';
        }
        if (result.context_audit.certificate) result.context_audit.certificate.cleanup_confirmed = result.context_audit.status !== 'blocked';
        writeFileSync(path.join(stage.root, 'context-audit.json'), JSON.stringify(result.context_audit, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }
      writeFileSync(path.join(stage.root, 'startup-audit.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const server = { confirmed: processCleanup.process_tree_containment === true, active_processes: processCleanup.active_processes };
      const daemon = { confirmed: ['confirmed_absent', 'not_created', 'not_configured'].includes(result.backend_cleanup.status),
        active_processes: ['confirmed_absent', 'not_created', 'not_configured'].includes(result.backend_cleanup.status) ? 0 : null };
      const confirmed = server.confirmed && daemon.confirmed && cliProof.confirmed;
      if (confirmed) solverClock?.disarm();
      return { root: stage.root, result: structuredClone(result), confirmed, server, daemon, cli: cliProof, diagnostics: diagnosticReceipts };
      } finally {
        // Observability failures are reported separately and never replace an
        // essential terminal or bypass any owned termination already initiated.
        diagnosticReceipts.before_cleanup = await beforeDiagnostic;
        if (diagnosticReceipts.before_cleanup.status !== 'written') diagnostics.event('cleanup',
          diagnosticReceipts.before_cleanup.status === 'write_timeout' ? 'diagnostic_write_timeout' : 'diagnostic_write_failed');
        diagnosticReceipts.final = await diagnostics.persist(path.join(stage.root, 'production-diagnostics.json'));
      }
    })(),
  });
  ownedBridges.set(handle, stage.bindings.nonce);
  return handle;
}

export async function auditStartup(options) {
  const bridge = startAuditBridge(options);
  try { await bridge.audit(); }
  catch (error) { await bridge.cleanup(); throw error; }
  return bridge.cleanup();
}

export async function auditContext(options) {
  const cli = resolveTrustedExecutable(options.cliPackageDir);
  const registry = builtinRegistry(cli.sha256);
  // No caller-supplied observed list can substitute for the independent artifact.
  const bridge = startAuditBridge({ ...options, approvedPlugins: registry ? builtinRecords(registry) : [] });
  try { await bridge.auditContext(); }
  catch (error) { await bridge.cleanup(); throw error; }
  return bridge.cleanup();
}

export async function auditNativeCLIBinding(options) {
  const cli = resolveTrustedExecutable(options.cliPackageDir);
  const registry = builtinRegistry(cli.sha256);
  const bridge = startAuditBridge({ ...options, approvedPlugins: registry ? builtinRecords(registry) : [] });
  try { await bridge.auditNativeCLIBinding(); }
  catch (error) { await bridge.cleanup(); throw error; }
  return bridge.cleanup();
}
