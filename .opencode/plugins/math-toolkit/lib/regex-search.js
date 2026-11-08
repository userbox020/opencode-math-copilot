import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./regex-worker.mjs", import.meta.url));

/** Execute case-insensitive line matches outside the plugin, with no partial results. */
export function runRegexLines(lines, pattern, { timeoutMs } = {}) {
  const configured = Number(timeoutMs ?? process.env.MATH_TOOLKIT_REGEX_TIMEOUT_MS ?? 1000);
  const timeout = Number.isFinite(configured) ? Math.max(100, Math.min(10000, Math.trunc(configured))) : 1000;
  const failure = message => ({ status: "error", message: `Regex search failed: ${message}; use literal:true or simplify the pattern.` });
  try {
    const result = spawnSync(process.execPath, [worker], {
      input: JSON.stringify({ pattern, lines }),
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error?.code === "ETIMEDOUT") {
      return { status: "timeout", message: `Regex search timed out after ${timeout} ms; use literal:true or simplify the pattern.` };
    }
    if (result.error || result.status !== 0) return failure(result.error?.message || `worker exited with status ${result.status}`);
    const { matches } = JSON.parse(result.stdout);
    if (!Array.isArray(matches) || matches.length !== lines.length || matches.some(match => typeof match !== "boolean")) {
      return failure("invalid worker response");
    }
    return { status: "ok", matches };
  } catch (error) {
    return failure(error.message);
  }
}
