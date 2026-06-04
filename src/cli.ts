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

  // 2. Create plugin directory
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  log(`Installing to ${PLUGIN_DIR}`);

  // 3. npm init + npm install (WITHOUT --ignore-scripts)
  //    This lets better-sqlite3's prebuild-install download pre-built binaries.
  const npmCmd = getPlatformCommand("npm");

  run(npmCmd, ["init", "-y"], { cwd: PLUGIN_DIR });

  log(`Installing ${packageSpec} (with native module prebuilds)...`);
  try {
    runInherit(npmCmd, [
      "install",
      packageSpec,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--save",
    ], { cwd: PLUGIN_DIR });
  } catch {
    error(
      "npm install failed. Ensure you have network access and (if prebuild is unavailable) " +
      "a C++ toolchain for node-gyp.\n" +
      "  macOS: xcode-select --install\n" +
      "  Linux: sudo apt install build-essential python3"
    );
  }

  // 4. Verify better-sqlite3 native module
  const nodeModulesDir = path.join(PLUGIN_DIR, "node_modules", PACKAGE_NAME);
  const dbJs = path.join(nodeModulesDir, "dist", "db.js");
  if (!fs.existsSync(dbJs)) {
    error(`Plugin not found at ${nodeModulesDir}. Installation may have failed.`);
  }

  // Check native binary
  const betterSqliteDir = path.join(nodeModulesDir, "node_modules", "better-sqlite3");
  const buildDir = path.join(betterSqliteDir, "build", "Release");
  const hasNative = fs.existsSync(path.join(buildDir, "better_sqlite3.node"));
  if (hasNative) {
    log("✓ better-sqlite3 native module ready");
  } else {
    warn(
      "better-sqlite3 native binary not found. The plugin may not work.\n" +
      "  Try: cd " + PLUGIN_DIR + " && npm rebuild better-sqlite3"
    );
  }

  // 5. Update openclaw.json
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

  // 6. Restart gateway
  log("Restarting OpenClaw gateway...");
  try {
    runInherit(getPlatformCommand("openclaw"), ["gateway", "restart"]);
  } catch {
    warn("Could not restart gateway automatically. Please restart manually: openclaw gateway restart");
    return;
  }

  // 7. Health check
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
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(`
openclaw-raw-message-plugin — one-command installer

Usage:
  npx openclaw-raw-message-plugin install [options]

Commands:
  install    Install the plugin into OpenClaw

Options:
  --version <ver>    Install a specific version (default: latest)
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
} else {
  error(`Unknown command: ${command}. Run with --help for usage.`);
}
