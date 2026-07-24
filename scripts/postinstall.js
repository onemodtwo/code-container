#!/usr/bin/env node

/**
 * postinstall.js — Install-time seeding for code-container
 *
 * Reads install.json, auto-detects runtime, discovers env paths,
 * writes config.json, and overwrites managed files.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const APPDATA_DIR = path.join(os.homedir(), ".code-container");
const PROJECTS_DIR = path.join(APPDATA_DIR, "projects");
const CONFIGS_DIR = path.join(APPDATA_DIR, "configs");
const DOCKERFILE_PATH = path.join(APPDATA_DIR, "Dockerfile");
const CONTAINER_BASHRC_PATH = path.join(APPDATA_DIR, "container.bashrc");
const HOST_CONFIG_PATH = path.join(APPDATA_DIR, "config.json");
const INSTALL_CONFIG_PATH = path.join(__dirname, "..", "install.json");

const PACKAGED_DOCKERFILE = path.join(__dirname, "..", "Dockerfile");
const PACKAGED_BASHRC = path.join(__dirname, "..", "container.bashrc");

// Load install.json — org-wide defaults seeded into config.json at install time.
const installConfig = fs.existsSync(INSTALL_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(INSTALL_CONFIG_PATH, "utf-8"))
  : {};

const BASE_IMAGE          = installConfig.base_image          || "ubuntu:24.04";
const TIMEZONE            = installConfig.timezone            || "UTC";
const RUNTIME_PREFERENCE  = installConfig.container_runtime   || "auto";
const DATA_BRANCHES       = installConfig.data_branches       || [];
const NETWORK             = installConfig.network             || "bridge";
const KEEP_ALIVE          = installConfig.keep_alive !== undefined ? installConfig.keep_alive : false;
const MOUNT_HOME_CHILDREN = installConfig.mount_home_children !== undefined ? installConfig.mount_home_children : true;
const AUTH_MODE           = installConfig.auth_mode           || "shared";
const HISTORY_MODE        = installConfig.history_mode        || "shared";
const PENV_PATTERN        = installConfig.penv_pattern        || "";
const RENV_PATTERN        = installConfig.renv_pattern        || "";
const ENV_SEARCH_TIMEOUT_MS = (installConfig.env_search_timeout_s || 10) * 1000;
const PROJECT_SYMLINK_MOUNTS = installConfig.project_symlink_mounts || "read";
const PROJECT_SYMLINK_DEPTH  = installConfig.project_symlink_depth !== undefined ? installConfig.project_symlink_depth : 3;
const FORWARD_SSH_AGENT      = installConfig.forward_ssh_agent !== undefined ? installConfig.forward_ssh_agent : false;
const TOOL_PERMISSIONS   = installConfig.tool_permissions   || { allow: ["*"], deny: [] };

function detectRuntime(preference) {
  if (preference === "podman" || preference === "docker") return preference;
  const podman = spawnSync("podman", ["--version"], { stdio: "pipe" });
  if (podman.status === 0) return "podman";
  const docker = spawnSync("docker", ["--version"], { stdio: "pipe" });
  if (docker.status === 0) return "docker";
  throw new Error(
    "[code-container] No container runtime found. Install podman or docker and try again.",
  );
}

const CONTAINER_RUNTIME = detectRuntime(RUNTIME_PREFERENCE);
console.log(`[code-container] Container runtime: ${CONTAINER_RUNTIME}`);

// Ensure directories exist
if (!fs.existsSync(APPDATA_DIR)) {
  fs.mkdirSync(APPDATA_DIR, { recursive: true, mode: 0o700 });
}
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true, mode: 0o700 });
}
if (!fs.existsSync(CONFIGS_DIR)) {
  fs.mkdirSync(CONFIGS_DIR, { recursive: true, mode: 0o700 });
}

// Always overwrite managed assets so reinstalls pick up package updates
function copyManaged(src, dest, label) {
  if (fs.existsSync(src)) {
    try {
      fs.copyFileSync(src, dest);
      console.log(`[code-container] Updated ${label}`);
    } catch (err) {
      console.log(`[code-container] Warning: could not update ${label}: ${err.message}`);
    }
  }
}

copyManaged(PACKAGED_DOCKERFILE, DOCKERFILE_PATH, "Dockerfile");
copyManaged(PACKAGED_BASHRC, CONTAINER_BASHRC_PATH, "container.bashrc");

// Discover SSH known_hosts path
function findKnownHostsPath() {
  const userKnownHosts = path.join(os.homedir(), ".ssh", "known_hosts");
  if (fs.existsSync(userKnownHosts)) return userKnownHosts;

  if (fs.existsSync("/etc/ssh/ssh_known_hosts")) return "/etc/ssh/ssh_known_hosts";

  function extractFromSshConfig(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const match = content.match(/^\s*GlobalKnownHostsFile\s+(.+)$/im);
      if (!match) return "";
      const candidates = match[1].trim().split(/\s+/).map(p => p.replace(/^["']|["']$/g, ""));
      for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
      }
    } catch { /* skip unreadable files */ }
    return "";
  }

  const found = extractFromSshConfig("/etc/ssh/ssh_config");
  if (found) return found;

  const configDir = "/etc/ssh/ssh_config.d";
  if (fs.existsSync(configDir)) {
    let files;
    try { files = fs.readdirSync(configDir); } catch { files = []; }
    for (const file of files) {
      const result = extractFromSshConfig(path.join(configDir, file));
      if (result) return result;
    }
  }

  return "";
}

// Discover Python and R environment paths
function findEnvPath(pattern, label) {
  if (!pattern) return "";
  const searchRoots = ["/data", "/data2", os.homedir()].filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });

  const result = spawnSync("find", [
    ...searchRoots,
    "-maxdepth", "8",
    "-path", pattern,
    "-print", "-quit",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: ENV_SEARCH_TIMEOUT_MS });

  if (result.signal) {
    console.log(
      `[code-container] Search for ${label} environment timed out. `
      + `If this path is required, set it manually in ~/.code-container/config.json.`,
    );
    return "";
  }

  const found = (result.stdout || "").trim();
  return found ? found.replace("/bin/activate", "") : "";
}

const isFirstInstall = !fs.existsSync(HOST_CONFIG_PATH);
const penvPath = isFirstInstall ? findEnvPath(PENV_PATTERN, "Python") : "";
const renvPath = isFirstInstall ? findEnvPath(RENV_PATTERN, "R") : "";
const knownHostsPath = isFirstInstall ? findKnownHostsPath() : "";

const defaultConfig = {
  base_image:            BASE_IMAGE,
  timezone:              TIMEZONE,
  container_runtime:     CONTAINER_RUNTIME,
  data_branches:         DATA_BRANCHES,
  network:               NETWORK,
  keep_alive:            KEEP_ALIVE,
  mount_home_children:   MOUNT_HOME_CHILDREN,
  auth_mode:             AUTH_MODE,
  history_mode:          HISTORY_MODE,
  penv_path:             penvPath,
  renv_path:             renvPath,
  extra_readonly:        [],
  extra_readwrite:       [],
  extra_ld_library_path: [],
  project_symlink_mounts: PROJECT_SYMLINK_MOUNTS,
  project_symlink_depth:  PROJECT_SYMLINK_DEPTH,
  forward_ssh_agent:      FORWARD_SSH_AGENT,
  ssh_known_hosts_path:   knownHostsPath,
  tool_permissions:       TOOL_PERMISSIONS,
};

if (isFirstInstall) {
  if (penvPath) console.log(`[code-container] Found Python environment: ${penvPath}`);
  if (renvPath) console.log(`[code-container] Found R environment: ${renvPath}`);
  if (!penvPath && !renvPath && (PENV_PATTERN || RENV_PATTERN)) {
    console.log("[code-container] No Python/R environments found. Set penv_path and renv_path in ~/.code-container/config.json if needed.");
  }
  if (knownHostsPath) console.log(`[code-container] Found SSH known_hosts: ${knownHostsPath}`);
  else console.log("[code-container] SSH known_hosts not found. Set ssh_known_hosts_path in ~/.code-container/config.json if SSH agent forwarding is needed.");

  fs.writeFileSync(HOST_CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + "\n");
  fs.chmodSync(HOST_CONFIG_PATH, 0o600);
  console.log("[code-container] Created config.json");
} else {
  // Migrate existing config.json: add missing keys, remove deprecated keys
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(HOST_CONFIG_PATH, "utf-8"));
  } catch (err) {
    console.log(`[code-container] Warning: could not parse ${HOST_CONFIG_PATH}: ${err.message} — skipping migration.`);
    existing = null;
  }

  if (existing) {
    const validKeys = new Set(Object.keys(defaultConfig));
    const missing = [...validKeys].filter(k => !(k in existing));
    const removed = Object.keys(existing).filter(k => !validKeys.has(k));

    const migrationOverrides = {};
    if (missing.includes("ssh_known_hosts_path")) {
      const discovered = findKnownHostsPath();
      migrationOverrides.ssh_known_hosts_path = discovered;
      if (discovered) console.log(`[code-container] Found SSH known_hosts: ${discovered}`);
      else console.log("[code-container] SSH known_hosts not found. Set ssh_known_hosts_path in ~/.code-container/config.json if SSH agent forwarding is needed.");
    }

    for (const k of missing) existing[k] = k in migrationOverrides ? migrationOverrides[k] : defaultConfig[k];
    for (const k of removed) delete existing[k];

    if (missing.length > 0 || removed.length > 0) {
      const removedEntries = removed.map(k => `${k} (was ${JSON.stringify(existing[k])})`);
      fs.writeFileSync(HOST_CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
      fs.chmodSync(HOST_CONFIG_PATH, 0o600);
      console.log(`[code-container] Migrated config.json: added ${missing.length} keys, removed ${removed.length} keys`);
      if (removedEntries.length > 0) {
        console.log(`[code-container] Deprecated keys removed: ${removedEntries.join(", ")}`);
      }
    } else {
      console.log("[code-container] config.json is up to date");
    }
  }
}

console.log("[code-container] Install complete");
