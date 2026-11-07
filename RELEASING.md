# Distribution and releases

## Project-local installation

Clone this repository or copy both `.opencode/plugins/math-toolkit.js` and the
complete `.opencode/plugins/math-toolkit/` directory into your project's matching
paths. Install the dependencies from `package.json`. The project-local OpenCode
entry remains `.opencode/plugins/math-toolkit.js`.

Copy `.opencode/skills/math-workflow/` and `.opencode/commands/math.md` as well to
include the skill and `/math` command.

`opencode plugin add` accepts npm registry or Git package specifiers, not local
directories or tarballs. Use the `plugins` configuration for explicit local paths
instead; the project-local layout above uses automatic discovery.

## npm release

The npm package entry is `index.js`, which re-exports the default project-local
plugin. Before releasing, confirm the intended version in `package.json` and run:

```sh
npm run check
npm test
npm pack --dry-run
```

Confirm the package includes `index.js`, `.opencode/plugins/math-toolkit.js`, the
complete `.opencode/plugins/math-toolkit/` implementation and prebuilt index,
`.opencode/skills/`, `.opencode/commands/`, `docker/`, `docs/`,
`scripts/lean-docker.ps1`, `scripts/setup-lean.ps1`, `README.md`, `LICENSE`, and
`NOTICE`.
CI performs these checks on Node 24, on Linux and Windows, without installing
Lean, SymPy, or the math corpus.

### GitHub Actions publishing

Configure the repository's GitHub Actions secret `NPM_TOKEN` with an npm
**granular access token with publish permission and bypass 2FA** (or an automation
token). The workflow fails explicitly if the secret is missing.

1. Bump the version in `package.json` and `package-lock.json`, then commit the change.
2. Tag that commit as `vX.Y.Z`, matching the package version.
3. Push the commit and tag to GitHub.
4. Create and publish a GitHub release for that tag.

`.github/workflows/publish.yml` runs on a published GitHub release or manual
`workflow_dispatch`, never on normal pushes or pull requests. Pushing a tag alone
does not publish. The workflow installs dependencies with `npm ci`, runs the
checks above on Node 24 / Ubuntu, then runs
`npm publish --access public --provenance` using `NPM_TOKEN` as `NODE_AUTH_TOKEN`.
Provenance requires the workflow's `id-token: write` permission.

For a manual run, select the intended release tag/ref in GitHub Actions. The
workflow publishes the version in that ref's `package.json`; it does not bump
versions or enforce that the tag matches. An already-published version cannot
be published again.

### Local publishing

Without a suitable token configured for npm authentication, local publishing
still requires a two-factor authentication code:

```sh
npm publish --access public --otp=<current-6-digit-code>
```

After npm publication, users can install the released version with:

```sh
opencode plugin add opencode-math-copilot@<version>
```
