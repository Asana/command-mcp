# Contributing

Thank you for contributing to the Asana Command MCP server.

## Local setup

Install Node.js 22 or newer, clone the repository, and install the locked dependencies:

```sh
git clone https://github.com/Asana/command-mcp.git
cd command-mcp
npm ci
```

Useful commands:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The architectural and safety authority for this project is [AGENTS.md](AGENTS.md). Read it before changing production code. This guide intentionally does not repeat its architecture rules.

Discuss new runtime dependencies with the maintainers before adding them. Do not add a runtime dependency ad hoc when the MCP SDK, official Asana SDK, Node.js, or a small local implementation already owns the capability.

## Required pull-request check

Run the complete check before opening a pull request:

```sh
npm run check
```

Include the command's complete, unfiltered output in the pull-request description. Never pipe a verification command through `head`, `tail`, `grep`, or another output filter. Missing, truncated, timed-out, or unparseable output is unknown evidence, not a passing check.

`npm run check` proves type checking, linting, non-integration tests, and the production build. It does not prove behavior against the live Asana API.

Installer tests execute `install.sh` with an isolated home directory, local release fixtures, and
fake client commands. They must not read or modify the developer's real Claude, Codex, or Cursor
configuration. Also check the POSIX shell syntax directly when changing the installer:

```sh
sh -n install.sh
```

## Live Asana integration suite

Use only a Teamspace in which the test-created tickets may be safely deleted. Run `asana-command-mcp auth login` first so a PAT is available in the operating system keychain, or use `auth login --oauth` for OAuth. A full integration run, including writes, then requires the Teamspace and explicit disposable acknowledgement:

```sh
ASANA_INTEGRATION_TEST_TEAMSPACE="<disposable-teamspace-id>" \
ASANA_INTEGRATION_TEST_DISPOSABLE=true \
npm run test:integration
```

- A PAT from `auth login`, or OAuth credentials from `auth login --oauth`, is required for any live integration test.
- `ASANA_INTEGRATION_TEST_TEAMSPACE` is required and identifies the test Teamspace.
- `ASANA_INTEGRATION_TEST_DISPOSABLE=true` is required for destructive lifecycle tests. Omitting it skips writes; using any value other than the lowercase string `true` does not enable them.
- `ASANA_INTEGRATION_TEST_SECOND_TEAMSPACE` is optional. When set, it enables the cross-Teamspace scope-isolation case.

The suite bounds its work and directly verifies deletion of every created ticket. A skipped write suite, a cleanup attempt, or an eventually consistent search result is not proof of cleanup.

## Live built-server validation

The live validator builds the package, starts `dist/index.js` as a real stdio MCP server, validates the advertised tools, exercises a disposable ticket lifecycle, and verifies cleanup:

```sh
ASANA_INTEGRATION_TEST_TEAMSPACE="<disposable-teamspace-id>" \
ASANA_INTEGRATION_TEST_DISPOSABLE=true \
npm run validate:live
```

OAuth keychain credentials and both variables are required. Without them, capabilities are reported as `unknown` and the run is not passing evidence. The validator sets `ASANA_READ_ONLY=false` and defaults `ASANA_CREATE_TIMEOUT_SECONDS` to `1` to probe resumable initialization. It also honors explicitly supplied `ASANA_MAX_SCAN_TASKS`, `ASANA_CREATE_TIMEOUT_SECONDS`, `ASANA_REQUEST_TIMEOUT_MS`, and `ASANA_TOOL_TIMEOUT_MS`.

Include complete, unfiltered output from any integration or live-validation run used as pull-request evidence. Live success applies only to the exact commit tested.

For release changes, also run these commands directly and preserve their complete output:

```sh
npm audit
npm pack --dry-run
```

## Maintainer release process

Releases are executable npm tarballs hosted by GitHub Releases; this package is not published to the npm registry.

1. Prepare and merge a release pull request that updates `package.json` and `package-lock.json` to the same version.
2. On the exact release commit, run the complete release checks:

   ```sh
   npm ci
   npm run check
   npm audit
   npm pack --dry-run
   ```

3. Tag that commit with `v` followed by the exact `package.json` version, then push only that tag:

   ```sh
   version="$(node -p "require('./package.json').version")"
   git tag -a "v${version}" -m "Release v${version}"
   git push origin "v${version}"
   ```

   The tag-triggered release workflow independently checks the tag, repeats all release checks,
   creates `asana-command-mcp-<version>.tgz`, and executes that packed archive through `npx` from a
   temporary directory. It also creates the stable `asana-command-mcp.tgz` alias and `SHA256SUMS`,
   verifies those checksums, and runs `install.sh` against the local release assets in an isolated
   home directory. Only then does it create the GitHub Release and attach the versioned archive,
   stable archive, installer, and checksums. A tag that does not exactly match
   `v<package.json version>` fails without publishing a release.

Do not move or reuse a published version tag. If a release needs a code or packaging correction, prepare a new version and tag.
