import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusRoot, decode, hash, parseContents, sectionAt, titleFromReadme, verifyPack } from './verify.mjs';

export const packDirectory = path.dirname(fileURLToPath(import.meta.url));
const contentsHash = 'd39079f4512d0ce6c969820987983fa89eacc170766f9685b2c70c3a9278bba1';

// Curated source sentences, not generated questions or mathematical answers.
// LF below is converted to the source's actual newline convention before hashing.
const selections = [
  {
    family: '101', file: 'manuscript/approximation.tex',
    sha256: '378280bdea478f9228dc68186ed2faebecee7642961cd23c19d05cdf10c175d2',
    quote: 'The elementary tail estimate below supplies a common integrable bound for\nthe approximation, including its entropy integrand.',
    clue: 'what the elementary tail estimate supplies for the approximation and entropy'
  },
  {
    family: '102', file: 'appendices/finite-consequences.tex',
    sha256: '1f82297643e8a787870f5eec453e03a20a45e42f0afd21e208db193ceff7c76d',
    quote: 'The composition specifies the graph,\nthe independent neighbor choices, and the conversion to constraints on distinct\nvariables.',
    clue: 'which three ingredients the composition specifies'
  },
  {
    family: '103', file: 'sections/arithmetic.tex',
    sha256: 'cbb925fa3823313f6183d4432ee51dcd841b56e54556321e7d0bc14476f1edbe',
    quote: 'An operand clock may\nexceed the output clock by an amount proportional to descriptor size;\nthe structural term also pays for this overshoot.',
    clue: 'how a descriptor-dependent clock overshoot is paid for'
  },
  {
    family: '104', file: 'build/sections/application.tex',
    sha256: '4b61cadf17863e950b0b1c2de8c934cb13f9becd27f16bca774f00a6052156b1',
    quote: 'It remains to show that the potentially large integer widths do not\nproduce a large recursion tree, and that every local computation has\npolynomial bit cost.',
    clue: 'the two remaining obligations concerning integer widths and local computations'
  },
  {
    family: '105', file: '00-introduction.tex',
    sha256: '3da0038a0ef284a11da367412378dbb64df9724b481dbf124988817b0c4ba48e',
    quote: 'The remaining issue was to make soundness arbitrarily small while retaining\nboth perfect completeness and two-element fibers.',
    clue: 'the remaining obstacle after the cited Label Cover hardness result'
  },
  {
    family: '106', file: 'source/sections/alignment-proof.tex',
    sha256: '929eecd1d2981d08f5ac37dfd8c07391c7d08141d516d942dbd0cd627ccc0fd0',
    quote: 'The argument depends only on\nthe list bound and the order of the indices; it has no graph-theoretic\nor analytic hypotheses.',
    clue: 'which inputs the alignment argument needs and which kinds of hypotheses it avoids'
  },
  {
    family: '107', file: 'paper.tex',
    sha256: '60e3ec55581eca5ecaaf0cdfb686cf1e98ced3c90490c60e937be16704fac93b',
    quote: 'Interpolation, counting words\nwith prescribed frequencies, and balancing the tensor legs retain\ntheir roles from the earlier tensor-power methods.',
    clue: 'which three techniques retain their earlier roles in the tensor construction'
  },
  {
    family: '108', file: 'source/sections/adjugate.tex',
    sha256: 'ad993821a3d3492f993d748f926f105eb1bd821d4a01f9db39abe73a03063034',
    quote: 'The fixed distinct-root fiber has established reducedness and a finite\nflat, generically separable projection.',
    clue: 'what the fixed distinct-root fiber has already established before the adjugate argument'
  },
  {
    family: '109', file: 'sections/00-introduction.tex',
    sha256: '6fed8df2b8ad17053e7deca9ff230dfdc16620e5d329d5c20ff61d3b55c43511',
    quote: 'In this representation, the transform calculation consists of address\nrearrangements, signed shifts, and two-point butterfly operations.',
    clue: 'which operations comprise the transform calculation in the described representation'
  },
  {
    family: '110', file: 'source/latex/sections/01_introduction.tex',
    sha256: 'ba81f6e91caf729f636a6e1b08cf85b46f570cf487bacb256c6f7e21975ede10',
    quote: 'The present paper concerns the different asymptotic behavior made\npossible by randomization against oblivious requests.',
    clue: 'how the focus of this paper differs immediately after the discussion of Coester, Koutsoupias, and Zbysiński'
  },
  {
    family: '111', file: 'sections/accounting.tex',
    sha256: '9cce17460bf06994903a8bcc7adfa5fd8ba0be1ebb7e085937272d3899ea969b',
    quote: 'Only after these deterministic comparisons do\nwe average over the independent test thinning and the other masks.',
    clue: 'when averaging over test thinning and masks takes place'
  },
  {
    family: '112', file: 'latex/sections/00_introduction.tex',
    sha256: '171e18d966a255a9f82ad2e2dfe69bf81619f60036bf595967dc9fbd8a422acd',
    quote: 'There are few enough\nsuch sparse tests that a moment\nbound controls them simultaneously.',
    clue: 'why a moment bound suffices to handle the sparse tests together'
  },
  {
    family: '113', file: 'main.tex',
    sha256: 'c451eda605976adedad4f5cd169a0ef5c3ff562e604144d901310ee71253f0eb',
    quote: 'On feasible inputs, its samplers always return a\nfeasible object and approximate the corresponding uniform law in total\nvariation.',
    clue: 'what the samplers guarantee on feasible inputs in the paragraph discussing prescribed degrees'
  },
  {
    family: '114', file: 'sections/counting.tex',
    sha256: 'c23869f2410663f444e8f3cb1413327a8713f984122af899c3c955da2d5ca4e0',
    quote: 'The remaining-capacity\nfactorials cancel the same multiplicities, leaving a positive multiple\nof the integer addition matrix.',
    clue: 'the cancellation performed by the remaining-capacity factorials in the addition argument'
  },
  {
    family: '115', file: 'sections/algorithms.tex',
    sha256: '1f6f6f89a3f5c289dcf6bd7af20cf834184d373792becfebaa3d53e69e05562b',
    quote: "In particular, a\ncompletion used to test a transition is discarded after that test; the\ncurrent small state is the chain's entire persistent state.",
    clue: 'what is discarded after a transition test and what persists'
  },
  {
    family: '116', file: 'sections/construction.tex',
    sha256: 'ff500919f71d53aa9614d541b6fad8056d557ac2aa40526b13443b98df40d55f',
    quote: 'A common denominator bound ensures that the second truncation\npreserves the nonvanishing established by the first.',
    clue: 'why the second truncation does not destroy the earlier nonvanishing'
  },
  {
    family: '117', file: 'source/sections/00-introduction.tex',
    sha256: 'd15cfe51c3b32f34152d67cf001ff96c5ffe13db4f6f23f3e791c15967092680',
    quote: 'To rule out a constant-factor approximation, one must create a\nmultiplicative separation between satisfiable and unsatisfiable instances,\nwhile preserving the uniform denominator.',
    clue: 'the separation needed to exclude a constant-factor approximation without changing the denominator'
  },
  {
    family: '118', file: 'source/completeness.tex',
    sha256: 'f6a0308911522912dbcebd3f6d5b1ef424af0a33ebf633be5e2f46aad97dddc2',
    quote: 'Consequently all global auxiliaries of these two\nsubclasses can be assigned as distinct physical copies, exhausting\ntheir length-one and length-zero stocks.',
    clue: 'how the two auxiliary subclasses exhaust their stocks in the vertex-cover packing'
  },
  {
    family: '119', file: 'main.tex',
    sha256: '63b2c1a857735c105e6e142a05537804c0da4ce9eb90b6f7de2dc5ccf27be811',
    quote: 'Holding the core and its mass fixed preserves the separation of the\nchild means, their average conditional entropy, and the joining cost.',
    clue: 'which quantities stay unchanged when the reflected core and its mass are held fixed'
  },
  {
    family: '120', file: 'sections/01-introduction.tex',
    sha256: '4c7ea14dbafdd4c2eea433bc0e5989d09d81436e0b35e53c7b9a9737a6768739',
    quote: 'It is given by an array of adjacency-list boundaries and two\nneighbor occurrences per edge.',
    clue: 'how the graph is encoded in arrays and neighbor occurrences'
  }
];

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildPack(root = corpusRoot()) {
  const contents = readFileSync(path.join(root, 'CONTENTS.md'));
  if (hash(contents) !== contentsHash) throw new Error('Pinned CONTENTS.md hash mismatch');
  const manuscripts = parseContents(decode(contents));
  const files = [];
  const tasks = selections.map((selection, index) => {
    const manuscript = manuscripts.find(item => item.family === selection.family);
    if (!manuscript) throw new Error(`Missing family ${selection.family}`);
    const manuscriptPath = `${manuscript.directory}/build/${selection.file}`;
    const bytes = readFileSync(path.join(root, manuscriptPath));
    if (hash(bytes) !== selection.sha256) throw new Error(`Pinned source hash mismatch: ${manuscriptPath}`);
    const text = decode(bytes);
    const quote = selection.quote.replaceAll('\n', text.includes('\r\n') ? '\r\n' : '\n');
    const offset = text.indexOf(quote);
    if (offset < 0) throw new Error(`Curated quote missing: ${manuscriptPath}`);
    const readmePath = `${manuscript.directory}/README.md`;
    const readme = readFileSync(path.join(root, readmePath));
    const title = titleFromReadme(decode(readme));
    const section = sectionAt(text, offset);
    files.push({
      manuscript_path: manuscriptPath,
      family: selection.family,
      source_sha256: selection.sha256,
      readme_path: readmePath,
      readme_sha256: hash(readme)
    });
    return {
      schema: 'math-bench-task/v1',
      benchmark: 'tool-necessity',
      id: `tool-text-${String(index + 1).padStart(2, '0')}`,
      prompt: `In the manuscript "${title}", in the section "${section}", quote verbatim the sentence explaining ${selection.clue}. Use the raw LaTeX source text, preserving its punctuation and line breaks (including the source newline convention); do not paraphrase or render TeX. Give the exact quote, the file path, and the line number. Use any available manuscript-search or grep tool to locate the source; do not ask the user for the text. If no retrieval tool is available, state that you cannot access the source.`,
      answer: quote,
      grading: {
        type: 'quote',
        answer: quote,
        note: 'Exact raw-source quote only, including original line breaks. Extract the quoted sentence before exact comparison; report the path and starting line separately. Locator correctness is a separate audit, not mathematical accuracy.'
      },
      metadata: {
        source: `https://github.com/openai/math/blob/main/${manuscriptPath}`,
        license: 'Source manuscript rights apply; license not independently verified.',
        kind: 'text',
        manuscript_path: manuscriptPath,
        line: text.slice(0, offset).split('\n').length,
        manuscript_title: title,
        section,
        quote_sha256: hash(quote)
      }
    };
  });
  const baselines = {
    schema: 'math-bench-baselines/v1',
    benchmark: 'tool-necessity',
    model: 'opencode-go/deepseek-v4.1-flash',
    external: [],
    note: 'No published score for this exact model/version was found; use the paired plugin-off arm.',
    metadata: {
      corpus: 'openai/math',
      corpus_manifest: 'CONTENTS.md',
      corpus_manifest_sha256: contentsHash,
      hash_scope: 'Raw CONTENTS.md bytes and the 20 selected TeX/README files only; not a whole-corpus tree hash.',
      selected_sources_sha256: hash(JSON.stringify(files)),
      files
    }
  };
  const pack = { tasks, pilot: tasks.slice(0, 10), baselines };
  verifyPack(pack, root);
  return pack;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pack = buildPack();
    for (const name of ['tasks', 'pilot', 'baselines']) {
      writeFileSync(path.join(packDirectory, `${name}.json`), serialize(pack[name]));
    }
    console.log(`Built ${pack.tasks.length} tasks and ${pack.pilot.length} pilot tasks.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
