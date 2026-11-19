import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTasks, validateTasks, sha256, isMain } from '../../external/schema.mjs';

export const PACK = path.dirname(fileURLToPath(import.meta.url));
export const MATH = path.resolve(process.env.PDF_NECESSITY_MATH_ROOT || 'C:/_Work/__OPENAI_MATH/math');
export const EXTRACTOR = path.resolve(process.env.PDF_NECESSITY_EXTRACTOR ||
  'C:/_Work/__OPENAI_MATH/.opencode/plugins/math-toolkit/lib/pdf.js');
export const normalize = value => value.replace(/\s+/gu, ' ').trim();
const words = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const count = (text, needle) => text.split(needle).length - 1;

export function assertUniqueQuote(text, answer) {
  assert.equal(count(text, answer), 1, 'quote absent or nonunique on physical page');
  assert.equal(count(normalize(text), normalize(answer)), 1, 'normalized quote is nonunique');
}

export function assertNoLeak(prompt, answer) {
  assert(!normalize(prompt).toLowerCase().includes(normalize(answer).toLowerCase()), 'prompt leaks full quote');
  const quoted = words(answer), prompted = ` ${words(prompt).join(' ')} `;
  for (let i = 0; i + 8 <= quoted.length; i++) {
    assert(!prompted.includes(` ${quoted.slice(i, i + 8).join(' ')} `), 'prompt leaks eight-word quote substring');
  }
}

export function pdfFilename(relative) {
  assert(typeof relative === 'string' && /^preprints\/[^/\\]+\/[^/\\]+\.pdf$/.test(relative),
    'expected released root PDF path');
  assert(!relative.split('/').some(part => part === '.' || part === '..'), 'invalid PDF path');
  const file = path.join(MATH, relative);
  assert(fs.statSync(file).isFile(), `missing PDF: ${relative}`);
  const actual = path.relative(fs.realpathSync(MATH), fs.realpathSync(file));
  assert(!path.isAbsolute(actual) && actual !== '..' && !actual.startsWith(`..${path.sep}`),
    'PDF resolves outside corpus');
  return file;
}

// This always invokes the real extraction helper; no injectable text provider or fallback.
export async function extractPage(relative, page) {
  assert(Number.isSafeInteger(page) && page > 0, 'invalid physical page');
  const filename = pdfFilename(relative);
  const before = sha256(fs.readFileSync(filename));
  process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE = '1';
  const { pdfText } = await import(pathToFileURL(EXTRACTOR).href);
  const output = await pdfText({ math: MATH, workspace: path.dirname(MATH) },
    { path: relative, pages: String(page), maxChars: 50000 });
  assert(typeof output === 'string' && !output.startsWith('PDF extraction error:'),
    `PDF extraction failed: ${output}`);
  const header = `# PDF text: ${relative}\n\nPDF pages: `;
  assert(output.startsWith(header), 'unexpected PDF locator');
  const match = output.slice(header.length).match(/^(\d+)\. Selected pages: (\d+)\. Text extraction only; no OCR\.\n\n## Page (\d+)\n\n([\s\S]+)$/);
  assert(match && Number(match[1]) >= page && Number(match[2]) === page && Number(match[3]) === page,
    'invalid physical page extraction envelope');
  assert(!/Output truncated|Page selection capped|No extractable text found/.test(match[4]),
    'incomplete PDF extraction');
  assert.equal(sha256(fs.readFileSync(filename)), before, 'PDF changed during extraction');
  return { text: match[4], pdf_sha256: before, total_pages: Number(match[1]) };
}

export async function verifyTask(task, { expectedPdfHash } = {}) {
  validateTasks([task]);
  assert.equal(task.benchmark, 'pdf-necessity');
  assert.match(task.id, /^pdf-text-\d{2}$/);
  assert.equal(task.metadata.kind, 'pdf');
  assert.equal(task.metadata.license, 'Apache-2.0');
  assert.equal(task.grading.type, 'quote');
  assert.equal(task.answer, task.grading.answer);
  assert.equal(task.metadata.section, `physical page ${task.metadata.line}`);
  assert(words(task.answer).length >= 12, 'quote must have at least twelve words');
  assert.equal(sha256(task.answer), task.metadata.quote_sha256, 'quote hash mismatch');
  assertNoLeak(task.prompt, task.answer);
  const prefix = `In the released PDF "${task.metadata.manuscript_title}", on physical page ${task.metadata.line}, quote verbatim the sentence explaining `;
  const suffix = '. Give the exact quote, the PDF path, and the page. Use the PDF text extraction tool if available; do not ask the user.';
  assert(task.prompt.startsWith(prefix) && task.prompt.endsWith(suffix) &&
    task.prompt.length > prefix.length + suffix.length, 'prompt locator/template mismatch');
  const extracted = await extractPage(task.metadata.manuscript_path, task.metadata.line);
  if (expectedPdfHash !== undefined) assert.equal(extracted.pdf_sha256, expectedPdfHash, 'PDF source hash mismatch');
  assertUniqueQuote(extracted.text, task.answer);
  return extracted;
}

export async function verifyPack() {
  const tasksFile = readTasks(path.join(PACK, 'tasks.json'));
  const pilotFile = readTasks(path.join(PACK, 'pilot.json'));
  const tasks = tasksFile.tasks;
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map(task => task.metadata.manuscript_path)).size, 10);
  assert.deepEqual(pilotFile.tasks, tasks.slice(0, 5), 'pilot must be deterministic first five');
  const baseline = JSON.parse(fs.readFileSync(path.join(PACK, 'baselines.json'), 'utf8'));
  assert.equal(baseline.schema, 'math-bench-baselines/v1');
  assert.equal(baseline.benchmark, 'pdf-necessity');
  assert.deepEqual(baseline.external, []);
  assert.equal(baseline.note, 'No published score for this exact model/version was found; use the paired plugin-off arm.');
  const readme = fs.readFileSync(path.join(PACK, 'README.md'), 'utf8');
  const block = readme.match(/```json\n([\s\S]+?)\n```/);
  assert(block, 'missing source hash manifest');
  const sources = JSON.parse(block[1]);
  for (const [key, file] of [
    ['manifest_sha256', path.join(MATH, 'CONTENTS.md')],
    ['license_sha256', path.join(MATH, 'LICENSE')],
    ['extractor_sha256', EXTRACTOR],
    ['build_sha256', path.join(PACK, 'build.mjs')],
    ['verify_sha256', path.join(PACK, 'verify.mjs')],
  ]) assert.equal(sha256(fs.readFileSync(file)), sources[key], `source hash mismatch: ${key}`);
  assert(readme.includes(`tasks.json SHA-256: \`${tasksFile.hash}\``), 'tasks artifact hash mismatch');
  assert(readme.includes(`pilot.json SHA-256: \`${pilotFile.hash}\``), 'pilot artifact hash mismatch');
  assert.equal(sources.pdfs.length, 10);
  const manifest = fs.readFileSync(path.join(MATH, 'CONTENTS.md'), 'utf8');
  for (const [index, task] of tasks.entries()) {
    const source = sources.pdfs[index];
    assert.equal(task.id, `pdf-text-${String(index + 1).padStart(2, '0')}`);
    assert(manifest.includes(`[${task.metadata.manuscript_title}](${task.metadata.manuscript_path})`),
      'released PDF title/path absent from CONTENTS.md');
    assert.equal(source.manuscript_path, task.metadata.manuscript_path);
    assert.equal(source.page, task.metadata.line);
    assert.match(source.pdf_sha256, /^[a-f0-9]{64}$/);
    const extracted = await verifyTask(task, { expectedPdfHash: source.pdf_sha256 });
    assert.equal(sha256(extracted.text), source.extracted_page_sha256, 'extracted page hash mismatch');
  }
  return { tasks: tasks.length, pilot: pilotFile.tasks.length, status: 'passed',
    extraction: sources.method, tasks_sha256: tasksFile.hash, pilot_sha256: pilotFile.hash };
}

if (isMain(import.meta.url)) console.log(JSON.stringify(await verifyPack(), null, 2));
