import path from "path";
import * as clack from "@clack/prompts";
import { SettingsStore } from "../config";
import { Filesystem } from "../platform/fs";
import { buildImage, CONTAINER_IMAGE } from "../docker";
import { ContainerClient } from "../container-client";
import {
  APPDATA_DIR,
  generateContainerName,
  resolveProjectPath,
} from "../platform/paths";

export interface ResolvedTarget {
  containerName: string;
  projectName: string;
  projectPath: string;
}

export function resolveTarget(
  fs: Filesystem,
  target: string | undefined,
): ResolvedTarget | null {
  const projectPath = resolveProjectPath(target);
  const normalizedProject = path.resolve(projectPath);
  const normalizedAppdata = path.resolve(APPDATA_DIR);
  if (
    normalizedProject === normalizedAppdata
    || normalizedProject.startsWith(`${normalizedAppdata}/`)
  ) {
    clack.log.error(
      `Project path must not be inside the config directory: ${APPDATA_DIR}`,
    );
    return null;
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    clack.log.error(`Project directory does not exist: ${projectPath}`);
    return null;
  }
  const containerName = generateContainerName(projectPath);
  const projectName = path.basename(projectPath);
  return { containerName, projectName, projectPath };
}

export async function ensureImageReady(
  runtime: ContainerClient,
  settingsStore: SettingsStore,
  fs: Filesystem,
): Promise<void> {
  if (!runtime.imageExists(CONTAINER_IMAGE)) {
    clack.log.warn("Image not found. Building...");
    const result = buildImage(runtime, settingsStore, undefined, fs);
    if (!result.ok) {
      clack.log.error("Failed to build image");
      process.exit(1);
    }
    clack.log.success("Image built successfully");
  }
}
