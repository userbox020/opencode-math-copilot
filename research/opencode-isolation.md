# OpenCode isolation contract (v2.0.29)

**Status:** proposed and source-verified for the installed `@opencode/cli` 2.0.29; exercised by the exploratory 90-episode pilot (one model, one repeat, 30 provisional tasks) with a safe credential-home copy and a runtime plugin-load audit. This is an adapter/design contract, not a security sandbox; the confirmatory pilot remains pending.

## Configuration model

Use the native 2.x keys, not only legacy aliases:

- `agents` (not only `agent`)
- `permissions` (action/resource/effect rules)
- `plugins` (explicit plugin list)

A wildcard deny removes tools from the agent snapshot; the generated Code Mode `execute` tool is subject to the same filter. Rules are ordered and last-match-wins.

### Profile A — no tools

```json
{
  "agents": {
    "eval": {
      "mode": "primary",
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

No plugins.

### Profile B — generic read/glob/grep/shell, no math plugin

```json
{
  "agents": {
    "eval": {
      "mode": "primary",
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "read", "resource": "*", "effect": "allow" },
        { "action": "glob", "resource": "*", "effect": "allow" },
        { "action": "grep", "resource": "*", "effect": "allow" },
        { "action": "shell", "resource": "*", "effect": "allow" },
        { "action": "math_*", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

`shell` is not filesystem/network isolation. Compute and Lean are external commands reached through shell, not built-in tool IDs.

The dry-run adapter now stages a dedicated B V2 plugin instead of allowing `shell`: it exposes exactly `corpus_search`, `read_excerpt`, `compute`, and `lean_check`, with the Code Mode `execute` transport. It reads only public episode excerpts, uses the fixed SymPy worker, and performs bounded Lean compiler checks (not trusted receipts). A runtime inventory/isolation audit is still required before execution.

### Profile F — full 16-tool math plugin

```json
{
  "plugins": ["./plugins/math-toolkit.js"],
  "agents": {
    "eval": {
      "mode": "primary",
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "read", "resource": "*", "effect": "allow" },
        { "action": "glob", "resource": "*", "effect": "allow" },
        { "action": "grep", "resource": "*", "effect": "allow" },
        { "action": "shell", "resource": "*", "effect": "allow" },
        { "action": "math_*", "resource": "*", "effect": "allow" },
        { "action": "execute", "resource": "*", "effect": "allow" }
      ]
    }
  }
}
```

The math plugin registers Code Mode tools, so `execute` must be allowed in F. A/B must not load the math plugin. `read`/`glob`/`grep`/`shell` are core registrations; `write`/`patch` share the `edit` permission action.

## Isolation environment

`--standalone` creates a private server but does **not** provide an empty home, database, plugin environment or config. Run each episode with freshly created directories and a sanitized child environment:

```text
HOME=<fresh>/home
USERPROFILE=<fresh>/home
XDG_CONFIG_HOME=<fresh>/xdg-config
XDG_DATA_HOME=<fresh>/xdg-data
XDG_STATE_HOME=<fresh>/xdg-state
XDG_CACHE_HOME=<fresh>/xdg-cache
OPENCODE_CONFIG_DIR=<fresh>/config
OPENCODE_CONFIG=<fresh>/project/opencode.json
```

Unset inherited `OPENCODE_CONFIG_CONTENT`, server-selection variables and unrelated OpenCode overrides. Do not pass `--continue`, `--session`, `--fork` or `--server`. Supply only deliberately authorized provider authentication; fresh data directories do not inherit login state.

Project discovery is deliberately **enabled only inside the fresh staged workspace**. OpenCode 2.0.29 auto-discovers immediate `.js` plugin files in `.opencode/plugins/`; the entry must be `.js` (`.mjs` was not discovered). The runtime stays in a subdirectory. Explicit `plugins` entries and `OPENCODE_CONFIG_PROJECT_DISABLE=1` both failed to load the staged plugin in a real smoke: the former was rejected as a file, the latter suppressed discovery. A real `opencode run` smoke with the normal HOME confirmed a `loading plugin` log for the staged entry and a working `execute` call. That smoke was **not isolated** and is not pilot evidence.

The adapter now creates a **fresh HOME/XDG tree outside the workspace** and can copy evaluator-supplied `auth.json`/`account.json` there (never into the agent-visible tree). A provider infrastructure package can be staged from `MATH_BENCH_PROVIDER_PLUGIN` with `MATH_BENCH_PROVIDER_OPTIONS`. The runtime audit starts the real server, requests `/api/config`, and observes the staged math/generic plugin in the `loading plugin` log. This is `runtime-plugin-load` plus static permissions, not a filtered catalog snapshot. A provider-route preflight (`opencode models --standalone`) is still required before any episode: the isolated environment exposed `opencode/deepseek-v4.1-flash-free`, whose free quota was exhausted, while `opencode-go/deepseek-v4.1-flash` was not registered.

## Adapter audit status (2026-11-08)

The dry-run adapter now stages each profile in a fresh workspace and audits the
**registered** inventory: A has none; B stages the generic V2 plugin with
`corpus_search`, `read_excerpt`, `compute`, `lean_check` plus the `execute`
transport; F stages the full math toolkit with the core allowlist plus `execute`.
The audit loads the copied plugin in the staged environment, normalizes the
permission rules with last-match-wins, and compares exact tool IDs.

The runtime audit starts the real server, requests `/api/config`, and observes
the staged math/generic plugin in the `loading plugin` log. This is
`runtime-plugin-load` plus static permissions/registrations, not a filtered
catalog snapshot. `/api/agent` still returns an empty list for the staged
config-defined agent, so it is not treated as a full catalog proof. The
exploratory pilot passed this audit with a safe credential-home copy and the
`opencode-go/deepseek-v4.1-flash` model. `--execute` also requires the exact
model to be listed by `opencode models --standalone`; the free routes were
quota-limited or extraction-failure prone.

The adapter also checks workspace contents, plugin staging, timeout, and cleanup.
It is not an OS sandbox, plugin code is application code, and `shell`-equivalent
power in F is broader than B. The isolated HOME does not contain provider
credentials; a real pilot needs evaluator-provisioned auth outside the
agent-visible workspace. A no-tool answer can omit `step_finish`, leaving usage
unavailable; the runner records that as an operational failure, never as an
under-budget success.

## Remaining trust limits

- System/managed configuration locations (`%ProgramData%\opencode`, `/etc/opencode`, managed macOS paths) may still load; 2.0.29 has no verified CLI flag for fully exclusive configuration. Use a fresh OS/container for strict claims.
- Plugins execute application code; permissions are not a plugin-process sandbox.
- `shell` is not filesystem/network isolation.
- Project/automatic plugin discovery is enabled only inside the fresh staged workspace; the entry must be `.js`, and `OPENCODE_CONFIG_PROJECT_DISABLE` must not be set.
- Record the resolved OpenCode version and effective tool inventory before every study; do not assume later versions behave identically.

## JSON output extraction

`opencode run --format json` is newline-delimited JSON, not one JSON document. Observed event types include:

```text
step_start
text
reasoning      (conditional)
tool_use
step_finish
error
```

- Session: top-level `sessionID`.
- Assistant text: `type === "text"` → `part.text`, grouped by `part.messageID`; select the final assistant message.
- Tool outcomes: `type === "tool_use"` → `part.tool`, `part.id`, `part.partID`, `part.messageID`, `part.state.status` (`completed`/`error`), input/output/error.
- Usage/cost: aggregate `step_finish.part` (`reason`, `cost`, `tokens`). Native tokens use `input`, `output`, `reasoning`, `cache.read`, `cache.write`; there is no `total` field.
- Capture stderr and exit code for startup/config/transport failures before JSON emission.

Tool events are completion/failure records, not a complete start/progress stream. For authoritative accounting, use the session API rather than treating NDJSON as a complete export.

## Adapter acceptance checklist

- [ ] Fresh directories/environment per episode; no global config, history, sessions, skills or shared cache.
- [ ] Profile manifest and effective tool inventory checked before dispatch; A has no tools, B has no `math_*`, F has the 16 math tools plus `execute`.
- [ ] No grader, answer, reference report or evaluator file in the agent workspace.
- [ ] Staged `.js` plugin discovery works inside the temporary workspace; no silent fallback to the host/global plugin.
- [ ] NDJSON parsed fail-closed; missing final answer/tool events are errors, not successes.
- [ ] The exploratory pilot ran after owner acceptance of the provisional set;
  a confirmatory pilot requires the owner-reviewed frozen set and the planned
  360-episode allocation.
- [ ] No trusted-receipt claim from stdout alone; formal grading requires the evaluator-controlled verifier side channel.

## Sources

- OpenCode v2.0.29 native agent schema and permission schema
- OpenCode v2.0.29 tool snapshot/filter and registration
- OpenCode v2.0.29 global paths, XDG roots, CLI server environment
- OpenCode v2.0.29 noninteractive runner and official test
- OpenCode v2.0.29 plugin discovery documentation
- Local `opencode run --help` and installed configuration inspected read-only
