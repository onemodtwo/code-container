// eslint-disable-next-line no-restricted-imports -- fs used to read harness YAML configs at startup (not in Filesystem abstraction)
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ConfigMount, HarnessPack } from "./types";
import { commandExists, Executor } from "./platform/shell";
import { getPlatform, Platform } from "./platform/os";

const MountEntrySchema = z.object({
  host: z.string(),
  container: z.string(),
  kind: z.enum(["file", "directory"]),
  role: z.enum(["auth", "settings", "history", "data"]),
  readonly: z.boolean().optional(),
  default_contents: z.string().optional(),
});

type MountEntryInput = z.infer<typeof MountEntrySchema>;

const DetectSchema = z.object({
  command: z.string(),
});

const PlatformOverrideSchema = z.object({
  detect: DetectSchema.optional(),
  install: z.array(z.string()).optional(),
  config: z.array(MountEntrySchema).optional(),
});

const HarnessConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  detect: DetectSchema,
  install: z.array(z.string()).default([]),
  config: z.array(MountEntrySchema).min(1),
  platforms: z
    .object({
      linux: PlatformOverrideSchema.optional(),
      darwin: PlatformOverrideSchema.optional(),
      windows: PlatformOverrideSchema.optional(),
    })
    .optional(),
});

type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

function deriveConfigPath(host: string): string {
  if (host.startsWith("~/")) {
    return host.slice(2);
  }
  return host;
}

function platformKey(): keyof NonNullable<HarnessConfig["platforms"]> {
  const p = getPlatform();
  if (p === Platform.Windows) return "windows";
  if (p === Platform.Macos) return "darwin";
  return "linux";
}

function applyPlatformOverrides(config: HarnessConfig): HarnessConfig {
  const overrides = config.platforms?.[platformKey()];
  if (!overrides) return config;

  const result: HarnessConfig = { ...config };

  if (overrides.detect !== undefined) {
    result.detect = overrides.detect;
  }
  if (overrides.install !== undefined) {
    result.install = overrides.install;
  }
  if (overrides.config !== undefined) {
    const overrideEntries = overrides.config;
    const merged: MountEntryInput[] = [...result.config];

    for (const override of overrideEntries) {
      const idx = merged.findIndex(e => e.container === override.container);
      if (idx >= 0) {
        merged[idx] = override;
      } else {
        merged.push(override);
      }
    }

    result.config = merged;
  }

  return result;
}

function buildConfigMount(entry: MountEntryInput): ConfigMount {
  const base = {
    host: entry.host,
    config: deriveConfigPath(entry.host),
    mount: entry.container,
    role: entry.role,
    readonly: entry.readonly,
  };

  if (entry.kind === "file") {
    return {
      ...base,
      kind: "file" as const,
      defaultContents: entry.default_contents,
    };
  }
  return { ...base, kind: "directory" as const };
}

function buildHarnessPack(resolved: HarnessConfig): HarnessPack {
  const shouldEnable = (executor: Executor): boolean =>
    commandExists(executor, resolved.detect.command);

  const buildArgName = `INSTALL_${resolved.id.toUpperCase()}`;

  return {
    id: resolved.id,
    name: resolved.name,
    shouldEnable,
    dockerfileLines: resolved.install,
    buildArgName,
    config: resolved.config.map(buildConfigMount),
  };
}

export function loadHarnessPack(yamlContent: string): HarnessPack {
  const raw = parseYaml(yamlContent);
  const parsed = HarnessConfigSchema.parse(raw);
  const resolved = applyPlatformOverrides(parsed);
  return buildHarnessPack(resolved);
}

function getHarnessesDir(): string {
  return path.resolve(__dirname, "..", "harnesses");
}

export function loadAllHarnessPacks(): Record<string, HarnessPack> {
  const dir = getHarnessesDir();
  const packs: Record<string, HarnessPack> = {};

  if (!fs.existsSync(dir)) {
    return packs;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".yaml"));

  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    try {
      const pack = loadHarnessPack(content);
      packs[pack.id] = pack;
    } catch {
      // Skip invalid YAML files silently
    }
  }

  return packs;
}
