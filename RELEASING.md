# Distribution and releases

## Option 1: project-local (recommended for development)

1. Clone this repository, or copy:
   - `.opencode/plugins/math-toolkit.js`
   - the complete `.opencode/plugins/math-toolkit/` directory
   - `.opencode/skills/math-workflow/`
   - `.opencode/commands/math.md`
2. Run `npm install` at the project root. This installs `unpdf`; OpenCode provides `@opencode/plugin` at runtime or through `node_modules`.
3. Clone `https://github.com/openai/math` into `math/` for manuscript reads, PDF extraction, Lean search, and Lean tools.
4. Run:
   ```powershell
   opencode.cmd plugin list
   opencode.cmd reload
   ```

The plugin is auto-discovered from `.opencode/plugins/`.

## Option 2: global Git install (no npm registry auth)

This is verified and does not require an npm token or 2FA:

```powershell
opencode plugin add github:userbox020/opencode-math-copilot
opencode plugin list
opencode plugin check
opencode plugin update
```

The Git spec installs the package from GitHub. It uses the root `index.js` package entry and the bundled `.opencode/plugins/` assets. The `math/` corpus still needs to exist in the project for manuscript/PDF/Lean tools; `math_search` works from the bundled index.

## npm registry status

npm registry publishing is intentionally disabled:

- `package.json` is `"private": true` to prevent accidental `npm publish`.
- `.github/workflows/publish.yml` is not part of the distribution.
- No `NPM_TOKEN` is required or stored.
- `npm install` is still used for `unpdf` and test dependencies, and `npm pack --dry-run` still validates package contents.

If npm publishing is needed later, make `private` false, restore a publish workflow, and use either interactive 2FA or npm trusted publishing (OIDC). Do not commit or paste long-lived tokens.

## Update

```powershell
git pull
npm install
opencode.cmd reload
```

For a global Git install, use `opencode plugin update` or reinstall the Git spec.

## Notes

- The supported installs are project-local discovery and the global Git spec.
- `opencode plugin add` accepts npm registry or Git package specs, not local tarballs.
- Keep `opencode plugin add github:userbox020/opencode-math-copilot` as the no-auth global path.
