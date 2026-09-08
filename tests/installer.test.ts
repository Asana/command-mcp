import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const INSTALLER_PATH = resolve(import.meta.dirname, "../install.sh");
const temporaryDirectories: string[] = [];

type Client = "claude" | "codex" | "cursor" | "agent" | "opencode";
type Downloader = "curl" | "wget";

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function commandPath(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Required test command is unavailable: ${command}`);
  }
  return result.stdout.trim();
}

function optionalCommandPath(command: string): string | null {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function linkCommand(binDirectory: string, command: string, source = commandPath(command)): void {
  symlinkSync(source, join(binDirectory, command));
}

function createArchive(assetDirectory: string, version = "1.0.0"): void {
  mkdirSync(assetDirectory, { recursive: true });
  const archivePath = join(assetDirectory, "asana-command-mcp.tgz");
  const stagingRoot = temporaryDirectory("asana-command-mcp-archive");
  const packageDirectory = join(stagingRoot, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@asana/command-mcp", version })}\n`,
  );
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", stagingRoot, "package"], {
    encoding: "utf8",
  });
  if (tar.status !== 0) {
    throw new Error(`Failed to build a test archive: ${tar.stderr}`);
  }
  const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  writeFileSync(join(assetDirectory, "SHA256SUMS"), `${digest}  asana-command-mcp.tgz\n`);
}

function archiveVersion(archivePath: string): string {
  const tar = spawnSync("tar", ["-xzOf", archivePath, "package/package.json"], {
    encoding: "utf8",
  });
  if (tar.status !== 0) {
    throw new Error(`Failed to read the test archive version: ${tar.stderr}`);
  }
  return JSON.parse(tar.stdout).version;
}

function createFakePath(options: {
  root: string;
  downloader?: Downloader;
  clients?: Client[];
  includeNpm?: boolean;
}): string {
  const binDirectory = join(options.root, "fake bin");
  rmSync(binDirectory, { recursive: true, force: true });
  mkdirSync(binDirectory, { recursive: true });

  for (const command of [
    "awk",
    "cat",
    "chmod",
    "gzip",
    "mkdir",
    "mktemp",
    "mv",
    "rm",
    "tar",
    "uname",
  ]) {
    linkCommand(binDirectory, command);
  }
  linkCommand(binDirectory, "node", process.execPath);
  const sha256sum = optionalCommandPath("sha256sum");
  if (sha256sum !== null) {
    linkCommand(binDirectory, "sha256sum", sha256sum);
  } else {
    linkCommand(binDirectory, "shasum");
  }

  if (options.includeNpm !== false) {
    writeExecutable(
      join(binDirectory, "npm"),
      `#!/bin/sh
set -eu
prefix=''
archive=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    shift
    prefix="$1"
  else
    archive="$1"
  fi
  shift
done
[ -n "$prefix" ]
mkdir -p "$prefix/bin"
cat >"$prefix/bin/asana-command-mcp" <<'EOF'
#!/bin/sh
if [ "\${1:-}" = "doctor" ]; then
  printf '%s\\n' '{"error":{"code":"invalid_configuration","message":"Asana login is missing; run asana-command-mcp auth login"}}'
  exit 1
fi
EOF
chmod +x "$prefix/bin/asana-command-mcp"
mkdir -p "$prefix/lib/node_modules/@asana/command-mcp"
tar -xzOf "$archive" package/package.json >"$prefix/lib/node_modules/@asana/command-mcp/package.json"
printf '%s\\n' "$prefix" >>"$TEST_LOG/npm"
`,
    );
  }

  const downloader = options.downloader ?? "curl";
  const downloaderBody =
    downloader === "curl"
      ? `#!/bin/sh
set -eu
url=''
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output="$1" ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
cp "$ASSET_DIR/\${url##*/}" "$output"
`
      : `#!/bin/sh
set -eu
[ "$1" = "-qO" ]
output="$2"
url="$3"
cp "$ASSET_DIR/\${url##*/}" "$output"
`;
  linkCommand(binDirectory, "cp");
  writeExecutable(join(binDirectory, downloader), downloaderBody);

  for (const client of options.clients ?? []) {
    writeExecutable(
      join(binDirectory, client),
      `#!/bin/sh
printf '%s' '${client}' >>"$TEST_LOG/clients"
for argument in "$@"; do
  printf ' <%s>' "$argument" >>"$TEST_LOG/clients"
done
printf '\\n' >>"$TEST_LOG/clients"
if [ '${client}' = 'claude' ] && [ "\${1:-}" = 'mcp' ] && [ "\${2:-}" = 'remove' ]; then
  rm -f "$HOME/.claude.json"
fi
if [ '${client}' = 'codex' ] && [ "\${1:-}" = 'mcp' ]; then
  case "\${2:-}" in
    get)
      [ -f "$TEST_LOG/codex-config" ] || exit 1
      cat "$TEST_LOG/codex-config"
      ;;
    remove)
      rm -f "$TEST_LOG/codex-config"
      ;;
    add)
      last_argument=''
      for argument in "$@"; do
        last_argument="$argument"
      done
      printf '{"transport":{"type":"stdio","command":"%s","args":[]}}\\n' "$last_argument" \
        >"$TEST_LOG/codex-config"
      ;;
  esac
fi
`,
    );
  }

  return binDirectory;
}

function runInstaller(options: {
  root: string;
  args?: string[];
  downloader?: Downloader;
  clients?: Client[];
  includeNpm?: boolean;
  claudeDesktopInstalled?: boolean;
}) {
  const home = join(options.root, "home with spaces");
  const assets = join(options.root, "assets");
  const log = join(options.root, "log");
  mkdirSync(home, { recursive: true });
  mkdirSync(log, { recursive: true });
  if (!existsSync(join(assets, "asana-command-mcp.tgz"))) {
    createArchive(assets);
  }
  const path = createFakePath({
    root: options.root,
    ...(options.downloader === undefined ? {} : { downloader: options.downloader }),
    ...(options.clients === undefined ? {} : { clients: options.clients }),
    ...(options.includeNpm === undefined ? {} : { includeNpm: options.includeNpm }),
  });

  // Claude Desktop is detected by an app-bundle directory, not a PATH-resolvable command, and
  // must never fall back to the real /Applications/Claude.app on the machine running these tests.
  const claudeDesktopAppPath = join(options.root, "fake-claude-desktop-app");
  if (options.claudeDesktopInstalled === true) {
    mkdirSync(claudeDesktopAppPath, { recursive: true });
  }

  const result = spawnSync("/bin/sh", [INSTALLER_PATH, ...(options.args ?? [])], {
    cwd: options.root,
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: path,
      ASSET_DIR: assets,
      TEST_LOG: log,
      ASANA_COMMAND_MCP_RELEASE_BASE_URL: "https://release.invalid",
      ASANA_COMMAND_MCP_CLAUDE_DESKTOP_APP_PATH: claudeDesktopAppPath,
    },
  });
  return { assets, home, log, result };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("install.sh", () => {
  it("installs, updates, and configures every detected client without damaging Cursor config", () => {
    const root = temporaryDirectory("command-installer-all");
    const home = join(root, "home with spaces");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor/mcp.json"),
      `${JSON.stringify({ theme: "dark", mcpServers: { existing: { command: "existing" } } })}\n`,
    );

    const first = runInstaller({
      root,
      args: ["--all"],
      clients: ["claude", "codex", "cursor"],
    });

    expect(first.result.status, first.result.stderr).toBe(0);
    const executable = join(home, ".asana/mcp/bin/asana-command-mcp");
    expect(existsSync(executable)).toBe(true);
    expect(archiveVersion(join(home, ".asana/mcp/asana-command-mcp.tgz"))).toBe("1.0.0");
    expect(first.result.stdout).toContain("Latest release version: 1.0.0");
    expect(first.result.stdout).not.toContain("Installed version:");
    const cursorConfig = JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8"));
    expect(cursorConfig).toEqual({
      theme: "dark",
      mcpServers: {
        existing: { command: "existing" },
        "asana-command": {
          type: "stdio",
          command: executable,
          args: [],
        },
      },
    });

    createArchive(first.assets, "2.0.0");
    const second = runInstaller({
      root,
      args: ["--all"],
      clients: ["claude", "codex", "cursor"],
    });

    expect(second.result.status, second.result.stderr).toBe(0);
    expect(archiveVersion(join(home, ".asana/mcp/asana-command-mcp.tgz"))).toBe("2.0.0");
    expect(second.result.stdout).toContain("Installed version: 1.0.0");
    expect(second.result.stdout).toContain("Latest release version: 2.0.0");
    expect(second.result.stdout).not.toContain("Already up to date");
    expect(readFileSync(join(first.log, "npm"), "utf8").trim().split("\n")).toHaveLength(2);
    const clientCalls = readFileSync(join(first.log, "clients"), "utf8");
    expect(clientCalls).toContain(
      `claude <mcp> <add> <--transport> <stdio> <--scope> <user> <asana-command> <--> <${executable}>`,
    );
    expect(clientCalls).toContain(`codex <mcp> <add> <asana-command> <--> <${executable}>`);

    const third = runInstaller({
      root,
      args: ["--all"],
      clients: ["claude", "codex", "cursor"],
    });

    expect(third.result.status, third.result.stderr).toBe(0);
    expect(third.result.stdout).toContain("Installed version: 2.0.0");
    expect(third.result.stdout).toContain("Already up to date; skipping reinstall.");
    expect(readFileSync(join(first.log, "npm"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("uses wget and can install without configuring clients", () => {
    const root = temporaryDirectory("command-installer-wget");
    const { home, result } = runInstaller({
      root,
      args: ["--no-config"],
      downloader: "wget",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(home, ".asana/mcp/bin/asana-command-mcp"))).toBe(true);
    expect(result.stdout).toContain("No supported MCP clients were detected");
  });

  it("configures every detected client by default and skips undetected ones without prompting", () => {
    const root = temporaryDirectory("command-installer-defaults");
    const { home, log, result } = runInstaller({
      root,
      clients: ["claude", "codex", "agent"],
      claudeDesktopInstalled: true,
    });

    expect(result.status, result.stderr).toBe(0);
    const clientCalls = readFileSync(join(log, "clients"), "utf8");
    expect(clientCalls).toContain("claude <mcp> <add>");
    expect(clientCalls).toContain("codex <mcp> <add>");
    expect(result.stdout).toContain("Configured: Claude Code Codex Cursor Claude Desktop");
    // opencode was never in the fake PATH, so it must be skipped silently, not fail the install.
    expect(result.stdout).not.toContain("OpenCode");
    const claudeDesktopConfig = JSON.parse(
      readFileSync(
        join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
        "utf8",
      ),
    );
    expect(claudeDesktopConfig.mcpServers["asana-command"]).toEqual({
      command: join(home, ".asana/mcp/bin/asana-command-mcp"),
      args: [],
    });
  });

  it("configures OpenCode when detected by default", () => {
    const root = temporaryDirectory("command-installer-opencode");
    const { home, result } = runInstaller({
      root,
      clients: ["opencode"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Configured: OpenCode");
    const opencodeConfig = JSON.parse(
      readFileSync(join(home, ".config/opencode/opencode.json"), "utf8"),
    );
    expect(opencodeConfig.mcp["asana-command"]).toEqual({
      type: "local",
      command: [join(home, ".asana/mcp/bin/asana-command-mcp")],
    });
  });

  it("preserves a user-disabled OpenCode entry's enabled: false across a rerun", () => {
    const root = temporaryDirectory("command-installer-opencode-disabled");
    const home = join(root, "home with spaces");
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        mcp: {
          "asana-command": {
            type: "local",
            command: ["/old/path/asana-command-mcp"],
            enabled: false,
          },
        },
      }),
    );

    const { result } = runInstaller({ root, args: ["--opencode"], clients: ["opencode"] });

    expect(result.status, result.stderr).toBe(0);
    const opencodeConfig = JSON.parse(
      readFileSync(join(home, ".config/opencode/opencode.json"), "utf8"),
    );
    expect(opencodeConfig.mcp["asana-command"]).toEqual({
      type: "local",
      command: [join(home, ".asana/mcp/bin/asana-command-mcp")],
      enabled: false,
    });
  });

  it("rejects an explicitly selected Claude Desktop or OpenCode that is not installed", () => {
    const root = temporaryDirectory("command-installer-missing-desktop-opencode");

    const claudeDesktopResult = runInstaller({ root, args: ["--claude-desktop"] });
    expect(claudeDesktopResult.result.status).toBe(1);
    expect(claudeDesktopResult.result.stderr).toContain("Claude Desktop was selected");

    const opencodeResult = runInstaller({ root, args: ["--opencode"] });
    expect(opencodeResult.result.status).toBe(1);
    expect(opencodeResult.result.stderr).toContain("OpenCode was selected");
  });

  it("deletes unreferenced manual packages outside the scripted install path", () => {
    const root = temporaryDirectory("command-installer-cleanup");
    const home = join(root, "home with spaces");
    const log = join(root, "log");
    const downloads = join(root, "manual downloads");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(log, { recursive: true });
    mkdirSync(downloads, { recursive: true });
    const claudePackage = join(downloads, "asana-command-mcp-0.1.0.tgz");
    const codexPackage = join(downloads, "asana-command-mcp-0.1.1.tgz");
    const cursorPackage = join(downloads, "asana-command-mcp-0.1.2.tgz");
    const claudeDesktopPackage = join(downloads, "asana-command-mcp-0.1.3.tgz");
    const opencodePackage = join(downloads, "asana-command-mcp-0.1.4.tgz");
    for (const packagePath of [
      claudePackage,
      codexPackage,
      cursorPackage,
      claudeDesktopPackage,
      opencodePackage,
    ]) {
      writeFileSync(packagePath, "old release");
    }
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "asana-command": {
            command: "npx",
            args: ["--yes", "--package", claudePackage, "asana-command-mcp"],
          },
        },
      }),
    );
    writeFileSync(
      join(log, "codex-config"),
      JSON.stringify({
        transport: {
          type: "stdio",
          command: "npx",
          args: ["--yes", "--package", codexPackage, "asana-command-mcp"],
        },
      }),
    );
    writeFileSync(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          "asana-command": {
            command: "npx",
            args: ["--yes", "--package", cursorPackage, "asana-command-mcp"],
          },
        },
      }),
    );
    mkdirSync(join(home, "Library/Application Support/Claude"), { recursive: true });
    writeFileSync(
      join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
      JSON.stringify({
        mcpServers: {
          "asana-command": {
            command: "npx",
            args: ["--yes", "--package", claudeDesktopPackage, "asana-command-mcp"],
          },
        },
      }),
    );
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        mcp: {
          "asana-command": {
            type: "local",
            command: ["npx", "--yes", "--package", opencodePackage, "asana-command-mcp"],
          },
        },
      }),
    );

    const { result } = runInstaller({
      root,
      args: ["--all", "--delete-old-packages"],
      clients: ["claude", "codex", "cursor", "opencode"],
      claudeDesktopInstalled: true,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(claudePackage)).toBe(false);
    expect(existsSync(codexPackage)).toBe(false);
    expect(existsSync(cursorPackage)).toBe(false);
    expect(existsSync(claudeDesktopPackage)).toBe(false);
    expect(existsSync(opencodePackage)).toBe(false);
    expect(result.stdout.match(/Deleted old package:/g)).toHaveLength(5);
  });

  it("keeps an old package while an unselected client still references it", () => {
    const root = temporaryDirectory("command-installer-shared-package");
    const home = join(root, "home with spaces");
    const oldPackage = join(root, "asana-command-mcp-0.1.0.tgz");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(oldPackage, "old release");
    const oldEntry = {
      command: "npx",
      args: ["--yes", "--package", oldPackage, "asana-command-mcp"],
    };
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { "asana-command": oldEntry } }),
    );
    writeFileSync(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { "asana-command": oldEntry } }),
    );

    const { result } = runInstaller({
      root,
      args: ["--claude", "--delete-old-packages"],
      clients: ["claude", "cursor"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(oldPackage)).toBe(true);
    expect(result.stdout).not.toContain("Deleted old package:");
  });

  it("keeps old packages by default without a terminal and excludes the scripted archive", () => {
    const root = temporaryDirectory("command-installer-keep-package");
    const home = join(root, "home with spaces");
    const oldPackage = join(root, "asana-command-mcp-0.1.0.tgz");
    mkdirSync(home, { recursive: true });
    writeFileSync(oldPackage, "old release");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "asana-command": {
            command: "npx",
            args: ["--package", oldPackage, "asana-command-mcp"],
          },
        },
      }),
    );

    const { result } = runInstaller({
      root,
      args: ["--claude"],
      clients: ["claude"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(oldPackage)).toBe(true);
    expect(result.stdout).toContain(`Kept old package: ${oldPackage}`);
    expect(archiveVersion(join(home, ".asana/mcp/asana-command-mcp.tgz"))).toBe("1.0.0");
  });

  it("rejects an archive whose checksum does not match", () => {
    const root = temporaryDirectory("command-installer-checksum");
    const assets = join(root, "assets");
    createArchive(assets);
    writeFileSync(join(assets, "asana-command-mcp.tgz"), "tampered");

    const { home, result } = runInstaller({ root, args: ["--no-config"] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum verification failed");
    expect(existsSync(join(home, ".asana/mcp/bin/asana-command-mcp"))).toBe(false);
  });

  it("fails before downloading when npm is unavailable", () => {
    const root = temporaryDirectory("command-installer-no-npm");
    const { result } = runInstaller({
      root,
      args: ["--no-config"],
      includeNpm: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm is required");
  });

  it("rejects an explicitly selected client that is not installed", () => {
    const root = temporaryDirectory("command-installer-missing-client");
    const { result } = runInstaller({ root, args: ["--claude"] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude Code was selected");
  });
});
