#!/bin/sh

set -eu

SERVER_NAME="asana-command"
ARCHIVE_NAME="asana-command-mcp.tgz"
CHECKSUM_NAME="SHA256SUMS"
DEFAULT_RELEASE_BASE_URL="https://github.com/AsanaPlayground/command-mcp/releases/latest/download"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage: install.sh [--all | --claude | --codex | --cursor | --no-config]
                  [--delete-old-packages | --keep-old-packages]

Installs or updates Asana Command MCP and configures detected MCP clients.
With no flags, the installer prompts for each detected client.
EOF
}

want_claude=false
want_codex=false
want_cursor=false
selection_explicit=false
old_package_action=prompt

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all)
      want_claude=true
      want_codex=true
      want_cursor=true
      selection_explicit=true
      ;;
    --claude)
      want_claude=true
      selection_explicit=true
      ;;
    --codex)
      want_codex=true
      selection_explicit=true
      ;;
    --cursor)
      want_cursor=true
      selection_explicit=true
      ;;
    --no-config)
      want_claude=false
      want_codex=false
      want_cursor=false
      selection_explicit=true
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

info "Installing into $install_dir..."
npm install --global --prefix "$install_dir" "$archive_path"
[ -x "$executable" ] || die "installation completed without creating $executable"
mv "$archive_path" "$install_dir/$ARCHIVE_NAME"

has_claude=false
has_codex=false
has_cursor=false
command -v claude >/dev/null 2>&1 && has_claude=true
command -v codex >/dev/null 2>&1 && has_codex=true
if command -v cursor >/dev/null 2>&1 || command -v agent >/dev/null 2>&1; then
  has_cursor=true
fi

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
function readJsonEntry(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const entry = config?.mcpServers?.[serverName];
    if (entry !== undefined) {
      entries.push(entry);
    }
  } catch {
    // Invalid or absent client configuration is handled by that client's setup path.
  }
}

readJsonEntry(path.join(process.env.HOME, ".claude.json"));
readJsonEntry(path.join(process.env.HOME, ".cursor", "mcp.json"));
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

prompt_target() {
  client_name="$1"
  if [ ! -t 1 ] || [ ! -r /dev/tty ]; then
    return 0
  fi
  printf 'Configure %s? [Y/n] ' "$client_name" >/dev/tty
  answer=''
  IFS= read -r answer </dev/tty || true
  case "$answer" in
    n|N|no|NO|No) return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$selection_explicit" = false ]; then
  [ "$has_claude" = false ] || prompt_target "Claude Code" && want_claude="$has_claude"
  [ "$has_codex" = false ] || prompt_target "Codex" && want_codex="$has_codex"
  [ "$has_cursor" = false ] || prompt_target "Cursor" && want_cursor="$has_cursor"
fi

configured_clients=''

if [ "$want_claude" = true ]; then
  [ "$has_claude" = true ] || die "Claude Code was selected but the claude command is not installed"
  claude mcp remove "$SERVER_NAME" --scope user >/dev/null 2>&1 || true
  claude mcp add --transport stdio --scope user "$SERVER_NAME" -- "$executable"
  configured_clients="${configured_clients} Claude Code"
fi

if [ "$want_codex" = true ]; then
  [ "$has_codex" = true ] || die "Codex was selected but the codex command is not installed"
  codex mcp remove "$SERVER_NAME" >/dev/null 2>&1 || true
  codex mcp add "$SERVER_NAME" -- "$executable"
  configured_clients="${configured_clients} Codex"
fi

if [ "$want_cursor" = true ]; then
  [ "$has_cursor" = true ] || die "Cursor was selected but neither cursor nor agent is installed"
  cursor_config="$HOME/.cursor/mcp.json"
  MCP_CONFIG_PATH="$cursor_config" MCP_EXECUTABLE="$executable" MCP_SERVER_NAME="$SERVER_NAME" \
    node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = process.env.MCP_CONFIG_PATH;
const executable = process.env.MCP_EXECUTABLE;
const serverName = process.env.MCP_SERVER_NAME;
if (!configPath || !executable || !serverName) {
  throw new Error("missing Cursor configuration input");
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
  config.mcpServers !== undefined &&
  (config.mcpServers === null ||
    Array.isArray(config.mcpServers) ||
    typeof config.mcpServers !== "object")
) {
  throw new Error(`${configPath}.mcpServers must be a JSON object`);
}

config.mcpServers ??= {};
config.mcpServers[serverName] = {
  type: "stdio",
  command: executable,
  args: [],
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode,
});
fs.renameSync(temporaryPath, configPath);
NODE
  configured_clients="${configured_clients} Cursor"
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
elif [ "$has_claude" = false ] && [ "$has_codex" = false ] && [ "$has_cursor" = false ]; then
  info "No supported MCP client commands were detected; the server was installed without client configuration."
else
  info "No MCP clients were configured."
fi
info ""
info "Next, sign in to Asana:"
info "  \"$executable\" auth login"
info ""
info "Run this installer again at any time to update to the latest release."
