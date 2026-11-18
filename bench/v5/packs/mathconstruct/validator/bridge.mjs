import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const schema = 'mathconstruct-validator/v1';
const script = fileURLToPath(new URL('./validate.py', import.meta.url));

// Injection keeps contract tests independent of Python and upstream dependencies.
export function validate(request, { python, run = spawnSync } = {}) {
  const unavailable = reason => ({
    schema, task_id: request.task_id, status: 'unavailable',
    tag: 'BRIDGE_ERROR', reason,
  });
  try {
    if (!python) return unavailable('A validator venv Python executable is required');
    const result = run(python, ['-B', script], {
      input: JSON.stringify(request), encoding: 'utf8', shell: false,
      timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) return unavailable('Python failed or timed out');
    const output = JSON.parse(result.stdout);
    if (!output || output.schema !== schema || output.task_id !== request.task_id
      || !['accepted', 'rejected', 'unavailable'].includes(output.status)
      || typeof output.tag !== 'string' || !output.tag
      || typeof output.reason !== 'string') {
      return unavailable('Invalid validator receipt');
    }
    return output;
  } catch {
    return unavailable('Python invocation or JSON output failed');
  }
}
