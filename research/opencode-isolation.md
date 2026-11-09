# OpenCode isolation contract (v2.0.29)

**Status:** proposed and source-verified for the installed `@opencode/cli` 2.0.29; not yet exercised by a real model pilot. This is an adapter/design contract, not a security sandbox.

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
OPENCODE_CONFIG_PROJECT_DISABLE=1
```

Unset inherited `OPENCODE_CONFIG_CONTENT`, server-selection variables and unrelated OpenCode overrides. Do not pass `--continue`, `--session`, `--fork` or `--server`. Supply only deliberately authorized provider authentication; fresh data directories do not inherit login state.

Explicit plugin loading is required when project discovery is disabled. A copied entry file alone is insufficient; copy/relocate the plugin's relative imports, data indexes and any corpus root expectations, then validate the effective inventory.

## Adapter audit status (2026-11-08)

The dry-run adapter now stages each profile in a fresh workspace and audits the
**registered** inventory: A has none; B stages the generic V2 plugin with
`corpus_search`, `read_excerpt`, `compute`, `lean_check` plus the `execute`
transport; F stages the full math toolkit with the core allowlist plus `execute`.
The audit loads the copied plugin in the staged environment, normalizes the
permission rules with last-match-wins, and compares exact tool IDs.

This is **static-equivalent**, not runtime proof. OpenCode 2.0.29 exposes no
supported session-free endpoint (found so far) that returns the resolved
effective tool catalog, and the CLI's `--standalone` does not provide exclusive
config or an empty OS environment. `--execute` therefore remains blocked even
with the opt-in environment variable. A server-API/plugin-snapshot investigation
is in progress; if it cannot establish runtime proof, the honest status stays
static-equivalent and no real pilot is allowed.

The adapter also checks workspace contents, plugin staging, timeout, and cleanup.
It is not an OS sandbox, plugin code is application code, and `shell`-equivalent
power in F is broader than B.

## Remaining trust limits

- System/managed configuration locations (`%ProgramData%\opencode`, `/etc/opencode`, managed macOS paths) may still load; 2.0.29 has no verified CLI flag for fully exclusive configuration. Use a fresh OS/container for strict claims.
- Plugins execute application code; permissions are not a plugin-process sandbox.
- `shell` is not filesystem/network isolation.
- Project/automatic plugin discovery is disabled by `OPENCODE_CONFIG_PROJECT_DISABLE=1`; load the intended plugin explicitly.
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
- [ ] Explicit plugin loading works from the temporary workspace; no silent fallback to the host/global plugin.
- [ ] NDJSON parsed fail-closed; missing final answer/tool events are errors, not successes.
- [ ] One engineering smoke per condition before any pilot matrix; no real pilot until the task set is reviewed.
- [ ] No trusted-receipt claim from stdout alone; formal grading requires the evaluator-controlled verifier side channel.

## Sources

- OpenCode v2.0.29 native agent schema and permission schema
- OpenCode v2.0.29 tool snapshot/filter and registration
- OpenCode v2.0.29 global paths, XDG roots, CLI server environment
- OpenCode v2.0.29 noninteractive runner and official test
- OpenCode v2.0.29 plugin discovery documentation
- Local `opencode run --help` and installed configuration inspected read-only
