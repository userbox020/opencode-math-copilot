import fs from "node:fs";
import os from "node:os";
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
  const configured = process.env.MATH_TOOLKIT_MATH_ROOT;
  if (configured && fs.existsSync(path.join(configured, "CONTENTS.md"))) {
    return { workspace: directory, math: path.resolve(configured) };
  }
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
  const home = env.USERPROFILE || os.homedir();
  const local = env.LOCALAPPDATA || (windows ? path.join(home, "AppData", "Local") : "");
  const allowExtras = !env.MATH_TOOLKIT_DISABLE_EXTRAS;
  // The OpenCode server may have started before elan/ripgrep/cargo updated PATH.
  const extras = allowExtras ? [
    path.join(home, ".elan", "bin"),
    path.join(home, ".cargo", "bin"),
    local && path.join(local, "Microsoft", "WinGet", "Links"),
    env.ProgramFiles && path.join(env.ProgramFiles, "ripgrep"),
    env.ProgramFiles && path.join(env.ProgramFiles, "nodejs"),
  ].filter(Boolean) : [];
  // WinGet package installs are not always linked into PATH.
  if (allowExtras && name === "rg" && local) {
    const packages = path.join(local, "Microsoft", "WinGet", "Packages");
    try {
      for (const entry of fs.readdirSync(packages)) {
        if (!/ripgrep/i.test(entry)) continue;
        const base = path.join(packages, entry);
        for (const child of fs.readdirSync(base)) extras.push(path.join(base, child));
      }
    } catch { /* WinGet may not be installed. */ }
  }
  // User-level Python installs are common on Windows and may be absent from
  // the server process PATH.
  if (allowExtras && local) {
    const pythonRoot = path.join(local, "Programs", "Python");
    try {
      for (const entry of fs.readdirSync(pythonRoot)) extras.push(path.join(pythonRoot, entry));
    } catch { /* Optional. */ }
  }
  const directories = [...new Set([...pathValue.split(path.delimiter), ...extras].filter(Boolean))];
  for (const directory of directories) {
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
