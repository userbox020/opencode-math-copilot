import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTasks, sha256, isMain } from '../../external/schema.mjs';
import { extractPage, verifyTask, assertNoLeak, MATH, EXTRACTOR, PACK } from './verify.mjs';

// Reviewed against actual released PDF page extraction, never TeX or cached excerpts.
export const selections = [
  {
    title: 'Spectral scalar curvature and uniform Urysohn width',
    pdf: 'Spectral-scalar-curvature-and-uniform-Urysohn-width-October-5-2026/main.pdf',
    page: 3,
    sentence: 'The additional work is to create a quadratic reserve from an unrestricted logarithmic drift and to adapt the local stretching argument to a signed drift.',
    clue: 'the two extra constructions needed beyond the starting partition theorem',
  },
  {
    title: 'Spectral scalar curvature and Urysohn width in dimension three',
    pdf: 'Spectral-scalar-curvature-and-Urysohn-width-in-dimension-three-October-5-2026/spectral-urysohn-three-manifolds.pdf',
    page: 3,
    sentence: 'A local area-nonincreasing retraction at a cut boundary permits full-neighborhood comparisons, so ordinary interior regularity applies even at boundary contacts.',
    clue: 'why ordinary interior regularity remains applicable where a cut boundary is touched',
  },
  {
    title: 'A Codimension-One Bound for the Singular Set of a Stationary Integral Varifold',
    pdf: 'A-Codimension-One-Bound-for-the-Singular-Set-of-a-Stationary-Integral-Varifold-October-5-2026/varifold-singular-dimension.pdf',
    page: 3,
    sentence: 'Both moment conclusions are needed: subtracting a reference graph must neither remove the entire limit nor leave an arbitrary translation in it.',
    clue: 'the two failures that the moment conclusions must prevent when removing a reference graph',
  },
  {
    title: 'Hamiltonian Fixed Points Below the Stable Morse Number in Dimension Twenty-Two',
    pdf: 'Hamiltonian-Fixed-Points-Below-the-Stable-Morse-Number-in-Dimension-Twenty-Two-October-5-2026/hamiltonian-fixed-points-below-stable-morse-number.pdf',
    page: 3,
    sentence: 'Taking the maximum of the two primary multiplicities in each degree then gives different savings in the number of generators.',
    clue: 'how comparing primary multiplicities degree by degree changes the generator savings',
  },
  {
    title: 'Sharpness of the Cyclic Integral Floer Bound Below the Stable Morse Number',
    pdf: 'Sharpness-of-the-Cyclic-Integral-Floer-Bound-Below-the-Stable-Morse-Number-October-5-2026/sharp-cyclic-integral-floer-bound-below-stable-morse-number.pdf',
    page: 3,
    sentence: 'In the cyclic grading the source and target lie in the two opposite parities, with the reverse differential zero.',
    clue: 'where the source and target sit in the cyclic grading and what happens to the reverse differential',
  },
  {
    title: 'Hamiltonian Fixed Points Below the Stable Morse Number',
    pdf: 'Hamiltonian-Fixed-Points-Below-the-Stable-Morse-Number-October-5-2026/paper.pdf',
    page: 3,
    sentence: 'When the two primes are combined into cyclic summands, these products permit different savings in the number of generators.',
    clue: 'what combining the two primes into cyclic summands permits for the products',
  },
  {
    title: 'An L² Einstein Gap for Nonnegatively Curved Four-Manifolds',
    pdf: 'An-L2-Einstein-Gap-for-Nonnegatively-Curved-Four-Manifolds-October-5-2026/einstein-gap.pdf',
    page: 3,
    sentence: 'The aim of this section is to obtain uniform geometric bounds without assuming a curvature maximum bound.',
    clue: 'which additional curvature assumption is deliberately avoided while establishing the initial bounds',
  },
  {
    title: 'A Smooth Nonquadratic Entire Affine Maximal Graph in Dimension Ten',
    pdf: 'Smooth-Nonquadratic-Affine-Maximal-Graph-in-Dimension-Ten-October-5-2026/affine-maximal-dimension-ten.pdf',
    page: 4,
    sentence: 'It remains to show that it can be continued to arbitrarily large radii without losing positivity.',
    clue: 'the remaining continuation goal once the local solution has the required properties',
  },
  {
    title: 'Nonuniqueness with local conservation for the hard-sphere Boltzmann equation',
    pdf: 'Nonuniqueness-with-local-conservation-for-the-hard-sphere-Boltzmann-equation-October-5-2026/paper.pdf',
    page: 3,
    sentence: 'The small relative entropy used in its construction therefore does not place it in these uniqueness classes.',
    clue: 'why the datum does not qualify for the cited uniqueness regimes despite an entropy property',
  },
  {
    title: 'Determination of a metric and a unitary connection from one boundary patch',
    pdf: 'Determination-of-a-metric-and-a-unitary-connection-from-one-boundary-patch-October-5-2026/paper.pdf',
    page: 3,
    sentence: 'Their components complementary to the real scalar matrices satisfy a first-order system whose principal symbol is the conformal Killing symbol.',
    clue: 'the differential system and principal symbol governing the nonscalar components of the first-moment matrices',
  },
];

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const promptFor = selection => `In the released PDF "${selection.title}", on physical page ${selection.page}, quote verbatim the sentence explaining ${selection.clue}. Give the exact quote, the PDF path, and the page. Use the PDF text extraction tool if available; do not ask the user.`;

export async function buildArtifacts() {
  const tasks = [], pdfs = [];
  const manifest = fs.readFileSync(path.join(MATH, 'CONTENTS.md'), 'utf8');
  for (const [index, selection] of selections.entries()) {
    const manuscript_path = `preprints/${selection.pdf}`;
    if (!manifest.includes(`[${selection.title}](${manuscript_path})`)) {
      throw new Error(`Released title/path absent from CONTENTS.md: ${manuscript_path}`);
    }
    const extracted = await extractPage(manuscript_path, selection.page);
    const pattern = new RegExp(selection.sentence.split(/\s+/).map(escape).join('\\s+'), 'gu');
    const matches = [...extracted.text.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`Expected one extracted sentence: ${manuscript_path}`);
    // Preserve the helper's actual internal spaces and line breaks in the answer.
    const answer = matches[0][0];
    const task = {
      schema: 'math-bench-task/v1',
      benchmark: 'pdf-necessity',
      id: `pdf-text-${String(index + 1).padStart(2, '0')}`,
      prompt: promptFor(selection),
      answer,
      grading: {
        type: 'quote',
        answer,
        note: 'Quote the exact extracted sentence and identify the released PDF path and 1-based physical page. Answer preserves PDF extraction whitespace; metadata.line is a page, not a text line.',
      },
      metadata: {
        source: 'openai/math released PDFs (CONTENTS.md)',
        license: 'Apache-2.0',
        kind: 'pdf',
        manuscript_path,
        line: selection.page,
        manuscript_title: selection.title,
        section: `physical page ${selection.page}`,
        quote_sha256: sha256(answer),
      },
    };
    assertNoLeak(task.prompt, answer);
    await verifyTask(task, { expectedPdfHash: extracted.pdf_sha256 });
    tasks.push(task);
    pdfs.push({
      manuscript_path, page: selection.page,
      pdf_sha256: extracted.pdf_sha256,
      extracted_page_sha256: sha256(extracted.text),
    });
  }
  const sources = {
    method: 'math-toolkit/lib/pdf.js pdfText; unpdf/PDF.js; cache disabled; no OCR',
    manifest_sha256: sha256(fs.readFileSync(path.join(MATH, 'CONTENTS.md'))),
    license_sha256: sha256(fs.readFileSync(path.join(MATH, 'LICENSE'))),
    extractor_sha256: sha256(fs.readFileSync(EXTRACTOR)),
    build_sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    verify_sha256: sha256(fs.readFileSync(path.join(PACK, 'verify.mjs'))),
    pdfs,
  };
  const artifacts = {
    'tasks.json': json(tasks),
    'pilot.json': json(tasks.slice(0, 5)),
    'baselines.json': json({
      schema: 'math-bench-baselines/v1',
      benchmark: 'pdf-necessity',
      model: 'opencode-go/deepseek-v4.1-flash',
      external: [],
      note: 'No published score for this exact model/version was found; use the paired plugin-off arm.',
    }),
  };
  artifacts['README.md'] = `# PDF necessity pack

Ten quote-retrieval tasks from ten distinct released openai/math PDFs dated October 5, 2026.
The pilot is the first five tasks in the fixed selection order. No model calls or network
access are used to build or verify this pack. External baselines are empty; the model
label follows the adjacent pack convention and is not an execution record.

## Extraction and scope

The existing workspace toolkit's \`pdfText\` helper extracts each actual root PDF page
using unpdf/PDF.js. PDF caching is forcibly disabled, including during verification.
There is no TeX/README text fallback, OCR, cached excerpt, mock extraction, or
fabricated answer. Sentences have at least twelve words and were selected from body
pages, not titles, abstracts, or opening sentences. Answers preserve internal whitespace
and line breaks exactly as returned by the helper. Hashes cover UTF-8 answers and raw
PDF/source bytes; page hashes cover the extracted page body including its final newline.
Physical page numbers are 1-based, independently of printed numbering.

These tasks test page-specific extraction access, not mathematical reasoning or proof
correctness. They do not prove exclusive necessity of one tool: other PDF-capable tools,
shell extractors, or leaked answers can solve them. Verify the actual runner's generic
\`read\` PDF support before claiming a plugin-on/off access gap. Keep evaluator answers,
this directory, and prebuilt PDF excerpts inaccessible to the evaluated model; the
pack itself does not implement sandboxing.

## Reproduce locally

Default corpus: \`C:/_Work/__OPENAI_MATH/math\`.
Default extractor: \`C:/_Work/__OPENAI_MATH/.opencode/plugins/math-toolkit/lib/pdf.js\`.
Override with \`PDF_NECESSITY_MATH_ROOT\` and \`PDF_NECESSITY_EXTRACTOR\` if relocated.
An installed local unpdf dependency is required; failures are fatal, not skipped.

From the repository root:

\`\`\`text
node bench/v5/packs/pdf-necessity/build.mjs
node bench/v5/packs/pdf-necessity/verify.mjs
node --test bench/v5/packs/pdf-necessity/tests/pdf-necessity.test.mjs
node --check bench/v5/packs/pdf-necessity/build.mjs
node --check bench/v5/packs/pdf-necessity/verify.mjs
\`\`\`

Build writes only tasks.json, pilot.json, baselines.json, and README.md in this pack.
It validates all pages before writing. Verification re-extracts without cached answers,
checks source hashes, exact quote uniqueness, page bounds, quote hashes, prompt template,
eight-word leakage, schema, and pilot ordering. Missing/malformed PDFs, extraction errors,
truncation, source drift, and tampered answers/pages fail closed.

## Artifact hashes

- tasks.json SHA-256: \`${sha256(artifacts['tasks.json'])}\`
- pilot.json SHA-256: \`${sha256(artifacts['pilot.json'])}\`

## Source hashes

The following manifest covers only these ten PDFs, their selected extracted pages,
CONTENTS.md, LICENSE, the extractor module, and the build/verify sources, not the corpus
tree or the full transitive PDF.js dependency tree.

\`\`\`json
${JSON.stringify(sources, null, 2)}
\`\`\`
`;
  return artifacts;
}

export async function build() {
  const artifacts = await buildArtifacts();
  for (const [name, text] of Object.entries(artifacts)) fs.writeFileSync(path.join(PACK, name), text);
  const { tasks, hash } = readTasks(path.join(PACK, 'tasks.json'));
  readTasks(path.join(PACK, 'pilot.json'));
  return { tasks: tasks.length, tasks_sha256: hash, pilot_sha256: sha256(artifacts['pilot.json']) };
}

if (isMain(import.meta.url)) console.log(JSON.stringify(await build(), null, 2));
