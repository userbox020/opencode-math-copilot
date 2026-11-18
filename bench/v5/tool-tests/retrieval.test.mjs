import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSearch, formatSearch } from '../../../.opencode/plugins/math-toolkit/lib/search.js';
import { grepCorpus, manuscript } from '../../../.opencode/plugins/math-toolkit/lib/corpus.js';
import { tempFixture } from './helpers.mjs';

const documents = [
  ['algebra', 'Polynomial factorization', 'roots irreducible polynomial', '001'],
  ['analysis', 'Heat equation', 'parabolic diffusion heat', '002'],
  ['geometry', 'Convex geometry', 'convex polytope volume', '003'],
  ['spectral', 'Spectral theory', 'eigenvalues matrix spectrum', '004'],
].map(([id, title, abstract, family]) => ({
  id, title, abstract, family, familyTitle: title, formalized: false, sections: [],
  dir: `preprints/${id}`, pdf: `preprints/${id}/main.pdf`,
}));
const search = createSearch({ manuscripts: documents });
const labels = [
  { query: 'polynomial roots', relevant: ['algebra'] },
  { query: 'heat diffusion', relevant: ['analysis'] },
  { query: 'convex volume', relevant: ['geometry'] },
  { query: 'matrix eigenvalues', relevant: ['spectral'] },
  { query: 'heat polynomial', relevant: ['analysis', 'algebra'] },
];
test('tiny labeled retrieval set: macro recall@2 equals 1', () => {
  const recalls = labels.map(({ query, relevant }) => {
    const ids = search({ query, limit: 2 }).map(hit => hit.manuscript.id);
    return relevant.filter(id => ids.includes(id)).length / relevant.length;
  });
  assert.deepEqual(recalls, [1, 1, 1, 1, 1]);
  assert.equal(recalls.reduce((a, b) => a + b, 0) / labels.length, 1);
});
test('BM25 case folding, deterministic ranking, result bound and no match', () => {
  assert.deepEqual(search({ query: 'HEAT DIFFUSION' }), search({ query: 'heat diffusion' }));
  assert.deepEqual(search({ query: 'heat polynomial', limit: 2 }), search({ query: 'heat polynomial', limit: 2 }));
  assert.equal(search({ query: '', limit: 2 }).length, 2);
  assert.equal(search({ query: 'heat polynomial', limit: 1 }).length, 1);
  assert.deepEqual(search({ query: 'unfindablezz' }), []);
  assert.match(formatSearch([]), /^No manuscripts found\./);
});

function corpus(t) {
  const directory = tempFixture(t);
  const relative = 'preprints/tiny/main.tex';
  fs.mkdirSync(path.join(directory, 'preprints/tiny'), { recursive: true });
  fs.writeFileSync(path.join(directory, relative), [
    '\\section{Introduction}', 'Heat equation.', 'heat equation.', 'Heat kernel.',
    '\\section{Conclusion}', 'Final line.',
  ].join('\n'));
  return { roots: { math: directory, workspace: directory }, relative };
}
function grep(roots, args) {
  const previous = process.env.MATH_TOOLKIT_DISABLE_RG;
  process.env.MATH_TOOLKIT_DISABLE_RG = '1'; // no optional executable invocation
  try { return grepCorpus(roots, args); }
  finally {
    if (previous === undefined) delete process.env.MATH_TOOLKIT_DISABLE_RG;
    else process.env.MATH_TOOLKIT_DISABLE_RG = previous;
  }
}
const locators = output => output.split('\n').filter(line => line.startsWith('preprints/'));
test('text retrieval: exact one-based relative locators and case-sensitive literal/regex', t => {
  const { roots, relative } = corpus(t);
  const args = { path: relative, query: 'Heat', limit: 10 };
  assert.deepEqual(locators(grep(roots, args)), [
    `${relative}:2: Heat equation.`, `${relative}:4: Heat kernel.`,
  ]);
  assert.deepEqual(locators(grep(roots, { ...args, query: 'heat' })), [`${relative}:3: heat equation.`]);
  assert.deepEqual(locators(grep(roots, { ...args, query: '^Heat', literal: false })), [
    `${relative}:2: Heat equation.`, `${relative}:4: Heat kernel.`,
  ]);
});
test('text retrieval: bounded matches, deduplicated context and no-match behavior', t => {
  const { roots, relative } = corpus(t);
  const args = { path: relative, query: 'Heat', limit: 1 };
  const bounded = grep(roots, args);
  assert.deepEqual(locators(bounded), [`${relative}:2: Heat equation.`]);
  assert.match(bounded, /Results truncated/);
  const context = grep(roots, { ...args, limit: 2, context: 1 });
  assert.deepEqual(locators(context), [
    `${relative}:1: \\section{Introduction}`, `${relative}:2: Heat equation.`,
    `${relative}:3: heat equation.`, `${relative}:4: Heat kernel.`, `${relative}:5: \\section{Conclusion}`,
  ]);
  const empty = grep(roots, { ...args, query: 'unfindablezz' });
  assert.match(empty, /^No matches found\./);
  assert.deepEqual(locators(empty), []);
});
test('manuscript retrieval: exact section range, case folding and absent section', t => {
  const { roots, relative } = corpus(t);
  const doc = { ...documents[0], dir: 'preprints/tiny', readme: 'preprints/tiny/README.md',
    texFile: relative, sections: [
      { title: 'Introduction', file: relative, line: 1, level: 2 },
      { title: 'Conclusion', file: relative, line: 5, level: 2 },
    ] };
  const index = { manuscripts: [doc] };
  const output = manuscript(index, roots, { path: doc.id, section: 'INTRODUCTION', maxChars: 2000 });
  assert.ok(output.includes(`Source: \`${relative}:1-4\``));
  assert.match(output, /Heat kernel\./);
  assert.doesNotMatch(output.split('## Section source:')[1], /Final line/);
  assert.match(manuscript(index, roots, { path: doc.id, section: 'Absent' }), /No section matches "Absent"/);
});
