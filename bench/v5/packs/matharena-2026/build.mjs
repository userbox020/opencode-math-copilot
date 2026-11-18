import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INPUT_DIR = 'C:/Users/MiPC/AppData/Local/Temp/opencode/math-benchmarks-20261117/matharena';
export const INSTRUCTION = 'Solve the problem. Put the final answer on its own last line in the form: FINAL: <answer>.';
export const REVIEW_NOTE = 'Normalized answer (length >= 8) appears verbatim in the original problem; retained for review because occurrence alone is not answer disclosure.';
export const SOURCES = [
  { contest: 'aime-2026', year: 2026, file: 'aime_2026.rows.json', count: 30, sha256: '9c9173d4ad201ade936a993d0899f914521dd42657a6f418f2aad3d118a358a2' },
  { contest: 'hmmt-feb-2026', year: 2026, file: 'hmmt_feb_2026.rows.json', count: 33, sha256: '26fec94fb258cabecda67ab20ff3f4838f815cfbe930108af6aff7fd622e87d2' },
  { contest: 'brumo-2025', year: 2025, file: 'brumo_2025.rows.json', count: 30, sha256: '0f5f81433e3b2276e0ee2a7ec9beab5fe7dbd850be8e36542624cb7babd8061e' },
  { contest: 'smt-2025', year: 2025, file: 'smt_2025.rows.json', count: 53, sha256: '843497f36a7f516db9786c8c674a2ff0ab95524dfb30022bbbd3cb5dda0d3748' },
];

export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function hasTopLevelComma(answer) {
  let depth = 0;
  for (const char of answer) {
    if ('({['.includes(char)) depth++;
    else if (')}]'.includes(char)) depth--;
    else if (char === ',' && depth === 0) return true;
  }
  return false;
}

export function normalizeAnswer(value) {
  if (value === null || value === undefined || !['number', 'string'].includes(typeof value)) {
    throw new Error('Missing or invalid answer');
  }
  const answer = String(value).trim();
  if (!answer) throw new Error('Empty answer');
  // Only conventional thousands separators are integer commas: 13,14,18 is a list.
  if (/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(answer)) {
    return { answer, grading: { type: 'integer', answer: answer.replaceAll(',', '') } };
  }
  const symbolic = /\\(?:frac|sqrt)\b|\^/.test(answer)
    || (answer.match(/=/g) ?? []).length > 1 || hasTopLevelComma(answer);
  return { answer, grading: { type: symbolic ? 'symbolic' : 'exact', answer } };
}

function rejectDisclosure(problem, answer) {
  // Inspect only the source problem, never the appended response-format instruction.
  if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?FINAL\s*:/im.test(problem)) {
    throw new Error('Explicit FINAL: line in source problem');
  }
  const escaped = answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const answerPhrase = new RegExp(
    String.raw`\b(?:the\s+)?(?:final\s+)?answer\s+is\s*[:=]?\s*(?:\${1,2}|\\\(|\\\[)?\s*${escaped}`,
    'i',
  );
  if (answerPhrase.test(problem)) throw new Error('Explicit answer phrase in source problem');
  const section = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:solution|answer)(?:\*\*)?\s*(?::|$)/gim;
  for (const match of problem.matchAll(section)) {
    if (problem.slice(match.index + match[0].length).toLowerCase().includes(answer.toLowerCase())) {
      throw new Error('Solution/answer section contains the answer');
    }
  }
}

export function normalizeRow(row, source) {
  if (typeof row.problem !== 'string' || !row.problem.trim()) throw new Error('Empty problem');
  if (!Number.isInteger(row.problem_idx) || row.problem_idx < 1) throw new Error('Invalid problem number');
  const { answer, grading } = normalizeAnswer(row.answer);
  rejectDisclosure(row.problem, grading.answer);
  const metadata = {
    source: `Hugging Face datasets-server snapshot: ${source.file}`,
    license: 'Not specified in supplied raw response',
    contest: source.contest,
    year: source.year,
    problem_number: row.problem_idx,
  };
  if (row.problem_type !== undefined) metadata.problem_type = row.problem_type;
  if (grading.answer.length >= 8 && row.problem.toLowerCase().includes(grading.answer.toLowerCase())) {
    metadata.answer_in_prompt = true;
    metadata.review_note = REVIEW_NOTE;
  }
  return {
    schema: 'math-bench-task/v1',
    benchmark: 'matharena-2026',
    id: `${source.contest}-${String(row.problem_idx).padStart(2, '0')}`,
    prompt: `${row.problem}\n\n${INSTRUCTION}`,
    answer,
    grading,
    metadata,
  };
}

export function selectPilot(tasks) {
  return SOURCES.flatMap(({ contest }) => {
    const group = tasks.filter((task) => task.metadata.contest === contest)
      .sort((a, b) => a.metadata.problem_number - b.metadata.problem_number);
    if (group.length < 10) throw new Error(`Too few tasks for ${contest}`);
    return Array.from({ length: 10 }, (_, i) => group[Math.round(i * (group.length - 1) / 9)]);
  });
}

export function buildPack(inputDir = DEFAULT_INPUT_DIR) {
  const tasks = SOURCES.flatMap((source) => {
    const bytes = readFileSync(join(inputDir, source.file));
    if (sha256(bytes) !== source.sha256) throw new Error(`Raw input checksum mismatch: ${source.file}`);
    const response = JSON.parse(bytes);
    if (response.rows.length !== source.count) throw new Error(`Wrong row count: ${source.file}`);
    return response.rows.map(({ row }) => normalizeRow(row, source))
      .sort((a, b) => a.metadata.problem_number - b.metadata.problem_number);
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('Duplicate task ids');
  const pilot = selectPilot(tasks);
  const review = tasks.filter((task) => task.metadata.answer_in_prompt)
    .map((task) => ({ id: task.id, reason: task.metadata.review_note }));
  return { tasks, pilot, review };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node build.mjs [raw-input-directory]');
  const pack = buildPack(process.argv[2] ?? DEFAULT_INPUT_DIR);
  for (const name of ['tasks', 'pilot', 'review']) {
    writeFileSync(join(PACK_DIR, `${name}.json`), serialize(pack[name]), 'utf8');
  }
  console.log(serialize({
    tasks: pack.tasks.length,
    counts: Object.fromEntries(SOURCES.map(({ contest }) =>
      [contest, pack.tasks.filter((task) => task.metadata.contest === contest).length])),
    grading: Object.fromEntries(['integer', 'exact', 'symbolic'].map((type) =>
      [type, pack.tasks.filter((task) => task.grading.type === type).length])),
    flaggedIds: pack.review.map(({ id }) => id),
    pilotIds: pack.pilot.map(({ id }) => id),
    sha256: { tasks: sha256(serialize(pack.tasks)), pilot: sha256(serialize(pack.pilot)) },
  }));
}
