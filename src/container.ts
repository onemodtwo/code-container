// eslint-disable-next-line no-restricted-imports -- fs used for symlink resolution (readlinkSync, realpathSync) not in Filesystem abstraction
import fs from "fs";
import path from "path";
import { ContainerClient } from "./container-client";
import { Filesystem } from "./platform/fs";
import {
  homeDir,
  APPDATA_DIR,
  PROJECTS_DIR,
  expandHomePath,
  CONTAINER_BASHRC_PATH,
} from "./platform/paths";
import { Result } from "./types";
import { HARNESS_PACKS } from "./harness-packs";
import { TOOL_PACKS } from "./tool-packs";
import { CONTAINER_IMAGE } from "./docker";
import { configMountSourcePath, ensureConfigExists } from "./config";
import { loadMountConfig, loadGlobalConfig, MountConfig } from "./mount-config";
import { mergePermissionsIntoConfig } from "./tool-permissions";
import { countActiveSessions } from "./session";

const TOOLCHAIN_HIDDEN_PATHS = [
  ".nvm",
  ".cargo",
  ".rustup",
  ".local",
  ".pyenv",
];

function parseMountEntry(entry: string): {
  hostPath: string;
  containerPath: string;
} {
  const idx = entry.indexOf(":");
  if (idx < 0) return { hostPath: entry, containerPath: entry };
  return { hostPath: entry.slice(0, idx), containerPath: entry.slice(idx + 1) };
}

function resolveVenvInterpreterMount(
  penvPath: string,
  plannedMountRoots: Set<string>,
): string | null {
  if (!penvPath) return null;

  const activateScript = path.join(penvPath, "bin", "activate");
  const pythonBin = path.join(penvPath, "bin", "python");
  if (!fs.existsSync(activateScript) || !fs.existsSync(pythonBin)) return null;

  let symlinkTarget: string;
  try {
    const raw = fs.readlinkSync(pythonBin);
    symlinkTarget = path.isAbsolute(raw)
      ? raw
      : path.resolve(path.dirname(pythonBin), raw);
  } catch {
    return null;
  }

  const containerInterpreterPath = path.dirname(path.dirname(symlinkTarget));

  for (const root of plannedMountRoots) {
    if (
      containerInterpreterPath === root
      || containerInterpreterPath.startsWith(root + path.sep)
    ) {
      return null;
    }
  }

  let hostInterpreterPath: string;
  try {
    hostInterpreterPath = fs.realpathSync(containerInterpreterPath);
  } catch {
    return null;
  }

  if (!fs.existsSync(hostInterpreterPath)) return null;

  return `${hostInterpreterPath}:${containerInterpreterPath}:ro`;
}

function walkForSymlinks(
  dir: string,
  maxDepth: number,
  callback: (realTarget: string, symlinkPath: string) => void,
  currentDepth: number = 0,
): void {
  if (currentDepth >= maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const raw = fs.readlinkSync(fullPath);
        const abs = path.isAbsolute(raw)
          ? raw
          : path.resolve(path.dirname(fullPath), raw);
        const real = (() => {
          try {
            return fs.realpathSync(abs);
          } catch {
            return abs;
          }
        })();
        callback(real, fullPath);
      } catch {
        // dead or unreadable link
      }
    } else if (entry.isDirectory()) {
      walkForSymlinks(fullPath, maxDepth, callback, currentDepth + 1);
    }
  }
}

export function buildMounts(
  fsInstance: Filesystem,
  projectPath: string,
  projectDirName: string,
  mountConfig: MountConfig,
  projectConfigsDir: string,
): { mounts: string[]; containerProjectPath: string } {
  const mounts: string[] = [];
  const mountIndex = new Map<string, number>();
  const hostPathSet = new Set<string>();
  const home = homeDir();

  function addMount(spec: string): void {
    const parts = spec.split(":");
    const containerPath = parts[1] ?? parts[0];
    const isReadOnly = parts[2] === "ro";

    if (mountIndex.has(containerPath)) {
      if (!isReadOnly) {
        const idx = mountIndex.get(containerPath)!;
        if (mounts[idx].endsWith(":ro")) {
          mounts[idx] = spec;
        }
      }
      return;
    }
    mountIndex.set(containerPath, mounts.length);
    hostPathSet.add(parts[0]);
    mounts.push(spec);
  }

  function isHostCovered(p: string): boolean {
    for (const h of hostPathSet) {
      if (p === h || p.startsWith(h + "/")) return true;
    }
    return false;
  }

  function addWriteWithProtection(
    hostPath: string,
    containerPath: string = hostPath,
  ): void {
    let ancestor = path.dirname(hostPath);
    let isImmediateParent = true;
    while (ancestor !== path.dirname(ancestor)) {
      if (!isImmediateParent && isHostCovered(ancestor)) break;
      if (fs.existsSync(ancestor)) {
        addMount(`${ancestor}:${ancestor}:ro`);
      }
      isImmediateParent = false;
      ancestor = path.dirname(ancestor);
    }
    addMount(`${hostPath}:${containerPath}`);
  }

  for (const branch of mountConfig.data_branches) {
    if (fs.existsSync(branch)) {
      addMount(`${branch}:${branch}:ro`);
    }
  }

  if (mountConfig.mount_home_children && fs.existsSync(home)) {
    for (const name of TOOLCHAIN_HIDDEN_PATHS) {
      const dirPath = path.join(home, name);
      if (fs.existsSync(dirPath)) {
        addMount(`${dirPath}:${dirPath}:ro`);
      }
    }
  }

  if (mountConfig.mount_home_children && fs.existsSync(home)) {
    function resolveAll(paths: string[]): string[] {
      return paths
        .filter(p => {
          try {
            return fs.existsSync(p);
          } catch {
            return false;
          }
        })
        .map(p => {
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        });
    }
    const hostOnly = (entries: string[]) =>
      entries.map(e => parseMountEntry(e).hostPath);
    const writableRealPaths = resolveAll([
      projectPath,
      ...hostOnly(mountConfig.extra_readwrite),
    ]);
    const configuredRealPaths = resolveAll([
      projectPath,
      ...mountConfig.data_branches,
      ...hostOnly(mountConfig.extra_readonly),
      ...hostOnly(mountConfig.extra_readwrite),
    ]);

    function isUnder(target: string, roots: string[]): boolean {
      return roots.some(r => target === r || target.startsWith(r + path.sep));
    }

    try {
      const children = fs
        .readdirSync(home)
        .filter(name => !name.startsWith("."));
      for (const child of children) {
        const childPath = path.join(home, child);

        let lstat: fs.Stats;
        try {
          lstat = fs.lstatSync(childPath);
        } catch {
          continue;
        }

        if (lstat.isSymbolicLink()) {
          let realTarget: string;
          try {
            realTarget = fs.realpathSync(childPath);
          } catch {
            continue;
          }

          if (
            realTarget === APPDATA_DIR
            || realTarget.startsWith(APPDATA_DIR + path.sep)
          ) {
            continue;
          }

          if (realTarget.startsWith(home + path.sep)) {
            const firstComponent = path
              .relative(home, realTarget)
              .split(path.sep)[0];
            if (firstComponent.startsWith(".")) continue;
          } else {
            if (!isUnder(realTarget, configuredRealPaths)) continue;
          }

          if (isUnder(realTarget, writableRealPaths)) {
            addMount(`${childPath}:${childPath}`);
            continue;
          }
        }

        addMount(`${childPath}:${childPath}:ro`);
      }
    } catch {
      // If home is unreadable, skip silently
    }
  }

  for (const extra of mountConfig.extra_readonly) {
    const { hostPath, containerPath } = parseMountEntry(extra);
    if (fs.existsSync(hostPath)) {
      addMount(`${hostPath}:${containerPath}:ro`);
    }
  }

  for (const extra of mountConfig.extra_ld_library_path) {
    if (fs.existsSync(extra)) {
      addMount(`${extra}:${extra}:ro`);
    }
  }

  const resolvedPenvPath =
    mountConfig.penv_path && !path.isAbsolute(mountConfig.penv_path)
      ? path.resolve(projectPath, mountConfig.penv_path)
      : mountConfig.penv_path;

  const venvInterpreterMount = resolveVenvInterpreterMount(
    resolvedPenvPath,
    new Set(mountIndex.keys()),
  );
  if (venvInterpreterMount) {
    addMount(venvInterpreterMount);
  }

  if (
    mountConfig.renv_path
    && fs.existsSync(mountConfig.renv_path)
    && !isHostCovered(mountConfig.renv_path)
  ) {
    addMount(`${mountConfig.renv_path}:${mountConfig.renv_path}:ro`);
  }

  const containerProjectPath = `/root/${path.basename(projectPath)}`;

  addMount(
    mountConfig.project_readonly
      ? `${projectPath}:${containerProjectPath}:ro`
      : `${projectPath}:${containerProjectPath}`,
  );

  for (const extra of mountConfig.extra_readwrite) {
    const { hostPath, containerPath } = parseMountEntry(extra);
    if (fs.existsSync(hostPath)) {
      addWriteWithProtection(hostPath, containerPath);
    }
  }

  if (
    mountConfig.project_symlink_mounts !== "off"
    && fs.existsSync(projectPath)
  ) {
    const isWrite = mountConfig.project_symlink_mounts === "write";
    walkForSymlinks(
      projectPath,
      mountConfig.project_symlink_depth,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- second param is part of walkForSymlinks callback signature
      (realTarget, _symlinkPath) => {
        if (
          realTarget === APPDATA_DIR
          || realTarget.startsWith(APPDATA_DIR + path.sep)
        ) {
          return;
        }
        if (!fs.existsSync(realTarget)) return;
        if (isHostCovered(realTarget)) return;
        if (isWrite) {
          addWriteWithProtection(realTarget);
        } else {
          addMount(`${realTarget}:${realTarget}:ro`);
        }
      },
    );
  }

  if (mountConfig.forward_ssh_agent) {
    const relayDir = path.join(home, ".ssh-agent-relay");
    if (fs.existsSync(relayDir)) {
      addMount(`${relayDir}:${relayDir}:ro`);
    }
    if (
      mountConfig.ssh_known_hosts_path
      && fs.existsSync(mountConfig.ssh_known_hosts_path)
    ) {
      addMount(`${mountConfig.ssh_known_hosts_path}:/root/.ssh/known_hosts:ro`);
    }
  }

  const enabledIds = loadGlobalConfigEnabledHarnesses();
  for (const id of enabledIds) {
    const pack = HARNESS_PACKS[id as keyof typeof HARNESS_PACKS];
    if (!pack) continue;
    for (const c of pack.config) {
      const configRole = "role" in c ? c.role : undefined;
      let sourcePath: string;
      if (configRole === "settings") {
        ensureConfigExists(fsInstance, c);
        sourcePath = path.join(projectConfigsDir, c.config);
      } else if (configRole === "auth" && mountConfig.auth_mode === "shared") {
        sourcePath = expandHomePath(c.host);
        if (!fs.existsSync(sourcePath)) {
          ensureConfigExists(fsInstance, c);
          sourcePath = configMountSourcePath(c);
        }
      } else if (
        configRole === "history"
        && mountConfig.history_mode === "shared"
      ) {
        sourcePath = expandHomePath(c.host);
        if (!fs.existsSync(sourcePath)) {
          ensureConfigExists(fsInstance, c);
          sourcePath = configMountSourcePath(c);
        }
      } else {
        ensureConfigExists(fsInstance, c);
        sourcePath = configMountSourcePath(c);
      }
      const configReadonly = "readonly" in c && c.readonly === true;
      if (configReadonly) {
        addMount(`${sourcePath}:${c.mount}:ro`);
      } else {
        addMount(`${sourcePath}:${c.mount}`);
      }
    }
    mergePermissionsIntoConfig(
      fsInstance,
      id,
      mountConfig.tool_permissions,
      projectConfigsDir,
    );
  }

  const enabledToolIds = loadGlobalConfigEnabledTools();
  for (const id of enabledToolIds) {
    const pack = TOOL_PACKS[id as keyof typeof TOOL_PACKS];
    if (!pack) continue;
    for (const c of pack.config) {
      ensureConfigExists(fsInstance, c);
      addMount(`${configMountSourcePath(c)}:${c.mount}`);
    }
  }

  if (fs.existsSync(CONTAINER_BASHRC_PATH)) {
    addMount(`${CONTAINER_BASHRC_PATH}:/etc/container.bashrc:ro`);
  }

  if (fs.existsSync(`${home}/.gitconfig`)) {
    addMount(`${home}/.gitconfig:/root/.gitconfig:ro`);
  }

  return { mounts, containerProjectPath };
}

function loadGlobalConfigEnabledHarnesses(): string[] {
  try {
    const config = loadGlobalConfig();
    return config.enabledHarnesses ?? [];
  } catch {
    return [];
  }
}

function loadGlobalConfigEnabledTools(): string[] {
  try {
    const config = loadGlobalConfig();
    return config.enabledTools ?? [];
  } catch {
    return [];
  }
}

export function createNewContainer(
  fs: Filesystem,
  runtime: ContainerClient,
  containerName: string,
  projectName: string,
  projectPath: string,
  projectDirName: string,
  cliFlags: string[],
): Result<void> {
  const mountConfig = loadMountConfig(projectDirName);
  const projectConfigsDir = path.join(PROJECTS_DIR, projectDirName, "configs");
  const { mounts, containerProjectPath } = buildMounts(
    fs,
    projectPath,
    projectDirName,
    mountConfig,
    projectConfigsDir,
  );
  const args = ["-d", "--name", containerName];

  args.push("--security-opt", "no-new-privileges");
  args.push("-e", "TERM=xterm-256color");
  args.push("-e", "COLORTERM=truecolor");
  if (mountConfig.penv_path) {
    const hostResolved = !path.isAbsolute(mountConfig.penv_path)
      ? path.resolve(projectPath, mountConfig.penv_path)
      : mountConfig.penv_path;
    const containerResolved = !path.isAbsolute(mountConfig.penv_path)
      ? `${containerProjectPath}/${mountConfig.penv_path}`
      : mountConfig.penv_path;
    if (fs.existsSync(hostResolved)) {
      args.push("-e", `PENV_PATH=${containerResolved}`);
    }
  }
  if (mountConfig.renv_path) {
    args.push("-e", `RENV_PATH=${mountConfig.renv_path}`);
  }
  if (mountConfig.extra_ld_library_path.length > 0) {
    args.push(
      "-e",
      `LD_LIBRARY_PATH=${mountConfig.extra_ld_library_path.join(":")}`,
    );
  }
  args.push("-w", containerProjectPath);

  if (runtime.getRuntimeBin() === "podman") {
    args.push("--group-add", "keep-groups");
  }

  for (const mount of mounts) {
    args.push("--volume", mount);
  }

  args.push(...cliFlags);

  args.push(CONTAINER_IMAGE, "sleep", "infinity");

  return runtime.run(args);
}

export function execInteractive(
  runtime: ContainerClient,
  containerName: string,
  projectName: string,
  projectPath: string,
  projectDirName: string,
  cliFlags: string[],
): void {
  const mountConfig = loadMountConfig(projectDirName);
  const containerProjectPath = `/root/${projectName}`;
  const args: string[] = [
    "-it",
    "-e",
    "TERM=xterm-256color",
    "-e",
    "COLORTERM=truecolor",
  ];

  if (mountConfig.penv_path) {
    const hostResolved = !path.isAbsolute(mountConfig.penv_path)
      ? path.resolve(projectPath, mountConfig.penv_path)
      : mountConfig.penv_path;
    const containerResolved = !path.isAbsolute(mountConfig.penv_path)
      ? `${containerProjectPath}/${mountConfig.penv_path}`
      : mountConfig.penv_path;
    if (fs.existsSync(hostResolved)) {
      args.push("-e", `PENV_PATH=${containerResolved}`);
    }
  }
  if (mountConfig.renv_path) {
    args.push("-e", `RENV_PATH=${mountConfig.renv_path}`);
  }
  if (mountConfig.extra_ld_library_path.length > 0) {
    args.push(
      "-e",
      `LD_LIBRARY_PATH=${mountConfig.extra_ld_library_path.join(":")}`,
    );
  }
  if (mountConfig.forward_ssh_agent) {
    const sshAuthSock = process.env.SSH_AUTH_SOCK;
    if (sshAuthSock) {
      args.push("-e", `SSH_AUTH_SOCK=${sshAuthSock}`);
    }
  }

  args.push(
    "-w",
    containerProjectPath,
    ...cliFlags,
    containerName,
    "/bin/bash",
  );

  runtime.exec(args);
}

export function stopContainerIfLastSession(
  runtime: ContainerClient,
  containerName: string,
  sessionDir: string,
): void {
  if (countActiveSessions(sessionDir) === 0) {
    runtime.stop(containerName);
  }
}

const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

export function stopOrphanedContainers(runtime: ContainerClient): void {
  const containers = runtime.listRunningManagedContainers();
  const now = Date.now();

  for (const name of containers) {
    const startedAt = runtime.containerStartedAt(name);
    if (startedAt === null) continue;

    const startedMs = new Date(startedAt).getTime();
    if (now - startedMs < ORPHAN_THRESHOLD_MS) continue;

    runtime.stop(name);
  }
}
