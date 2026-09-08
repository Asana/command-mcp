#!/bin/sh

set -eu

SERVER_NAME="asana-command"
ARCHIVE_NAME="asana-command-mcp.tgz"
CHECKSUM_NAME="SHA256SUMS"
DEFAULT_RELEASE_BASE_URL="https://github.com/Asana/command-mcp/releases/latest/download"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage: install.sh [--all | --claude | --claude-desktop | --codex | --cursor | --opencode | --no-config]
                  [--delete-old-packages | --keep-old-packages]

Installs or updates Asana Command MCP and configures detected MCP clients.
With no flags (same as --all), every detected client is configured
automatically and undetected ones are skipped without prompting. Passing an
individual client flag instead requires exactly that client to be installed.

ChatGPT Desktop shares Codex CLI's configuration (~/.codex/config.toml) on
the same host, so --codex also covers it when the codex command is installed.
EOF
}

want_claude=false
want_claude_desktop=false
want_codex=false
want_cursor=false
want_opencode=false
selection_explicit=false
auto_select=true
old_package_action=prompt

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all)
      want_claude=true
      want_claude_desktop=true
      want_codex=true
      want_cursor=true
      want_opencode=true
      selection_explicit=true
      auto_select=true
      ;;
    --claude)
      want_claude=true
      selection_explicit=true
      auto_select=false
      ;;
    --claude-desktop)
      want_claude_desktop=true
      selection_explicit=true
      auto_select=false
      ;;
    --codex)
      want_codex=true
      selection_explicit=true
      auto_select=false
      ;;
    --cursor)
      want_cursor=true
      selection_explicit=true
      auto_select=false
      ;;
    --opencode)
      want_opencode=true
      selection_explicit=true
      auto_select=false
      ;;
    --no-config)
      want_claude=false
      want_claude_desktop=false
      want_codex=false
      want_cursor=false
      want_opencode=false
      selection_explicit=true
      auto_select=false
      ;;
    --delete-old-packages)
      old_package_action=delete
      ;;
    --keep-old-packages)
      old_package_action=keep
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

[ -n "${HOME:-}" ] || die "HOME is not set"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "only macOS and Linux are supported" ;;
esac

command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required"
node_major="$(node -p 'process.versions.node.split(".")[0]')" ||
  die "could not determine the Node.js version"
case "$node_major" in
  ''|*[!0-9]*) die "could not determine the Node.js version" ;;
esac
[ "$node_major" -ge 22 ] || die "Node.js 22 or newer is required (found Node.js $node_major)"

command -v npm >/dev/null 2>&1 || die "npm is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

if command -v curl >/dev/null 2>&1; then
  download() {
    curl -fsSL "$1" -o "$2"
  }
elif command -v wget >/dev/null 2>&1; then
  download() {
    wget -qO "$2" "$1"
  }
else
  die "curl or wget is required"
fi

if command -v sha256sum >/dev/null 2>&1; then
  checksum() {
    sha256sum "$1" | awk '{print $1}'
  }
elif command -v shasum >/dev/null 2>&1; then
  checksum() {
    shasum -a 256 "$1" | awk '{print $1}'
  }
else
  die "sha256sum or shasum is required"
fi

install_dir="${ASANA_COMMAND_MCP_INSTALL_DIR:-"$HOME/.asana/mcp"}"
release_base_url="${ASANA_COMMAND_MCP_RELEASE_BASE_URL:-"$DEFAULT_RELEASE_BASE_URL"}"
executable="$install_dir/bin/asana-command-mcp"
installed_package_json="$install_dir/lib/node_modules/@asana/command-mcp/package.json"

package_version() {
  node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'
}

archive_version() {
  tar -xzOf "$1" package/package.json | package_version
}

mkdir -p "$install_dir"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/asana-command-mcp.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

archive_path="$work_dir/$ARCHIVE_NAME"
checksums_path="$work_dir/$CHECKSUM_NAME"

info "Downloading the latest Asana Command MCP release..."
download "$release_base_url/$ARCHIVE_NAME" "$archive_path" ||
  die "failed to download $ARCHIVE_NAME"
download "$release_base_url/$CHECKSUM_NAME" "$checksums_path" ||
  die "failed to download $CHECKSUM_NAME"

expected_checksum="$(
  awk -v archive="$ARCHIVE_NAME" '
    $2 == archive || $2 == "*" archive {
      print $1
      found = 1
      exit
    }
    END {
      if (!found) {
        exit 1
      }
    }
  ' "$checksums_path"
)" || die "$CHECKSUM_NAME does not contain $ARCHIVE_NAME"
actual_checksum="$(checksum "$archive_path")" || die "failed to checksum $ARCHIVE_NAME"
[ "$actual_checksum" = "$expected_checksum" ] || die "checksum verification failed"

latest_version="$(archive_version "$archive_path")" ||
  die "failed to read the release version from $ARCHIVE_NAME"
current_version=''
if [ -f "$installed_package_json" ]; then
  current_version="$(package_version <"$installed_package_json" 2>/dev/null || true)"
fi

if [ -n "$current_version" ]; then
  info "Installed version: $current_version"
fi
info "Latest release version: $latest_version"

if [ "$current_version" = "$latest_version" ]; then
  info "Already up to date; skipping reinstall."
else
  info "Installing into $install_dir..."
  npm install --global --prefix "$install_dir" "$archive_path"
  [ -x "$executable" ] || die "installation completed without creating $executable"
fi
mv "$archive_path" "$install_dir/$ARCHIVE_NAME"

has_claude=false
has_claude_desktop=false
has_codex=false
has_cursor=false
has_opencode=false
command -v claude >/dev/null 2>&1 && has_claude=true
claude_desktop_config="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
claude_desktop_app_path="${ASANA_COMMAND_MCP_CLAUDE_DESKTOP_APP_PATH:-/Applications/Claude.app}"
[ -d "$claude_desktop_app_path" ] && has_claude_desktop=true
command -v codex >/dev/null 2>&1 && has_codex=true
if command -v cursor >/dev/null 2>&1 || command -v agent >/dev/null 2>&1; then
  has_cursor=true
fi
command -v opencode >/dev/null 2>&1 && has_opencode=true

snapshot_codex_config() {
  output_path="$1"
  if [ "$has_codex" = true ] &&
    codex mcp get "$SERVER_NAME" --json >"$output_path" 2>/dev/null; then
    return
  fi
  : >"$output_path"
}

collect_package_references() {
  output_path="$1"
  codex_config_path="$2"
  MCP_REFERENCE_OUTPUT="$output_path" \
    MCP_CODEX_CONFIG="$codex_config_path" \
    MCP_INSTALL_DIR="$install_dir" \
    MCP_SERVER_NAME="$SERVER_NAME" \
    node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const outputPath = process.env.MCP_REFERENCE_OUTPUT;
const codexConfigPath = process.env.MCP_CODEX_CONFIG;
const installDir = process.env.MCP_INSTALL_DIR;
const serverName = process.env.MCP_SERVER_NAME;
if (!outputPath || !codexConfigPath || !installDir || !serverName) {
  throw new Error("missing legacy package discovery input");
}

const entries = [];
function readJsonEntry(configPath, serversKey = "mcpServers") {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const entry = config?.[serversKey]?.[serverName];
    if (entry !== undefined) {
      entries.push(entry);
    }
  } catch {
    // Invalid or absent client configuration is handled by that client's setup path.
  }
}

readJsonEntry(path.join(process.env.HOME, ".claude.json"));
readJsonEntry(path.join(process.env.HOME, ".cursor", "mcp.json"));
readJsonEntry(
  path.join(process.env.HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
);
readJsonEntry(path.join(process.env.HOME, ".config", "opencode", "opencode.json"), "mcp");
try {
  const contents = fs.readFileSync(codexConfigPath, "utf8").trim();
  if (contents !== "") {
    entries.push(JSON.parse(contents));
  }
} catch {
  // Older Codex versions may not support `mcp get --json`; leave their files untouched.
}

const strings = [];
function collectStrings(value) {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item);
    }
  }
}
for (const entry of entries) {
  collectStrings(entry);
}

const resolvedInstallDir = path.resolve(installDir);
const references = new Set();
for (const candidate of strings) {
  if (
    !path.isAbsolute(candidate) ||
    candidate.includes("\n") ||
    !/^asana-command-mcp(?:-[0-9][0-9A-Za-z.-]*)?\.tgz$/.test(path.basename(candidate))
  ) {
    continue;
  }
  const resolved = path.resolve(candidate);
  if (resolved === resolvedInstallDir || resolved.startsWith(`${resolvedInstallDir}${path.sep}`)) {
    continue;
  }
  try {
    if (fs.lstatSync(resolved).isFile()) {
      references.add(resolved);
    }
  } catch {
    // Missing old downloads do not need cleanup.
  }
}

fs.writeFileSync(outputPath, references.size === 0 ? "" : `${[...references].join("\n")}\n`);
NODE
}

codex_config_before="$work_dir/codex-before.json"
legacy_packages="$work_dir/legacy-packages"
snapshot_codex_config "$codex_config_before"
collect_package_references "$legacy_packages" "$codex_config_before"

if [ "$selection_explicit" = false ]; then
  want_claude="$has_claude"
  want_claude_desktop="$has_claude_desktop"
  want_codex="$has_codex"
  want_cursor="$has_cursor"
  want_opencode="$has_opencode"
fi

require_client() {
  has_client="$1"
  missing_message="$2"
  if [ "$has_client" = false ] && [ "$auto_select" = false ]; then
    die "$missing_message"
  fi
}

configured_clients=''

if [ "$want_claude" = true ]; then
  require_client "$has_claude" "Claude Code was selected but the claude command is not installed"
  if [ "$has_claude" = true ]; then
    claude mcp remove "$SERVER_NAME" --scope user >/dev/null 2>&1 || true
    claude mcp add --transport stdio --scope user "$SERVER_NAME" -- "$executable"
    configured_clients="${configured_clients} Claude Code"
  fi
fi

if [ "$want_codex" = true ]; then
  require_client "$has_codex" "Codex was selected but the codex command is not installed"
  if [ "$has_codex" = true ]; then
    codex mcp remove "$SERVER_NAME" >/dev/null 2>&1 || true
    codex mcp add "$SERVER_NAME" -- "$executable"
    configured_clients="${configured_clients} Codex"
  fi
fi

write_mcp_json_config() {
  config_path="$1"
  servers_key="$2"
  entry_style="$3"
  MCP_CONFIG_PATH="$config_path" \
    MCP_SERVERS_KEY="$servers_key" \
    MCP_ENTRY_STYLE="$entry_style" \
    MCP_EXECUTABLE="$executable" \
    MCP_SERVER_NAME="$SERVER_NAME" \
    node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = process.env.MCP_CONFIG_PATH;
const serversKey = process.env.MCP_SERVERS_KEY;
const entryStyle = process.env.MCP_ENTRY_STYLE;
const executable = process.env.MCP_EXECUTABLE;
const serverName = process.env.MCP_SERVER_NAME;
if (!configPath || !serversKey || !entryStyle || !executable || !serverName) {
  throw new Error("missing MCP configuration input");
}

const entriesByStyle = {
  // Cursor documents an explicit "type" field on each server entry.
  stdio: { type: "stdio", command: executable, args: [] },
  // Claude Desktop infers stdio from the presence of "command".
  plain: { command: executable, args: [] },
  // OpenCode combines the executable and its arguments into one "command" array. No "enabled"
  // field here: omitting it lets OpenCode's own default apply, and merging below (rather than
  // replacing the entry outright) preserves a user's own "enabled": false untouched.
  "opencode-local": { type: "local", command: [executable] },
};
const entry = entriesByStyle[entryStyle];
if (entry === undefined) {
  throw new Error(`unknown MCP entry style: ${entryStyle}`);
}

let config = {};
let mode = 0o600;
if (fs.existsSync(configPath)) {
  const stats = fs.statSync(configPath);
  mode = stats.mode & 0o777;
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
}
if (config === null || Array.isArray(config) || typeof config !== "object") {
  throw new Error(`${configPath} must contain a JSON object`);
}
if (
  config[serversKey] !== undefined &&
  (config[serversKey] === null ||
    Array.isArray(config[serversKey]) ||
    typeof config[serversKey] !== "object")
) {
  throw new Error(`${configPath}.${serversKey} must be a JSON object`);
}

config[serversKey] ??= {};
const existingEntry = config[serversKey][serverName];
const preservedFields =
  existingEntry !== null && typeof existingEntry === "object" && !Array.isArray(existingEntry)
    ? existingEntry
    : {};
// Merge onto the existing entry (when there is one) instead of replacing it outright, so a
// client- or user-managed field the constructed entry doesn't know about — OpenCode's
// "enabled": false, for example — survives a rerun of this installer.
config[serversKey][serverName] = { ...preservedFields, ...entry };

fs.mkdirSync(path.dirname(configPath), { recursive: true });
const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode,
});
fs.renameSync(temporaryPath, configPath);
NODE
}

if [ "$want_cursor" = true ]; then
  require_client "$has_cursor" "Cursor was selected but neither cursor nor agent is installed"
  if [ "$has_cursor" = true ]; then
    write_mcp_json_config "$HOME/.cursor/mcp.json" "mcpServers" "stdio"
    configured_clients="${configured_clients} Cursor"
  fi
fi

if [ "$want_claude_desktop" = true ]; then
  require_client "$has_claude_desktop" \
    "Claude Desktop was selected but the application is not installed"
  if [ "$has_claude_desktop" = true ]; then
    write_mcp_json_config "$claude_desktop_config" "mcpServers" "plain"
    configured_clients="${configured_clients} Claude Desktop"
  fi
fi

if [ "$want_opencode" = true ]; then
  require_client "$has_opencode" "OpenCode was selected but the opencode command is not installed"
  if [ "$has_opencode" = true ]; then
    write_mcp_json_config "$HOME/.config/opencode/opencode.json" "mcp" "opencode-local"
    configured_clients="${configured_clients} OpenCode"
  fi
fi

codex_config_after="$work_dir/codex-after.json"
current_packages="$work_dir/current-packages"
snapshot_codex_config "$codex_config_after"
collect_package_references "$current_packages" "$codex_config_after"

remove_old_package() {
  old_package="$1"
  case "$old_package_action" in
    delete) return 0 ;;
    keep) return 1 ;;
  esac
  if [ ! -t 1 ] || [ ! -r /dev/tty ]; then
    return 1
  fi
  printf 'Delete old Asana Command MCP package at %s? [y/N] ' "$old_package" >/dev/tty
  answer=''
  IFS= read -r answer </dev/tty || true
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -s "$legacy_packages" ]; then
  while IFS= read -r old_package; do
    if awk -v candidate="$old_package" '$0 == candidate { found = 1 } END { exit !found }' \
      "$current_packages"; then
      continue
    fi
    if remove_old_package "$old_package"; then
      rm -f "$old_package"
      info "Deleted old package: $old_package"
    else
      info "Kept old package: $old_package"
    fi
  done <"$legacy_packages"
fi

info ""
info "Asana Command MCP is installed at:"
info "  $executable"
if [ -n "$configured_clients" ]; then
  info "Configured:${configured_clients}"
elif [ "$has_claude" = false ] && [ "$has_claude_desktop" = false ] && [ "$has_codex" = false ] &&
  [ "$has_cursor" = false ] && [ "$has_opencode" = false ]; then
  info "No supported MCP clients were detected; the server was installed without client configuration."
else
  info "No MCP clients were configured."
fi
info ""
info "Next, sign in to Asana:"
info "  \"$executable\" auth login"
info ""
info "Run this installer again at any time to update to the latest release."
