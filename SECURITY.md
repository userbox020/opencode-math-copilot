# Security policy

## Supported versions

Security fixes target the latest released version. Older versions are not maintained; upgrade before reporting an issue where practical.

## Reporting vulnerabilities

Use GitHub's private [Report a vulnerability](https://github.com/userbox020/opencode-math-copilot/security/advisories/new) feature. If private reporting is unavailable, contact the maintainer privately through a contact method listed on their GitHub profile before sharing details. Do not disclose vulnerabilities publicly while coordinating a fix.

Never include secrets, credentials, tokens, private manuscripts, or sensitive logs in issues or reports. Provide a minimal, redacted reproduction and affected version.

## Token hygiene

Use least-privilege, short-lived tokens and keep them out of source control, prompts, logs, and shared configuration. Revoke exposed tokens immediately at their provider, replace them, and review their usage; deleting a leaked token from a file does not revoke it. For npm tokens, use npm's access-token settings or `npm token revoke <token-id>`. This project does not publish to npm and requires no npm publishing token.

## Scope and dependencies

The plugin exposes local search, file-reading, and external-tool execution capabilities, including Lean, Docker, and SymPy. Run it only with trusted inputs and appropriately restricted local permissions. It is not a sandbox or a guarantee of mathematical correctness; proof verification depends on the actual toolchain, statements, and successful checks.

Dependabot checks npm and GitHub Actions dependencies weekly. Security CI runs `npm audit --audit-level=high`: high and critical findings fail, while moderate findings may remain and should be reviewed. A passing audit does not establish that all dependencies are vulnerability-free.
