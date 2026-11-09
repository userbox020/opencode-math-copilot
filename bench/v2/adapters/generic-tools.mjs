import { Plugin } from '@opencode/plugin';
import { GENERIC_INPUTS, GENERIC_TOOL_NAMES, createGenericExecutors } from './lib/generic-runtime.mjs';

const descriptions = {
  corpus_search: 'Literal case-insensitive search of the episode public excerpts only; at most 10 bounded matches. Not an exhaustive corpus inventory.',
  read_excerpt: 'Read one public excerpt by exact document and locator; no filesystem paths. At most 8000 characters.',
  compute: 'Bounded allowlisted SymPy operations via a fixed worker. Requires installed Python/SymPy. No arbitrary code evaluation.',
  lean_check: 'Compile one bounded Init theorem/example with allowlisted tactics using installed native Lean. No IO/metaprograms, shell or package installation. Compiler check only, never a trusted verification receipt.',
};

export default Plugin.define({
  id: 'benchmark-generic-tools',
  async setup(ctx) {
    const executors = createGenericExecutors({ directory: ctx.location?.directory });
    await ctx.tool.transform(editor => {
      for (const name of GENERIC_TOOL_NAMES) editor.add({
        name, description: descriptions[name], input: GENERIC_INPUTS[name], options: { codemode: true },
        async execute(args = {}) {
          try { return { content: JSON.stringify(await executors[name](args)) }; }
          catch (error) { return { content: JSON.stringify({ status: 'rejected', error: error.message }) }; }
        },
      });
    });
  },
});
