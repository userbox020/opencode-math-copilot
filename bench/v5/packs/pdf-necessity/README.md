# PDF necessity pack

Ten quote-retrieval tasks from ten distinct released openai/math PDFs dated October 5, 2026.
The pilot is the first five tasks in the fixed selection order. No model calls or network
access are used to build or verify this pack. External baselines are empty; the model
label follows the adjacent pack convention and is not an execution record.

## Extraction and scope

The existing workspace toolkit's `pdfText` helper extracts each actual root PDF page
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
`read` PDF support before claiming a plugin-on/off access gap. Keep evaluator answers,
this directory, and prebuilt PDF excerpts inaccessible to the evaluated model; the
pack itself does not implement sandboxing.

## Reproduce locally

Default corpus: `C:/_Work/__OPENAI_MATH/math`.
Default extractor: `C:/_Work/__OPENAI_MATH/.opencode/plugins/math-toolkit/lib/pdf.js`.
Override with `PDF_NECESSITY_MATH_ROOT` and `PDF_NECESSITY_EXTRACTOR` if relocated.
An installed local unpdf dependency is required; failures are fatal, not skipped.

From the repository root:

```text
node bench/v5/packs/pdf-necessity/build.mjs
node bench/v5/packs/pdf-necessity/verify.mjs
node --test bench/v5/packs/pdf-necessity/tests/pdf-necessity.test.mjs
node --check bench/v5/packs/pdf-necessity/build.mjs
node --check bench/v5/packs/pdf-necessity/verify.mjs
```

Build writes only tasks.json, pilot.json, baselines.json, and README.md in this pack.
It validates all pages before writing. Verification re-extracts without cached answers,
checks source hashes, exact quote uniqueness, page bounds, quote hashes, prompt template,
eight-word leakage, schema, and pilot ordering. Missing/malformed PDFs, extraction errors,
truncation, source drift, and tampered answers/pages fail closed.

## Artifact hashes

- tasks.json SHA-256: `33498e887a09f37372ca0e57a4d442a28db2773ef450538aee42efd98f47f72c`
- pilot.json SHA-256: `6be78cd1237829455357a59c48777fd76f73b5b1da51431acd269c8b9c73c5ef`

## Source hashes

The following manifest covers only these ten PDFs, their selected extracted pages,
CONTENTS.md, LICENSE, the extractor module, and the build/verify sources, not the corpus
tree or the full transitive PDF.js dependency tree.

```json
{
  "method": "math-toolkit/lib/pdf.js pdfText; unpdf/PDF.js; cache disabled; no OCR",
  "manifest_sha256": "d39079f4512d0ce6c969820987983fa89eacc170766f9685b2c70c3a9278bba1",
  "license_sha256": "1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6",
  "extractor_sha256": "c3693c7590b0ab58c6c3e1b98d941e79e9818d6e667ea0fa46a2bede1993425e",
  "build_sha256": "c690acc492e2c6d10f91db4b4ff2be5d6753d6638309ae61fa04d6d219f80f0e",
  "verify_sha256": "ed2108b77a7f1b33e569cf83a827bc5a9f85d31aa1e507915fe5bae985f48d79",
  "pdfs": [
    {
      "manuscript_path": "preprints/Spectral-scalar-curvature-and-uniform-Urysohn-width-October-5-2026/main.pdf",
      "page": 3,
      "pdf_sha256": "1b55879b1d10b0f5b31aa41b220a84f101f44bd01347626293f3fc70c85d917d",
      "extracted_page_sha256": "8ec26f95eed77b4a75bcc4c34e2795753ff24978f83bf275b92f0baa51b5376b"
    },
    {
      "manuscript_path": "preprints/Spectral-scalar-curvature-and-Urysohn-width-in-dimension-three-October-5-2026/spectral-urysohn-three-manifolds.pdf",
      "page": 3,
      "pdf_sha256": "2a0852ff04d11752b6a39d3da257ef8d768e11d1dd269e44f76745a55afae99a",
      "extracted_page_sha256": "792d9dae2ee3426a389daa587092422d2c5cd63a6b677fb7357f01479473ff1c"
    },
    {
      "manuscript_path": "preprints/A-Codimension-One-Bound-for-the-Singular-Set-of-a-Stationary-Integral-Varifold-October-5-2026/varifold-singular-dimension.pdf",
      "page": 3,
      "pdf_sha256": "550b6c1b4bf40bda7958c13378471d3347d592e6d4711e7ef63ccf9e0edad044",
      "extracted_page_sha256": "8f481eef054ae6bbfb3acef2759cf5f159168d237445ddfa36152bc97e8fcb73"
    },
    {
      "manuscript_path": "preprints/Hamiltonian-Fixed-Points-Below-the-Stable-Morse-Number-in-Dimension-Twenty-Two-October-5-2026/hamiltonian-fixed-points-below-stable-morse-number.pdf",
      "page": 3,
      "pdf_sha256": "12e5b850a57973914df99d6e8686b3b8c1bf77bd738605fffc1cd3cc26787058",
      "extracted_page_sha256": "ea829bb477ca3d523a3da994ce0a11a645c45072417d62cdb3dc170c778e35df"
    },
    {
      "manuscript_path": "preprints/Sharpness-of-the-Cyclic-Integral-Floer-Bound-Below-the-Stable-Morse-Number-October-5-2026/sharp-cyclic-integral-floer-bound-below-stable-morse-number.pdf",
      "page": 3,
      "pdf_sha256": "b9fec0a6b56d3a8dd7ffe7ce53bfd6304e3a6560f98d0ee7f73812862b9a1c02",
      "extracted_page_sha256": "76020c40cb189c94cb979bdf7938f7fd151e45ac6b80770d6b87408a5669ad45"
    },
    {
      "manuscript_path": "preprints/Hamiltonian-Fixed-Points-Below-the-Stable-Morse-Number-October-5-2026/paper.pdf",
      "page": 3,
      "pdf_sha256": "b482e3ec793c52e06a1a3f6cd92f13518a806511e2974cd4f9005eea116f5f0f",
      "extracted_page_sha256": "7d9de22533be7023171101b6cb0ac299c4636c834ffb7bb63ef30d9294f93746"
    },
    {
      "manuscript_path": "preprints/An-L2-Einstein-Gap-for-Nonnegatively-Curved-Four-Manifolds-October-5-2026/einstein-gap.pdf",
      "page": 3,
      "pdf_sha256": "3be17e2ac8ba5f5f2f8de7af7c5d8c47321d3366b0fe012d9b9771b1aaf772ef",
      "extracted_page_sha256": "75b90abbb6cb83b362bd8cca961eb5993ab835bf59fd449fa70c5c05de426374"
    },
    {
      "manuscript_path": "preprints/Smooth-Nonquadratic-Affine-Maximal-Graph-in-Dimension-Ten-October-5-2026/affine-maximal-dimension-ten.pdf",
      "page": 4,
      "pdf_sha256": "f7851c8489621a2df0e520d7aebe9c4dca5e6d3e68c9086d914b479dc9983da9",
      "extracted_page_sha256": "59c90e00f6f2593409377cecb0e9c6e7d50d605e84fa1c49b9f6db505a2c1fc2"
    },
    {
      "manuscript_path": "preprints/Nonuniqueness-with-local-conservation-for-the-hard-sphere-Boltzmann-equation-October-5-2026/paper.pdf",
      "page": 3,
      "pdf_sha256": "640850bc08703544037791cecd9d71f11d558b8333d7f990abbe3a604d805489",
      "extracted_page_sha256": "640ad771a7ae116d7e15026f9f40d07b36cab2bf808a4ac56454ccefdc4687e2"
    },
    {
      "manuscript_path": "preprints/Determination-of-a-metric-and-a-unitary-connection-from-one-boundary-patch-October-5-2026/paper.pdf",
      "page": 3,
      "pdf_sha256": "8e1bdd3a9067234842406dba45efc9e8efae5be0cd72a6c09f6dceee8793badb",
      "extracted_page_sha256": "197dd30f4b6155a48c78f53ddd965318407f55eedb9adfabb2890d750ac0d219"
    }
  ]
}
```
