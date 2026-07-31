# Contributing

Thank you for contributing to the Asana Command MCP server.

## Local setup

Install Node.js 22 or newer, clone the repository, and install the locked dependencies:

```sh
git clone https://github.com/AsanaPlayground/command-mcp.git
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

## Live Asana integration suite

Use only a Teamspace in which the test-created tickets may be safely deleted. A full integration run, including writes, requires all three variables and the explicit disposable acknowledgement:

```sh
ASANA_ACCESS_TOKEN="<personal-access-token>" \
ASANA_INTEGRATION_TEST_TEAMSPACE="<disposable-teamspace-id>" \
ASANA_INTEGRATION_TEST_DISPOSABLE=true \
npm run test:integration
```

- `ASANA_ACCESS_TOKEN` is required for any live integration test.
- `ASANA_INTEGRATION_TEST_TEAMSPACE` is required and identifies the test Teamspace.
- `ASANA_INTEGRATION_TEST_DISPOSABLE=true` is required for destructive lifecycle tests. Omitting it skips writes; using any value other than the lowercase string `true` does not enable them.
- `ASANA_INTEGRATION_TEST_SECOND_TEAMSPACE` is optional. When set, it enables the cross-Teamspace scope-isolation case.

The suite bounds its work and directly verifies deletion of every created ticket. A skipped write suite, a cleanup attempt, or an eventually consistent search result is not proof of cleanup.

## Live built-server validation

The live validator builds the package, starts `dist/index.js` as a real stdio MCP server, validates the advertised tools, exercises a disposable ticket lifecycle, and verifies cleanup:

```sh
ASANA_ACCESS_TOKEN="<personal-access-token>" \
ASANA_INTEGRATION_TEST_TEAMSPACE="<disposable-teamspace-id>" \
ASANA_INTEGRATION_TEST_DISPOSABLE=true \
npm run validate:live
```

All three variables are required. Without them, capabilities are reported as `unknown` and the run is not passing evidence. The validator sets `ASANA_READ_ONLY=false` and defaults `ASANA_CREATE_TIMEOUT_SECONDS` to `1` to probe resumable initialization. It also honors explicitly supplied `ASANA_MAX_SCAN_TASKS`, `ASANA_CREATE_TIMEOUT_SECONDS`, `ASANA_REQUEST_TIMEOUT_MS`, and `ASANA_TOOL_TIMEOUT_MS`.

Include complete, unfiltered output from any integration or live-validation run used as pull-request evidence. Live success applies only to the exact commit tested.

For release changes, also run these commands directly and preserve their complete output:

```sh
npm audit
npm pack --dry-run
```
