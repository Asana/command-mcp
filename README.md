# Asana Command MCP server

`@asana/command-mcp` is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for managing Asana Command tickets through the public Asana API. It runs on your machine under your own Asana credentials.

It is not a hosted service. It has no hosted component, does not accept inbound HTTP connections, and exposes no HTTP listener; its only MCP transport is stdio.

## Requirements

- Node.js 22 or newer
- A customer-owned Asana OAuth application

Each operator creates an app in the [Asana developer console](https://app.asana.com/0/my-apps) and keeps its client secret outside this repository. Configure the app's distribution, permission scopes, and redirect URL as `urn:ietf:wg:oauth:2.0:oob`, which Asana documents for native and command-line applications. See [Asana's OAuth guide](https://developers.asana.com/docs/oauth).

## Install and configure

The package is distributed as an executable npm tarball attached to each GitHub Release. It is not published to the npm registry. Run the version-pinned release directly with `npx`; no repository clone or local build is needed. The URL pins both the release tag and archive version so an upstream release cannot silently change the executable.

### Authenticate with OAuth

Export the customer-owned OAuth app credentials in the shell:

```sh
export ASANA_OAUTH_CLIENT_ID="replace-with-your-client-id"
export ASANA_OAUTH_CLIENT_SECRET="replace-with-your-client-secret"
```

If the app uses granular permissions instead of Full permissions, also export its registered scopes as a space-separated value:

```sh
export ASANA_OAUTH_SCOPES="tasks:read tasks:write projects:read projects:write"
```

Run the one-time login command with the same version-pinned package used by the MCP configuration:

```sh
npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp auth login
```

The command opens Asana's authorization page. After authorization, copy the one-time code shown by Asana and paste it into the terminal prompt. The command also accepts a complete `urn:ietf:wg:oauth:2.0:oob?...` redirect URI when Asana provides one. Every exchange uses PKCE, and the command also verifies OAuth `state` when the input is a complete redirect URI. It then saves the client ID, client secret, and refresh token in the operating system keychain. It never persists the short-lived access token.

The keychain backend uses macOS Keychain, Windows Credential Manager, or the available native secure store on Linux. Headless Linux systems and containers may not have an available or unlocked keychain. In that case the command fails closed with `The operating system keychain is unavailable`; it never silently falls back to a plaintext credentials file.

After login, the `ASANA_OAUTH_CLIENT_ID`, `ASANA_OAUTH_CLIENT_SECRET`, and `ASANA_OAUTH_SCOPES` variables are no longer needed and can be unset. Future server starts load the OAuth credentials from the keychain, obtain a short-lived access token from Asana, cache it only in memory, and refresh it before expiry. If Asana rotates the refresh token, the replacement is saved to the keychain before use.

### Claude Code

Run `auth login` first, then register the version-pinned release at user scope without credential environment variables:

```sh
claude mcp add \
  --transport stdio \
  --scope user \
  asana-command \
  -- npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp
```

Claude Code does not run this upstream Asana login flow. It starts the local stdio process, which reads and refreshes the credentials previously saved by `auth login`.

Confirm the registration with `claude mcp get asana-command`. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for scope and removal options.

### Codex

Run `auth login` first, then add this entry to `$CODEX_HOME/config.toml` (by default `~/.codex/config.toml`):

```toml
[mcp_servers.asana-command]
command = "npx"
args = ["--yes", "--package", "https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz", "asana-command-mcp"]
```

Confirm the registration with:

```sh
codex mcp list
```

The Codex CLI and IDE extension on the same host share this configuration. Codex starts the local stdio process, which reads and refreshes credentials from the operating system keychain. See the [Codex MCP documentation](https://developers.openai.com/codex/mcp) for project-scoped and other configuration options.

## Configuration

| Environment variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ASANA_OAUTH_CLIENT_ID` | OAuth login only | None | Customer-owned OAuth application client ID. Saved to the operating system keychain after login. |
| `ASANA_OAUTH_CLIENT_SECRET` | OAuth login only | None | OAuth application client secret. Saved to the operating system keychain after login and used only at Asana's token endpoint. |
| `ASANA_OAUTH_SCOPES` | OAuth login only | Full-permission default | Space-separated scopes registered for an app using granular permissions. Omit this for an app registered with Full permissions. |
| `ASANA_READ_ONLY` | No | `false` | Accepts `true` or `false`, case-insensitively. When `true`, every mutating tool is absent from MCP tool discovery, rather than advertised and made to fail when called. |
| `ASANA_MAX_SCAN_TASKS` | No | `1000` | Positive integer bounding ticket listing, ticket search, and pull-request discovery scans. Values above the hard maximum of `10000` are clamped to `10000`. |
| `ASANA_CREATE_TIMEOUT_SECONDS` | No | `30` | Positive integer number of seconds to wait for asynchronous custom-type initialization during ticket creation. |
| `ASANA_REQUEST_TIMEOUT_MS` | No | `20000` | Positive integer per-request Asana API timeout in milliseconds, also bounded by the remaining overall tool budget. |
| `ASANA_TOOL_TIMEOUT_MS` | No | `120000` | Positive integer overall deadline in milliseconds for one tool call or doctor run. |

The executable loads `.env` from the process working directory when that file exists. This may be used for OAuth login inputs and non-secret runtime settings. Server starts do not need credential environment variables after `auth login` has saved them to the operating system keychain.

## Tools

The descriptions below are the exact strings advertised through MCP tool discovery. Tools marked **write** are omitted entirely when `ASANA_READ_ONLY=true`.

| Tool | Mode | Advertised description |
| --- | --- | --- |
| `get_context` | Read | Confirm one selected Teamspace at the start of an Asana workflow or when diagnosing schema warnings; do not call before every tool. |
| `list_workspaces` | Read | List workspaces accessible to the configured Asana identity for Teamspace discovery or access diagnosis. |
| `find_teamspaces` | Read | Find recent or query-matched Teamspace candidates in one workspace; candidates are not schema-validated. |
| `get_teamspace_schema` | Read | Return the freshly discovered Command schema used for this tool call. |
| `read_ticket` | Read | Read one Command ticket by Asana GID, Command short ID, or Asana task URL. |
| `list_tickets` | Read | Enumerate tickets in the selected Teamspace with bounded type, label, assignee, Release, and completion-status filtering plus opaque pagination. Use search_tickets instead for completion-date ranges. |
| `search_tickets` | Read | Search tickets in the selected Teamspace using eventually consistent Asana workspace search, with a total result limit up to 1,000. Use this tool for completion-date ranges; results include created_at and completed_at. Set compact=true to return only gid, name, and those timestamps. |
| `get_comments` | Read | List comments, excluding system stories, with comment-relative pagination. |
| `list_teamspace_releases` | Read | List only Releases referenced by the selected Teamspace. |
| `get_ticket_prs` | Read | Best-effort discovery of GitHub pull-request URLs in ticket attachments and stories. |
| `create_ticket` | Write | Create a Command ticket and wait for asynchronous custom-type initialization. For natural-language ticketing requests, search the whole Teamspace first for active duplicates. |
| `update_ticket` | Write | Update one in-scope ticket and return a canonical post-write read. |
| `add_dependency` | Write | Make ticket depend on dependency (dependency blocks ticket), then return ticket's current dependency list. |
| `remove_dependency` | Write | Stop ticket from depending on dependency, then return ticket's current dependency list. |
| `add_comment` | Write | Add a plain-text comment to an in-scope ticket. |
| `add_ticket_to_release` | Write | Multi-home a ticket into a currently referenced Teamspace Release. |
| `remove_ticket_from_release` | Write | Remove a ticket from a currently referenced Teamspace Release. |

Important consistency guarantees:

- Full ticket views returned by `read_ticket`, `list_tickets`, non-compact `search_tickets`, and successful `create_ticket` and `update_ticket` calls include a canonical Command `url` and `releases` as `{gid, name}` entries. Only projects currently referenced as Teamspace Releases are included; tickets in no Release return `releases: []`. Compact search results remain limited to their four documented fields.
- `list_tickets` reads Teamspace membership authoritatively, but scans no more than `ASANA_MAX_SCAN_TASKS`; its `truncated`, `scanned_count`, `has_more`, and opaque cursor fields describe the bounded result.
- `search_tickets` uses Asana workspace search, which is eventually consistent. A newly changed ticket may not appear immediately.
- Mutations perform authoritative direct reads to verify the requested effect before reporting success. Use a direct `read_ticket` after an ambiguous timeout rather than assuming whether a mutation happened.
- `get_ticket_prs` is best-effort. It extracts GitHub pull-request URLs from Asana attachment and story data; it never contacts GitHub or opens the discovered links.

Every scoped call performs a fresh Teamspace schema discovery. Ticket identifiers may be an Asana task GID, a Command short ID, or an Asana task URL.

## Diagnose configuration with `doctor`

Run `doctor` first when credentials, access, or Teamspace schema discovery is not working. The command writes one JSON object to stdout on success:

```sh
npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp doctor
```

Credentials-only output has this shape:

```json
{
  "status": "passed",
  "authentication": {
    "status": "passed",
    "workspaces": [
      {
        "gid": "<workspace-gid>",
        "name": "Example workspace"
      }
    ]
  }
}
```

Pass a Teamspace project GID or its `https://app.asana.com/.../dev/space/...` URL to check authentication, schema discovery, and the required Asana custom-types opt-in:

```sh
npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp doctor "<teamspace-id-or-url>"
```

The Teamspace form has this shape:

```json
{
  "status": "passed",
  "authentication": {
    "status": "passed",
    "workspaces": [
      {
        "gid": "<workspace-gid>",
        "name": "Example workspace"
      }
    ]
  },
  "teamspace_schema": {
    "status": "passed",
    "workspace": {
      "gid": "<workspace-gid>",
      "name": "Example workspace"
    },
    "teamspace": {
      "gid": "<teamspace-gid>",
      "name": "Example Teamspace",
      "url": "https://app.asana.com/.../dev/space/..."
    },
    "schema_fingerprint": "<schema-fingerprint>",
    "warnings": []
  },
  "asana_custom_types_opt_in": {
    "status": "passed"
  }
}
```

The `teamspace.url` field uses the canonical Command Teamspace route. CLI and doctor failures are JSON error payloads on stderr. MCP tool failures return the same payload as structured content with the MCP error flag set:

```json
{
  "error": {
    "code": "invalid_configuration",
    "message": "Asana OAuth login is missing; run asana-command-mcp auth login",
    "retryable": false
  },
  "asana_request_ids": []
}
```

Stable error codes are `authentication_failed`, `payment_required`, `permission_denied`, `not_found`, `required_api_change_unavailable`, `invalid_teamspace`, `schema_ambiguous`, `schema_incompatible`, `schema_drift`, `cursor_invalid`, `out_of_scope`, `unknown_release`, `rate_limited`, `request_timeout`, `tool_timeout`, `invalid_configuration`, `invalid_input`, and `asana_api_error`.

## Known limitations

- Schema discovery relies on English-language field and option names. Non-English Teamspace schemas are unverified.
- A Teamspace without a ticket type field returns `null` for type reads; type filters and type mutations are unavailable. Creating or updating other fields remains possible.
- Completion is the only core ticket state represented by this server. It does not model a separate workflow-status state.
- Asana initializes a new ticket's custom type asynchronously. If initialization or the required follow-up updates cannot complete within the applicable create, request, or overall tool deadline, `create_ticket` may return `status: "pending"` and `outcome: "initialization_pending"`. The task already exists: do **not** call `create_ticket` again. Call `update_ticket` with `data.teamspace_id` as `teamspace_id`, `data.task_gid` as `task_gid`, and the fields in `data.pending_updates.update_ticket`. If initialization is still pending, retry that same `update_ticket` request.
- Listing and pull-request extraction are scan-bounded. Search is eventually consistent.
- OAuth login uses Asana's command-line redirect, so the user must paste the one-time authorization code shown by Asana back into the interactive `auth login` prompt. A complete redirect URI is also accepted. Claude Code and Codex do not perform this upstream login on behalf of the stdio server.
- OAuth requires an available and unlocked operating system keychain. Headless Linux systems and containers without a native secure store are unsupported; there is no plaintext fallback.

## Verification status

`npm run check` verifies type checking, linting, non-integration tests, and a production build. The unit and contract suite covers OAuth-only configuration, standalone OOB authorization codes, redirect-URI state verification, PKCE, keychain storage and fail-closed behavior, OAuth refresh caching and rotation, failure handling, tool discovery and descriptions, scope checks, bounded scans, workspace-search request mapping, post-write direct reads, pending initialization, error normalization, and credential redaction.

The repository also contains a disposable-Teamspace integration suite and a built-server live MCP validator. This documentation revision has no recorded passing real-Asana run against its exact commit because the required credentials and disposable Teamspace were unavailable. Real-Asana behavior—including OAuth token exchange, writes, eventual search visibility, pending-initialization resumption, and verified cleanup—therefore remains **unverified**, not passed. See [CONTRIBUTING.md](CONTRIBUTING.md) to produce that evidence safely.

## Security and contributing

See [SECURITY.md](SECURITY.md) for the trust model and vulnerability reporting process. See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and verification requirements.
