# Asana Command MCP server

`@asana/command-mcp` is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for managing Asana Command tickets through the public Asana API. It runs on your machine under your own Asana credentials.

It is not a hosted service. It has no hosted component, does not accept inbound HTTP connections, and exposes no HTTP listener; its only MCP transport is stdio.

## Requirements

- Node.js 22 or newer
- An Asana Personal Access Token (PAT)

A PAT has the same Asana permissions as the user who created it. Open the [Asana developer console](https://app.asana.com/0/my-apps), select **Create new token**, name it, create it, and copy it immediately. Asana displays the token only once. Treat it like a password.

## Install and build

The package is not yet published to npm. Build it from this repository:

```sh
git clone https://github.com/AsanaPlayground/command-mcp.git
cd command-mcp
npm ci
npm run build
```

Register the built server with an MCP client. Replace the absolute path and token in this generic MCP client configuration:

```json
{
  "mcpServers": {
    "asana-command": {
      "command": "node",
      "args": ["/absolute/path/to/command-mcp/dist/index.js"],
      "env": {
        "ASANA_ACCESS_TOKEN": "replace-with-your-personal-access-token"
      }
    }
  }
}
```

The absolute script path makes the registration independent of the client's working directory. Restart the client after changing its MCP configuration.

### Claude Code

Export the token in the shell or profile that launches Claude Code, then register the server at user scope:

```sh
claude mcp add \
  --env 'ASANA_ACCESS_TOKEN=replace-with-your-personal-access-token' \
  --transport stdio \
  --scope user \
  asana-command \
  -- node /absolute/path/to/command-mcp/dist/index.js
```
Confirm the registration with:

```sh
claude mcp get asana-command
```

See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for scope and removal options.

### Codex

Export the token in the environment that launches Codex:

```sh
export ASANA_ACCESS_TOKEN="replace-with-your-personal-access-token"
```

Add this entry to `$CODEX_HOME/config.toml` (by default `~/.codex/config.toml`):

```toml
[mcp_servers.asana-command]
command = "node"
args = ["/absolute/path/to/command-mcp/dist/index.js"]
env_vars = ["ASANA_ACCESS_TOKEN"]
```

`env_vars` forwards the token without storing its value in `config.toml`. Confirm the registration with:

```sh
codex mcp list
```

The Codex CLI and IDE extension on the same host share this configuration. See the [Codex MCP documentation](https://developers.openai.com/codex/mcp) for project-scoped and other configuration options.

## Configuration

| Environment variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ASANA_ACCESS_TOKEN` | Yes | None | Personal Access Token used for all Asana API requests. Blank values are rejected. |
| `ASANA_READ_ONLY` | No | `false` | Accepts `true` or `false`, case-insensitively. When `true`, every mutating tool is absent from MCP tool discovery, rather than advertised and made to fail when called. |
| `ASANA_MAX_SCAN_TASKS` | No | `1000` | Positive integer bounding ticket listing, ticket search, and pull-request discovery scans. Values above the hard maximum of `10000` are clamped to `10000`. |
| `ASANA_CREATE_TIMEOUT_SECONDS` | No | `30` | Positive integer number of seconds to wait for asynchronous custom-type initialization during ticket creation. |
| `ASANA_REQUEST_TIMEOUT_MS` | No | `20000` | Positive integer per-request Asana API timeout in milliseconds, also bounded by the remaining overall tool budget. |
| `ASANA_TOOL_TIMEOUT_MS` | No | `120000` | Positive integer overall deadline in milliseconds for one tool call or doctor run. |

The executable loads `.env` from the process working directory when that file exists. The MCP client chooses the process working directory, which may not be the repository directory. Supplying an absolute executable path and explicit `env` entries in the client configuration is the reliable option; alternatively, configure the client to use the directory that contains `.env`.

## Tools

The descriptions below are the exact strings advertised through MCP tool discovery. Tools marked **write** are omitted entirely when `ASANA_READ_ONLY=true`.

| Tool | Mode | Advertised description |
| --- | --- | --- |
| `get_context` | Read | Confirm one selected Teamspace at the start of an Asana workflow or when diagnosing schema warnings; do not call before every tool. |
| `list_workspaces` | Read | List workspaces accessible to the configured Asana Personal Access Token for Teamspace discovery or access diagnosis. |
| `find_teamspaces` | Read | Find recent or query-matched Teamspace candidates in one workspace; candidates are not schema-validated. |
| `get_teamspace_schema` | Read | Return the freshly discovered Command schema used for this tool call. |
| `read_ticket` | Read | Read one Command ticket by Asana GID, Command short ID, or Asana task URL. |
| `list_tickets` | Read | Enumerate tickets in the selected Teamspace with bounded type, label, assignee, Release, and completion-status filtering plus opaque pagination. Use search_tickets instead for completion-date or due-date ranges. |
| `search_tickets` | Read | Search tickets in the selected Teamspace using eventually consistent Asana workspace search, with a total result limit up to 1,000. Use this tool for completion-date or due-date ranges; results include created_at and completed_at. Set compact=true to return only gid, name, and those timestamps. |
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

- Full ticket views returned by `read_ticket`, `list_tickets`, non-compact `search_tickets`, and successful `create_ticket` and `update_ticket` calls include `releases` as `{gid, name}` entries. Only projects currently referenced as Teamspace Releases are included; tickets in no Release return `releases: []`. Compact search results remain limited to their four documented fields.
- `list_tickets` reads Teamspace membership authoritatively, but scans no more than `ASANA_MAX_SCAN_TASKS`; its `truncated`, `scanned_count`, `has_more`, and opaque cursor fields describe the bounded result.
- `search_tickets` uses Asana workspace search, which is eventually consistent. A newly changed ticket may not appear immediately.
- Mutations perform authoritative direct reads to verify the requested effect before reporting success. Use a direct `read_ticket` after an ambiguous timeout rather than assuming whether a mutation happened.
- `get_ticket_prs` is best-effort. It extracts GitHub pull-request URLs from Asana attachment and story data; it never contacts GitHub or opens the discovered links.

Every scoped call performs a fresh Teamspace schema discovery. Ticket identifiers may be an Asana task GID, a Command short ID, or an Asana task URL.

## Diagnose configuration with `doctor`

Run `doctor` first when credentials, access, or Teamspace schema discovery is not working. The command writes one JSON object to stdout on success:

```sh
node /absolute/path/to/command-mcp/dist/index.js doctor
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
node /absolute/path/to/command-mcp/dist/index.js doctor "<teamspace-id-or-url>"
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

The `teamspace.url` field is optional. CLI and doctor failures are JSON error payloads on stderr. MCP tool failures return the same payload as structured content with the MCP error flag set:

```json
{
  "error": {
    "code": "invalid_configuration",
    "message": "Invalid value for ASANA_ACCESS_TOKEN",
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

## Verification status

`npm run check` verifies type checking, linting, non-integration tests, and a production build. The unit and contract suite covers configuration defaults, tool discovery and descriptions, scope checks, bounded scans, workspace-search request mapping, post-write direct reads, pending initialization, error normalization, and credential redaction.

The repository also contains a disposable-Teamspace integration suite and a built-server live MCP validator. This documentation revision has no recorded passing real-Asana run against its exact commit because the required credentials and disposable Teamspace were unavailable. Real-Asana behavior—including writes, eventual search visibility, pending-initialization resumption, and verified cleanup—therefore remains **unverified**, not passed. See [CONTRIBUTING.md](CONTRIBUTING.md) to produce that evidence safely.

## Security and contributing

See [SECURITY.md](SECURITY.md) for the trust model and vulnerability reporting process. See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and verification requirements.
