# Asana Command MCP

`@asana/command-mcp` is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for working with Asana Command tickets from Claude Code, Codex, or Cursor.

The server runs on your machine over stdio. By default, it authenticates with an Asana personal access token (PAT) stored in your operating system keychain. OAuth is also supported as a fallback.

> [!WARNING]
> **By downloading or accessing this MCP, you agree to the [Command by Asana MCP Terms](https://asana.com/terms/command-mcp).**
> 
> **Beta software, provided as-is.** No warranties, express or implied, including fitness for a particular purpose.
> Behavior may change without notice, and there is no guarantee of continued availability or support.
> Use of this software is entirely at your own risk.

## Requirements

- Node.js 22 or newer
- npm
- macOS or Linux with `curl` or `wget`
- An Asana account
- Claude Code, Codex, or Cursor

## Install or update

Run one of these commands:

```sh
curl -fsSL https://github.com/Asana/command-mcp/releases/latest/download/install.sh | sh
```

```sh
wget -qO- https://github.com/Asana/command-mcp/releases/latest/download/install.sh | sh
```

The installer:

- downloads the latest release and verifies its SHA-256 checksum;
- installs it under `~/.asana/mcp`;
- detects the `claude`, `codex`, `cursor`, and Cursor Agent (`agent`) commands;
- offers to configure each detected client as a user-level stdio MCP server.

Run the same command again to update the existing installation. The executable path remains
`~/.asana/mcp/bin/asana-command-mcp`, so configured clients do not need a version-specific path.

The prompt defaults to configuring every detected client. For non-interactive use, select clients
explicitly:

```sh
curl -fsSL https://github.com/Asana/command-mcp/releases/latest/download/install.sh \
  | sh -s -- --claude --codex --cursor
```

Use `--all` to require all three clients, or `--no-config` to install without changing client
configuration. Selecting a client whose command is not installed causes the installer to stop with
an error.

When replacing an existing `asana-command` client entry, the installer detects versioned `.tgz`
packages referenced by the old configuration. If an old package is outside `~/.asana/mcp` and no
supported client still references it, the installer offers to delete it. The safe default is to
keep the file. Use `--delete-old-packages` or `--keep-old-packages` to make that choice
non-interactively. The installer never deletes packages inside its managed installation directory.

## Manual installation

To install without running the downloaded installer script:

1. Open the [latest GitHub release](https://github.com/Asana/command-mcp/releases/latest).
2. Download `asana-command-mcp.tgz` and `SHA256SUMS` into the same directory.
3. Verify the archive checksum.

   On Linux:

   ```sh
   sha256sum --check --ignore-missing SHA256SUMS
   ```

   On macOS:

   ```sh
   expected="$(awk '$2 == "asana-command-mcp.tgz" { print $1 }' SHA256SUMS)"
   actual="$(shasum -a 256 asana-command-mcp.tgz | awk '{ print $1 }')"
   test -n "$expected" && test "$actual" = "$expected"
   ```

4. Install the package into the stable user-level location:

   ```sh
   mkdir -p "$HOME/.asana/mcp"
   npm install --global --prefix "$HOME/.asana/mcp" ./asana-command-mcp.tgz
   cp ./asana-command-mcp.tgz "$HOME/.asana/mcp/asana-command-mcp.tgz"
   ```

The executable is now at `~/.asana/mcp/bin/asana-command-mcp`. Continue with
[Sign in to Asana](#sign-in-to-asana), then use [Manual client configuration](#manual-client-configuration)
for each MCP client you want to enable.

## Sign in to Asana

Create and store a personal access token:

1. Open the [Asana developer console](https://app.asana.com/0/my-apps).
2. Select **Create new token**.
3. Name and create the token, then copy it immediately. Asana displays it only once.
4. Run:

```sh
"$HOME/.asana/mcp/bin/asana-command-mcp" auth login
```

Paste the PAT at the prompt and press Enter. The command stores it in your operating system keychain; it does not add the token to your shell environment or MCP configuration.

A PAT has the same Asana permissions as the user who created it. Treat it like a password.

<details>
<summary>Use OAuth instead</summary>

OAuth requires an Asana OAuth application and is used only when no PAT is stored in the keychain.

1. Open the [Asana developer console](https://app.asana.com/0/my-apps) and create an OAuth application.
2. Add `urn:ietf:wg:oauth:2.0:oob` as a redirect URL.
3. Select **Full permissions**. The custom-types API required for Command schema discovery does not currently support granular OAuth scopes.
4. Copy the client ID and client secret, then set them in the terminal:

```sh
export ASANA_OAUTH_CLIENT_ID="your-client-id"
export ASANA_OAUTH_CLIENT_SECRET="your-client-secret"
```

Start OAuth login explicitly:

```sh
"$HOME/.asana/mcp/bin/asana-command-mcp" auth login --oauth
```

The command opens Asana in your browser. Authorize the application, copy the one-time code shown by Asana, and paste it into the terminal.

After login, the client ID, client secret, and refresh token are stored in the operating system keychain. The access token is kept only in memory and refreshed automatically. You can remove the login variables from your shell:

```sh
unset ASANA_OAUTH_CLIENT_ID ASANA_OAUTH_CLIENT_SECRET
```

Keep the client secret private. Do not commit it or add it to an MCP configuration file. See [Asana's OAuth documentation](https://developers.asana.com/docs/oauth) for application settings.

</details>

## Check the connection

Check the stored credentials and Asana access:

```sh
"$HOME/.asana/mcp/bin/asana-command-mcp" doctor
```

To also validate a Command Teamspace, pass its project GID or URL:

```sh
"$HOME/.asana/mcp/bin/asana-command-mcp" doctor "TEAMSPACE_ID_OR_URL"
```

Restart configured clients after installation or login, then confirm the server:

```sh
claude mcp get asana-command
codex mcp list
```

For Cursor, open **Settings → Tools & MCP** or inspect `~/.cursor/mcp.json`. The installer
preserves unrelated entries in that file. If authentication stops working, run `auth login` again
for a PAT or `auth login --oauth` for OAuth, then restart the client.

## Manual client configuration

The installer normally handles this step. To configure a client later, rerun it with the
corresponding flag. The equivalent Claude Code and Codex commands are:

```sh
claude mcp add --transport stdio --scope user asana-command \
  -- "$HOME/.asana/mcp/bin/asana-command-mcp"
codex mcp add asana-command -- "$HOME/.asana/mcp/bin/asana-command-mcp"
```

For Cursor, add a user-level stdio entry to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "asana-command": {
      "type": "stdio",
      "command": "/absolute/path/to/.asana/mcp/bin/asana-command-mcp",
      "args": []
    }
  }
}
```

MCP clients do not reliably expand `~` in configuration files; use an absolute path.

## Uninstall

Remove the `asana-command` MCP entry from each configured client, then remove the installation:

```sh
claude mcp remove asana-command --scope user
codex mcp remove asana-command
rm -rf "$HOME/.asana/mcp"
```

For Cursor, remove only the `asana-command` entry from `~/.cursor/mcp.json`.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `ASANA_OAUTH_CLIENT_ID` | None | OAuth client ID used only by `auth login --oauth`. |
| `ASANA_OAUTH_CLIENT_SECRET` | None | OAuth client secret used only by `auth login --oauth`. |
| `ASANA_READ_ONLY` | `false` | Set to `true` to remove all write tools. |
| `ASANA_MAX_SCAN_TASKS` | `1000` | Maximum number of tasks scanned by bounded operations. Maximum: `10000`. |
| `ASANA_CREATE_TIMEOUT_SECONDS` | `30` | Time allowed for ticket custom-type initialization. |
| `ASANA_REQUEST_TIMEOUT_MS` | `20000` | Timeout for one Asana API request. |
| `ASANA_TOOL_TIMEOUT_MS` | `120000` | Overall timeout for one tool call. |

A local untracked `.env` file can be used for non-secret settings and the temporary OAuth login variables. Do not commit credentials.

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

- Authentication requires an available and unlocked macOS Keychain, Windows Credential Manager, or Linux secret store. Plaintext credential storage is not supported.
- A stored PAT takes precedence. When no PAT is stored, the server falls back to stored OAuth credentials.
- Teamspace schema discovery currently relies on English field and option names.
- Asana search is eventually consistent, so recent changes may take time to appear in search results.

## Development

```sh
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release validation. See [SECURITY.md](SECURITY.md) for security reporting and the credential trust model.
