// eslint-disable-next-line no-restricted-imports -- fs used for config file operations (read/write/exists)
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { APPDATA_DIR, PROJECTS_DIR } from "./platform/paths";

export const HOST_CONFIG_PATH = path.join(APPDATA_DIR, "config.json");

export const GlobalMountConfigSchema = z.object({
  base_image: z.string().default("ubuntu:24.04"),
  timezone: z.string().default("UTC"),
  container_runtime: z.enum(["podman", "docker"]).default("docker"),
  data_branches: z.array(z.string()).default([]),
  network: z.string().default("bridge"),
  keep_alive: z.boolean().default(false),
  mount_home_children: z.boolean().default(true),
  auth_mode: z.enum(["shared", "per_project"]).default("shared"),
  history_mode: z.enum(["shared", "isolated"]).default("shared"),
  penv_path: z.string().default(""),
  renv_path: z.string().default(""),
  extra_readonly: z.array(z.string()).default([]),
  extra_readwrite: z.array(z.string()).default([]),
  extra_ld_library_path: z.array(z.string()).default([]),
  project_symlink_mounts: z.enum(["read", "write", "off"]).default("read"),
  project_symlink_depth: z.number().int().min(1).default(3),
  forward_ssh_agent: z.boolean().default(false),
  ssh_known_hosts_path: z.string().default(""),
  tool_permissions: z
    .object({
      allow: z.array(z.string()).default(["*"]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: ["*"], deny: [] }),

  enabledHarnesses: z.array(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
  runtime: z.enum(["docker", "podman"]).optional(),
  dockerRunFlags: z.array(z.string()).optional(),
  dockerExecFlags: z.array(z.string()).optional(),

  configVersion: z.number().optional(),
  migrationVersion: z.number().optional(),
  onboardingVersion: z.number().optional(),
  tosVersion: z.number().optional(),
  systemMounts: z.object({ ssh: z.boolean().optional() }).optional(),
});

const ProjectOverrideSchema = z.object({
  network: z.string().optional(),
  keep_alive: z.boolean().optional(),
  project_readonly: z.boolean().optional(),
  auth_mode: z.enum(["shared", "per_project"]).optional(),
  history_mode: z.enum(["shared", "isolated"]).optional(),
  mount_home_children: z.boolean().optional(),
  penv_path: z.string().optional(),
  renv_path: z.string().optional(),
  extra_readonly: z.array(z.string()).optional(),
  extra_readwrite: z.array(z.string()).optional(),
  extra_ld_library_path: z.array(z.string()).optional(),
  project_symlink_mounts: z.enum(["read", "write", "off"]).optional(),
  project_symlink_depth: z.number().int().min(1).optional(),
  forward_ssh_agent: z.boolean().optional(),
  ssh_known_hosts_path: z.string().optional(),
  tool_permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
});

export type GlobalConfig = z.infer<typeof GlobalMountConfigSchema>;

export type MountConfig = {
  auth_mode: "shared" | "per_project";
  history_mode: "shared" | "isolated";
  network: string;
  keep_alive: boolean;
  project_readonly: boolean;
  penv_path: string;
  renv_path: string;
  data_branches: string[];
  mount_home_children: boolean;
  extra_readonly: string[];
  extra_readwrite: string[];
  extra_ld_library_path: string[];
  project_symlink_mounts: "read" | "write" | "off";
  project_symlink_depth: number;
  forward_ssh_agent: boolean;
  ssh_known_hosts_path: string;
  tool_permissions: { allow: string[]; deny: string[] };
};

function parseFile<T extends z.ZodTypeAny>(
  schema: T,
  filePath: string,
): z.infer<T> {
  if (!fs.existsSync(filePath)) return schema.parse({});
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return schema.parse({});
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(
      `[code-container] Warning: ${filePath} contains invalid JSON — using schema defaults`,
    );
    return schema.parse({});
  }
  try {
    return schema.parse(json);
  } catch {
    console.error(
      `[code-container] Warning: ${filePath} has unexpected field types or values — using schema defaults`,
    );
    return schema.parse({});
  }
}

export function loadGlobalConfig(): GlobalConfig {
  return parseFile(GlobalMountConfigSchema, HOST_CONFIG_PATH);
}

export function loadMountConfig(projectDirName: string): MountConfig {
  const global = loadGlobalConfig();
  const override = parseFile(
    ProjectOverrideSchema,
    path.join(PROJECTS_DIR, projectDirName, "override.json"),
  );

  return {
    auth_mode: override.auth_mode ?? global.auth_mode,
    history_mode: override.history_mode ?? global.history_mode,
    network: override.network ?? global.network,
    keep_alive: override.keep_alive ?? global.keep_alive,
    project_readonly: override.project_readonly ?? false,
    penv_path: override.penv_path ?? global.penv_path,
    renv_path: override.renv_path ?? global.renv_path,
    data_branches: global.data_branches,
    mount_home_children:
      override.mount_home_children ?? global.mount_home_children,
    extra_readonly: [
      ...global.extra_readonly,
      ...(override.extra_readonly ?? []),
    ],
    extra_readwrite: [
      ...global.extra_readwrite,
      ...(override.extra_readwrite ?? []),
    ],
    extra_ld_library_path: [
      ...(global.extra_ld_library_path ?? []),
      ...(override.extra_ld_library_path ?? []),
    ],
    project_symlink_mounts:
      override.project_symlink_mounts ?? global.project_symlink_mounts,
    project_symlink_depth:
      override.project_symlink_depth ?? global.project_symlink_depth,
    forward_ssh_agent: override.forward_ssh_agent ?? global.forward_ssh_agent,
    ssh_known_hosts_path:
      override.ssh_known_hosts_path ?? global.ssh_known_hosts_path,
    tool_permissions: {
      allow: override.tool_permissions?.allow ?? global.tool_permissions.allow,
      deny: override.tool_permissions?.deny ?? global.tool_permissions.deny,
    },
  };
}

export function ensureHostConfig(): void {
  if (!fs.existsSync(HOST_CONFIG_PATH)) {
    const defaults = GlobalMountConfigSchema.parse({});
    fs.mkdirSync(path.dirname(HOST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      HOST_CONFIG_PATH,
      JSON.stringify(defaults, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}

export function generateProjectHash(projectPath: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(projectPath);
  } catch {
    canonicalPath = path.resolve(projectPath);
  }
  return crypto
    .createHash("sha1")
    .update(canonicalPath)
    .digest("hex")
    .substring(0, 8);
}

export function generateProjectDirName(projectPath: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(projectPath);
  } catch {
    canonicalPath = path.resolve(projectPath);
  }
  const projectName = path.basename(canonicalPath);
  const hash = generateProjectHash(projectPath);
  return `${projectName}-${hash}`;
}
