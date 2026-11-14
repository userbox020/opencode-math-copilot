import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { leanCheck, runDocker, runLake, runLeanSource } from "../lib/lean.js";
import { leanVerify } from "../lib/verify.js";

// All process execution is injected. No Lean, Docker, corpus, or network needed.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-recovery-test-"));
const roots = { math: fixture, workspace: fixture };
fs.mkdirSync(path.join(fixture, "lean"));
fs.writeFileSync(path.join(fixture, "lean", "Sample.lean"), "example : True := True.intro\n");
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const badPath = "error: invalid path 'AINTLIB/2026-07-16T07:39:08Z/Basic.lean'";
const cacheError = "Check.lean:1:0: error: object file '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean' of module Mathlib does not exist";
const request = { code: "theorem demo : True := True.intro", theorem: "demo", expectedType: "True" };
const failed = stderr => ({ status: 1, stdout: "", stderr });

function host(result, platform = "win32") {
  const calls = [];
  return {
    calls, platform,
    findExecutable(name) { assert.equal(name, "lake", "Native checks must not probe Docker"); return "lake.exe"; },
    spawnSync(executable, args, options) {
      calls.push(args);
      assert.equal(executable, "lake.exe");
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 60000);
      return result;
    },
  };
}
const verify = (runners, args = request) => JSON.parse(leanVerify(roots, args, (r, source, options) => runLeanSource(r, source, options, runners)));
function recovery(text) {
  assert.match(text, /Windows Lean environment\/setup failure/);
  assert.match(text, /not a proof verdict/);
  assert.match(text, /docker:true/);
  assert.match(text, /WSL.*Linux filesystem/);
  assert.match(text, /docker build -f docker\/lean.Dockerfile/);
  assert.match(text, /docker volume create opencode-math-lean/);
  assert.match(text, /docker run --rm -e SKIP_BUILD=1 .*verify-lean.sh/);
  assert.match(text, /No automatic retry or pin change/);
}

test("Windows NTFS-invalid dependency path: original error plus explicit recovery; no retry", () => {
  for (const input of [{ code: "example : True := True.intro" }, { file: "Sample.lean" }]) {
    const runners = host(failed(badPath));
    const output = leanCheck(roots, input, runners);
    assert.match(output, /\*\*FAIL\*\*.*exit code: 1/);
    assert(output.includes(badPath));
    recovery(output);
    assert.equal(runners.calls.length, 1);
  }
});

test("Windows dependency cache failure retains strict receipt statuses and error", () => {
  const runners = host(failed(cacheError));
  const receipt = verify(runners);
  assert.equal(receipt.version, "math-lean-verify/v1");
  assert.equal(receipt.execution.mode, "native");
  assert.equal(receipt.execution.status, "completed");
  assert.equal(receipt.execution.exitCode, 1);
  assert.equal(receipt.compilation.status, "failed");
  assert.equal(receipt.proof.status, "unverified");
  assert(receipt.compilation.diagnostics.includes(cacheError));
  recovery(receipt.compilation.diagnostics);
  assert.equal(runners.calls.length, 1);
});

test("missing Lake gives Windows guidance, missing-tool/not-run, and no process", () => {
  const runners = { platform: "win32", findExecutable: () => null, spawnSync: () => assert.fail("Must not execute") };
  recovery(leanCheck(roots, { code: "example : True := True.intro" }, runners));
  const receipt = verify(runners);
  assert.equal(receipt.execution.status, "missing-tool");
  assert.equal(receipt.compilation.status, "not-run");
  assert.equal(receipt.proof.status, "unverified");
  recovery(receipt.execution.error);
  assert.match(receipt.execution.error, /lake was not found on PATH/);
});

test("missing executable race preserves ENOENT; missing Lean toolchain gets recovery", () => {
  const result = { status: null, error: Object.assign(new Error("spawnSync lake.exe ENOENT"), { code: "ENOENT" }) };
  const runners = host(result);
  const raw = runLeanSource(roots, request.code, {}, runners);
  assert.equal(raw.error.code, "ENOENT");
  assert.equal(raw.error.message, result.error.message);
  recovery(raw.stderr);
  const receipt = verify(runners);
  assert.equal(receipt.execution.status, "missing-tool");
  assert.equal(receipt.compilation.status, "not-run");
  assert.equal(receipt.proof.status, "unverified");
  recovery(leanCheck(roots, { code: request.code }, host(failed("error: toolchain 'leanprover/lean4:v4.34.1' is not installed"))));
});

test("syntax/type/unknown module failures are not mislabeled as Windows setup failures", () => {
  for (const error of ["Check.lean:3:4: error: unexpected token 'end'", "Check.lean:3:4: error: Type mismatch", "Check.lean:1:0: error: unknown module prefix 'MyMissingModule'", "error: invalid path 'my-own-invalid-path'"]) {
    const receipt = verify(host(failed(error)));
    assert.equal(receipt.execution.status, "completed");
    assert.equal(receipt.compilation.status, "failed");
    assert.equal(receipt.proof.status, "unverified");
    assert.equal(receipt.compilation.diagnostics, error);
    assert.doesNotMatch(receipt.compilation.diagnostics, /Windows|docker:true/);
  }
});

test("strict target mismatch and timeout remain failures with original error codes", () => {
  const runners = host(failed(""));
  runners.spawnSync = (_exe, args, options) => {
    const source = fs.readFileSync(path.resolve(options.cwd, args.at(-1)), "utf8");
    const line = source.split("\n").findIndex(text => text.startsWith("theorem _root_.math_verify_")) + 1;
    return failed(`Check.lean:${line}:26: error: Type mismatch\n  demo\nhas type\n  False\nbut is expected to have type\n  True`);
  };
  const mismatch = verify(runners);
  assert.equal(mismatch.target.status, "mismatch");
  assert.equal(mismatch.proof.status, "unverified");
  const timeout = verify(host({ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), stderr: "original timeout output" }));
  assert.equal(timeout.execution.status, "timeout");
  assert.equal(timeout.execution.error, "spawnSync ETIMEDOUT");
  assert.equal(timeout.compilation.diagnostics, "original timeout output");
  assert.equal(timeout.proof.status, "unverified");
});

test("Linux diagnostics are unchanged and successful raw output is not rewritten", () => {
  for (const stderr of [badPath, cacheError]) {
    const result = runLeanSource(roots, request.code, {}, host(failed(stderr), "linux"));
    assert.equal(result.stderr, stderr);
  }
  const absent = leanCheck(roots, { code: request.code }, { platform: "linux", findExecutable: () => null });
  assert.match(absent, /Install elan\/Lean/);
  assert.doesNotMatch(absent, /Windows|Docker|docker:true/);
  const success = { status: 0, stdout: badPath, stderr: "" };
  assert.equal(runLeanSource(roots, request.code, {}, host(success)), success);
});

test("failure diagnostics are bounded and common credential forms are redacted", () => {
  const secret = "fixture-only-credential";
  const stderr = "x".repeat(20000) + `\nhttps://user:${secret}@example.invalid/repo?token=${secret}\nAuthorization: Bearer ${secret}\nAPI_KEY=${secret}\n` + badPath;
  const receipt = verify(host({ status: 1, stdout: "y".repeat(20000), stderr, error: new Error(`password=${secret}`) }));
  const text = JSON.stringify(receipt);
  assert(!text.includes(secret));
  assert.match(text, /REDACTED/);
  assert.match(text, /earlier output truncated/);
  assert(receipt.compilation.diagnostics.length <= 8000);
  assert(receipt.execution.error.length < 2100);
  assert(receipt.compilation.diagnostics.includes(badPath));
  recovery(receipt.compilation.diagnostics);
});

function dockerRunner(respond) {
  const calls = [];
  return {
    calls, platform: "win32",
    findExecutable(name) { assert.equal(name, "docker", "Explicit Docker must not probe native Lake"); return "docker.exe"; },
    spawnSync(_exe, args, options) {
      calls.push(args);
      assert.equal(options.shell, false);
      return respond(args);
    },
  };
}
const ok = { status: 0, stdout: "", stderr: "" };

test("Docker missing image has build guidance, preserves error, and never runs a container", () => {
  const runners = dockerRunner(args => args[0] === "image" ? failed("No such image: fixture") : ok);
  const output = runDocker(["lake", "--version"], 60000, {}, runners);
  assert.match(output, /docker build -f docker\/lean.Dockerfile/);
  assert.match(output, /No such image: fixture/);
  assert.deepEqual(runners.calls.map(args => args[0]), ["image", "info"]);
  const receipt = verify(runners, { ...request, docker: true });
  assert.equal(receipt.execution.mode, "docker");
  assert.equal(receipt.execution.status, "error");
  assert.equal(receipt.compilation.status, "not-run");
  assert.equal(receipt.proof.status, "unverified");
  assert.match(receipt.execution.error, /docker build/);
  assert.match(receipt.compilation.diagnostics, /No such image/);
});

test("Docker daemon failure preserves spawn error plus actionable guidance", () => {
  const runners = dockerRunner(() => ({ status: null, error: Object.assign(new Error("x".repeat(20000) + " connect ECONNREFUSED"), { code: "ECONNREFUSED" }), stderr: "Cannot connect to the Docker daemon" }));
  const receipt = verify(runners, { ...request, docker: true });
  assert.equal(receipt.compilation.status, "not-run");
  assert.equal(receipt.proof.status, "unverified");
  assert.match(receipt.execution.error, /Start Docker Desktop.*docker info/);
  assert.match(receipt.execution.error, /connect ECONNREFUSED/);
  assert(receipt.execution.error.length < 2600);
  assert.match(receipt.compilation.diagnostics, /Cannot connect to the Docker daemon/);
  assert.deepEqual(runners.calls.map(args => args[0]), ["image", "info"]);
});

test("Docker missing volume gives bounded cache-only setup guidance without creating it", () => {
  const runners = dockerRunner(args => args[0] === "volume" ? failed("No such volume: fixture") : ok);
  const output = runDocker(["lake", "--version"], 60000, {}, runners);
  assert.match(output, /docker volume create/);
  assert.match(output, /docker run --rm -e SKIP_BUILD=1 .*verify-lean.sh/);
  assert.match(output, /No such volume: fixture/);
  assert.deepEqual(runners.calls.map(args => args.slice(0, 2)), [["image", "inspect"], ["volume", "inspect"]]);
});

test("explicit Docker executes once, preserves genuine Lean errors, and cleans temp source", () => {
  const runners = dockerRunner(args => args[0] === "run" ? failed("Check.lean:3:4: error: Type mismatch") : ok);
  const receipt = verify(runners, { ...request, docker: true });
  assert.equal(receipt.execution.status, "completed");
  assert.equal(receipt.execution.exitCode, 1);
  assert.equal(receipt.compilation.status, "failed");
  assert.equal(receipt.proof.status, "unverified");
  assert.equal(receipt.compilation.diagnostics, "Check.lean:3:4: error: Type mismatch");
  const runs = runners.calls.filter(args => args[0] === "run");
  assert.equal(runs.length, 1);
  const mount = runs[0].find(arg => arg.endsWith(":/check:ro"));
  assert(mount);
  assert.equal(fs.existsSync(mount.slice(0, -":/check:ro".length)), false);
});

test("missing Docker and rejected native batch shim do not execute", () => {
  const receipt = verify({ findExecutable: () => null, spawnSync: () => assert.fail("Must not execute") }, { ...request, docker: true });
  assert.equal(receipt.execution.status, "missing-tool");
  assert.equal(receipt.compilation.status, "not-run");
  assert.match(receipt.execution.error, /Install Docker Desktop/);
  const output = runLake(roots, ["env", "lean"], 60000, 8000, {}, { platform: "win32", findExecutable: () => "lake.cmd", spawnSync: () => assert.fail("Must not execute") });
  assert.match(output, /batch shims cannot run safely/);
  recovery(output);
});
