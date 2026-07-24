import * as clack from "@clack/prompts";
import { ContainerClient } from "../container-client";
import { SettingsStore } from "../config";
import { Filesystem } from "../platform/fs";
import { generateProjectDirName } from "../mount-config";
import { resolveTarget, ResolvedTarget } from "./shared";
import { execInteractive, stopContainerIfLastSession } from "../container";
import { trackSessionStart, trackSessionEnd, getSessionDir } from "../session";

export function attachToContainer(
  runtime: ContainerClient,
  resolved: ResolvedTarget,
  projectDirName: string,
  cliFlags: string[],
): void {
  if (!runtime.containerExists(resolved.containerName)) {
    clack.log.error(`Container does not exist: ${resolved.containerName}`);
    process.exit(1);
  }

  if (!runtime.containerRunning(resolved.containerName)) {
    clack.log.info(`Starting container: ${resolved.containerName}`);
    runtime.start(resolved.containerName);
  }

  let stopped = false;
  const sessionDir = getSessionDir(projectDirName);
  const sessionFile = trackSessionStart(sessionDir);

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    trackSessionEnd(sessionFile);
    stopContainerIfLastSession(runtime, resolved.containerName, sessionDir);
  };

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGHUP", "SIGTERM"];
  for (const sig of signals) {
    process.on(sig, cleanup);
  }

  clack.log.info("Attaching to container...");
  execInteractive(
    runtime,
    resolved.containerName,
    resolved.projectName,
    resolved.projectPath,
    projectDirName,
    cliFlags,
  );

  for (const sig of signals) {
    process.removeListener(sig, cleanup);
  }
  cleanup();
  clack.log.success("Container session ended");
}

export function attachCommand(
  runtime: ContainerClient,
  settingsStore: SettingsStore,
  fs: Filesystem,
  target: string | undefined,
  projectDirName: string | undefined,
  cliFlags: string[] = [],
): void {
  const settingsResult = settingsStore.load();
  if (!settingsResult.ok) {
    clack.log.error("Failed to load settings");
    process.exit(1);
  }

  const resolved = resolveTarget(fs, target);
  if (!resolved) process.exit(1);

  const resolvedProjectDirName =
    projectDirName ?? generateProjectDirName(resolved.projectPath);

  attachToContainer(runtime, resolved, resolvedProjectDirName, cliFlags);
}
