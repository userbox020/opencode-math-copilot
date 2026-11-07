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

## Option 2: global Git package (no npm registry auth)

This is verified and does not require an npm token:

```powershell
opencode plugin add github:userbox020/opencode-math-copilot
opencode plugin list
opencode plugin check
opencode plugin update
```

The Git spec installs the package from GitHub. It uses the root `index.js` package entry and the bundled `.opencode/plugins/` assets. The `math/` corpus still needs to exist in the project for manuscript/PDF/Lean tools; `math_search` works from the bundled index.

## Option 3: npm registry

The package is public and `npm pack --dry-run` is part of CI. The release workflow is `.github/workflows/publish.yml`; it runs only on a published GitHub release or manual dispatch, never on ordinary pushes.

The package can be published with either:

### Interactive 2FA

```powershell
cd C:\_Work\opencode-math-copilot
npm login --auth-type=web
npm publish --access public
```

### Granular token with Bypass 2FA

Create a token with **Read and write (publish and stage)**, **All Packages**, and **Bypass two-factor authentication** checked. Then set the repository secret:

```powershell
gh secret set NPM_TOKEN --repo userbox020/opencode-math-copilot
```

`NPM_TOKEN` is currently **not set**; the publish workflow therefore skips cleanly. Do not commit or paste long-lived tokens into the repository or issue tracker.

### Trusted publishing (recommended long-term)

After the package exists, configure **Trusted Publisher** in npm package settings:

- Provider: GitHub Actions
- User: `userbox020`
- Repository: `opencode-math-copilot`
- Workflow: `publish.yml`
- Allow direct `npm publish`

Then remove `NPM_TOKEN`; the workflow already has `id-token: write` and uses npm OIDC/provenance.

## Update

```powershell
git pull
npm install
opencode.cmd reload
```

For a global Git install, use `opencode plugin update` or reinstall the Git spec.

## Notes

- `package.json` is public (`private: false`), versioned, and exports `index.js`.
- `opencode plugin add` accepts npm registry or Git package specs, not local tarballs.
- Use project-local discovery for development; use the Git spec for a no-auth global install.
