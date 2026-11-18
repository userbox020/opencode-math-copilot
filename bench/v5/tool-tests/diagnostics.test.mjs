import test from 'node:test';
import assert from 'node:assert/strict';
import { importWithStubs } from './helpers.mjs';

// These paths and the canary are invented data, never values from this host.
const roots = { math: '/fixture/corpus', workspace: '/fixture/workspace' };
const canary = 'SYNTHETIC_PRIVATE_CANARY_DO_NOT_EMIT';
const index = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  counts: { families: 1, manuscripts: 1, formalized: 0, sections: 1, leanDocs: 0 },
  lean: { toolchain: 'fixture-toolchain', libraries: [] }, manuscripts: [],
};
const binding = (from, specifier, exports) => ({ from, specifier, exports });
const both = ['main.js', 'lib/doctor.js'];
const paths = { findExecutable: name => `/fixture/bin/${name}`, REBUILD: 'Fixture rebuild hint.', resolveRoots: () => roots };
const fs = {
  readFileSync: () => JSON.stringify(index),
  statSync: () => ({ size: 128, mtime: new Date(index.generatedAt), isDirectory: () => true }),
  statfsSync: () => ({ bavail: 10n, bsize: 1024n }),
  opendirSync: () => ({ readSync: () => null, closeSync() {} }),
};
let probes = [];
const { default: plugin } = await importWithStubs('main.js', [
  binding(both, 'node:fs', { default: fs }),
  binding(both, 'node:url', { fileURLToPath: () => '/fixture/index.json' }),
  binding(both, 'node:child_process', { spawnSync: (_executable, args, options) => {
    probes.push({ args, options });
    return { status: 0, stdout: canary, stderr: canary };
  } }),
  binding(['main.js'], '@opencode/plugin', { Plugin: { define: value => value } }),
  binding(['main.js'], './lib/paths.js', paths),
  binding(['lib/doctor.js'], './paths.js', paths),
  binding(['main.js'], './lib/compute.js', { compute() {}, sympyVersion: () => 'fixture-version' }),
  binding(['lib/doctor.js'], './compute.js', { sympyVersion: () => 'fixture-version' }),
  binding(['main.js'], './lib/corpus.js', { grepCorpus() {}, manuscript() {} }),
  binding(['main.js'], './lib/lean.js', { comparator() {}, leanBuild() {}, leanCheck() {} }),
  binding(['main.js'], './lib/verify.js', { DEFAULT_AXIOMS: [], leanVerify() {} }),
  binding(['main.js'], './lib/lean-search.js', { searchLean() {} }),
  binding(['main.js'], './lib/pdf.js', { pdfText() {} }),
  binding(['main.js'], './lib/pdf-search.js', { pdfCorpusSearch() {}, pdfSearch() {} }),
  binding(['main.js'], './lib/pdf-index.js', { pdfIndexSearch() {} }),
  binding(['lib/doctor.js'], './pdf.js', { pdfCacheDirectory: () => '/fixture/cache' }),
  binding(['lib/doctor.js'], './pdf-index.js', {
    PDF_INDEX_FILE: '/fixture/excerpts.gz', PDF_INDEX_BUILD: 'fixture rebuild',
    getPdfIndex: () => ({ version: 1, generatedAt: index.generatedAt, counts: { pages: 1 } }),
  }),
]);

async function diagnostic(name) {
  const environment = process.env;
  process.env = { V5_SYNTHETIC_SECRET: canary, UNRELATED_ENVIRONMENT: canary, PATH: '/fixture/private-env' };
  probes = [];
  try {
    const tools = new Map();
    await plugin.setup({
      location: { directory: roots.workspace },
      tool: { transform: async edit => edit({ add: tool => tools.set(tool.name, tool) }) },
    });
    const result = await tools.get(name).execute({});
    return typeof result === 'string' ? result : result.content;
  } finally { process.env = environment; }
}

for (const name of ['math_status', 'math_doctor']) {
  test(`${name}: public field inventory; no environment or subprocess-output dump`, async () => {
    const output = await diagnostic(name);
    assert.equal(typeof output, 'string');
    assert.equal(output.includes(canary), false, 'synthetic private canary must not appear');
    assert.doesNotMatch(output, /V5_SYNTHETIC_SECRET|UNRELATED_ENVIRONMENT|private-env/);
    assert.ok(output.length <= 16000);
    const allowed = name === 'math_status'
      ? /^(Math root|Index|Index size|Index mtime|Generated|Families|Manuscripts|Formalized|Sections|Lean docs|Lean toolchain|Libraries|lake|lean|comparator|landrun|lean4export|latexmk|pdflatex|python|rg|sympy):/
      : /^(Corpus clone path|Math root|lean\/|Manuscript index|Manuscript counts|Lean declaration index|PDF cache|PDF excerpt index|PDF excerpts|lake|lean|comparator|landrun|lean4export|python|rg|sympy|Docker executable|Lean image \([^)]*\)|Comparator image \([^)]*\)|Lean volume \([^)]*\)|Comparator tools volume \([^)]*\)|Repo \([^)]*\)|Corpus \([^)]*\)):/;
    for (const line of output.split('\n').filter(line => line.startsWith('- '))) assert.match(line.slice(2), allowed);
    if (name === 'math_doctor') {
      assert.ok(output.split('\n').includes(`- Corpus clone path: ${roots.math}`));
      assert.equal(probes.length, 4);
      assert.ok(probes.every(({ args, options }) => args[1] === 'inspect' && options.shell === false && options.timeout === 2000));
    } else {
      // The status description explicitly advertises root paths and availability.
      const rest = output.split('\n').filter(line => !/^- (Math root|Index|Lean toolchain|lake|lean|comparator|landrun|lean4export|latexmk|pdflatex|python|rg):/.test(line)).join('\n');
      assert.equal(rest.includes('/fixture/'), false, 'paths restricted to advertised status fields');
      assert.equal(probes.length, 0);
    }
  });
}

test('math_doctor: sanitized interface beyond the documented corpus-path exception', {
  skip: 'Known gap: current doctor also exposes cache/executable/workspace paths; README records the interface discrepancy. No production changes authorized.',
}, async () => {
  const output = await diagnostic('math_doctor');
  const rest = output.split('\n').filter(line => !line.startsWith('- Corpus clone path:')).join('\n');
  // Boolean assertion avoids printing output, environment or paths on failure.
  assert.equal(rest.includes('/fixture/'), false, 'non-corpus paths must be sanitized');
});
