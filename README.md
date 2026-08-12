# Asana Command MCP

`@asana/command-mcp` is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for working with Asana Command tickets from Claude Code or Codex.

The server runs on your machine over stdio. It authenticates with Asana through OAuth, stores credentials in your operating system keychain, and refreshes access tokens automatically.

## Requirements

- Node.js 22 or newer
- An Asana account
- An Asana OAuth application
- Claude Code or Codex

## 1. Create an Asana OAuth application

1. Open the [Asana developer console](https://app.asana.com/0/my-apps).
2. Create an OAuth application.
3. Add this redirect URL:

   ```text
   urn:ietf:wg:oauth:2.0:oob
   ```

4. Select **Full permissions**. The custom-types API required for Command schema discovery does not currently support granular OAuth scopes.
5. Copy the client ID and client secret.

Keep the client secret private. Do not commit it to this repository or add it to an MCP configuration file.

See [Asana's OAuth documentation](https://developers.asana.com/docs/oauth) for application settings.

## 2. Download the package

Sign in to GitHub with an account that can access this private repository, then:

1. Open the [latest GitHub release](https://github.com/AsanaPlayground/command-mcp/releases/latest).
2. Download the `asana-command-mcp-<version>.tgz` file.
3. Save it in a permanent location on your machine. Do not move or delete it after adding the MCP server.

Set its absolute path in your terminal:

```sh
export ASANA_COMMAND_MCP_PACKAGE="/absolute/path/to/asana-command-mcp-0.1.0.tgz"
```

Use an absolute path. MCP clients do not reliably expand `~` in their configuration.

## 3. Sign in to Asana

Set the OAuth application credentials in your terminal:

```sh
export ASANA_OAUTH_CLIENT_ID="your-client-id"
export ASANA_OAUTH_CLIENT_SECRET="your-client-secret"
```

Start the login flow:

```sh
npx --yes --package "$ASANA_COMMAND_MCP_PACKAGE" asana-command-mcp auth login
```

The command opens Asana in your browser. Authorize the application, copy the code shown by Asana, and paste it into the terminal.

After login, the client ID, client secret, and refresh token are stored in the operating system keychain. The access token is kept only in memory and refreshed automatically. You can remove the login variables from your shell:

```sh
unset ASANA_OAUTH_CLIENT_ID ASANA_OAUTH_CLIENT_SECRET
```

## 4. Add the server to Claude Code

```sh
claude mcp add \
  --transport stdio \
  --scope user \
  asana-command \
  -- npx --yes --package "$ASANA_COMMAND_MCP_PACKAGE" asana-command-mcp
```

Confirm that it was added:

```sh
claude mcp get asana-command
```

Start Claude Code and ask it to list your Asana workspaces or inspect a Command Teamspace.

Claude Code starts the local MCP server but does not perform the Asana login. Run `auth login` before adding or starting the server.

See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for MCP scope and removal options.

## Add the server to Codex

After completing the Asana login, add this entry to `~/.codex/config.toml`:

```toml
[mcp_servers.asana-command]
command = "npx"
args = ["--yes", "--package", "/absolute/path/to/asana-command-mcp-0.1.0.tgz", "asana-command-mcp"]
```

Confirm that it was added:

```sh
codex mcp list
```

See the [Codex MCP documentation](https://developers.openai.com/codex/mcp) for other configuration options.

## Check the connection

Check OAuth credentials and Asana access:

```sh
npx --yes --package "$ASANA_COMMAND_MCP_PACKAGE" asana-command-mcp doctor
```

To also validate a Command Teamspace, pass its project GID or URL:

```sh
npx --yes --package "$ASANA_COMMAND_MCP_PACKAGE" asana-command-mcp doctor "TEAMSPACE_ID_OR_URL"
```

If authentication stops working, run `auth login` again, then restart Claude Code or Codex so it starts the MCP server with the new credentials.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `ASANA_OAUTH_CLIENT_ID` | None | OAuth client ID used only by `auth login`. |
| `ASANA_OAUTH_CLIENT_SECRET` | None | OAuth client secret used only by `auth login`. |
| `ASANA_READ_ONLY` | `false` | Set to `true` to remove all write tools. |
| `ASANA_MAX_SCAN_TASKS` | `1000` | Maximum number of tasks scanned by bounded operations. Maximum: `10000`. |
| `ASANA_CREATE_TIMEOUT_SECONDS` | `30` | Time allowed for ticket custom-type initialization. |
| `ASANA_REQUEST_TIMEOUT_MS` | `20000` | Timeout for one Asana API request. |
| `ASANA_TOOL_TIMEOUT_MS` | `120000` | Overall timeout for one tool call. |

A local untracked `.env` file can be used instead of shell exports. Do not commit credentials.

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

## Notes

- OAuth credentials require an available and unlocked macOS Keychain, Windows Credential Manager, or Linux secret store. Plaintext credential storage is not supported.
- Asana displays a one-time authorization code during login. Copy it into the terminal to finish authentication.
- Teamspace schema discovery currently relies on English field and option names.
- Asana search is eventually consistent, so recent changes may take time to appear in search results.

## Development

```sh
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release validation. See [SECURITY.md](SECURITY.md) for security reporting and the credential trust model.
