import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function findFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "data") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findFiles(path);
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

try {
  const files = [".opencode/plugins", "scripts", "bench"]
    .flatMap((directory) => findFiles(join(root, directory)));
  files.push(join(root, "index.js"));
  files.sort();
  let failed = 0;

  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      shell: false,
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      failed += 1;
      console.error(`FAIL ${relative(root, file)}`);
      console.error(result.error?.message || result.stderr || result.stdout || `Process exited with ${result.signal || result.status}`);
    }
  }

  console.log(`Syntax check: ${files.length - failed} passed, ${failed} failed (${files.length} files).`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(`Syntax check failed: ${error.message}`);
  process.exitCode = 1;
}
