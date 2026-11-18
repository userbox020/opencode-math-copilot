import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildArtifacts, defaultSourceDir, formalStatement, instruction, packDir,
  selectPilot, serialize, sha256, sourceFiles, taskId, theoremName, zipEntries,
} from "../build.mjs";

const sourceDir = process.env.PROOFNET_SOURCE_DIR || defaultSourceDir;
const load = async (name) => JSON.parse(await readFile(path.join(packDir, name), "utf8"));
const tasks = await load("tasks.json");
const pilot = await load("pilot.json");
const controls = await load("controls.json");
const rows = (await readFile(path.join(sourceDir, sourceFiles.jsonl), "utf8"))
  .trim().split(/\r?\n/u).map(JSON.parse);
const byIndex = new Map(rows.map((row) => [row.index, row]));

test("367 schema-conforming tasks with unique zero-padded IDs", () => {
  assert.equal(tasks.length, 367);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 367);
  for (const [i, task] of tasks.entries()) {
    assert.equal(task.id, taskId(i + 1));
    assert.equal(task.schema, "math-bench-lean-task/v1");
    assert.equal(task.benchmark, "proofnet-verified");
    assert.equal(task.name, byIndex.get(i + 1).name);
    assert.deepEqual(task.grading, {
      type: "lean", toolchain: "4.34.0", imports: ["Mathlib"],
      allowed_axioms: ["propext", "Quot.sound", "Classical.choice"],
    });
    assert.equal(task.metadata.license, "Apache-2.0");
    assert.equal(task.metadata.gold_proof, "evaluator-only-archive");
  }
});

test("prompts contain only the allowed source fields and instruction, never source proofs", () => {
  for (const task of tasks) {
    const row = byIndex.get(Number(task.id.slice(9)));
    assert.equal(task.prompt, [
      row.informal_stmt, instruction, row.header, row.helper, formalStatement(row),
    ].join("\n\n"));
    for (const key of ["informal_proof", "formal_proof"]) {
      assert.equal(Object.hasOwn(task, key), false);
      if (row[key]?.trim()) assert.equal(task.prompt.includes(row[key].trim()), false, `${task.id}: ${key}`);
    }
    assert.doesNotMatch(task.prompt, /proofnet_verified_gt|proofnet-verified_gt-4\.28\.zip/u);
  }
});

test("every formal statement has sorry and its extracted theorem name", () => {
  for (const task of tasks) {
    const row = byIndex.get(Number(task.id.slice(9)));
    assert.equal(task.formal.header, row.header);
    assert.equal(task.formal.helper, row.helper);
    assert.match(task.formal.statement, /\bsorry\b/u);
    assert.equal(task.formal.theorem_name, theoremName(row.formal_stmt));
    assert.equal(task.formal.theorem_name, row.name);
    if (row.index !== 35) assert.equal(task.formal.statement, row.formal_stmt);
  }
});

test("theorem-name extraction supports attributes, lemmas, and namespaces", () => {
  assert.equal(theoremName("@[simp] theorem Foo.Bar.result (x : Nat) : x = x := by sorry"), "Foo.Bar.result");
  assert.equal(theoremName("@[simp, aesop safe] protected lemma Foo.result' : True := by sorry"), "Foo.result'");
  assert.equal(theoremName("lemma Foo.«name with spaces» : True := by sorry"), "Foo.«name with spaces»");
  assert.throws(() => theoremName("def value : Nat := 0"));
});

test("row 35 embedded answer is removed without changing its declaration", () => {
  const row = byIndex.get(35);
  const task = tasks.find((item) => item.id === "proofnet-035");
  assert.equal(task.formal.statement, `${row.formal_stmt.split(":= by")[0]}:= by\n  sorry`);
  assert.equal(task.prompt.includes(row.formal_stmt), false);
  assert.doesNotMatch(task.prompt, /constructor|intro f|let iu|hiu_sq_one/u);
  assert.equal(controls.normalizations[0].id, task.id);
});

test("pilot contains 20 unique tasks, five evenly spaced from each highest-count textbook", () => {
  assert.equal(pilot.length, 20);
  assert.equal(new Set(pilot.map((task) => task.id)).size, 20);
  assert.deepEqual(pilot, selectPilot([...tasks].reverse()));
  const books = ["Dummit Foote", "Munkres", "Rudin", "Herstein"];
  for (const [i, book] of books.entries()) {
    const group = tasks.filter((task) => task.metadata.textbook === book);
    const expected = Array.from({ length: 5 }, (_, n) => group[Math.round(n * (group.length - 1) / 4)]);
    assert.deepEqual(pilot.slice(i * 5, i * 5 + 5), expected);
  }
});

test("367 evaluator-only controls contain references but no extracted proof", () => {
  assert.equal(Object.keys(controls.entries).length, 367);
  assert.deepEqual(Object.keys(controls.entries), tasks.map((task) => task.id));
  for (const [id, entry] of Object.entries(controls.entries)) {
    assert.deepEqual(entry, {
      gold_proof_zip_entry: `proofnet_verified_gt/proofnet-${Number(id.slice(9))}.lean`,
      gold_proof_sha256: null,
      verified: false,
    });
  }
  assert.equal(controls.checker_bound, false);
  assert.equal(controls.gold_archive_toolchain, "4.28");
});

test("ZIP metadata has exactly 367 entries, matching the control references", async () => {
  const entries = zipEntries(await readFile(path.join(sourceDir, sourceFiles.zip)));
  assert.equal(entries.length, 367);
  assert.equal(controls.zip_entry_count, 367);
  assert.deepEqual(new Set(entries), new Set(Object.values(controls.entries).map((entry) => entry.gold_proof_zip_entry)));
});

test("all three input SHA-256 hashes match their original bytes", async () => {
  for (const [key, file] of Object.entries(sourceFiles)) {
    assert.deepEqual(controls.inputs[key], {
      path: file,
      sha256: sha256(await readFile(path.join(sourceDir, file))),
    });
  }
});

test("build is deterministic and matches committed 2-space JSON with trailing newlines", async () => {
  const first = await buildArtifacts(sourceDir);
  const second = await buildArtifacts(sourceDir);
  assert.deepEqual(first, second);
  for (const [name, text] of Object.entries(first)) {
    assert.equal(text, serialize(JSON.parse(text)));
    assert.equal(await readFile(path.join(packDir, name), "utf8"), text);
  }
});

test("no verified:true flag or gold-proof file is shipped", async () => {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "verified")) assert.equal(value.verified, false);
    for (const child of Object.values(value)) visit(child);
  };
  for (const name of ["tasks.json", "pilot.json", "controls.json", "baselines.json"]) visit(await load(name));
  assert.deepEqual((await readdir(packDir)).sort(), [
    "README.md", "baselines.json", "build.mjs", "controls.json", "pilot.json", "tasks.json", "tests",
  ]);
  assert.deepEqual(await readdir(path.join(packDir, "tests")), ["proofnet-pack.test.mjs"]);
});

test("baseline contract is explicit about the absent score and unbound checker", async () => {
  assert.deepEqual(await load("baselines.json"), {
    schema: "math-bench-baselines/v1",
    benchmark: "proofnet-verified",
    model: "opencode-go/deepseek-v4.1-flash",
    external: [],
    note: "No published score for this exact model/version was found; use the paired plugin-off arm. Lean 4.34.0 pack; workspace checker is 4.34.1 and is not yet bound.",
  });
});
