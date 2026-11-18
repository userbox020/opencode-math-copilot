import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packDir = path.dirname(fileURLToPath(import.meta.url));
export const defaultSourceDir = "C:/Users/MiPC/AppData/Local/Temp/opencode/math-benchmarks-20261117/proofnet-verified";
export const sourceFiles = {
  jsonl: "data/proofnet-verified-latest.jsonl",
  toolchain: "lean-toolchain",
  zip: "data/archive/proofnet-verified_gt-4.28.zip",
};
export const instruction = "Prove the following Lean theorem by replacing the `sorry`. Return a complete Lean file. Do not change the statement or definitions.";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const taskId = (index) => `proofnet-${String(index).padStart(3, "0")}`;

export function theoremName(statement) {
  const match = statement.match(/\b(?:theorem|lemma)\s+((?:«[^»]+»|[^\s.:({\[]+)(?:\.(?:«[^»]+»|[^\s.:({\[]+))*)/u);
  assert.ok(match, "Missing theorem/lemma declaration");
  return match[1];
}

export function formalStatement(row) {
  if (row.index !== 35) {
    assert.match(row.formal_stmt, /\bsorry\b/u);
    return row.formal_stmt;
  }
  // The latest source accidentally embeds a complete answer for this row.
  // Preserve its declaration/type verbatim, but never export its proof body.
  const declaration = "theorem Dummit_Foote_exercise_1_6_4 :\n    IsEmpty (ℝˣ ≃* ℂˣ) := by";
  assert.ok(row.formal_stmt.startsWith(`${declaration}\n`), "Row 35 declaration changed");
  return `${declaration}\n  sorry`;
}

// Read only ZIP central-directory metadata; never decompress any gold proof.
export function zipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  assert.ok(end >= 0, "ZIP end record not found");
  assert.equal(bytes.readUInt16LE(end + 4), 0, "Multi-disk ZIP unsupported");
  assert.equal(bytes.readUInt16LE(end + 6), 0, "Multi-disk ZIP unsupported");
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  let offset = bytes.readUInt32LE(end + 16);
  const directoryEnd = offset + bytes.readUInt32LE(end + 12);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50, "Invalid ZIP central entry");
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    names.push(bytes.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, directoryEnd);
  assert.ok(directoryEnd <= end);
  return names;
}

export function selectPilot(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const book = task.metadata.textbook;
    if (!groups.has(book)) groups.set(book, []);
    groups.get(book).push(task);
  }
  const ordered = [...groups.entries()].sort(([a, x], [b, y]) =>
    y.length - x.length || (a < b ? -1 : a > b ? 1 : 0));
  const pilot = [];
  for (const [, group] of ordered) {
    group.sort((a, b) => Number(a.id.slice(9)) - Number(b.id.slice(9)));
    const count = Math.min(5, group.length, 20 - pilot.length);
    for (let i = 0; i < count; i++) {
      const position = count === 1 ? 0 : Math.round(i * (group.length - 1) / (count - 1));
      pilot.push(group[position]);
    }
    if (pilot.length === 20) break;
  }
  assert.equal(pilot.length, 20);
  return pilot;
}

export async function buildArtifacts(sourceDir = defaultSourceDir) {
  const buffers = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(
    async ([key, file]) => [key, await readFile(path.join(sourceDir, file))],
  )));
  assert.equal(buffers.toolchain.toString("utf8").trim(), "leanprover/lean4:v4.34.0");
  const rows = buffers.jsonl.toString("utf8").trim().split(/\r?\n/u).map(JSON.parse)
    .sort((a, b) => a.index - b.index);
  assert.equal(rows.length, 367);
  assert.equal(new Set(rows.map((row) => row.index)).size, 367);
  const entries = zipEntries(buffers.zip);
  assert.equal(entries.length, 367);
  assert.equal(new Set(entries).size, 367);
  const tasks = rows.map((row) => {
    assert.ok(Number.isInteger(row.index) && row.index >= 1 && row.index <= 367);
    for (const key of ["name", "textbook", "header", "helper", "informal_stmt", "formal_stmt"]) {
      assert.equal(typeof row[key], "string");
    }
    const statement = formalStatement(row);
    return {
      schema: "math-bench-lean-task/v1",
      benchmark: "proofnet-verified",
      id: taskId(row.index),
      name: row.name,
      prompt: [row.informal_stmt, instruction, row.header, row.helper, statement].join("\n\n"),
      formal: {
        header: row.header,
        helper: row.helper,
        statement,
        theorem_name: theoremName(statement),
      },
      grading: {
        type: "lean",
        toolchain: "4.34.0",
        imports: ["Mathlib"],
        allowed_axioms: ["propext", "Quot.sound", "Classical.choice"],
      },
      metadata: {
        source: "https://github.com/marcusm117/ProofNet-Verified",
        license: "Apache-2.0",
        textbook: row.textbook,
        gold_proof: "evaluator-only-archive",
        version: "latest",
      },
    };
  });
  const controls = {
    schema: "math-bench-lean-controls/v1",
    benchmark: "proofnet-verified",
    verified: false,
    inputs: Object.fromEntries(Object.entries(sourceFiles).map(([key, file]) => [
      key, { path: file, sha256: sha256(buffers[key]) },
    ])),
    gold_archive_toolchain: "4.28",
    task_toolchain: "4.34.0",
    workspace_checker_toolchain: "4.34.1",
    checker_bound: false,
    zip_entry_count: entries.length,
    normalizations: [{
      id: "proofnet-035",
      field: "formal_stmt",
      action: "Replaced embedded complete proof body with sorry; declaration/type unchanged.",
    }],
    entries: Object.fromEntries(rows.map((row) => {
      const entry = `proofnet_verified_gt/proofnet-${row.index}.lean`;
      assert.ok(entries.includes(entry), `Missing gold ZIP entry: ${entry}`);
      return [taskId(row.index), {
        gold_proof_zip_entry: entry,
        gold_proof_sha256: null,
        verified: false,
      }];
    })),
  };
  const baselines = {
    schema: "math-bench-baselines/v1",
    benchmark: "proofnet-verified",
    model: "opencode-go/deepseek-v4.1-flash",
    external: [],
    note: "No published score for this exact model/version was found; use the paired plugin-off arm. Lean 4.34.0 pack; workspace checker is 4.34.1 and is not yet bound.",
  };
  return {
    "tasks.json": serialize(tasks),
    "pilot.json": serialize(selectPilot(tasks)),
    "controls.json": serialize(controls),
    "baselines.json": serialize(baselines),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length <= 3, "Usage: node build.mjs [source-directory]");
  const artifacts = await buildArtifacts(process.argv[2] || defaultSourceDir);
  for (const [name, contents] of Object.entries(artifacts)) {
    await writeFile(path.join(packDir, name), contents, "utf8");
  }
  console.log("Built 367 tasks, 20 pilot tasks, and 367 unverified controls.");
}
