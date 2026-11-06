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
`.opencode/skills/`, `.opencode/commands/`, `docs/`, `scripts/setup-lean.ps1`,
`README.md`, `LICENSE`, and `NOTICE`.
CI performs these checks on Node 24, on Linux and Windows, without installing
Lean, SymPy, or the math corpus.

The preparation machine is authenticated as `userbox020`, but the npm registry
requires **two-factor authentication** for publishing. A direct
`npm publish --access public` returns:

```text
403 Forbidden — Two-factor authentication or granular access token with bypass
2FA is required to publish packages.
```

No publish is performed by CI. An authorized maintainer can run one of:

```sh
npm publish --access public --otp=<current-6-digit-code>
```

or configure a granular access token with publish permission and bypass 2FA,
then use it as `NPM_TOKEN`.

The GitHub release `v0.1.0` is available even while npm publishing is gated.
After npm publication, users can install the released version with:

```sh
opencode plugin add opencode-math-copilot@<version>
```
