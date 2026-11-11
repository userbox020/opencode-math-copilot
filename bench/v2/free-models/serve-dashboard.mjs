import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO = 'C:/_Work/opencode-math-copilot';
const ROOT = path.join(REPO, 'bench/v2/free-models');
const portArg = process.argv.find((arg, index) => arg === '--port' && process.argv[index + 1]);
const port = Number(portArg ? process.argv[process.argv.indexOf('--port') + 1] : process.env.PORT || 8765);
const generators = {
  dashboard: path.join(ROOT, 'build-dashboard.mjs'),
  live: path.join(ROOT, 'build-live.mjs'),
  scores: path.join(ROOT, 'build-score-report.mjs'),
  normal: path.join(ROOT, '../../v3/normal-use/build-normal-page.mjs'),
};
const cache = new Map();
function regenerate(kind) {
  const now = Date.now();
  const previous = cache.get(kind);
  if (previous && now - previous.at < 1000) return previous.error;
  const result = spawnSync(process.execPath, [generators[kind]], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  const error = result.status === 0 ? null : (result.stderr || result.stdout || `generator exit ${result.status}`).slice(-1000);
  cache.set(kind, { at: now, error });
  if (error) console.error(`[regenerate:${kind}] ${error}`);
  return error;
}
function injectLive(html) {
  const live = `<style>#live-badge{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:7px;padding:8px 11px;border:1px solid var(--line,#30363d);border-radius:7px;background:var(--panel,#161b22);color:var(--text,#e6edf3);font:11px ui-monospace,Consolas,monospace;box-shadow:0 8px 24px #0005}#live-badge .live-dot{width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 0 3px #3fb95033}</style><div id="live-badge" role="status" aria-live="polite"><span class="live-dot" aria-hidden="true"></span>LIVE · 15s auto-refresh</div><script>(()=>{const badge=document.getElementById('live-badge');setInterval(()=>location.reload(),15000);if(badge)badge.title='This page reloads every 15 seconds and the local server regenerates the snapshot.';})();</script>`;
  return html.includes('</body>') ? html.replace('</body>', `${live}</body>`) : `${html}${live}`;
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const files = new Set(['dashboard.html', 'dashboard-data.js', 'dashboard-data.json', 'running.html', 'running-data.js', 'running-data.json', 'scores.html', 'scores-data.js', 'scores-data.json', 'normal-use.html', 'normal-use-data.js', 'normal-use-data.json']);

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/') {
      response.writeHead(302, { Location: '/dashboard.html', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const name = path.basename(decodeURIComponent(url.pathname));
    if (!files.has(name)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }
    const kind = name.startsWith('running') ? 'live' : name.startsWith('scores') ? 'scores' : name.startsWith('normal-use') ? 'normal' : 'dashboard';
    const error = regenerate(kind);
    const file = name.startsWith('normal-use')
      ? path.join(ROOT, '../../v3/normal-use', name)
      : path.join(ROOT, name);
    if (!existsSync(file)) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`Missing ${name}. Generator error: ${error ?? 'unknown'}`);
      return;
    }
    let body = readFileSync(file);
    if (name.endsWith('.html')) body = Buffer.from(injectLive(body.toString('utf8')), 'utf8');
    response.writeHead(200, {
      'Content-Type': types[path.extname(name)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Dashboard-Snapshot': new Date().toISOString(),
      ...(error ? { 'X-Generator-Error': error.replace(/[\r\n]+/g, ' ').slice(0, 300) } : {}),
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`Dashboard server error: ${error.message}`);
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard live server: http://127.0.0.1:${port}/dashboard.html`);
  console.log(`Current runs:         http://127.0.0.1:${port}/running.html`);
  console.log('Auto-refresh: 15s; snapshots regenerate on each request (1s coalescing).');
});
