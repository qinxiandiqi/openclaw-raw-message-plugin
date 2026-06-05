#!/usr/bin/env node
/**
 * openclaw-raw-message-plugin CLI — one-command installer.
 *
 * Usage:
 *   npx openclaw-raw-message-plugin install
 *   npx openclaw-raw-message-plugin install --version 0.2.0
 *
 * Bypasses `openclaw plugins install` (which uses --ignore-scripts)
 * so that better-sqlite3's prebuild-install can download pre-built
 * native binaries.  Then registers the plugin with openclaw and
 * restarts the gateway.
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[openclaw-raw-message-plugin] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[openclaw-raw-message-plugin] ⚠ ${msg}`);
}

function error(msg: string): never {
  console.error(`[openclaw-raw-message-plugin] ✗ ${msg}`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts?: { cwd?: string }): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function runInherit(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): void {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function getOpenClawDir(): string {
  const dir = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  if (!fs.existsSync(dir)) {
    error(`OpenClaw directory not found: ${dir}`);
  }
  return dir;
}

function getExtensionsDir(): string {
  return path.join(getOpenClawDir(), "extensions");
}

function getConfigPath(): string {
  return path.join(getOpenClawDir(), "openclaw.json");
}

function readConfig(): Record<string, any> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeConfig(config: Record<string, any>): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

function getOpenClawVersion(): string | null {
  try {
    const output = run("openclaw", ["--version"]);
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    const match = lastLine.match(/(?:OpenClaw\s+)?(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getPlatformCommand(cmd: string): string {
  return process.platform === "win32" ? `${cmd}.cmd` : cmd;
}

/**
 * Detect the Node.js binary that openclaw gateway actually uses.
 * The gateway may run on a different Node version than the current shell
 * (e.g. shell via hermes v22, gateway via nvm v24).
 * We read the LaunchAgent plist or fall back to `openclaw` path resolution.
 */
function getGatewayNodePath(): string | null {
  // 1. Try reading the LaunchAgent plist (macOS)
  const plistNames = ["ai.openclaw.gateway.plist", "com.openclaw.gateway.plist"];
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  for (const name of plistNames) {
    const plistPath = path.join(launchAgentsDir, name);
    if (fs.existsSync(plistPath)) {
      const content = fs.readFileSync(plistPath, "utf-8");
      // Look for <string>/path/to/node</string> in ProgramArguments
      const lines = content.split("\n").map((l) => l.trim());
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("ProgramArguments")) {
          // Scan next ~20 lines for a node path
          for (let j = i; j < Math.min(i + 25, lines.length); j++) {
            const m = lines[j].match(/<string>(.*\/node)<\/string>/);
            if (m && !m[1].endsWith("/env/node")) return m[1];
          }
        }
      }
    }
  }

  // 2. Try service-env wrapper
  const envWrapper = path.join(os.homedir(), ".openclaw", "service-env", "ai.openclaw.gateway-env-wrapper.sh");
  if (fs.existsSync(envWrapper)) {
    const envFile = path.join(os.homedir(), ".openclaw", "service-env", "ai.openclaw.gateway.env");
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf-8");
      const m = content.match(/PATH="?([^":\n]*?)(?::"?|$)/);
      if (m) {
        const dir = m[1].trim();
        const nodePath = path.join(dir, "node");
        if (fs.existsSync(nodePath)) return nodePath;
      }
    }
  }

  // 3. Try resolving from openclaw binary location
  try {
    const openclawPath = run("which", ["openclaw"]);
    // openclaw might be a symlink — resolve it
    let realPath = openclawPath;
    try { realPath = fs.realpathSync(openclawPath); } catch {}
    // Typically: .../nvm/versions/node/vXX/bin/openclaw
    // The node binary is in the same bin/ directory
    const binDir = path.dirname(realPath);
    const nodePath = path.join(binDir, "node");
    if (fs.existsSync(nodePath)) return nodePath;
  } catch {}

  return null;
}

/**
 * Find better-sqlite3 native binary — npm may hoist it to the top-level
 * node_modules or keep it nested under the plugin package.
 */
function findNativeBinary(pluginDir: string): string | null {
  const candidates = [
    // hoisted by npm to top-level node_modules
    path.join(pluginDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    // nested inside the plugin package
    path.join(pluginDir, "node_modules", "openclaw-raw-message-plugin", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install command
// ---------------------------------------------------------------------------

function installCommand(options: { version?: string }): void {
  const PLUGIN_ID = "raw-message";
  const PACKAGE_NAME = "openclaw-raw-message-plugin";
  const EXTENSIONS_DIR = getExtensionsDir();
  const PLUGIN_DIR = path.join(EXTENSIONS_DIR, PLUGIN_ID);

  const packageSpec = options.version
    ? `${PACKAGE_NAME}@${options.version}`
    : PACKAGE_NAME;

  // 1. Check openclaw
  const version = getOpenClawVersion();
  if (!version) {
    warn("Could not detect OpenClaw version. Proceeding anyway.");
  } else {
    log(`Detected OpenClaw ${version}`);
  }

  // 2. Clean existing plugin directory
  //    Remove old install artifacts so npm can install fresh.
  //    The plugin database at ~/.openclaw/raw-message/ is NOT touched.
  if (fs.existsSync(PLUGIN_DIR)) {
    log(`Removing previous installation at ${PLUGIN_DIR}`);
    fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  log(`Installing to ${PLUGIN_DIR}`);

  // 3. npm install the plugin package directly into the extension directory.
  //    This puts openclaw.plugin.json, dist/, etc. at the root level
  //    so openclaw can discover the plugin correctly.
  //    We do NOT use --ignore-scripts so better-sqlite3's prebuild-install runs.
  const npmCmd = getPlatformCommand("npm");

  log(`Installing ${packageSpec} (with native module prebuilds)...`);
  try {
    runInherit(npmCmd, [
      "install",
      packageSpec,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ], { cwd: PLUGIN_DIR });
  } catch {
    error(
      "npm install failed. Ensure you have network access and (if prebuild is unavailable) " +
      "a C++ toolchain for node-gyp.\n" +
      "  macOS: xcode-select --install\n" +
      "  Linux: sudo apt install build-essential python3"
    );
  }

  // 4. Verify installation — openclaw expects openclaw.plugin.json at the root
  const pluginJson = path.join(PLUGIN_DIR, "openclaw.plugin.json");
  if (!fs.existsSync(pluginJson)) {
    // npm install put files in node_modules/<package>/ — copy them up
    const nestedPkgDir = path.join(PLUGIN_DIR, "node_modules", PACKAGE_NAME);
    if (!fs.existsSync(nestedPkgDir)) {
      error(`Plugin package not found. Installation may have failed.`);
    }
    log("Copying plugin files to extension root (npm did not install them at root level)...");
    const entries = fs.readdirSync(nestedPkgDir);
    for (const entry of entries) {
      // skip node_modules to avoid recursive copy
      if (entry === "node_modules") continue;
      const src = path.join(nestedPkgDir, entry);
      const dest = path.join(PLUGIN_DIR, entry);
      fs.cpSync(src, dest, { recursive: true, force: true });
    }
  }

  // Re-verify after potential copy
  if (!fs.existsSync(pluginJson)) {
    error(`openclaw.plugin.json not found at ${PLUGIN_DIR}. Installation failed.`);
  }
  log("✓ Plugin files in place");

  // 5. Rebuild better-sqlite3 with the gateway's Node.js version.
  //    The current shell may use a different Node version (e.g. hermes v22)
  //    than the openclaw gateway (e.g. nvm v24). Native modules must match
  //    the Node that actually loads them.
  const gatewayNode = getGatewayNodePath();
  const shellNodeVersion = process.versions.node;

  if (gatewayNode && gatewayNode !== process.execPath) {
    log(`Shell Node: v${shellNodeVersion} (${process.execPath})`);
    try {
      const gwVersion = run(gatewayNode, ["--version"]).trim();
      log(`Gateway Node: ${gwVersion} (${gatewayNode})`);
    } catch {}
    log("Rebuilding better-sqlite3 for gateway's Node version...");
    try {
      // Use gateway's node to run npm rebuild
      const gatewayBinDir = path.dirname(gatewayNode);
      const gatewayNpm = path.join(gatewayBinDir, getPlatformCommand("npm"));
      if (fs.existsSync(gatewayNpm)) {
        runInherit(gatewayNpm, ["rebuild", "better-sqlite3"], { cwd: PLUGIN_DIR });
        log("✓ better-sqlite3 rebuilt for gateway's Node version");
      } else {
        // No npm alongside gateway's node — use npx with the correct node
        runInherit(getPlatformCommand("npx"), [
          "--node-arg=--experimental-modules",
          "node-gyp",
          "rebuild",
          "--directory=" + path.join(PLUGIN_DIR, "node_modules", "better-sqlite3"),
        ], { cwd: PLUGIN_DIR, env: { ...process.env, PATH: gatewayBinDir + ":" + process.env.PATH } });
        log("✓ better-sqlite3 rebuilt for gateway's Node version");
      }
    } catch {
      warn(
        "Could not rebuild better-sqlite3 for gateway's Node version.\n" +
        "  The plugin may not work. Try manually:\n" +
        "  cd " + PLUGIN_DIR + " && " + gatewayNode + " " +
        path.join(path.dirname(gatewayNode), "npm") + " rebuild better-sqlite3"
      );
    }
  } else {
    // Same Node version or couldn't detect gateway node — just verify binary exists
    const nativeBinary = findNativeBinary(PLUGIN_DIR);
    if (nativeBinary) {
      log(`✓ better-sqlite3 native module ready`);
    } else {
      warn(
        "better-sqlite3 native binary not found. Attempting rebuild..."
      );
      try {
        runInherit(npmCmd, ["rebuild", "better-sqlite3"], { cwd: PLUGIN_DIR });
        const rebuilt = findNativeBinary(PLUGIN_DIR);
        if (rebuilt) {
          log(`✓ better-sqlite3 rebuilt successfully`);
        } else {
          warn(
            "Rebuild did not produce native binary. The plugin may not work.\n" +
            "  Try: cd " + PLUGIN_DIR + " && npm rebuild better-sqlite3"
          );
        }
      } catch {
        warn(
          "better-sqlite3 rebuild failed. The plugin may not work.\n" +
          "  macOS: xcode-select --install\n" +
          "  Linux: sudo apt install build-essential python3"
        );
      }
    }
  }

  // 6. Update openclaw.json
  const config = readConfig();

  if (!config.plugins) config.plugins = {};
  if (!config.plugins.allow) config.plugins.allow = [];
  if (!config.plugins.allow.includes(PLUGIN_ID)) {
    config.plugins.allow.push(PLUGIN_ID);
  }

  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries[PLUGIN_ID] = { enabled: true };

  writeConfig(config);
  log("✓ Updated openclaw.json");

  // 7. Restart gateway
  log("Restarting OpenClaw gateway...");
  try {
    runInherit(getPlatformCommand("openclaw"), ["gateway", "restart"]);
  } catch {
    warn("Could not restart gateway automatically. Please restart manually: openclaw gateway restart");
    return;
  }

  // 8. Health check
  log("Waiting for gateway to start...");
  let healthy = false;
  for (let i = 0; i < 10; i++) {
    try {
      const output = run(getPlatformCommand("openclaw"), ["health", "--json"]);
      const match = output.match(/\{[\s\S]*\}/);
      if (match) {
        const health = JSON.parse(match[0]);
        if (health?.ok === true) {
          healthy = true;
          break;
        }
      }
    } catch {
      // not ready yet
    }
    // Wait 2s between retries
    execSync("sleep 2", { stdio: "ignore" });
  }

  if (healthy) {
    log("✓ OpenClaw gateway is healthy. Plugin installed successfully!");
  } else {
    warn("Gateway health check timed out. The plugin may need a moment to initialize.");
  }
}

// ---------------------------------------------------------------------------
// Uninstall command
// ---------------------------------------------------------------------------

function uninstallCommand(options: { keepData?: boolean }): void {
  const PLUGIN_ID = "raw-message";
  const EXTENSIONS_DIR = getExtensionsDir();
  const PLUGIN_DIR = path.join(EXTENSIONS_DIR, PLUGIN_ID);
  const DATA_DIR = path.join(getOpenClawDir(), PLUGIN_ID);

  // 1. Remove extension directory
  if (fs.existsSync(PLUGIN_DIR)) {
    log(`Removing plugin from ${PLUGIN_DIR}`);
    fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
    log("✓ Plugin files removed");
  } else {
    warn("Plugin directory not found. Already uninstalled?");
  }

  // 2. Optionally remove plugin data (database)
  if (!options.keepData && fs.existsSync(DATA_DIR)) {
    log(`Removing plugin data from ${DATA_DIR}`);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    log("✓ Plugin data removed");
  } else if (options.keepData && fs.existsSync(DATA_DIR)) {
    log(`Keeping plugin data at ${DATA_DIR}`);
  }

  // 3. Update openclaw.json — remove plugin entries
  const config = readConfig();
  let configChanged = false;

  if (config.plugins?.allow) {
    const idx = config.plugins.allow.indexOf(PLUGIN_ID);
    if (idx !== -1) {
      config.plugins.allow.splice(idx, 1);
      configChanged = true;
    }
  }

  if (config.plugins?.entries?.[PLUGIN_ID]) {
    delete config.plugins.entries[PLUGIN_ID];
    configChanged = true;
  }

  if (configChanged) {
    writeConfig(config);
    log("✓ Removed plugin from openclaw.json");
  } else {
    log("Plugin not found in openclaw.json (already removed)");
  }

  // 4. Restart gateway
  log("Restarting OpenClaw gateway...");
  try {
    runInherit(getPlatformCommand("openclaw"), ["gateway", "restart"]);
  } catch {
    warn("Could not restart gateway automatically. Please restart manually: openclaw gateway restart");
    return;
  }

  log("✓ Plugin uninstalled successfully");
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(`
openclaw-raw-message-plugin — one-command installer

Usage:
  npx openclaw-raw-message-plugin <command> [options]

Commands:
  install      Install the plugin into OpenClaw
  uninstall    Uninstall the plugin from OpenClaw

Options:
  --version <ver>    Install a specific version (default: latest)
  --keep-data       Uninstall only; keep plugin database
  -h, --help         Show this help
`);
  process.exit(0);
}

if (command === "install") {
  const opts: { version?: string } = {};
  const vIdx = args.indexOf("--version");
  if (vIdx !== -1 && args[vIdx + 1]) {
    opts.version = args[vIdx + 1];
  }
  installCommand(opts);
} else if (command === "uninstall") {
  const opts: { keepData?: boolean } = {};
  opts.keepData = args.includes("--keep-data");
  uninstallCommand(opts);
} else {
  error(`Unknown command: ${command}. Run with --help for usage.`);
}
