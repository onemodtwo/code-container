import { z } from "zod";
import type { Executor } from "./platform/shell";
import type { GlobalConfig } from "./mount-config";

export type Result<T, E = string> =
  { ok: true; value: T } | { ok: false; error: E };

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used for type inference only
const RuntimeBinSchema = z.enum(["docker", "podman"]);
export type RuntimeBin = z.infer<typeof RuntimeBinSchema>;

interface BaseConfigMount {
  host: string;
  config: string;
  mount: string;
  role?: "auth" | "settings" | "history";
  readonly?: boolean;
}

export type ConfigMount =
  | (BaseConfigMount & { kind: "file"; defaultContents?: string })
  | (BaseConfigMount & { kind: "directory" });

export interface HarnessPack {
  id: string;
  name: string;
  shouldEnable: (executor: Executor) => boolean;
  dockerfileLines: string[];
  config: ConfigMount[];
}

export interface ToolPack {
  id: string;
  name: string;
  shouldEnable: (executor: Executor) => boolean;
  dockerfileLines: string[];
  config: ConfigMount[];
}

export const SystemMountsSchema = z.object({
  ssh: z.boolean().optional(),
});
export type SystemMounts = z.infer<typeof SystemMountsSchema>;

export type Settings = GlobalConfig;

export const StateSchema = z.object({
  lastUpgradeTime: z.number().optional(),
});
export type StateData = z.infer<typeof StateSchema>;
