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

4. Use Full permissions, or configure the granular permissions your organization requires.
5. Copy the client ID and client secret.

Keep the client secret private. Do not commit it to this repository or add it to an MCP configuration file.

See [Asana's OAuth documentation](https://developers.asana.com/docs/oauth) for application settings.

## 2. Sign in to Asana

Set the OAuth application credentials in your terminal:

```sh
export ASANA_OAUTH_CLIENT_ID="your-client-id"
export ASANA_OAUTH_CLIENT_SECRET="your-client-secret"
```

If the application uses granular permissions, also set its scopes as a space-separated value:

```sh
export ASANA_OAUTH_SCOPES="tasks:read tasks:write projects:read projects:write"
```

Start the login flow:

```sh
npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp auth login
```

The command opens Asana in your browser. Authorize the application, copy the code shown by Asana, and paste it into the terminal.

After login, the client ID, client secret, and refresh token are stored in the operating system keychain. The access token is kept only in memory and refreshed automatically. You can remove the login variables from your shell:

```sh
unset ASANA_OAUTH_CLIENT_ID ASANA_OAUTH_CLIENT_SECRET ASANA_OAUTH_SCOPES
```

## 3. Add the server to Claude Code

```sh
claude mcp add \
  --transport stdio \
  --scope user \
  asana-command \
  -- npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp
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
args = ["--yes", "--package", "https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz", "asana-command-mcp"]
```

Confirm that it was added:

```sh
codex mcp list
```

See the [Codex MCP documentation](https://developers.openai.com/codex/mcp) for other configuration options.

## Check the connection

Check OAuth credentials and Asana access:

```sh
npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp doctor
```

To also validate a Command Teamspace, pass its project GID or URL:

```sh
npx --yes --package https://github.com/AsanaPlayground/command-mcp/releases/download/v0.1.0/asana-command-mcp-0.1.0.tgz asana-command-mcp doctor "TEAMSPACE_ID_OR_URL"
```

If authentication stops working, run `auth login` again.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `ASANA_OAUTH_CLIENT_ID` | None | OAuth client ID used only by `auth login`. |
| `ASANA_OAUTH_CLIENT_SECRET` | None | OAuth client secret used only by `auth login`. |
| `ASANA_OAUTH_SCOPES` | Full permissions | Space-separated scopes used only by `auth login`. |
| `ASANA_READ_ONLY` | `false` | Set to `true` to remove all write tools. |
| `ASANA_MAX_SCAN_TASKS` | `1000` | Maximum number of tasks scanned by bounded operations. Maximum: `10000`. |
| `ASANA_CREATE_TIMEOUT_SECONDS` | `30` | Time allowed for ticket custom-type initialization. |
| `ASANA_REQUEST_TIMEOUT_MS` | `20000` | Timeout for one Asana API request. |
| `ASANA_TOOL_TIMEOUT_MS` | `120000` | Overall timeout for one tool call. |

A local untracked `.env` file can be used instead of shell exports. Do not commit credentials.

## Available tools

Read tools:

- `get_context`
- `list_workspaces`
- `find_teamspaces`
- `get_teamspace_schema`
- `read_ticket`
- `list_tickets`
- `search_tickets`
- `get_comments`
- `list_teamspace_releases`
- `get_ticket_prs`

Write tools:

- `create_ticket`
- `update_ticket`
- `add_dependency`
- `remove_dependency`
- `add_comment`
- `add_ticket_to_release`
- `remove_ticket_from_release`

Write tools are not exposed when `ASANA_READ_ONLY=true`.

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
