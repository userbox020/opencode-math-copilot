import { createHash } from 'node:crypto';
import { createSnapshotTools, GENERIC_DEFINITIONS, ON_ONLY_DEFINITIONS } from './lib/snapshot-tools.mjs';
import { COMPILE_SCHEMA, COMPUTE_SCHEMA, RUNTIME_BACKEND_POLICY_HASH, COMPUTE_WORKER_HASH,
  runtimeBackendIdentity, validateCompileInput, validateComputeInput } from './runtime-backend.mjs';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mappings = Object.freeze({ approved_list: 'list_sources', approved_read: 'read_source', approved_search: 'search_source', approved_pdf_text: 'read_pdf' });
const named = (name, definition) => ({ name, ...definition, options: { codemode: false }, permission: name });
export const BASELINE_DEFINITIONS = freeze({
  ...Object.fromEntries(Object.entries(mappings).map(([name, source]) => [name, named(name, GENERIC_DEFINITIONS[source])])),
  compute: named('compute', { description: 'Bounded allowlisted symbolic computation in the fixed isolated Python/SymPy container. No arbitrary Python or host execution.', inputSchema: COMPUTE_SCHEMA }),
  lean_compile: named('lean_compile', { description: 'Compile proposed Lean against the fixed isolated Mathlib image. Compilation is NOT theorem/type/axiom proof verification; proof status remains not_assessed.', inputSchema: COMPILE_SCHEMA }),
});
export const NAVIGATION_DEFINITIONS = freeze(Object.fromEntries(Object.entries(ON_ONLY_DEFINITIONS).map(([name, definition]) => [name, named(name, definition)])));
export const RUNTIME_INVENTORY_HASHES = freeze({
  baseline: hash(BASELINE_DEFINITIONS), 'plugin-off': hash(BASELINE_DEFINITIONS),
  'plugin-on': hash({ ...BASELINE_DEFINITIONS, ...NAVIGATION_DEFINITIONS }),
});

// Operator-only factory. Image inspection binds identity, not controls/readiness
// or permission to launch a model run. Fixture inspection is never production evidence.
export async function createRuntimeTools(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !['condition', 'snapshotRoot', 'expectedManifestHash', 'backend', 'limits'].includes(key)) ||
      !['plugin-on', 'plugin-off'].includes(config.condition) || !/^[a-f0-9]{64}$/.test(config.expectedManifestHash ?? '')) throw new Error('invalid_runtime_tool_configuration');
  const limits = config.limits === undefined ? {} : config.limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => key !== 'calls') ||
      (limits.calls !== undefined && (!Number.isSafeInteger(limits.calls) || limits.calls < 1 || limits.calls > 200))) throw new Error('invalid_runtime_limits');
  const backend = config.backend, identity = runtimeBackendIdentity(backend);
  if (!identity || !['fixture', 'local-docker'].includes(identity.evidence) || identity.policy_sha256 !== RUNTIME_BACKEND_POLICY_HASH || identity.worker_sha256 !== COMPUTE_WORKER_HASH) throw new Error('runtime_backend_identity_required');
  const calls = limits.calls ?? 200;
  const condition = config.condition;
  const snapshot = createSnapshotTools({ snapshotRoot: config.snapshotRoot, expectedManifestHash: config.expectedManifestHash, callBudget: calls });
  const inspection = await backend.inspectImage();
  if (Object.entries(identity).some(([key, value]) => JSON.stringify(inspection[key]) !== JSON.stringify(value)) ||
      !/^[a-f0-9]{64}$/.test(inspection.inspect_sha256 ?? '')) throw new Error('runtime_backend_inspection_mismatch');
  let remaining = calls;
  const bounded = handler => (input, options) => {
    if (remaining-- <= 0) throw new Error('runtime_tool_call_budget_exhausted');
    return handler(input, options);
  };
  const handlers = {
    ...Object.fromEntries(Object.entries(mappings).map(([name, source]) => [name, snapshot.generic[source].handler])),
    compute: (input, options) => backend.compute(validateComputeInput(input), options),
    lean_compile: (input, options) => backend.compile(validateCompileInput(input), options),
    ...Object.fromEntries(Object.entries(snapshot.onOnly).map(([name, tool]) => [name, tool.handler])),
  };
  const definitions = condition === 'plugin-on' ? { ...BASELINE_DEFINITIONS, ...NAVIGATION_DEFINITIONS } : BASELINE_DEFINITIONS;
  const tools = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, { ...definition, handler: bounded(handlers[name]) }]));
  return freeze({ schema: 'real-use-runtime-tools/v1', condition, tools,
    evidence: identity.evidence, imageInspected: identity.evidence === 'local-docker',
    admission: 'not_assessed', canAuthorizeModelRun: false,
    backendIdentity: identity, imageInspectionHash: inspection.inspect_sha256,
    snapshotManifestHash: snapshot.manifestHash, inventoryHash: RUNTIME_INVENTORY_HASHES[condition],
    baselineInventoryHash: RUNTIME_INVENTORY_HASHES.baseline, limits: { calls } });
}
