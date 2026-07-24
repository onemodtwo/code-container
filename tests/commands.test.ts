import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fs, vol } from "memfs";
import os from "os";
import { ContainerClient } from "../src/container-client";
import { Executor } from "../src/platform/shell";
import { SettingsStore, StateStore } from "../src/config";
import {
  APPDATA_DIR,
  TEMP_DIR,
  STATE_PATH,
  CONFIG_JSON_PATH,
  PROJECTS_DIR,
} from "../src/platform/paths";
import { buildCommand } from "../src/commands/build";
import { stopCommand } from "../src/commands/stop";
import { removeCommand } from "../src/commands/remove";
import { listCommand } from "../src/commands/list";
import { settingsCommand } from "../src/commands/settings";
import { createCommand } from "../src/commands/create";
import { attachCommand } from "../src/commands/attach";
import { runCommand } from "../src/commands/run";
import { detectInstallSource, upgradeCommand } from "../src/commands/upgrade";
import { resolveTarget } from "../src/commands/shared";
import * as clack from "@clack/prompts";
import { FsReader, Filesystem } from "../src/platform/fs";
import path from "path";

const calls: Array<{ command: string; args: string[]; options?: object }> = [];
const queue: Array<{
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
}> = [];

const mockExecutor: Executor = {
  spawnSync(command: string, args: string[], options?: object) {
    calls.push({ command, args, options });
    if (queue.length > 0) return queue.shift()!;
    return { status: 0, stdout: "", stderr: "" };
  },
};

function enqueue(result: {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}) {
  queue.push({ stdout: "", stderr: "", ...result });
}

function reset() {
  calls.length = 0;
  queue.length = 0;
  vi.clearAllMocks();
}

const fsReader = new Filesystem(fs as unknown as FsReader);

vi.mock("fs");

beforeEach(() => {
  reset();
  vol.reset();
});

describe("buildCommand", () => {
  it("calls buildImage and prints success", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "{}\n");
    fs.writeFileSync(
      path.join(APPDATA_DIR, "Dockerfile"),
      "FROM ubuntu:24.04\n",
    );
    const runtime = new ContainerClient(mockExecutor, "docker");
    const settingsStore = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    enqueue({ status: 0 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    buildCommand(runtime, settingsStore, fsReader);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("calls process.exit on build failure", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "{}\n");
    fs.writeFileSync(
      path.join(APPDATA_DIR, "Dockerfile"),
      "FROM ubuntu:24.04\n",
    );
    const runtime = new ContainerClient(mockExecutor, "docker");
    const settingsStore = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    enqueue({ status: 1 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => buildCommand(runtime, settingsStore, fsReader)).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("upgradeCommand", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects standalone installs under ~/.code-container/bin", () => {
    expect(
      detectInstallSource(
        path.join(os.homedir(), ".code-container/bin/container"),
        undefined,
      ),
    ).toBe("standalone");
  });

  it("detects npm installs from node_modules package path", () => {
    expect(
      detectInstallSource(
        "/usr/bin/node",
        "/usr/lib/node_modules/@onemodtwo/code-container/dist/js/main.js",
      ),
    ).toBe("npm");
  });

  it("detects npm installs from global bin shims", () => {
    expect(
      detectInstallSource(
        "/Users/developer/.nvm/versions/node/v22.22.1/bin/node",
        "/Users/developer/.nvm/versions/node/v22.22.1/bin/container",
      ),
    ).toBe("npm");
  });

  it("runs npm upgrade for npm installs", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v99.0.0" }),
    });
    const stateStore = new StateStore(fsReader, STATE_PATH);
    await upgradeCommand(
      mockExecutor,
      stateStore,
      "/usr/bin/node",
      "/usr/lib/node_modules/@onemodtwo/code-container/dist/js/main.js",
    );
    expect(calls[0]).toEqual({
      command: "npm",
      args: ["install", "-g", "@onemodtwo/code-container@latest"],
      options: { stdio: "inherit" },
    });
    const saved = stateStore.load();
    if (saved.ok) {
      expect(saved.value.lastUpgradeTime).toBeGreaterThan(Date.now() - 10000);
    }
  });
});

describe("stopCommand", () => {
  it("exits when container does not exist", () => {
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 1 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => stopCommand(runtime, undefined)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("stops running container", () => {
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });
    enqueue({ status: 0, stdout: "true\n" });
    enqueue({ status: 0 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    stopCommand(runtime, undefined);
    const stopCall = calls.find(c => c.args[0] === "stop");
    expect(stopCall).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe("removeCommand", () => {
  it("exits when container does not exist", () => {
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 1 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => removeCommand(runtime, undefined)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("stops then removes running container", () => {
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });
    enqueue({ status: 0, stdout: "true\n" });
    enqueue({ status: 0 });
    enqueue({ status: 0 });

    removeCommand(runtime, undefined);
    const stopCall = calls.find(c => c.args[0] === "stop");
    const rmCall = calls.find(c => c.args[0] === "rm");
    expect(stopCall).toBeDefined();
    expect(rmCall).toBeDefined();
  });
});

describe("listCommand", () => {
  it("delegates to runtime.listContainers", () => {
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });

    listCommand(runtime);
    const listCall = calls.find(c => c.args[0] === "ps");
    expect(listCall).toBeDefined();
  });
});

function setupSessionStores(): {
  settingsStore: SettingsStore;
  stateStore: StateStore;
} {
  fs.mkdirSync(APPDATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR), { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync("/project", { recursive: true });
  fs.writeFileSync(CONFIG_JSON_PATH, "{}\n");
  const settingsStore = new SettingsStore(fsReader, CONFIG_JSON_PATH);
  const stateStore = new StateStore(fsReader, STATE_PATH);
  settingsStore.save({
    runtime: "docker",
    enabledHarnesses: [],
  });
  return { settingsStore, stateStore };
}

describe("createCommand", () => {
  it("creates container when it does not exist", async () => {
    const { settingsStore } = setupSessionStores();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });
    enqueue({ status: 1 });
    enqueue({ status: 0 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    await createCommand(runtime, settingsStore, fsReader, "/project", [
      "-p",
      "8080:8080",
    ]);
    const runCalls = calls.filter(c => c.args[0] === "run");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].args).toContain("-p");
    expect(runCalls[0].args).toContain("8080:8080");
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("errors if container already exists", async () => {
    const { settingsStore } = setupSessionStores();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });
    enqueue({ status: 0 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    await expect(
      createCommand(runtime, settingsStore, fsReader, "/project", []),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("attachCommand", () => {
  it("errors if container does not exist", () => {
    const { settingsStore } = setupSessionStores();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 1 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() =>
      attachCommand(
        runtime,
        settingsStore,
        fsReader,
        "/project",
        undefined,
        [],
      ),
    ).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("starts if stopped then execs", () => {
    const { settingsStore } = setupSessionStores();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });
    enqueue({ status: 0, stdout: "false\n" });
    enqueue({ status: 0 });

    attachCommand(runtime, settingsStore, fsReader, "/project", undefined, [
      "-e",
      "FOO=bar",
    ]);
    const startCalls = calls.filter(c => c.args[0] === "start");
    const execCalls = calls.filter(c => c.args[0] === "exec");
    expect(startCalls).toHaveLength(1);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args).toContain("FOO=bar");
  });
});

describe("runCommand flag routing", () => {
  it("passes cliFlags to both create and attach", async () => {
    const { settingsStore, stateStore } = setupSessionStores();
    stateStore.save({ lastUpgradeTime: Date.now() });
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });
    enqueue({ status: 1 });
    enqueue({ status: 0 });
    enqueue({ status: 0 });
    enqueue({ status: 0, stdout: "true\n" });
    enqueue({ status: 0 });

    await runCommand(runtime, settingsStore, stateStore, fsReader, "/project", [
      "-p",
      "8080:8080",
    ]);
    const runCalls = calls.filter(c => c.args[0] === "run");
    const execCalls = calls.filter(c => c.args[0] === "exec");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].args).toContain("-p");
    expect(runCalls[0].args).toContain("8080:8080");
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args).toContain("-p");
    expect(execCalls[0].args).toContain("8080:8080");
  });
});

describe("settingsCommand", () => {
  function setupStores(): {
    settingsStore: SettingsStore;
  } {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEMP_DIR), { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "{}\n");
    const settingsStore = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    settingsStore.save({
      enabledHarnesses: ["opencode"],
      runtime: "docker",
    });
    return { settingsStore };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits immediately when done is selected without changes", async () => {
    const { settingsStore } = setupStores();

    vi.mocked(clack.select).mockResolvedValueOnce("done");

    await settingsCommand(mockExecutor, settingsStore, fsReader);

    expect(clack.outro).toHaveBeenCalledWith("Settings saved");
    expect(calls).toHaveLength(0);
    const saved = settingsStore.load();
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.enabledHarnesses).toEqual(["opencode"]);
  });

  it("updates runtime", async () => {
    const { settingsStore } = setupStores();

    vi.mocked(clack.select)
      .mockResolvedValueOnce("runtime")
      .mockResolvedValueOnce("podman")
      .mockResolvedValueOnce("done");

    await settingsCommand(mockExecutor, settingsStore, fsReader);

    const saved = settingsStore.load();
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.runtime).toBe("podman");
  });

  it("handles cancel on main menu", async () => {
    const { settingsStore } = setupStores();

    vi.mocked(clack.select).mockResolvedValueOnce(Symbol("cancel"));
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);

    await settingsCommand(mockExecutor, settingsStore, fsReader);

    expect(clack.outro).toHaveBeenCalledWith("Settings saved");
  });
});

describe("resolveTarget", () => {
  it("returns null when project path is APPDATA_DIR", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    const result = resolveTarget(fsReader, APPDATA_DIR);
    expect(result).toBeNull();
  });

  it("returns null when project path is inside APPDATA_DIR", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(APPDATA_DIR, "projects"), { recursive: true });
    const result = resolveTarget(fsReader, path.join(APPDATA_DIR, "projects"));
    expect(result).toBeNull();
  });

  it("returns null when project directory does not exist", () => {
    const result = resolveTarget(fsReader, "/nonexistent/path");
    expect(result).toBeNull();
  });

  it("returns null when path is a file not a directory", () => {
    fs.mkdirSync("/test-dir", { recursive: true });
    fs.writeFileSync("/test-dir/file.txt", "hello");
    const result = resolveTarget(fsReader, "/test-dir/file.txt");
    expect(result).toBeNull();
  });

  it("returns a valid target for an existing directory", () => {
    fs.mkdirSync("/test-project", { recursive: true });
    const result = resolveTarget(fsReader, "/test-project");
    expect(result).not.toBeNull();
    expect(result!.projectPath).toBe("/test-project");
    expect(result!.projectName).toBe("test-project");
    expect(result!.containerName).toMatch(
      /^container-test-project-[a-f0-9]{8}$/,
    );
  });
});
