import * as clack from "@clack/prompts";
import { ContainerClient } from "../container-client";
import { SettingsStore } from "../config";
import { Filesystem } from "../platform/fs";
import { buildImage } from "../docker";

export function buildCommand(
  runtime: ContainerClient,
  settingsStore: SettingsStore,
  fs: Filesystem,
): void {
  clack.log.info("Building container image");
  const result = buildImage(runtime, settingsStore, undefined, fs);
  if (!result.ok) {
    clack.log.error("Failed to build image");
    process.exit(1);
  }
  clack.log.success("Image built successfully");
}
