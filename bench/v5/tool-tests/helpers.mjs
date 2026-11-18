import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';

export const toolkit = new URL('../../../.opencode/plugins/math-toolkit/', import.meta.url);

// Substitute dependencies, not the implementation under test. Hooks are scoped
// to exact importer URLs and removed after import; no files or loaders are emitted.
export async function importWithStubs(relative, bindings) {
  const key = `v5_tool_fixture_${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[key] = bindings.map(binding => binding.exports);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const i = bindings.findIndex(binding =>
        binding.from.some(from => new URL(from, toolkit).href === context.parentURL) &&
        binding.specifier === specifier);
      if (i < 0) return next(specifier, context);
      const source = Object.keys(bindings[i].exports).map(name => name === 'default'
        ? `export default globalThis.${key}[${i}].default;`
        : `export const ${name} = globalThis.${key}[${i}][${JSON.stringify(name)}];`).join('\n');
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
  });
  try { return await import(new URL(relative, toolkit)); }
  finally { hook.deregister(); delete globalThis[key]; }
}

export function tempFixture(t) {
  const preferred = path.join(os.tmpdir(), 'opencode');
  const directory = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(), 'v5-tools-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
