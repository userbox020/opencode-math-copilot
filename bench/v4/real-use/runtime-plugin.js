// Evaluator-owned V2 plugin. Production release requires the private bridge RPC
// after evaluator capability consumption; audit requests always throw.
// The host retains native auth; these tools are not a host/OS sandbox.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_ID = 'real-use-audit-guard';
export const RPC_ID = 'real-use-audit';
export const MODEL = 'opencode-go/deepseek-v4.1-flash';
export const MODEL_REF = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default' });
export const isNativeCompletionProfile = (profileId, protocolHash) => ['g023-compat', 'g024-workflows'].includes(profileId) &&
  typeof protocolHash === 'string' && /^[a-f0-9]{64}$/.test(protocolHash);
export const VARIANT_CHOICE = Object.freeze({ variant: 'default', chosen_by: 'parent-before-inference', settings_overlay: false,
  source_commit: '042d0832f5f3a73eaa039a58a7d565776f6d4290', references: ['runner/model.ts:82-90', 'model-resolver.ts:136-159,396-402'] });
export const AGENT = 'math-eval';
export const TITLE = 'Restricted math evaluation audit';
export const MODEL_IDENTITY_TEMPLATE = '# Your Model\n- Name: ${catalogDisplayName}\n- Provider ID: opencode-go\n- Model ID: deepseek-v4.1-flash';
// Parent bridge-context-provenance-g004.json; pinned public commit 042d0832,
// packages/core/src/tool/plugin/opencode.ts:88-102. This grants no tools.
export const WORKTREE_FRAGMENT = "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.";
export const DISPATCH_PROOF = 'pinned-2.0.29-session-hooks-before-inference-auth-may-precede';
export const HOOK_REVIEW = Object.freeze({ version: '2.0.29', provenance: 'parent-supplied authoritative pinned-source review',
  references: ['promiseadapter.ts:591-595', 'core/plugin/hooks.ts:88-95', 'model-request.ts:236-309,340-364,422-430',
    'runner/step.ts:107', 'model-transport.ts:308-325,375-388', 'model-resolver.ts:374-388', 'integration.ts:723-740', 'core/generate.ts:39-72'],
  session_inference_abort: true, auth_http_may_precede: true, stateless_generate_covered: false });
export const SYSTEM = 'You are a mathematics assistant in a restricted evaluation. Use only the supplied offline tools. Do not access host state, credentials, prior sessions, or external services. Distinguish proposed work from actual verification.';
// Matches runtime-tools.mjs; only that factory constructs the shared snapshot handlers.
export const SOURCE_TOOL_MAPPING = Object.freeze({ approved_list: 'list_sources', approved_read: 'read_source',
  approved_search: 'search_source', approved_pdf_text: 'read_pdf' });
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 1024 };
const query = { type: 'string', minLength: 1, maxLength: 256 };
const limit = { type: 'integer', minimum: 1, maximum: 20 };
// Constant model-facing schemas; operator paths/worker/image/hostnames never appear here.
export const DEFINITIONS = freeze({
  approved_list: { description: 'List the three approved snapshot sources and their extraction scope. No archive discovery.', input: object({}) },
  approved_read: { description: 'Read bounded lines of an approved UTF-8 source. Use read_pdf for PDF physical pages.', input: object({ path: text, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['path']) },
  approved_search: { description: 'Literal case-sensitive search across approved text and extracted PDF pages; no regex, OCR, or archive search.', input: object({ query, limit }, ['query']) },
  approved_pdf_text: { description: 'Read at most five physical pages from approved PDF-derived text, with explicit extraction/truncation scope. No OCR.', input: object({ path: text, pages: { type: 'string', minLength: 1, maxLength: 100, pattern: '^\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*$' } }, ['path', 'pages']) },
  compute: { description: 'Bounded allowlisted symbolic computation in the fixed isolated Python/SymPy container. No arbitrary Python or host execution.', input: object({ operation: { type: 'string', enum: ['simplify', 'factor', 'expand', 'solve', 'diff', 'integrate', 'limit', 'series', 'evalf', 'det', 'eigenvalues'] }, expression: { type: 'string', minLength: 1, maxLength: 2000 }, variable: { type: 'string', minLength: 1, maxLength: 32 }, point: { anyOf: [{ type: 'string', minLength: 1, maxLength: 2000 }, { type: 'number' }] }, order: { type: 'integer', minimum: 1, maximum: 50 }, matrix: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'number' } } } }, ['operation']) },
  lean_compile: { description: 'Compile proposed Lean against the fixed isolated Mathlib image. Compilation is NOT theorem/type/axiom proof verification; proof status remains not_assessed.', input: object({ code: { type: 'string', minLength: 1, maxLength: 131072 } }, ['code']) },
  math_search: { description: 'Restricted three-source workflow BM25 navigation using shipped math-toolkit search logic; not the full corpus/plugin.', input: object({ query, limit }, ['query']) },
  math_manuscript: { description: 'Restricted source metadata/outline and bounded excerpt, from the same approved snapshot bytes. Supply path OR query.', input: { ...object({ path: text, query }), oneOf: [{ required: ['path'], not: { required: ['query'] } }, { required: ['query'], not: { required: ['path'] } }] } },
});
export function namesFor(condition) {
  if (!['plugin-on', 'plugin-off'].includes(condition)) throw new Error('invalid_condition');
  return Object.keys(DEFINITIONS).slice(0, condition === 'plugin-on' ? 8 : 6);
}
export const permissionsFor = condition => freeze([{ action: '*', resource: '*', effect: 'deny' },
  ...namesFor(condition).map(action => ({ action, resource: '*', effect: 'allow' })),
  { action: 'execute', resource: '*', effect: 'deny' }]);
const safeID = value => typeof value === 'string' && /^[A-Za-z0-9_./:@-]{1,200}$/.test(value) ? value : 'invalid-id';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (a, b) => canonical(a) === canonical(b);
const dataType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
export function diagnosticShape(value) {
  const keys = value !== null && ['object', 'function'].includes(typeof value) ? Reflect.ownKeys(value) : [];
  return { type: dataType(value), truncated: keys.length > 32, properties: keys.slice(0, 32).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return { name: typeof key === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(key) ? key : 'redacted_key',
      type: Object.hasOwn(descriptor, 'value') ? dataType(descriptor.value) : 'accessor' };
  }) };
}
export function validDiagnosticShape(shape) {
  const types = ['undefined', 'null', 'array', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol', 'function', 'accessor'];
  return exact(shape, ['type', 'truncated', 'properties']) && types.includes(shape.type) && typeof shape.truncated === 'boolean' &&
    Array.isArray(shape.properties) && shape.properties.length <= 32 && shape.properties.every(p => exact(p, ['name', 'type']) &&
      typeof p.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(p.name) && types.includes(p.type));
}
export function promptDifference(observed, expected) {
  if (typeof observed !== 'string' || typeof expected !== 'string') return null;
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(observed.length, expected.length) && observed[prefix] === expected[prefix]) prefix++;
  while (suffix < Math.min(observed.length, expected.length) - prefix && observed.at(-suffix - 1) === expected.at(-suffix - 1)) suffix++;
  return { observed_length: observed.length, expected_length: expected.length, common_prefix: prefix, common_suffix: suffix,
    expected_is_substring: observed.includes(expected) };
}

export function makeRequestTemplate({ sessionID, messageID, prompt, promptHash, directory, projectDirectory, tmp, localDate, platform }) {
  if (!/^ses_[a-f0-9-]{36}$/.test(sessionID ?? '') || !/^msg_[a-f0-9-]{36}$/.test(messageID ?? '') ||
      typeof prompt !== 'string' || !prompt.length || Buffer.byteLength(prompt) > 65536 || hash(prompt) !== promptHash ||
      ![directory, projectDirectory, tmp].every(value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value)) ||
      directory !== projectDirectory || !['win32', 'linux', 'darwin'].includes(platform) ||
      typeof localDate !== 'string' || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{2} \d{4}$/.test(localDate)) throw new Error('invalid_request_template_input');
  // Exact pinned builtins.ts:24-51 text. Never normalize an observed system block.
  const environment = `Today's date: ${localDate}\n\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: ${directory}\n  Workspace root folder: ${projectDirectory}\n  Is directory a git repo: no\n  Platform: ${platform}\n  Prefer ${tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\n</env>`;
  return freeze({ sessionID, messageID, prompt_sha256: promptHash, local_date: localDate,
    system: [{ type: 'text', text: SYSTEM }, { type: 'text', text: environment }],
    messages: [{ id: messageID, role: 'user', content: [{ type: 'text', text: prompt }], metadata: {} }] });
}

function validTemplate(template) {
  return exact(template, ['sessionID', 'messageID', 'prompt_sha256', 'local_date', 'system', 'messages']) &&
    /^ses_[a-f0-9-]{36}$/.test(template.sessionID) && /^msg_[a-f0-9-]{36}$/.test(template.messageID) &&
    digest(template.prompt_sha256) && Array.isArray(template.system) && template.system.length === 2 &&
    template.system.every(part => exact(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string' && part.text.length < 16384) &&
    template.system[0].text === SYSTEM && Array.isArray(template.messages) && template.messages.length === 1 &&
    exact(template.messages[0], ['id', 'role', 'content', 'metadata']) && template.messages[0].id === template.messageID && template.messages[0].role === 'user' &&
    same(template.messages[0].metadata, {}) && Array.isArray(template.messages[0].content) && template.messages[0].content.length === 1 &&
    exact(template.messages[0].content[0], ['type', 'text']) && template.messages[0].content[0].type === 'text' &&
    typeof template.messages[0].content[0].text === 'string' && Buffer.byteLength(template.messages[0].content[0].text) <= 65536 &&
    hash(template.messages[0].content[0].text) === template.prompt_sha256;
}

export function withModelIdentity(template, catalogDisplayName) {
  if (!validTemplate(template) || typeof catalogDisplayName !== 'string' || !catalogDisplayName.trim() ||
      catalogDisplayName.length > 256 || /[\x00-\x1f\x7f]/.test(catalogDisplayName)) throw new Error('invalid_catalog_identity');
  return freeze({ ...structuredClone(template), system: [template.system[0],
    { type: 'text', text: MODEL_IDENTITY_TEMPLATE.replace('${catalogDisplayName}', () => catalogDisplayName) }, template.system[1],
    { type: 'text', text: WORKTREE_FRAGMENT }] });
}

export const nativeMessageID = value => typeof value === 'string' && /^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/.test(value);
export function withNativeMessage(template, messageID) {
  if (!nativeMessageID(messageID)) throw new Error('native_message_id_invalid');
  return freeze({ ...structuredClone(template), messageID, messages: [{ ...structuredClone(template.messages[0]), id: messageID }] });
}
export function inspectNativeUserArtifact(artifact, template) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) ||
      Object.keys(artifact).some(key => !['id', 'type', 'time', 'metadata', 'text', 'files'].includes(key)) ||
      artifact.type !== 'user' || !nativeMessageID(artifact.id) || artifact.id !== template.messageID ||
      artifact.text !== template.messages[0].content[0].text || hash(artifact.text) !== template.prompt_sha256 ||
      (artifact.metadata !== undefined && !same(artifact.metadata, {})) ||
      // SessionMessage.User.files is an optional array. An empty CLI array carries
      // no attachment; never admit a file payload or an agent/skill attachment.
      (artifact.files !== undefined && !same(artifact.files, [])) ||
      !exact(artifact.time, ['created']) || !Number.isFinite(artifact.time.created)) throw new Error('native_user_artifact_rejected');
  return freeze({ id: artifact.id, type: 'user', text: artifact.text, metadata: {} });
}
export function guardBinding(options, incarnation, template) {
  return { incarnation, nonce: options.nonce, session_sha256: hash(template.sessionID), message_sha256: hash(template.messageID),
    prompt_sha256: template.prompt_sha256, template_sha256: hash(template), model_sha256: hash(MODEL_REF), agent: AGENT,
    tool_sha256: hash(Object.fromEntries(namesFor(options.condition).map(name => [name, DEFINITIONS[name]]))),
    source_graph_sha256: options.backend_sha256 ?? null, config_sha256: options.config_sha256,
    runtime_sha256: options.runtime_sha256, cli_sha256: options.cli_sha256, project_sha256: options.project_sha256,
    snapshot_sha256: options.snapshot_sha256 ?? null };
}

// Reduced pinned 042d0832 converter: to-llm-message.ts SHA256 d0590ccab12cfa6ff0ee4088e9a9a645d3abfa01e77347f0b8498523775ee91b;
// messages.ts SHA256 23ad9aebc503cb856f8166526e8d86f032b33cb605807851bb8d95ef597b614d.
// No hosted calls, attachments, compaction, synthetic/system/user additions, or
// model switches. Tool messages intentionally have NO invented message ID.
export function normalizeHistory(messages) {
  const omit = (value, optional) => Object.fromEntries(Object.entries(value).filter(([k, v]) => !(optional.includes(k) && v === undefined)));
  return messages.map(message => ({ ...omit(message, ['id', 'metadata', 'providerMetadata', 'native']), content: message.content.map(part =>
    omit(part, ['cache', 'metadata', 'providerMetadata', ...(['tool-call', 'tool-result'].includes(part.type) ? ['namespace', 'providerExecuted'] : []),
      ...(part.type === 'reasoning' ? ['encrypted'] : [])])) }));
}
export function projectNativeHistory(rows, template, condition, completed = new Map()) {
  const reject = () => { throw new Error('native_history_rejected'); };
  const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
  const emptyMetadata = v => v === undefined || same(v, {});
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const providerState = v => v === undefined || record(v);
  const time = (v, optional = []) => keys(v, ['created', ...optional]) && Number.isFinite(v.created) &&
    optional.every(k => v[k] === undefined || (Number.isFinite(v[k]) && v[k] >= v.created));
  const error = v => keys(v, ['type', 'message', 'status', 'response']) && typeof v.type === 'string' && typeof v.message === 'string' &&
    (v.status === undefined || (Number.isInteger(v.status) && v.status >= 100 && v.status <= 599)) &&
    (v.response === undefined || (exact(v.response, ['body']) && typeof v.response.body === 'string'));
  const textContent = value => Array.isArray(value) && value.length <= 256 && value.every(p => keys(p, ['type', 'text']) && p.type === 'text' && typeof p.text === 'string');
  const metadata = state => state === undefined ? undefined : { [MODEL_REF.providerID]: state };
  if (!Array.isArray(rows) || rows.length > 256 || Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) reject();
  const seen = new Set(), calls = new Set(), projected = [], nextCompleted = new Map(completed);
  let users = 0, selections = 0, placeholders = 0, lastCreated = -Infinity;
  for (const row of rows) {
    if (!nativeMessageID(row?.id) || seen.has(row.id) || !Number.isFinite(row.time?.created) || row.time.created < lastCreated) reject();
    seen.add(row.id); lastCreated = row.time.created;
    if (completed.has(row.id) && completed.get(row.id) !== hash(row)) reject();
    if (row.type === 'agent-switched') {
      if (users || ++selections > 1 || !keys(row, ['id', 'type', 'time', 'metadata', 'agent', 'previous']) || row.agent !== AGENT || row.previous !== AGENT || !emptyMetadata(row.metadata) || !time(row.time)) reject();
      nextCompleted.set(row.id, hash(row)); continue;
    }
    if (row.type === 'idle') {
      if (!users || !keys(row, ['id', 'type', 'time', 'metadata', 'outcome', 'error']) || !['succeeded', 'failed', 'interrupted'].includes(row.outcome) || !emptyMetadata(row.metadata) || !time(row.time) || (row.error !== undefined && !error(row.error))) reject();
      nextCompleted.set(row.id, hash(row)); continue;
    }
    if (row.type === 'user') {
      if (++users !== 1) reject();
      inspectNativeUserArtifact(row, template);
      projected.push({ id: row.id, role: 'user', content: [{ type: 'text', text: row.text }], metadata: {} });
      nextCompleted.set(row.id, hash(row)); continue;
    }
    if (row.type !== 'assistant' || users !== 1 || !keys(row, ['id', 'type', 'time', 'metadata', 'agent', 'model', 'content', 'snapshot', 'finish', 'rawFinish', 'providerState', 'cost', 'tokens', 'error', 'retry']) ||
        row.agent !== AGENT || !same(row.model, MODEL_REF) || row.retry !== undefined || !Array.isArray(row.content) || row.content.length > 256 ||
        !emptyMetadata(row.metadata) || !time(row.time, ['streamed', 'completed']) || !providerState(row.providerState) ||
        (row.error !== undefined && !error(row.error)) || (row.snapshot !== undefined && !same(row.snapshot, {}))) reject();
    if ((row.finish !== undefined && !['stop', 'length', 'content-filter', 'tool-calls', 'error', 'unknown'].includes(row.finish)) ||
        (row.rawFinish !== undefined && typeof row.rawFinish !== 'string') || (row.cost !== undefined && !Number.isFinite(row.cost)) ||
        (row.tokens !== undefined && (!exact(row.tokens, ['input', 'output', 'reasoning', 'cache']) ||
          !['input', 'output', 'reasoning'].every(k => Number.isFinite(row.tokens[k])) || !exact(row.tokens.cache, ['read', 'write']) ||
          !Object.values(row.tokens.cache).every(Number.isFinite)))) reject();
    const reuse = row.error === undefined;
    const interrupted = row.content.some(p => p.type === 'reasoning' && p.time !== undefined && p.time.completed === undefined);
    const content = [], results = [];
    for (const part of row.content) {
      if (part.type === 'text' || part.type === 'reasoning') {
        if (!keys(part, part.type === 'text' ? ['type', 'text', 'state'] : ['type', 'text', 'state', 'time']) || typeof part.text !== 'string' || !providerState(part.state) ||
            (part.type === 'reasoning' && part.time !== undefined && !time(part.time, ['completed']))) reject();
        if (part.type === 'text') { if (part.text) content.push({ type: 'text', text: part.text, providerMetadata: reuse ? metadata(part.state) : undefined }); }
        else if (reuse && !interrupted) {
          const pm = metadata(part.state); if (part.text || pm) content.push({ type: 'reasoning', text: part.text, providerMetadata: pm });
        } else if (part.text) content.push({ type: reuse && !interrupted ? 'reasoning' : 'text', text: part.text });
        continue;
      }
      if (part.type !== 'tool' || !keys(part, ['type', 'id', 'name', 'executed', 'providerState', 'providerResultState', 'state', 'time']) ||
          typeof part.id !== 'string' || !part.id.length || part.id.length > 200 || calls.has(part.id) || !namesFor(condition).includes(part.name) ||
          (part.executed !== undefined && part.executed !== false) || !time(part.time, ['ran', 'completed']) ||
          !providerState(part.providerState) || !providerState(part.providerResultState) || !['completed', 'error'].includes(part.state?.status)) reject();
      calls.add(part.id);
      const state = part.state;
      if (!keys(state, state.status === 'completed' ? ['status', 'input', 'content', 'metadata'] : ['status', 'input', 'error', 'content', 'metadata']) ||
          !state.input || typeof state.input !== 'object' || Array.isArray(state.input) ||
          (state.status === 'completed' ? !textContent(state.content) || !state.content.length : state.content !== undefined && !textContent(state.content))) reject();
      if (state.metadata !== undefined && !record(state.metadata)) reject();
      if (state.status === 'error' && !error(state.error)) reject();
      content.push({ type: 'tool-call', id: part.id, name: part.name, input: state.input, providerExecuted: part.executed,
        providerMetadata: reuse ? metadata(part.providerState) : undefined });
      const result = state.status === 'error' ? { type: 'error', value: { error: state.error, content: state.content ?? [] } } :
        state.content.length === 1 ? { type: 'text', value: state.content[0].text } : { type: 'content', value: state.content };
      results.push({ role: 'tool', content: [{ type: 'tool-result', id: part.id, name: part.name, result, providerExecuted: part.executed,
        providerMetadata: reuse ? metadata(part.providerResultState ?? part.providerState) : undefined }] });
    }
    if (content.length) projected.push({ id: row.id, role: 'assistant', content, metadata: row.metadata });
    projected.push(...results);
    if (row.time.completed !== undefined) {
      if (!Number.isFinite(row.time.completed)) reject();
      nextCompleted.set(row.id, hash(row));
    } else if (row.content.length || ++placeholders > 1 || row !== rows.at(-1) || Object.keys(row).some(k => !['id', 'type', 'time', 'metadata', 'agent', 'model', 'content'].includes(k))) reject(); // Only one empty current placeholder may remain mutable.
  }
  if (users !== 1 || [...completed.keys()].some(id => !seen.has(id))) reject();
  return { messages: normalizeHistory(projected), completed: nextCompleted };
}

export function createLiveGate({ template, condition, incarnation, invocation, purpose, nonce }) {
  if (!['production', 'abort-control'].includes(purpose)) throw new Error('live_purpose_rejected');
  let phase = 'armed', ordinal = 0, released = 0, modelRequests = 0, violations = 0, pending = null, resolve, timer, firstMID = null, activeTools = 0;
  let http = 0, handshake = 0, sends = 0;
  let solverDeadline = null;
  let diagnosticStage = 'armed', diagnosticTime = Date.now(), lastFailure = null, lastMessageHash = null, lastPending = null;
  const transportCounts = { model: 0, http: 0, ws_handshake: 0, ws_send: 0 };
  const observe = stage => { diagnosticStage = stage; diagnosticTime = Date.now(); };
  const expired = () => solverDeadline !== null && Date.now() >= solverDeadline;
  const calls = new Set(), records = [];
  const revoke = () => { observe('revoked'); phase = 'revoked'; clearTimeout(timer); resolve?.(false); resolve = null; pending = null; };
  const seal = () => { if (phase !== 'revoked') { observe('sealed'); phase = 'sealed'; clearTimeout(timer); resolve?.(false); resolve = null; pending = null; } };
  const sealed = (attempt = true) => { if (phase === 'sealed') {
    if (attempt) { violations++; lastFailure ??= { stage: 'sealed', reason: 'guard_rejected', at_ms: Date.now(), ordinal }; }
    throw new Error('live_gate_sealed');
  } };
  const reject = () => { lastFailure ??= { stage: diagnosticStage, reason: expired() ? 'solver_deadline' : 'guard_rejected', at_ms: Date.now(), ordinal };
    violations++; revoke(); throw new Error('live_guard_rejected'); };
  const scope = request => request?.sessionID === template.sessionID && request.agent === AGENT && same(request.model, MODEL_REF);
  const evidence = () => ({ incarnation, purpose, phase, session_sha256: hash(template.sessionID), prompt_sha256: template.prompt_sha256,
    ordinal, released, model_requests: modelRequests, violations, tool_calls: calls.size, active_tools: activeTools,
    records: structuredClone(records), pending: pending && structuredClone(pending) });
  return {
    revoke, seal, evidence,
    // Separate observational surface: never consulted by permission/release logic.
    // Retains the last pending digest and bounded release records after revocation.
    diagnostics() { return { schema: 'real-use-native-guard-diagnostics/v1', incarnation, purpose, phase,
      session_sha256: hash(template.sessionID), prompt_sha256: template.prompt_sha256, model_sha256: hash(MODEL_REF),
      message_sha256: lastMessageHash, ordinal, released, model_requests: modelRequests, violations,
      tool_calls: calls.size, active_tools: activeTools, transport_counts: { ...transportCounts },
      stage: diagnosticStage, at_ms: diagnosticTime, solver_deadline_ms: solverDeadline, last_failure: lastFailure && { ...lastFailure },
      pending: pending ? { ordinal: pending.ordinal, message_sha256: hash(pending.message_id), messages_sha256: pending.messages_sha256, digest: pending.digest } : null,
      last_pending: lastPending && { ...lastPending }, records: structuredClone(records.slice(-32)),
      records_count: records.length, records_sha256: hash(records), records_truncated: records.length > 32 }; },
    context(context) {
      sealed();
      observe('context');
      if (expired() || !['armed', 'released'].includes(phase) || activeTools || ordinal >= 200 || (ordinal && modelRequests !== released) || !scope(context) ||
          Object.keys(context).some(k => !['sessionID', 'agent', 'model', 'system', 'messages', 'tools', 'options'].includes(k))) return reject();
      const messageID = context.messages?.[0]?.id;
      if (!nativeMessageID(messageID) || (firstMID && firstMID !== messageID)) return reject();
      const expected = withNativeMessage(template, messageID);
      if (!same(context.system, expected.system) || !same(context.tools, Object.fromEntries(namesFor(condition).map(n => [n, DEFINITIONS[n]]))) ||
          !Array.isArray(context.messages) || context.messages.length > 512 || context.messages.filter(m => m.role === 'user').length !== 1 ||
          !same(context.messages[0], expected.messages[0])) return reject();
      if (!ordinal && !same(context.messages, expected.messages)) return reject();
      ordinal++; phase = 'pending'; http = handshake = sends = 0;
      const messagesHash = hash(normalizeHistory(context.messages));
      const digest = hash({ incarnation, invocation, ordinal, session: template.sessionID, messageID, messagesHash });
      pending = freeze({ ordinal, message_id: messageID, messages_sha256: messagesHash, digest });
      lastMessageHash = hash(messageID); lastPending = { ordinal, message_sha256: lastMessageHash, messages_sha256: messagesHash, digest };
      observe('pending');
      return new Promise(done => { resolve = done; timer = setTimeout(() => {
        lastFailure = { stage: 'pending', reason: 'pending_timeout', at_ms: Date.now(), ordinal }; violations++; revoke();
      }, 20000); }).then(ok => {
        sealed(false); // Cancelling an already-pending continuation is the seal itself, not a new attempt.
        if (ok) observe('context_continuation');
        if (expired() || !ok || phase !== 'pending' || hash(normalizeHistory(context.messages)) !== messagesHash || !scope(context) ||
            !same(context.system, expected.system) || !same(context.tools, Object.fromEntries(namesFor(condition).map(n => [n, DEFINITIONS[n]])))) return reject();
        firstMID ??= messageID; released = ordinal; pending = null;
        records.push({ ordinal, messages_sha256: messagesHash, system_sha256: hash(context.system), tools_sha256: hash(context.tools),
          session_sha256: hash(context.sessionID), model_sha256: hash(context.model) });
        if (purpose === 'abort-control') { phase = 'control-aborted'; throw new Error('real_use_live_handoff_control_aborted'); }
        phase = 'released';
        observe('released');
      });
    },
    bind(request) {
      sealed();
      observe('bind');
      const deadlineKeys = purpose === 'production' ? ['solver_deadline'] : [];
      if (!exact(request, ['nonce', 'incarnation', 'session_id', 'message_id', 'invocation_token', 'digest', 'messages_sha256', 'ordinal', ...deadlineKeys]) ||
          request.nonce !== nonce || phase !== 'pending' || !resolve || request.incarnation !== incarnation || request.invocation_token !== invocation ||
          request.session_id !== template.sessionID || request.message_id !== pending.message_id || request.ordinal !== ordinal ||
           request.digest !== pending.digest || request.messages_sha256 !== pending.messages_sha256) return reject();
      // A host-side AbortSignal cannot undo an already delivered RPC. Check the
      // immutable launch deadline again in context continuation and transport.
      if (purpose === 'production') {
        if (!Number.isSafeInteger(request.solver_deadline) || request.solver_deadline <= Date.now() || request.solver_deadline > Date.now() + 300000 ||
            (solverDeadline !== null && request.solver_deadline !== solverDeadline)) return reject();
        solverDeadline = request.solver_deadline;
      }
      const done = resolve; resolve = null; clearTimeout(timer); done(true);
    },
    transport(kind, request) {
      sealed();
      observe(['model.request', 'http.request', 'experimental.ws.handshake', 'experimental.ws.send'].includes(kind) ? kind : 'transport_unknown');
      if (expired() || purpose !== 'production' || phase !== 'released' || !scope(request) || request.kind !== 'primary') return reject();
      if (kind === 'model.request') { if (modelRequests !== released - 1) return reject(); modelRequests++; transportCounts.model++; return; }
      if (modelRequests !== released) return reject();
      if (kind === 'http.request') { if (handshake || sends || ++http !== 1) return reject(); }
      else if (kind === 'experimental.ws.handshake') { if (http || ++handshake !== 1) return reject(); }
      else if (kind === 'experimental.ws.send') { if (http || handshake !== 1 || ++sends !== 1) return reject(); }
      else return reject();
      transportCounts[kind === 'http.request' ? 'http' : kind === 'experimental.ws.handshake' ? 'ws_handshake' : 'ws_send']++;
    },
    permission(evaluation) {
      if (phase === 'sealed') { violations++; lastFailure ??= { stage: 'sealed', reason: 'guard_rejected', at_ms: Date.now(), ordinal }; return false; }
      observe('permission');
      const allowed = !expired() && purpose === 'production' && phase === 'released' && modelRequests === released && evaluation.sessionID === template.sessionID &&
        (evaluation.agent === undefined || evaluation.agent === AGENT) && namesFor(condition).includes(evaluation.action);
      if (!allowed) { lastFailure = { stage: 'permission', reason: expired() ? 'solver_deadline' : 'guard_rejected', at_ms: Date.now(), ordinal }; violations++; revoke(); }
      return allowed;
    },
    tool(name, context) {
      sealed();
      observe('tool');
      if (expired() || purpose !== 'production' || phase !== 'released' || modelRequests !== released || context.sessionID !== template.sessionID || context.agent !== AGENT ||
          !nativeMessageID(context.messageID) || typeof context.id !== 'string' || !context.id.length || calls.has(context.id) ||
          calls.size >= 200 || !namesFor(condition).includes(name)) return reject();
      calls.add(context.id); activeTools++;
      let done = false;
      return () => { if (!done) { done = true; activeTools--; observe('tool_settled'); } };
    },
    deny() { observe('deny'); return reject(); },
  };
}

export function verifyFrozenAssets(operator) {
  const expected = ['bench/v4/real-use/runtime-tools.mjs', 'bench/v4/real-use/runtime-backend.mjs',
    'bench/v4/real-use/lib/snapshot-tools.mjs', 'bench/v3/arxivlean/lib/eval-sandbox.mjs',
    '.opencode/plugins/math-toolkit/lib/search.js', '.opencode/plugins/math-toolkit/lib/format.js',
    '.opencode/plugins/math-toolkit/scripts/math_compute.py', 'package.json'];
  if (!operator || !Array.isArray(operator.sources) || !same(operator.sources.map(item => item.file), expected) ||
      hash(operator.sources) !== operator.sourceGraphHash) throw new Error('frozen_asset_manifest_mismatch');
  const root = realpathSync(operator.assetRoot);
  for (const source of operator.sources) {
    const file = realpathSync(path.join(root, source.file));
    if (!file.startsWith(root + path.sep) || hash(readFileSync(file)) !== source.sha256) throw new Error('frozen_asset_source_mismatch');
  }
}

export async function createFrozenRuntimePlugin(Plugin, bindings, operator) {
  verifyFrozenAssets(operator);
  if (operator.sourceGraphHash !== bindings.backend_sha256 || operator.expectedManifestHash !== bindings.snapshot_sha256 ||
      operator.backend?.owner?.nonce !== bindings.nonce) throw new Error('frozen_runtime_binding_mismatch');
  const base = path.join(operator.assetRoot, 'bench', 'v4', 'real-use');
  const { createRuntimeBackend } = await import(pathToFileURL(path.join(base, 'runtime-backend.mjs')).href);
  const { createRuntimeTools } = await import(pathToFileURL(path.join(base, 'runtime-tools.mjs')).href);
  const backend = createRuntimeBackend(operator.backend);
  const runtime = await createRuntimeTools({ condition: bindings.condition, snapshotRoot: operator.snapshotRoot,
    expectedManifestHash: operator.expectedManifestHash, backend, limits: { calls: 200 } });
  verifyFrozenAssets(operator);
  if (!runtime.imageInspected || runtime.evidence !== 'local-docker' || runtime.admission !== 'not_assessed' ||
      runtime.canAuthorizeModelRun !== false || runtime.snapshotManifestHash !== bindings.snapshot_sha256) throw new Error('runtime_factory_evidence_mismatch');
  const identity = runtime.backendIdentity;
  const evidence = freeze({ backend_id: identity.backend_id, image: identity.image, evidence: identity.evidence,
    policy_sha256: identity.policy_sha256, worker_sha256: identity.worker_sha256,
    docker_endpoint_sha256: identity.docker_endpoint_sha256, owner_sha256: hash(identity.owner),
    image_inspection_sha256: runtime.imageInspectionHash, image_inspected: runtime.imageInspected,
    admission: runtime.admission, can_authorize_model_run: runtime.canAuthorizeModelRun,
    inventory_sha256: runtime.inventoryHash, source_graph_sha256: operator.sourceGraphHash,
    sources: structuredClone(operator.sources) });
  return createRuntimePlugin(Plugin, { ...bindings, tools: runtime.tools, runtime_evidence: evidence });
}

export async function cleanupFrozenBackend(operator) {
  verifyFrozenAssets(operator);
  const { cleanupOwned } = await import(pathToFileURL(path.join(operator.assetRoot, 'bench/v4/real-use/runtime-backend.mjs')).href);
  const { ledgerPath, owner, dockerExecutable, endpoint } = operator.backend;
  const result = await cleanupOwned({ ledgerPath, owner, dockerExecutable, endpoint });
  // No raw endpoint, ledger, Docker output, environment or exception is returned.
  return { schema: 'real-use-bridge-backend-cleanup/v1', status: result.status,
    ledger_integrity: result.ledger_integrity, owned_entries: result.results.length,
    endpoint_sha256: hash(endpoint), source_graph_sha256: operator.sourceGraphHash };
}

export function inspectInventory(tools, plugins, options) {
  const expected = namesFor(options.condition).sort();
  const reasons = [];
  if (!Array.isArray(tools) || !Array.isArray(plugins)) throw new Error('malformed_inventory');
  const projectedTools = tools.map(tool => {
    const name = safeID(tool.name), id = safeID(tool.id);
    const definition = DEFINITIONS[name];
    // Reject schemas/options before returning them; never serialize arbitrary plugin objects.
    const matches = !!definition && same(tool.input, definition.input) && tool.description === definition.description &&
      same(tool.options, { codemode: false, permission: name }) && id === name;
    if (!matches) reasons.push(`unexpected_tool:${id}`);
    return { id, name, normalized_name: id, schema: matches ? definition.input : null,
      schema_sha256: matches ? hash(definition.input) : null, options: matches ? tool.options : null, matches };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!same(projectedTools.map(tool => tool.name).sort(), expected)) reasons.push('tool_set_mismatch');
  const projectedPlugins = plugins.map(plugin => {
    const id = safeID(plugin.id), source_type = ['builtin', 'local', 'package', 'sdk'].includes(plugin.source?.type) ? plugin.source.type : 'invalid';
    let source_sha256 = source_type === 'builtin' ? options.cli_sha256 : null;
    if (id === PLUGIN_ID && source_type === 'local' && plugin.source.path === options.entryPath) source_sha256 = hash(readFileSync(options.entryPath));
    const approved = options.approvedPlugins.some(item => item.id === id && item.source_type === source_type && item.source_sha256 === source_sha256);
    const active = plugin.state?.status === 'active';
    if (!approved || !active) reasons.push(`unapproved_plugin:${id}`);
    return { id, source_type, source_sha256, active, approved };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!same(projectedPlugins.map(item => item.id).sort(), options.approvedPlugins.map(item => item.id).sort())) reasons.push('plugin_set_mismatch');
  if (!projectedPlugins.some(item => item.id === PLUGIN_ID && item.active && item.approved)) reasons.push('guard_missing');
  return { tools: projectedTools, plugins: projectedPlugins, reasons };
}

// First-request template is deliberately exact, not a hash of arbitrary observed history.
// Continued conversations remain blocked until the parent supplies a reviewed capability/state machine.
export function inspectContext(context, options) {
  const reasons = [];
  if (context.agent !== AGENT) reasons.push('agent_mismatch');
  // Explicit parent-selected no-overlay variant, never learned from context.
  if (!exact(context.model, ['providerID', 'id', 'variant']) || !same(context.model, MODEL_REF)) reasons.push('model_mismatch');
  if (!options.requestTemplate || context.sessionID !== options.requestTemplate.sessionID) reasons.push('session_mismatch');
  if (!options.requestTemplate || !same(context.system, options.requestTemplate.system)) reasons.push('system_template_unapproved');
  if (!options.requestTemplate || !same(context.messages, options.requestTemplate.messages)) reasons.push('history_template_unapproved');
  const expected = Object.fromEntries(namesFor(options.condition).map(name => [name, DEFINITIONS[name]]));
  if (!same(context.tools, expected)) reasons.push('request_tools_mismatch');
  return { agent: context.agent === AGENT ? AGENT : 'unexpected', model_matches: !reasons.includes('model_mismatch'),
    model_diagnostic: { shape: diagnosticShape(context.model), providerID_equals_expected: context.model?.providerID === 'opencode-go',
      id_equals_expected: context.model?.id === 'deepseek-v4.1-flash', variant_is_undefined: context.model?.variant === undefined },
    session_sha256: typeof context.sessionID === 'string' ? hash(context.sessionID) : null,
    session_matches: !reasons.includes('session_mismatch'),
    system_matches: !reasons.includes('system_template_unapproved'), history_matches: !reasons.includes('history_template_unapproved'),
    system_part_sha256: Array.isArray(context.system) ? context.system.slice(0, 32).map(part => typeof part?.text === 'string' && part.text.length <= 65536 ? hash(part.text) : null) : [],
    message_id_sha256: Array.isArray(context.messages) ? context.messages.slice(0, 32).map(message => typeof message?.id === 'string' ? hash(message.id) : null) : [],
    first_message_diagnostic: { shape: diagnosticShape(context.messages?.[0]), metadata_shape: diagnosticShape(context.messages?.[0]?.metadata),
      content_matches: same(context.messages?.[0]?.content, options.requestTemplate?.messages?.[0]?.content),
      content: Array.isArray(context.messages?.[0]?.content) ? context.messages[0].content.slice(0, 8).map(part => ({ shape: diagnosticShape(part),
        text_sha256: typeof part?.text === 'string' ? hash(part.text) : null,
        difference: promptDifference(part?.text, options.requestTemplate?.messages?.[0]?.content?.[0]?.text),
        text_matches: part?.text === options.requestTemplate?.messages?.[0]?.content?.[0]?.text,
        text_matches_dash_prefix: part?.text === `-- ${options.requestTemplate?.messages?.[0]?.content?.[0]?.text}` })) : [],
      metadata_empty_or_absent: context.messages?.[0]?.metadata === undefined || same(context.messages?.[0]?.metadata, {}) },
    tool_schema_sha256: Object.fromEntries(Object.entries(context.tools ?? {}).slice(0, 64).map(([name, tool]) =>
      [safeID(name), DEFINITIONS[name] && same(tool.input, DEFINITIONS[name].input) ? hash(tool.input) : null])),
    tool_names: Object.keys(context.tools ?? {}).map(safeID).sort(), reasons };
}

export function createRuntimePlugin(Plugin, input) {
  // Operator-only construction. No JSON, RPC, environment variable or model argument grants admission.
  if (!input || Object.keys(input).some(key => !['condition', 'nonce', 'project_sha256', 'snapshot_sha256', 'config_sha256', 'runtime_sha256', 'cli_sha256', 'entryPath', 'configPath', 'approvedPlugins', 'tools', 'backend_sha256', 'runtime_evidence', 'requestTemplate', 'run_id', 'episode_id', 'profile_id', 'protocol_hash', 'registration_sha256'].includes(key))) throw new Error('invalid_runtime_options');
  if (['profile_id', 'protocol_hash', 'registration_sha256'].some(key => input[key] !== undefined) &&
      (!isNativeCompletionProfile(input.profile_id, input.protocol_hash) || !digest(input.registration_sha256))) throw new Error('invalid_runtime_profile');
  namesFor(input.condition);
  for (const key of ['project_sha256', 'config_sha256', 'runtime_sha256', 'cli_sha256']) if (!digest(input[key])) throw new Error('invalid_runtime_binding');
  if (typeof input.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(input.nonce)) throw new Error('invalid_nonce');
  if (input.requestTemplate !== undefined && !validTemplate(input.requestTemplate)) throw new Error('invalid_request_template');
  if (!Array.isArray(input.approvedPlugins) || input.approvedPlugins.some(item => !exact(item, ['id', 'source_type', 'source_sha256']) || safeID(item.id) !== item.id || !digest(item.source_sha256)) || new Set(input.approvedPlugins.map(item => item.id)).size !== input.approvedPlugins.length) throw new Error('invalid_plugin_registry');
  // Accept the actual createRuntimeTools(...).tools records, not model-supplied
  // callback definitions. Preserve the factory's handler/schema object identities.
  const callbacks = input.tools;
  const options = freeze(structuredClone(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'tools'))));
  if (callbacks && (!digest(options.backend_sha256) || !Object.isFrozen(callbacks) ||
      !same(Object.keys(callbacks).sort(), namesFor(options.condition).sort()) || Object.entries(callbacks).some(([name, tool]) =>
        !tool || !Object.isFrozen(tool) || typeof tool.handler !== 'function' || tool.name !== name || tool.permission !== name ||
        !same(tool.options, { codemode: false }) || tool.description !== DEFINITIONS[name].description ||
        !same(tool.inputSchema, DEFINITIONS[name].input)))) throw new Error('invalid_frozen_backend');
  const runtimeHash = hash(readFileSync(fileURLToPath(import.meta.url)));
  if (runtimeHash !== options.runtime_sha256) throw new Error('runtime_source_mismatch');
  if (hash(readFileSync(options.configPath)) !== options.config_sha256) throw new Error('native_config_source_mismatch');
  const policy = permissionsFor(options.condition);
  let setupComplete = false, requests = 0, lastRequest = null, templateBound = false, boundTemplate;
  let incarnation, state = 'audit-only', abortCount = 0, abortRecord = null, pending = null, release, pendingTimer, invocation, bindMode;
  let liveGate = null;
  const guardCounts = Object.fromEntries(['context', 'model.request', 'http.request', 'experimental.ws.handshake', 'experimental.ws.send', 'compaction', 'generate', 'title'].map(name => [name, 0]));
  return Plugin.define({ id: PLUGIN_ID, async setup(ctx) {
    incarnation = randomUUID();
    const registrations = [];
    const register = async value => { registrations.push(await value); };
    const block = () => { throw new Error('real_use_audit_only_dispatch_blocked'); };
    const revoke = () => { liveGate?.revoke(); state = 'revoked'; clearTimeout(pendingTimer); release?.(false); release = null; };
    const commitAbort = () => {
      if (state === 'revoked' || requests !== 1 || lastRequest?.reasons.length || abortCount) { revoke(); block(); }
      // No await/callback/IO between this record and the unconditional throw.
      abortCount++;
      abortRecord = freeze({ abort_committed: true, request_ordinal: requests, ...guardBinding(options, incarnation, boundTemplate) });
      state = 'bound-abort';
      block();
    };
    // Unscoped provider hooks cover primary and auxiliary request kinds.
    for (const kind of ['model.request', 'http.request', 'experimental.ws.handshake', 'experimental.ws.send', 'compaction', 'generate']) await register(ctx.session.hook(kind, request => {
      if (liveGate) return liveGate.transport(kind, request);
      guardCounts[kind]++; block();
    }));
    await register(ctx.session.hook('retry', retry => { retry.decision = { retry: false }; if (liveGate) return liveGate.deny(); }));
    await register(ctx.session.hook('title', title => { if (liveGate) return liveGate.deny(); guardCounts.title++; title.result = TITLE; }));
    await register(ctx.session.hook('context', context => {
      if (liveGate) return liveGate.context(context);
      requests++;
      guardCounts.context++;
      if (requests !== 1 || state === 'revoked') { revoke(); block(); }
      if (bindMode === 'native-cli' && state === 'armed-native-cli-binding') {
        const messageID = context.messages?.[0]?.id;
        if (!nativeMessageID(messageID)) { revoke(); block(); }
        const candidate = withNativeMessage(boundTemplate, messageID);
        lastRequest = inspectContext(context, { ...options, requestTemplate: candidate });
        if (lastRequest.reasons.length) { revoke(); block(); }
        const digest = hash({ invocation, incarnation, request_ordinal: requests, template_sha256: hash(candidate), binding: guardBinding(options, incarnation, candidate) });
        pending = freeze({ message_id: messageID, session_sha256: hash(candidate.sessionID), request_ordinal: 1, digest, template_sha256: hash(candidate) });
        state = 'pending-first-context';
        return new Promise(resolve => { release = resolve; pendingTimer = setTimeout(revoke, 20000); }).then(approved => {
          if (!approved || state !== 'pending-first-context') { revoke(); block(); }
          boundTemplate = candidate;
          commitAbort();
        });
      }
      lastRequest = inspectContext(context, { ...options, requestTemplate: templateBound ? boundTemplate : undefined });
      if (!templateBound) lastRequest.reasons.push('template_not_bound');
      if (requests !== 1) lastRequest.reasons.push('repeated_context_request');
      // Evidence is bounded and excludes text, headers, settings and raw session IDs.
      commitAbort();
    }));
    await register(ctx.permission.hook('evaluate', evaluation => { evaluation.effect = liveGate?.permission(evaluation) ? 'allow' : 'deny'; }));
    const restrictAgents = editor => {
      for (const agent of editor.list()) if (agent.id !== AGENT) editor.remove(agent.id);
      editor.update(AGENT, agent => { agent.system = SYSTEM; agent.permissions = structuredClone(policy); agent.mode = 'primary'; agent.model = structuredClone(MODEL_REF); });
      editor.default(AGENT);
    };
    const restrictTools = editor => {
      for (const tool of editor.list()) editor.remove(tool.id);
      for (const name of namesFor(options.condition)) {
        const definition = callbacks ? { description: callbacks[name].description, input: callbacks[name].inputSchema } : DEFINITIONS[name];
        editor.add({ name, ...definition, options: { codemode: false, permission: name },
          async execute(args, context) {
            if (!callbacks) throw new Error('frozen_backend_unavailable');
            // This gate has no JSON/nonce override. A future parent-owned capability
            // must replace it only after runtime + checker controls and hook proof.
            if (!liveGate) throw new Error('audit_only_tool_invocation_blocked');
            const done = liveGate.tool(name, context);
            try {
              const output = await callbacks[name].handler(args, { signal: context.signal });
              return { content: typeof output === 'string' ? output : JSON.stringify(output) };
            } finally { done(); }
          } });
      }
    };
    await register(ctx.agent.transform(restrictAgents));
    await register(ctx.tool.transform(restrictTools));
    let finalTransformsInstalled = false;
    await register(ctx.rpc.register({ id: RPC_ID, events: {}, methods: { audit: {
      input: object({ nonce: { type: 'string' } }, ['nonce']), output: { type: 'object' },
    }, bindContext: {
      input: object({ nonce: { type: 'string' }, incarnation: { type: 'string' }, mode: { enum: ['direct', 'native-cli'] }, invocation_token: { type: 'string' }, template_sha256: { type: 'string' }, catalog_display_name: { type: 'string', maxLength: 256 } }, ['nonce', 'incarnation', 'mode', 'invocation_token', 'template_sha256', 'catalog_display_name']), output: { type: 'object' },
    }, pending: {
      input: object({ nonce: { type: 'string' }, incarnation: { type: 'string' } }, ['nonce', 'incarnation']), output: { type: 'object' },
    }, bindLiveMessage: {
      input: object({ ...Object.fromEntries(['nonce', 'incarnation', 'episode_id', 'session_id', 'message_id', 'prompt_sha256', 'invocation_token', 'digest'].map(key => [key, { type: 'string' }])), store_projection: { type: 'object' } },
        ['nonce', 'incarnation', 'episode_id', 'session_id', 'message_id', 'prompt_sha256', 'invocation_token', 'digest', 'store_projection']), output: { type: 'object' },
    }, armEpisode: {
      input: object(Object.fromEntries(['nonce', 'incarnation', 'session_id', 'invocation_token', 'purpose', 'audit_binding_sha256', 'episode_id'].map(key => [key, { type: 'string' }])),
        ['nonce', 'incarnation', 'session_id', 'invocation_token', 'purpose', 'audit_binding_sha256', 'episode_id']), output: { type: 'object' },
    }, episodeStatus: {
      input: object({ nonce: { type: 'string' }, incarnation: { type: 'string' } }, ['nonce', 'incarnation']), output: { type: 'object' },
    }, bindEpisodeContext: {
      input: object({ ...Object.fromEntries(['nonce', 'incarnation', 'session_id', 'message_id', 'invocation_token', 'digest', 'messages_sha256'].map(key => [key, { type: 'string' }])), ordinal: { type: 'integer' }, solver_deadline: { type: 'integer' } },
        ['nonce', 'incarnation', 'session_id', 'message_id', 'invocation_token', 'digest', 'messages_sha256', 'ordinal']), output: { type: 'object' },
    }, revokeEpisode: {
      input: object({ nonce: { type: 'string' }, incarnation: { type: 'string' } }, ['nonce', 'incarnation']), output: { type: 'object' },
    }, sealEpisode: {
      input: object({ nonce: { type: 'string' }, incarnation: { type: 'string' } }, ['nonce', 'incarnation']), output: { type: 'object' },
    } } }, { async bindContext(request) {
      if (!exact(request, ['nonce', 'incarnation', 'mode', 'invocation_token', 'template_sha256', 'catalog_display_name']) || request.nonce !== options.nonce || request.incarnation !== incarnation ||
          !['direct', 'native-cli'].includes(request.mode) || !/^[a-f0-9-]{36}$/.test(request.invocation_token) || !setupComplete || templateBound || requests || state !== 'audit-only' ||
          !options.requestTemplate) { revoke(); throw new Error('context_binding_rejected'); }
      state = 'binding'; // Prevent concurrent authenticated rebind during model lookup.
      const models = await ctx.model.list();
      const selected = models.data?.filter(model => model.providerID === 'opencode-go' && model.id === 'deepseek-v4.1-flash');
      if (selected?.length !== 1 || selected[0].name !== request.catalog_display_name) { revoke(); throw new Error('context_catalog_binding_rejected'); }
      const finalTemplate = withModelIdentity(options.requestTemplate, request.catalog_display_name);
      if (request.template_sha256 !== hash(finalTemplate) || state !== 'binding') { revoke(); throw new Error('context_binding_rejected'); }
      // Binding enables evidence matching only, never execution or inference.
      boundTemplate = finalTemplate;
      templateBound = true;
      invocation = request.invocation_token; bindMode = request.mode;
      state = bindMode === 'native-cli' ? 'armed-native-cli-binding' : 'armed-direct';
      return { bound: true, incarnation, binding_sha256: hash(guardBinding(options, incarnation, boundTemplate)), template_sha256: hash(boundTemplate), production_admission: false };
    }, async pending(request) {
      if (!exact(request, ['nonce', 'incarnation']) || request.nonce !== options.nonce || request.incarnation !== incarnation) { revoke(); throw new Error('native_binding_rejected'); }
      return { incarnation, state, pending };
    }, async bindLiveMessage(request) {
      const keys = ['nonce', 'incarnation', 'episode_id', 'session_id', 'message_id', 'prompt_sha256', 'invocation_token', 'digest', 'store_projection'];
      if (!exact(request, keys) || request.nonce !== options.nonce || request.incarnation !== incarnation || request.episode_id !== options.condition ||
          state !== 'pending-first-context' || !release || request.session_id !== boundTemplate.sessionID || request.message_id !== pending?.message_id ||
          request.prompt_sha256 !== boundTemplate.prompt_sha256 || request.invocation_token !== invocation || request.digest !== pending.digest ||
          !same(request.store_projection, { id: pending.message_id, type: 'user', text: boundTemplate.messages[0].content[0].text, metadata: {} })) {
        revoke(); throw new Error('native_binding_rejected');
      }
      const resume = release; release = null; clearTimeout(pendingTimer); resume(true);
      return { accepted: true, production_admission: false, incarnation, message_sha256: hash(pending.message_id) };
    }, async armEpisode(request) {
      const keys = ['nonce', 'incarnation', 'session_id', 'invocation_token', 'purpose', 'audit_binding_sha256', 'episode_id'];
      if (!exact(request, keys) || request.nonce !== options.nonce || request.incarnation !== incarnation || liveGate || state !== 'bound-abort' ||
          abortCount !== 1 || requests !== 1 || request.audit_binding_sha256 !== hash(abortRecord) || request.episode_id !== options.episode_id ||
          !/^ses_[a-f0-9-]{36}$/.test(request.session_id) || request.session_id === boundTemplate.sessionID || !/^[a-f0-9-]{36}$/.test(request.invocation_token) ||
          !['production', 'abort-control'].includes(request.purpose) || (request.purpose === 'production' && (!callbacks || options.run_id === 'audit-only')) ||
          Object.entries(guardCounts).some(([key, count]) => count !== (key === 'context' ? 1 : 0))) { revoke(); throw new Error('episode_arm_rejected'); }
      // This RPC is private to the authenticated owned host. Production callers
      // reach it only after consumeEpisodeCapability succeeds in bridge.admit.
      liveGate = createLiveGate({ template: { ...boundTemplate, sessionID: request.session_id }, condition: options.condition,
        incarnation, invocation: request.invocation_token, purpose: request.purpose, nonce: options.nonce });
      return { armed: true, incarnation, session_sha256: hash(request.session_id), purpose: request.purpose };
    }, async episodeStatus(request) {
      if (!exact(request, ['nonce', 'incarnation']) || request.nonce !== options.nonce || request.incarnation !== incarnation || !liveGate) { revoke(); throw new Error('episode_status_rejected'); }
      return { ...liveGate.evidence(), diagnostics: liveGate.diagnostics() };
    }, async bindEpisodeContext(request) {
      if (!request || request.nonce !== options.nonce || !liveGate) {
        revoke(); throw new Error('episode_binding_rejected');
      }
      liveGate.bind(request);
      return { bound: true, incarnation, ordinal: request.ordinal };
    }, async revokeEpisode(request) {
      if (!exact(request, ['nonce', 'incarnation']) || request.nonce !== options.nonce || request.incarnation !== incarnation) { revoke(); throw new Error('episode_revoke_rejected'); }
      liveGate?.revoke(); return { revoked: true, incarnation, diagnostics: liveGate?.diagnostics() ?? null };
    }, async sealEpisode(request) {
      if (!exact(request, ['nonce', 'incarnation']) || request.nonce !== options.nonce || request.incarnation !== incarnation || !liveGate ||
          !isNativeCompletionProfile(options.profile_id, options.protocol_hash)) { revoke(); throw new Error('episode_seal_rejected'); }
      liveGate.seal(); return { sealed: liveGate.evidence().phase === 'sealed', incarnation, evidence: liveGate.evidence(), diagnostics: liveGate.diagnostics() };
    }, async audit(request) {
      if (!exact(request, ['nonce']) || request.nonce !== options.nonce || !setupComplete) throw new Error('audit_request_rejected');
      // Only post-setup: tool.list during a boot transform deadlocks the core reload.
      // Native browser/config transforms may register after external plugin setup.
      // First settle all boot tools, then install our final transforms. Inventory
      // is still independently checked, and every request remains blocked.
      await ctx.tool.list();
      if (!finalTransformsInstalled) {
        await register(ctx.agent.transform(restrictAgents));
        await register(ctx.tool.transform(restrictTools));
        finalTransformsInstalled = true;
      }
      // Agent/plugin endpoints retain Location.response {location,data}; tool.list is direct.
      const [tools, pluginResponse, agentResponse] = await Promise.all([ctx.tool.list(), ctx.plugin.list(), ctx.agent.list()]);
      const plugins = pluginResponse.data, agents = agentResponse.data;
      if (!Array.isArray(agents)) throw new Error('malformed_agent_inventory');
      const inventory = inspectInventory(tools, plugins, options);
      if (hash(readFileSync(options.configPath)) !== options.config_sha256) inventory.reasons.push('native_config_source_changed');
      const agent = agents.find(item => item.id === AGENT);
      const policyMatches = agents.length === 1 && same(agent?.permissions, policy) && agent?.system === SYSTEM && agent?.mode === 'primary' && same(agent?.model, MODEL_REF);
      if (!policyMatches) inventory.reasons.push('effective_agent_policy_mismatch');
      if (ctx.app.version !== '2.0.29') inventory.reasons.push('runtime_version_mismatch');
      return { schema: 'real-use-bridge-audit/v1', mode: 'audit-only', production_admission: false,
        incarnation, abort_count: abortCount, abort_record: abortRecord, guard_state: state,
        nonce: options.nonce, condition: options.condition, project_sha256: options.project_sha256,
        config_sha256: options.config_sha256, runtime_sha256: runtimeHash, cli_sha256: options.cli_sha256,
        snapshot_sha256: options.snapshot_sha256 ?? null, backend_sha256: options.backend_sha256 ?? null,
        runtime_evidence: options.runtime_evidence ?? null,
        backend_available: !!callbacks, runtime_version: ctx.app.version === '2.0.29' ? '2.0.29' : 'unexpected',
        effective_permissions: policyMatches ? policy : null, permission_hook: 'deny-all-audit-only',
        ...inventory, inventory_passed: inventory.reasons.length === 0, requests, last_request: lastRequest,
        guard_counts: { ...guardCounts }, template_bound: templateBound,
        dispatch_proof: DISPATCH_PROOF, auth_http_may_precede: true, stateless_generate_covered: false };
    } }));
    setupComplete = true;
    return async () => { revoke(); setupComplete = false; for (const registration of registrations.reverse()) await registration.dispose(); };
  } });
}
