import { Plugin } from '@opencode/plugin';
import { createCompilerSandbox, POLICY } from './lib/eval-sandbox.mjs';

export const CONDITIONS = Object.freeze(['eval-restricted-on', 'eval-restricted-off']);
export const TOOLSET = 'eval-restricted-v1';
export function assertCondition(condition, toolset = TOOLSET) {
  if (!CONDITIONS.includes(condition) || toolset !== TOOLSET) throw new Error('unknown_evaluation_condition_or_toolset');
}
export function toolManifest(condition, toolset = TOOLSET) {
  assertCondition(condition, toolset);
  return {
    schema: 'eval-tool-manifest/v1', condition, toolset, scope: 'evaluation-restricted toolkit; not the ordinary plugin',
    tools: [{ name: 'lean_compile', options: { codemode: false }, input: { type: 'object', properties: { code: { type: 'string', minLength: 1, maxLength: POLICY.sourceBytes } }, required: ['code'], additionalProperties: false } }],
    math_compute: { status: condition === 'eval-restricted-on' ? 'BLOCKED' : 'disabled', reason: 'pinned contained SymPy backend unavailable' },
    incremental_proof_capability: false,
  };
}

// This is the same registration path used by setup, not a bootstrap into the full toolkit.
export async function registerEvalTools(ctx, { condition, image, toolset = TOOLSET }) {
  const manifest = toolManifest(condition, toolset);
  const backend = createCompilerSandbox({ image });
  const registered = [];
  await ctx.tool.transform(editor => {
    for (const tool of manifest.tools) {
      editor.add({ ...tool, description: 'Bounded local Lean compilation diagnostics only. Executes elaboration in a restricted container; never certifies a proof.',
        async execute(args, context) { return { content: JSON.stringify(await backend.compile(args, { signal: context?.signal })) }; },
      });
      registered.push(tool.name);
    }
  });
  return { ...manifest, registered, evidence: 'adapter-registration-only-not-final-session-inventory' };
}

export default Plugin.define({
  id: 'arxivlean-evaluation-local',
  async setup(ctx) {
    if (process.env.MATH_TOOLKIT_TOOLSET || process.env.MATH_TOOLKIT_DISABLE) throw new Error('inherited_toolkit_selection_forbidden');
    await registerEvalTools(ctx, { condition: process.env.ARXIVLEAN_EVAL_CONDITION, image: process.env.ARXIVLEAN_EVAL_IMAGE, toolset: process.env.ARXIVLEAN_EVAL_TOOLSET });
  },
});
