import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCHMARK = 'imo-answerbench-v2';
export const DEFAULT_CSV = 'C:/Users/MiPC/AppData/Local/Temp/opencode/math-benchmarks-20261117/imobench/answerbench_v2.csv';
export const CSV_SHA256 = '275877a9d988d85278fad3a5f8a41d7f83393a60bf259531ec0a5161e6b21cf9';
export const INSTRUCTION = 'Solve the problem. Put the final answer on its own last line in the form: FINAL: <answer>.';
export const GRADING_NOTE = 'normalized exact/symbolic comparison; unparseable if not confidently comparable';
export const REVIEW_NOTE = 'Normalized answer of length >= 8 appears in the problem; review for possible answer leakage (not automatically rejected).';
export const REPAIR_ID = 'imo-bench-algebra-036';
const ORIGINAL_EXCERPT = String.raw`imo-bench-algebra-036,"Find all functions $Y: \mathbb{R} \backslash\{0\} \rightarrow \mathbb{R}$ such that for any non-zero real numbers $a, b$ with $ab \neq -1$, the following equation holds:
\[
a Y\left(a+\frac{1}{b}\right)+b Y(b)+\frac{a}{b}=b Y\left(b+\frac{1}{a}\right)+a Y(a)+\frac{b}{a}
\]
,"$Y(x)=A+\frac{B}{x}-x$",Algebra,Functional Equation,Iran 2002`;
const REPAIRED_EXCERPT = ORIGINAL_EXCERPT.replace('\n,"$Y', '"\n,"$Y');
export const REPAIRED_ROW = [
  REPAIR_ID,
  ORIGINAL_EXCERPT.split('\n').slice(0, 4).join('\n').slice(`${REPAIR_ID},"`.length),
  String.raw`$Y(x)=A+\frac{B}{x}-x$`,
  'Algebra',
  'Functional Equation',
  'Iran 2002',
];
export const BASELINES = {
  schema: 'math-bench-baselines/v1',
  benchmark: BENCHMARK,
  model: 'opencode-go/deepseek-v4.1-flash',
  external: [],
  note: 'No published score for this exact model/version was found; use the paired plugin-off arm. External leaderboard scores are not apples-to-apples.',
};
const HEADERS = ['Problem ID', 'Problem', 'Short Answer', 'Category', 'Subcategory', 'Source'];

// Preserve field contents, including CRLF inside quotes; only record separators are removed.
export function parseCSV(input, { repairedRowContinuation = false } = {}) {
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let started = false;
  const finishField = () => {
    row.push(field);
    field = '';
    closedQuote = false;
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === ',') {
      finishField();
    } else if (ch === '\r' || ch === '\n') {
      // The authorized repair closes the field BEFORE the physical newline.
      // Only this row may continue with a comma on the following physical line.
      const next = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1;
      if (repairedRowContinuation && closedQuote && row.length === 1
          && row[0] === REPAIR_ID && text[next] === ',') {
        i = next - 1;
        continue;
      }
      finishField();
      rows.push(row);
      row = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else if (ch === '"' && !started && !closedQuote) {
      quoted = true;
      started = true;
    } else {
      if (closedQuote || ch === '"') throw new Error(`Invalid CSV quoting at character ${i}`);
      field += ch;
      started = true;
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field');
  if (started || closedQuote || row.length) {
    finishField();
    rows.push(row);
  }
  return rows;
}

export function repairCSV(csv) {
  if (sha256(Buffer.from(csv, 'utf8')) !== CSV_SHA256) throw new Error('Unexpected source CSV hash');
  if (csv.split(ORIGINAL_EXCERPT).length !== 2) throw new Error('Expected exactly one authorized repair site');
  const start = csv.indexOf(ORIGINAL_EXCERPT);
  assert.equal(csv.slice(0, start).split('\n').length, 150);
  const repaired = csv.replace(ORIGINAL_EXCERPT, REPAIRED_EXCERPT);
  const rows = parseCSV(repaired, { repairedRowContinuation: true });
  assert.equal(rows.length, 401, 'Expected header and 400 data rows');
  assert.deepEqual(rows.find((row) => row[0] === REPAIR_ID), REPAIRED_ROW);
  // The original complete CSV is unparseable. Parse its untouched prefix and
  // suffix with the malformed record excluded, then compare all other rows.
  const unaffectedBefore = parseCSV(csv.slice(0, start)
    + csv.slice(start + ORIGINAL_EXCERPT.length).replace(/^\r?\n/u, ''));
  assert.deepEqual(rows.filter((row) => row[0] !== REPAIR_ID), unaffectedBefore);
  assert.ok(rows.slice(1).every((row) => row.length === 6 && row[2].trim()));
  return {
    csv: repaired,
    repairs: {
      schema: 'math-bench-repairs/v1',
      source_csv_sha256: CSV_SHA256,
      entries: [{
        id: REPAIR_ID,
        line_range: [150, 154],
        action: 'Insert one missing closing quote immediately after \\] and before the newline, in memory only. Parse the following physical newline as a record continuation for this row only.',
        original_excerpt: ORIGINAL_EXCERPT,
        repaired_excerpt: REPAIRED_EXCERPT,
      }],
    },
    unchangedRows: unaffectedBefore.length - 1,
  };
}

export function normalize(text) {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function answerInPrompt(prompt, answer) {
  const normalized = normalize(answer);
  return normalized.length >= 8 && normalize(prompt).toLowerCase().includes(normalized.toLowerCase());
}

export function explicitLeakage(problem, answer) {
  if (/^\s*FINAL:/imu.test(problem)) return true;
  const escaped = normalize(answer).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (new RegExp(`\\bthe answer is\\s+${escaped}(?=$|[\\s.,;:!?])`, 'iu').test(normalize(problem))) return true;
  const section = /^(?:\s*#{1,6}\s*|\s*\*\*|\s*)(?:solution|answer)(?:\*\*)?\s*(?::|$)|\\(?:sub)*section\*?\{(?:solution|answer)\}/imu.exec(problem);
  return Boolean(section && normalize(problem.slice(section.index + section[0].length)).includes(normalize(answer)));
}

export function gradingType(answer) {
  return /[\\^_,]/u.test(answer) || (answer.match(/=/gu) ?? []).length > 1
    ? 'symbolic'
    : 'exact';
}

export function createTasks(csv, options) {
  const [header, ...rows] = parseCSV(csv, options);
  if (JSON.stringify(header) !== JSON.stringify(HEADERS)) throw new Error('Unexpected CSV headers');
  const ids = new Set();
  return rows.map((row, index) => {
    if (row.length !== HEADERS.length) throw new Error(`Wrong column count in row ${index + 2}`);
    const [id, problem, shortAnswer, category, subcategory, sourceText] = row;
    if (!id.trim() || ids.has(id)) throw new Error(`Empty or duplicate Problem ID: ${id}`);
    ids.add(id);
    const answer = shortAnswer.trim();
    if (!problem.trim() || !answer) throw new Error(`Empty prompt or answer: ${id}`);
    const prompt = `${problem}\n\n${INSTRUCTION}`;
    if (explicitLeakage(problem, answer)) throw new Error(`Explicit answer leakage: ${id}`);
    return {
      schema: 'math-bench-task/v1',
      benchmark: BENCHMARK,
      id,
      prompt,
      answer,
      grading: { type: gradingType(answer), answer, note: GRADING_NOTE },
      metadata: {
        source: 'IMO-Bench / answerbench_v2.csv',
        license: 'CC-BY-4.0 (data); Apache-2.0 (software)',
        category,
        subcategory,
        source_text: sourceText,
        ...(answerInPrompt(problem, answer) ? { answer_in_prompt: true, review_note: REVIEW_NOTE } : {}),
      },
    };
  });
}

export function selectPilot(tasks) {
  const categories = new Map();
  for (const task of tasks) {
    const name = task.metadata.category;
    if (!categories.has(name)) categories.set(name, []);
    categories.get(name).push(task);
  }
  // Code-point name ordering avoids locale-dependent sorting.
  const ranked = [...categories].sort(([a, aa], [b, bb]) =>
    bb.length - aa.length || (a < b ? -1 : a > b ? 1 : 0));
  return ranked.slice(0, 4).flatMap(([, members]) => {
    const count = Math.min(10, members.length);
    return Array.from({ length: count }, (_, i) =>
      members[count === 1 ? 0 : Math.floor(i * (members.length - 1) / (count - 1))]);
  });
}

export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function distribution(tasks, key) {
  const counts = {};
  for (const task of tasks) {
    const value = key(task);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export async function build(csvPath = DEFAULT_CSV) {
  const bytes = await readFile(csvPath);
  const csvSha256 = sha256(bytes);
  if (csvSha256 !== CSV_SHA256) throw new Error(`CSV SHA-256 mismatch: ${csvSha256}`);
  const repaired = repairCSV(bytes.toString('utf8'));
  const tasks = createTasks(repaired.csv, { repairedRowContinuation: true });
  const pilot = selectPilot(tasks);
  if (tasks.length !== 400) throw new Error(`Expected 400 tasks, got ${tasks.length}`);
  if (pilot.length !== 40) throw new Error(`Expected 40 pilot tasks, got ${pilot.length}`);
  const tasksJSON = json(tasks);
  const pilotJSON = json(pilot);
  const repairsJSON = json(repaired.repairs);
  const review = {
    schema: 'math-bench-review/v1',
    benchmark: BENCHMARK,
    source_csv_sha256: csvSha256,
    entries: tasks.filter((task) => task.metadata.answer_in_prompt).map((task) => ({
      id: task.id, answer: task.answer, note: task.metadata.review_note,
    })),
  };
  for (const [name, contents] of [
    ['tasks.json', tasksJSON], ['pilot.json', pilotJSON], ['baselines.json', json(BASELINES)],
    ['repairs.json', repairsJSON], ['review.json', json(review)],
  ]) {
    await writeFile(new URL(name, import.meta.url), contents, 'utf8');
  }
  return {
    tasks: tasks.length,
    pilot: pilot.length,
    categories: distribution(tasks, (task) => task.metadata.category),
    grading: distribution(tasks, (task) => task.grading.type),
    pilotCategories: distribution(pilot, (task) => task.metadata.category),
    pilotIds: pilot.map((task) => task.id),
    flaggedIds: review.entries.map((entry) => entry.id),
    unchangedRows: repaired.unchangedRows,
    csvSha256,
    tasksSha256: sha256(tasksJSON),
    pilotSha256: sha256(pilotJSON),
    repairsSha256: sha256(repairsJSON),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(json(await build(process.argv[2])));
}
