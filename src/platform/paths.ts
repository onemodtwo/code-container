import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { isWindows } from "./os";

export const APPDATA_DIR = path.join(os.homedir(), ".code-container");
export const STANDALONE_INSTALL_DIR = path.join(APPDATA_DIR, "bin");
export const CONFIGS_DIR = path.join(APPDATA_DIR, "configs");
export const TEMP_DIR = path.join(APPDATA_DIR, "temp");
export const STATE_PATH = path.join(TEMP_DIR, "state.json");
export const USER_DOCKERFILE_PATH = path.join(APPDATA_DIR, "Dockerfile.User");
export const CONFIG_JSON_PATH = path.join(APPDATA_DIR, "config.json");
export const PROJECTS_DIR = path.join(APPDATA_DIR, "projects");
export const DOCKERFILE_PATH = path.join(APPDATA_DIR, "Dockerfile");
export const CONTAINER_BASHRC_PATH = path.join(APPDATA_DIR, "container.bashrc");

export function homeDir(): string {
  return os.homedir();
}

export function expandHomePath(hostPath: string): string {
  if (hostPath.startsWith("~")) {
    return path.join(homeDir(), hostPath.slice(1));
  }
  return hostPath;
}

export function resolveProjectPath(projectPath: string | undefined): string {
  if (!projectPath) {
    return process.cwd();
  }
  return path.resolve(projectPath);
}

export const CONTAINER_PREFIX = "container";

// Canonical key derived from a project path, used solely for hashing the
// container name. NOT a real filesystem path. Native Windows drive-letter
// paths (C:\Users\dev) are rewritten to the WSL mount form (/mnt/c/Users/dev)
// so the same project resolves to one container whether the CLI is invoked
// from native Windows or WSL. All other paths pass through unchanged.
function canonicalizeProjectPath(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const driveMatch = trimmed.match(/^([A-Za-z]):[\\/](.*)$/);
  let resolved: string;
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, "/");
    resolved = `/mnt/${drive}/${rest}`;
  } else {
    try {
      resolved = fs.realpathSync(trimmed);
    } catch {
      resolved = path.resolve(trimmed);
    }
  }
  return resolved;
}

export function generateContainerName(projectPath: string): string {
  const canonicalPath = canonicalizeProjectPath(projectPath);
  const projectName = path.basename(canonicalPath);
  const pathHash = crypto
    .createHash("sha1")
    .update(canonicalPath)
    .digest("hex")
    .substring(0, 8);
  return `${CONTAINER_PREFIX}-${projectName}-${pathHash}`;
}

export function resolveContainerName(target: string | undefined): string {
  return generateContainerName(resolveProjectPath(target));
}

export function buildBindMount(
  source: string,
  dest: string,
  mode?: string,
): string {
  const src = normalizePath(source);
  const dst = normalizePath(dest);
  const mount = `type=bind,source=${src},target=${dst}`;
  return mode === "ro" ? `${mount},readonly` : mount;
}

function normalizePath(p: string): string {
  return isWindows() ? p.replace(/\\/g, "/") : p;
}
