import * as clack from "@clack/prompts";
import { ContainerClient } from "../container-client";
import { SettingsStore } from "../config";
import { Filesystem } from "../platform/fs";
import { Executor } from "../platform/shell";
import { RuntimeBin } from "../types";
import { HARNESS_PACKS } from "../harness-packs";
import { TOOL_PACKS } from "../tool-packs";
import { buildImage } from "../docker";
import { migrateToolConfigs } from "../onboarding";

type SettingsAction = "harnesses" | "tools" | "runtime" | "mounts" | "done";

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

export async function settingsCommand(
  executor: Executor,
  settingsStore: SettingsStore,
  fs: Filesystem,
): Promise<void> {
  const result = settingsStore.load();
  if (!result.ok) {
    clack.log.error("Failed to load settings");
    process.exit(1);
  }

  let settings = result.value;
  const initialHarnesses = [...(settings.enabledHarnesses ?? [])];
  const initialTools = [...(settings.enabledTools ?? [])];

  clack.intro("Settings");

  while (true) {
    const action = await clack.select<SettingsAction>({
      message: "What would you like to configure?",
      options: [
        {
          value: "harnesses",
          label: "Enabled Harnesses",
        },
        {
          value: "tools",
          label: "Enabled Tools",
        },
        {
          value: "runtime",
          label: "Container Runtime",
          hint: settings.runtime ?? "not set",
        },
        {
          value: "mounts",
          label: "System Mounts",
          hint: `SSH: ${(settings.systemMounts?.ssh ?? false) ? "on" : "off"}`,
        },
        { value: "done", label: "Done" },
      ],
    });

    if (clack.isCancel(action) || action === "done") break;

    switch (action) {
      case "harnesses": {
        const allIds = Object.keys(HARNESS_PACKS);
        const selected = await clack.multiselect({
          message:
            "Select harnesses to enable (space to toggle, enter to confirm)",
          options: allIds.map(id => {
            const pack = HARNESS_PACKS[id as keyof typeof HARNESS_PACKS];
            return { value: id, label: pack.name };
          }),
          initialValues: settings.enabledHarnesses ?? [],
        });

        if (!clack.isCancel(selected)) {
          const newHarnesses = (selected as string[]).sort();
          settings = {
            ...settings,
            enabledHarnesses: newHarnesses,
          };
          settingsStore.save(settings);
          clack.log.success(`Harnesses updated: ${formatList(newHarnesses)}`);
        }
        break;
      }
      case "tools": {
        const allToolIds = Object.keys(TOOL_PACKS);
        const selectedTools = await clack.multiselect({
          message: "Select tools to enable (space to toggle, enter to confirm)",
          options: allToolIds.map(id => {
            const pack = TOOL_PACKS[id as keyof typeof TOOL_PACKS];
            return { value: id, label: pack.name };
          }),
          initialValues: settings.enabledTools ?? [],
        });

        if (!clack.isCancel(selectedTools)) {
          const newTools = (selectedTools as string[]).sort();
          const addedTools = newTools.filter(t => !initialTools.includes(t));
          if (addedTools.length > 0) {
            migrateToolConfigs(fs, addedTools);
          }
          settings = {
            ...settings,
            enabledTools: newTools,
          };
          settingsStore.save(settings);
          clack.log.success(`Tools updated: ${formatList(newTools)}`);
        }
        break;
      }
      case "runtime": {
        const selected = await clack.select({
          message: "Select container runtime",
          options: [
            { value: "docker", label: "Docker" },
            { value: "podman", label: "Podman" },
          ],
          initialValue: settings.runtime,
        });

        if (!clack.isCancel(selected)) {
          settings = { ...settings, runtime: selected as RuntimeBin };
          settingsStore.save(settings);
          clack.log.success(`Runtime updated: ${selected}`);
        }
        break;
      }
      case "mounts": {
        const ssh = await clack.confirm({
          message: "Mount ~/.ssh (read-only)?",
          initialValue: settings.systemMounts?.ssh ?? false,
        });

        if (clack.isCancel(ssh)) break;

        settings = {
          ...settings,
          systemMounts: { ssh },
        };
        settingsStore.save(settings);
        clack.log.success(`Mounts updated: SSH ${ssh ? "on" : "off"}`);
        break;
      }
    }
  }

  const currentHarnesses = [...(settings.enabledHarnesses ?? [])].sort();
  const initialSorted = [...initialHarnesses].sort();
  const harnessesChanged =
    currentHarnesses.length !== initialSorted.length
    || currentHarnesses.some((v, i) => v !== initialSorted[i]);

  const initialToolsSorted = [...initialTools].sort();
  const currentTools = [...(settings.enabledTools ?? [])].sort();
  const toolsChanged =
    currentTools.length !== initialToolsSorted.length
    || currentTools.some((v, i) => v !== initialToolsSorted[i]);

  if (harnessesChanged || toolsChanged) {
    const rebuildChoice = await clack.confirm({
      message: "Configuration changed. Rebuild the image now?",
      initialValue: true,
    });

    if (!clack.isCancel(rebuildChoice) && rebuildChoice) {
      if (!settings.runtime) {
        clack.log.error("No container runtime configured. Image not rebuilt.");
      } else {
        const runtime = new ContainerClient(executor, settings.runtime);
        clack.log.info("Building container image");
        const buildResult = buildImage(runtime, settingsStore, undefined, fs);
        if (!buildResult.ok) {
          clack.log.error("Failed to build image");
          clack.log.warn("Run 'container build' manually to retry.");
        } else {
          clack.log.success("Image built successfully");
        }
      }
    }
  }

  clack.outro("Settings saved");
}
