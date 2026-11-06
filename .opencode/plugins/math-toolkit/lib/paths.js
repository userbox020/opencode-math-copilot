import fs from "node:fs";
import path from "node:path";

export const REBUILD = "Rebuild with `node .opencode/plugins/math-toolkit/scripts/build-index.mjs` from the workspace root, then reload/restart the plugin.";
export const slash = value => String(value).replace(/\\/g, "/");

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function rejectTraversal(value) {
  if (String(value).includes("\0") || slash(value).split("/").includes("..")) {
    throw new Error("Path traversal (`..`) and NUL characters are not allowed.");
  }
}

// Check both lexical containment and the real path (including existing ancestors
// of a new file), so symlinks/junctions cannot escape the intended root.
export function safePath(root, value = "") {
  rejectTraversal(value);
  const normalized = slash(value);
  if (process.platform !== "win32" && path.win32.isAbsolute(normalized)) {
    throw new Error("Absolute Windows paths are not allowed on this platform.");
  }
  const base = path.resolve(root);
  const candidate = path.resolve(base, normalized);
  if (!inside(base, candidate)) throw new Error(`Path must stay inside ${base}.`);
  if (fs.existsSync(base)) {
    let ancestor = candidate;
    while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
    if (!inside(fs.realpathSync(base), fs.realpathSync(ancestor))) {
      throw new Error("Path resolves outside the allowed root through a symlink/junction.");
    }
  }
  return candidate;
}

export function resolveRoots(input = {}) {
  const directory = path.resolve(input.directory || input.worktree || process.cwd());
  const nested = path.join(directory, "math");
  if (fs.existsSync(path.join(nested, "CONTENTS.md"))) return { workspace: directory, math: nested };
  if (fs.existsSync(path.join(directory, "CONTENTS.md"))) return { workspace: path.dirname(directory), math: directory };
  return { workspace: directory, math: nested };
}

export function mathPath(roots, value = "") {
  const normalized = slash(value).replace(/^math\//i, "");
  return safePath(roots.math, normalized);
}

export function relativeMath(roots, value) {
  return slash(path.relative(roots.math, value));
}

export function findExecutable(name, env = process.env) {
  const windows = process.platform === "win32";
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = windows ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const names = windows && !path.extname(name) ? extensions.map(ext => name + ext.toLowerCase()) : [name];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const filename of names) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), filename);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch { /* Missing PATH entries are normal. */ }
    }
  }
  return null;
}
