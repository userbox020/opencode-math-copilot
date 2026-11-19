import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const hash = value => createHash('sha256').update(value).digest('hex');
export const corpusRoot = () => process.env.TOOL_NECESSITY_CORPUS_ROOT || 'C:\\_Work\\__OPENAI_MATH\\math';

export function decode(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  assert(!text.includes('\0'), 'NUL in source');
  return text;
}

function validString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `Invalid ${label}`);
  assert(!value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value, `Invalid UTF-8/NUL in ${label}`);
}

export function words(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
}

export function promptLeaks(prompt, quote) {
  if (prompt.includes(quote)) return true;
  const promptWords = ` ${words(prompt).join(' ')} `;
  const quoteWords = words(quote);
  for (let i = 0; i <= quoteWords.length - 8; i++) {
    if (promptWords.includes(` ${quoteWords.slice(i, i + 8).join(' ')} `)) return true;
  }
  return false;
}

export function parseContents(text) {
  let family;
  const manuscripts = [];
  for (const line of text.split('\n')) {
    const heading = line.match(/^\*\*(\d+)\./);
    if (heading) family = heading[1];
    const link = line.match(/\]\((preprints\/[^)]+\.pdf)\)/);
    if (family && link) manuscripts.push({ family, directory: path.posix.dirname(link[1]) });
  }
  return manuscripts;
}

export function titleFromReadme(text) {
  const title = text.match(/^# \[(.+)\]\([^\r\n]+\)/m)?.[1];
  assert(title, 'README title missing');
  return title;
}

export function sectionAt(text, offset) {
  const prefix = text.slice(0, offset);
  const matches = [...prefix.matchAll(/\\(?:sub)*section\*?(?:\[[^\]]*\])?\{/g)];
  assert(matches.length, 'Quote has no identifiable section');
  const start = matches.at(-1).index + matches.at(-1)[0].length;
  let depth = 1;
  for (let i = start; i < prefix.length; i++) {
    if (prefix[i - 1] === '\\') continue;
    if (prefix[i] === '{') depth++;
    if (prefix[i] === '}' && --depth === 0) return prefix.slice(start, i);
  }
  throw new Error('Unterminated section heading');
}

function readActual(root, relative) {
  assert(typeof relative === 'string' && !relative.includes('\\') && !relative.split('/').includes('..') && !path.isAbsolute(relative), 'Unsafe source path');
  const base = realpathSync(root);
  const target = realpathSync(path.join(base, relative));
  const resolved = path.relative(base, target);
  assert(resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved), 'Source escapes corpus');
  return readFileSync(target);
}

function exactKeys(object, keys, label) {
  assert(object && typeof object === 'object' && !Array.isArray(object), `Invalid ${label}`);
  assert(JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort()), `Unexpected ${label} fields`);
}

export function verifyPack({ tasks, pilot, baselines }, root = corpusRoot()) {
  assert(Array.isArray(tasks) && tasks.length === 20, 'Expected 20 tasks');
  assert(Array.isArray(pilot) && pilot.length === 10, 'Expected 10 pilot tasks');
  assert(baselines?.schema === 'math-bench-baselines/v1' && baselines.benchmark === 'tool-necessity', 'Invalid baselines');
  assert(Array.isArray(baselines.external) && baselines.external.length === 0, 'Expected empty external baselines');
  const provenance = baselines.metadata;
  assert(provenance?.corpus === 'openai/math' && provenance.corpus_manifest === 'CONTENTS.md', 'Missing corpus provenance');
  const contents = readActual(root, 'CONTENTS.md');
  assert(hash(contents) === provenance.corpus_manifest_sha256, 'Corpus manifest hash mismatch');
  const manuscripts = parseContents(decode(contents));
  assert(Array.isArray(provenance.files) && provenance.files.length === tasks.length, 'Missing source hashes');
  assert(hash(JSON.stringify(provenance.files)) === provenance.selected_sources_sha256, 'Source manifest hash mismatch');
  const ids = new Set(), directories = new Set(), families = new Set(), pilotFamilies = new Set();
  tasks.forEach((task, index) => {
    exactKeys(task, ['schema', 'benchmark', 'id', 'prompt', 'answer', 'grading', 'metadata'], 'task');
    assert(task.schema === 'math-bench-task/v1' && task.benchmark === 'tool-necessity', 'Invalid task schema');
    assert(task.id === `tool-text-${String(index + 1).padStart(2, '0')}` && !ids.has(task.id), 'Invalid/duplicate task ID');
    ids.add(task.id);
    validString(task.answer, 'quote');
    validString(task.prompt, 'prompt');
    assert(words(task.answer).length >= 12, `${task.id}: quote shorter than 12 words`);
    assert(!promptLeaks(task.prompt, task.answer), `${task.id}: prompt leaks quote`);
    exactKeys(task.grading, ['type', 'answer', 'note'], 'grading');
    assert(task.grading.type === 'quote' && task.grading.answer === task.answer, `${task.id}: grading mismatch`);
    validString(task.grading.note, 'grading note');
    const meta = task.metadata;
    exactKeys(meta, ['source', 'license', 'kind', 'manuscript_path', 'line', 'manuscript_title', 'section', 'quote_sha256'], 'metadata');
    assert(meta.kind === 'text' && Number.isSafeInteger(meta.line) && meta.line >= 1, `${task.id}: invalid locator`);
    for (const key of ['source', 'license', 'manuscript_path', 'manuscript_title', 'section', 'quote_sha256']) validString(meta[key], key);
    assert(/^preprints\/[^/]+\/build\/.+\.tex$/.test(meta.manuscript_path), 'Not a manuscript TeX source');
    assert(meta.source === `https://github.com/openai/math/blob/main/${meta.manuscript_path}`, 'Source URL mismatch');
    const manuscriptDirectory = meta.manuscript_path.split('/').slice(0, 2).join('/');
    assert(!directories.has(manuscriptDirectory), 'Duplicate manuscript');
    directories.add(manuscriptDirectory);
    const record = provenance.files[index];
    const manuscript = manuscripts.find(item => item.directory === manuscriptDirectory);
    assert(manuscript && manuscript.family === record.family, 'Family mismatch');
    families.add(record.family);
    if (index < 10) pilotFamilies.add(record.family);
    assert(record.manuscript_path === meta.manuscript_path, 'Source manifest locator mismatch');
    const bytes = readActual(root, meta.manuscript_path);
    assert(hash(bytes) === record.source_sha256, `${task.id}: source hash mismatch`);
    const text = decode(bytes);
    const offset = text.indexOf(task.answer);
    assert(offset >= 0, `${task.id}: quote absent from actual source`);
    assert(text.indexOf(task.answer, offset + 1) === -1, `${task.id}: quote not unique in source`);
    assert(hash(task.answer) === meta.quote_sha256, `${task.id}: quote hash mismatch`);
    assert(text.slice(0, offset).split('\n').length === meta.line, `${task.id}: line mismatch`);
    const lines = text.split('\n');
    const lineStart = lines.slice(0, meta.line - 1).reduce((length, line) => length + line.length + 1, 0);
    assert(offset >= lineStart && offset < lineStart + lines[meta.line - 1].length, `${task.id}: quote does not start on recorded line`);
    assert(sectionAt(text, offset) === meta.section, `${task.id}: section mismatch`);
    const environment = [];
    for (const match of text.slice(0, offset).matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
      if (match[1] === 'begin') environment.push(match[2]);
      else {
        assert(environment.at(-1) === match[2], 'Unbalanced TeX environments before quote');
        environment.pop();
      }
    }
    assert(!environment.some(name => /^(abstract|theorem|lemma|proposition|corollary)\*?$/.test(name)), `${task.id}: abstract/theorem quote excluded`);
    assert(record.readme_path === `${manuscriptDirectory}/README.md`, 'README locator mismatch');
    const readme = readActual(root, record.readme_path);
    assert(hash(readme) === record.readme_sha256, 'README hash mismatch');
    assert(titleFromReadme(decode(readme)) === meta.manuscript_title, 'README title mismatch');
    assert(task.answer !== meta.manuscript_title && task.prompt.includes(meta.manuscript_title) && task.prompt.includes(meta.section), 'Title/section prompt mismatch');
  });
  assert(families.size >= 6 && pilotFamilies.size >= 6, 'Insufficient family coverage');
  assert(JSON.stringify(pilot) === JSON.stringify(tasks.slice(0, 10)), 'Pilot is not the first 10 tasks');
  return { status: 'verified', tasks: tasks.length, manuscripts: directories.size, families: [...families], pilot_ids: pilot.map(task => task.id) };
}

export function loadPack() {
  return Object.fromEntries(['tasks', 'pilot', 'baselines'].map(name => [name, JSON.parse(decode(readFileSync(path.join(directory, `${name}.json`))))]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--stdin'), 'Usage: node verify.mjs [--stdin]');
    const pack = process.argv[2] === '--stdin' ? JSON.parse(decode(readFileSync(0))) : loadPack();
    console.log(JSON.stringify(verifyPack(pack), null, 2));
  } catch (error) {
    console.error(`Verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
