// Non-inference Node probe. This is NOT the OpenCode tool resolver.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [workspace, plugin] = process.argv.slice(2);
try {
  const url = plugin ? pathToFileURL(path.join(workspace, plugin)).href : null;
  const tools = [];
  if (url) {
    const loaded = await import(url);
    if (typeof loaded.default?.setup !== 'function') throw new Error('Missing V2 plugin setup');
    await loaded.default.setup({
      location: { directory: workspace },
      tool: { transform: async callback => callback({ add: tool => {
        if (typeof tool.name !== 'string' || tool.options?.codemode !== true) throw new Error('Invalid Code Mode registration');
        tools.push(tool.name);
      } }) },
    });
  }
  process.stdout.write(JSON.stringify({ plugin: url, tools }));
} catch (error) {
  process.stderr.write(`plugin_load_error: ${error.message}`);
  process.exitCode = 1;
}
