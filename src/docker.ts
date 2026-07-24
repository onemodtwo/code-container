import * as clack from "@clack/prompts";
import { ContainerClient } from "./container-client";
import { SettingsStore } from "./config";
import { Filesystem } from "./platform/fs";
import {
  APPDATA_DIR,
  DOCKERFILE_PATH,
} from "./platform/paths";
import { loadGlobalConfig } from "./mount-config";
import { Result } from "./types";
import path from "path";
import fs from "fs";

const IMAGE_TAG = "latest";
export const CONTAINER_IMAGE = `localhost/onemodtwo/code-container:${IMAGE_TAG}`;

const TOOL_BUILD_ARG_MAP: Record<string, string> = {
  python: "INSTALL_PYTHON",
  bun: "INSTALL_BUN",
  "enhanced-tools": "INSTALL_ENHANCED_TOOLS",
  deno: "INSTALL_DENO",
  rust: "INSTALL_RUST",
  go: "INSTALL_GO",
  uv: "INSTALL_UV",
  gh: "INSTALL_GH",
  aws: "INSTALL_AWS",
  gcloud: "INSTALL_GCLOUD",
  azure: "INSTALL_AZURE",
  neovim: "INSTALL_NEOVIM",
};

const HARNESS_BUILD_ARG_MAP: Record<string, string> = {
  claude: "INSTALL_CLAUDE",
  opencode: "INSTALL_OPENCODE",
  codex: "INSTALL_CODEX",
  pi: "INSTALL_PI",
  gemini: "INSTALL_GEMINI",
  copilot: "INSTALL_COPILOT",
  grok: "INSTALL_GROK",
  cursor: "INSTALL_CURSOR",
  nitro: "INSTALL_NITRO",
  antigravity: "INSTALL_ANTIGRAVITY",
};

function copyManagedDockerfile(fsInstance: Filesystem): void {
  const sourceDockerfile = path.resolve(__dirname, "..", "Dockerfile");
  if (fs.existsSync(sourceDockerfile)) {
    fsInstance.ensureAppdataDir();
    fsInstance.secureWriteFile(
      DOCKERFILE_PATH,
      fs.readFileSync(sourceDockerfile, "utf-8"),
    );
  }
}

export function buildImage(
  runtime: ContainerClient,
  settingsStore: SettingsStore,
  _stateStore: unknown,
  fsInstance: Filesystem,
): Result<void> {
  copyManagedDockerfile(fsInstance);

  if (!fs.existsSync(DOCKERFILE_PATH)) {
    return { ok: false, error: "dockerfile_not_found" };
  }

  const config = loadGlobalConfig();
  const buildArgs: string[] = [];

  const enabledTools = config.enabledTools ?? [];
  for (const id of enabledTools) {
    const argName = TOOL_BUILD_ARG_MAP[id];
    if (argName) {
      buildArgs.push("--build-arg", `${argName}=true`);
    }
  }

  const enabledHarnesses = config.enabledHarnesses ?? [];
  for (const id of enabledHarnesses) {
    const argName = HARNESS_BUILD_ARG_MAP[id];
    if (argName) {
      buildArgs.push("--build-arg", `${argName}=true`);
    }
  }

  clack.log.info("Building container image...");
  const result = runtime.build(
    DOCKERFILE_PATH,
    CONTAINER_IMAGE,
    APPDATA_DIR,
    buildArgs,
  );
  if (!result.ok) return result;

  runtime.pruneImages("label=onemodtwo.code-container=v3");

  return { ok: true, value: undefined };
}
