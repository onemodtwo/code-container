import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import { fs, vol } from "memfs";
import { ContainerClient } from "../src/container-client";
import { Executor } from "../src/platform/shell";
import { FsReader, Filesystem } from "../src/platform/fs";
import {
  APPDATA_DIR,
  CONFIGS_DIR,
  CONFIG_JSON_PATH,
  PROJECTS_DIR,
  CONTAINER_BASHRC_PATH,
} from "../src/platform/paths";
import { SettingsStore } from "../src/config";
import { buildImage } from "../src/docker";
import {
  stopContainerIfLastSession,
  createNewContainer,
  buildMounts,
  stopOrphanedContainers,
} from "../src/container";

vi.mock("fs");

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
}

const fsReader = new Filesystem(fs as unknown as FsReader);

beforeEach(() => {
  reset();
  vol.reset();
});

afterEach(() => {
  if (queue.length > 0) {
    throw new Error(`${queue.length} unconsumed mock responses remaining`);
  }
});

describe("Runtime", () => {
  const runtime = new ContainerClient(mockExecutor, "docker");

  describe("imageExists", () => {
    it("returns true when status is 0", () => {
      enqueue({ status: 0 });
      expect(runtime.imageExists("test:latest")).toBe(true);
    });

    it("returns false when status is non-zero", () => {
      enqueue({ status: 1 });
      expect(runtime.imageExists("test:latest")).toBe(false);
    });
  });

  describe("containerExists", () => {
    it("returns true when status is 0", () => {
      enqueue({ status: 0 });
      expect(runtime.containerExists("container-foo-abc12345")).toBe(true);
    });

    it("returns false when status is non-zero", () => {
      enqueue({ status: 1 });
      expect(runtime.containerExists("container-foo-abc12345")).toBe(false);
    });
  });

  describe("containerRunning", () => {
    it("returns true when status is 0 and stdout is 'true'", () => {
      enqueue({ status: 0, stdout: "true\n" });
      expect(runtime.containerRunning("container-foo-abc12345")).toBe(true);
    });

    it("returns false when status is 0 but stdout is 'false'", () => {
      enqueue({ status: 0, stdout: "false\n" });
      expect(runtime.containerRunning("container-foo-abc12345")).toBe(false);
    });

    it("returns false when status is non-zero", () => {
      enqueue({ status: 1 });
      expect(runtime.containerRunning("container-foo-abc12345")).toBe(false);
    });
  });

  describe("isAvailable", () => {
    it("returns true when status is 0", () => {
      enqueue({ status: 0 });
      expect(runtime.isAvailable()).toBe(true);
    });

    it("returns false when status is non-zero", () => {
      enqueue({ status: 1 });
      expect(runtime.isAvailable()).toBe(false);
    });
  });

  describe("daemonRunning", () => {
    it("returns true when status is 0", () => {
      enqueue({ status: 0 });
      expect(runtime.daemonRunning()).toBe(true);
    });

    it("returns false when status is non-zero", () => {
      enqueue({ status: 1 });
      expect(runtime.daemonRunning()).toBe(false);
    });
  });
});

describe("stopContainerIfLastSession", () => {
  function makeSessionDir(): string {
    const dir = path.join(APPDATA_DIR, "projects", "foo-test", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("stops when no sessions exist", () => {
    const runtime = new ContainerClient(mockExecutor, "docker");
    const sessionDir = makeSessionDir();
    enqueue({ status: 0 });
    stopContainerIfLastSession(runtime, "container-foo-abc12345", sessionDir);
    const stopCall = calls.find(c => c.args[0] === "stop");
    expect(stopCall).toBeDefined();
  });

  it("skips stop when sessions are active", () => {
    const runtime = new ContainerClient(mockExecutor, "docker");
    const sessionDir = makeSessionDir();
    // Write a lock file for the current process
    const sessionFile = path.join(sessionDir, `session-${process.pid}`);
    fs.writeFileSync(sessionFile, String(process.pid));
    stopContainerIfLastSession(runtime, "container-foo-abc12345", sessionDir);
    const stopCall = calls.find(c => c.args[0] === "stop");
    expect(stopCall).toBeUndefined();
    // Clean up
    fs.unlinkSync(sessionFile);
  });
});

describe("createNewContainer", () => {
  function seedConfig() {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.mkdirSync(path.join(PROJECTS_DIR, "foo-a1b2c3d4"), { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "{}\n");
  }

  it("constructs correct docker run arguments", () => {
    seedConfig();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });

    const result = createNewContainer(
      fsReader,
      runtime,
      "container-foo-abc12345",
      "foo",
      "/home/user/foo",
      "foo-a1b2c3d4",
      [],
    );

    expect(result.ok).toBe(true);
    const runCall = calls[calls.length - 1];
    expect(runCall.command).toBe("docker");
    expect(runCall.args[0]).toBe("run");
    expect(runCall.args).toContain("-d");
    expect(runCall.args).toContain("--name");
    expect(runCall.args).toContain("container-foo-abc12345");
    expect(runCall.args).toContain("TERM=xterm-256color");
    expect(runCall.args).toContain("COLORTERM=truecolor");
    expect(runCall.args).toContain("-w");
    expect(runCall.args).toContain("/root/foo");
    expect(runCall.args).toContain("--volume");
    expect(runCall.args).toContain("/home/user/foo:/root/foo");
  });

  it("includes cliFlags in the argument list", () => {
    seedConfig();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });

    createNewContainer(
      fsReader,
      runtime,
      "container-foo-abc12345",
      "foo",
      "/home/user/foo",
      "foo-a1b2c3d4",
      ["-p", "8080:80"],
    );

    const runCall = calls[calls.length - 1];
    expect(runCall.args).toContain("-p");
    expect(runCall.args).toContain("8080:80");
  });

  it("returns failure on non-zero exit", () => {
    seedConfig();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 1 });

    const result = createNewContainer(
      fsReader,
      runtime,
      "c",
      "p",
      "/path",
      "path-a1b2c3d4",
      [],
    );
    expect(result.ok).toBe(false);
  });

  it("includes --security-opt=no-new-privileges for docker", () => {
    seedConfig();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });

    createNewContainer(
      fsReader,
      runtime,
      "container-foo-abc12345",
      "foo",
      "/home/user/foo",
      "foo-a1b2c3d4",
      [],
    );

    const runCall = calls[calls.length - 1];
    expect(runCall.args).toContain("--security-opt");
    expect(runCall.args).toContain("no-new-privileges");
    // docker should NOT have --group-add keep-groups
    expect(runCall.args).not.toContain("keep-groups");
  });

  it("includes --group-add=keep-groups for podman", () => {
    seedConfig();
    const runtime = new ContainerClient(mockExecutor, "podman");
    enqueue({ status: 0 });

    createNewContainer(
      fsReader,
      runtime,
      "container-foo-abc12345",
      "foo",
      "/home/user/foo",
      "foo-a1b2c3d4",
      [],
    );

    const runCall = calls[calls.length - 1];
    expect(runCall.args).toContain("--security-opt");
    expect(runCall.args).toContain("no-new-privileges");
    expect(runCall.args).toContain("--group-add");
    expect(runCall.args).toContain("keep-groups");
  });

  it("sets PENV_PATH and RENV_PATH env vars from mount config", () => {
    seedConfig();
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({
        penv_path: "/home/user/.venvs/myenv",
        renv_path: "/home/user/.renv",
      }) + "\n",
    );
    fs.mkdirSync("/home/user/.venvs/myenv", { recursive: true });
    fs.mkdirSync("/home/user/foo", { recursive: true });
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });

    createNewContainer(
      fsReader,
      runtime,
      "container-foo-abc12345",
      "foo",
      "/home/user/foo",
      "foo-a1b2c3d4",
      [],
    );

    const runCall = calls[calls.length - 1];
    expect(runCall.args).toContain("PENV_PATH=/home/user/.venvs/myenv");
    expect(runCall.args).toContain("RENV_PATH=/home/user/.renv");
  });

  it("does not set PENV_PATH or RENV_PATH when paths are empty", () => {
    seedConfig();
    const runtime = new ContainerClient(mockExecutor, "docker");
    enqueue({ status: 0 });

    createNewContainer(
      fsReader,
      runtime,
      "container-foo-abc12345",
      "foo",
      "/home/user/foo",
      "foo-a1b2c3d4",
      [],
    );

    const runCall = calls[calls.length - 1];
    expect(runCall.args).not.toContain("PENV_PATH=");
    expect(runCall.args).not.toContain("RENV_PATH=");
  });
});

describe("buildImage", () => {
  function seedDirs() {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "{}\n");
    fs.writeFileSync(
      path.join(APPDATA_DIR, "Dockerfile"),
      "FROM ubuntu:24.04\n",
    );
  }

  function makeStores() {
    const settingsStore = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    return { settingsStore };
  }

  it("builds image with single Dockerfile", () => {
    seedDirs();
    const runtime = new ContainerClient(mockExecutor, "docker");
    const { settingsStore } = makeStores();
    enqueue({ status: 0 });

    const result = buildImage(runtime, settingsStore, undefined, fsReader);
    expect(result.ok).toBe(true);

    const builds = calls.filter(c => c.args[0] === "build");
    expect(builds).toHaveLength(1);
  });

  it("copies managed Dockerfile to APPDATA_DIR", () => {
    seedDirs();
    const runtime = new ContainerClient(mockExecutor, "docker");
    const { settingsStore } = makeStores();
    enqueue({ status: 0 });

    buildImage(runtime, settingsStore, undefined, fsReader);

    expect(fs.existsSync(path.join(APPDATA_DIR, "Dockerfile"))).toBe(true);
  });

  it("passes build args for enabled tools and harnesses", () => {
    seedDirs();
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({ enabledTools: ["bun"], enabledHarnesses: ["claude"] })
        + "\n",
    );
    const runtime = new ContainerClient(mockExecutor, "docker");
    const { settingsStore } = makeStores();
    enqueue({ status: 0 });

    buildImage(runtime, settingsStore, undefined, fsReader);

    const buildCall = calls.find(c => c.args[0] === "build");
    expect(buildCall).toBeDefined();
    expect(buildCall!.args).toContain("--build-arg");
    expect(buildCall!.args).toContain("INSTALL_BUN=true");
    expect(buildCall!.args).toContain("INSTALL_CLAUDE=true");
  });

  it("returns failure on non-zero exit", () => {
    seedDirs();
    const runtime = new ContainerClient(mockExecutor, "docker");
    const { settingsStore } = makeStores();
    enqueue({ status: 1 });

    const result = buildImage(runtime, settingsStore, undefined, fsReader);
    expect(result.ok).toBe(false);
  });

  it("returns failure when Dockerfile is missing", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "{}\n");
    const runtime = new ContainerClient(mockExecutor, "docker");
    const { settingsStore } = makeStores();

    const result = buildImage(runtime, settingsStore, undefined, fsReader);
    expect(result.ok).toBe(false);
  });
});

describe("buildMounts", () => {
  const home = os.homedir();

  function defaultMountConfig() {
    return {
      auth_mode: "shared" as const,
      history_mode: "shared" as const,
      network: "bridge",
      keep_alive: false,
      project_readonly: false,
      penv_path: "",
      renv_path: "",
      data_branches: [] as string[],
      mount_home_children: false,
      extra_readonly: [] as string[],
      extra_readwrite: [] as string[],
      extra_ld_library_path: [] as string[],
      project_symlink_mounts: "off" as const,
      project_symlink_depth: 3,
      forward_ssh_agent: false,
      ssh_known_hosts_path: "",
    };
  }

  function seedConfig(
    enabledHarnesses: string[] = [],
    enabledTools: string[] = [],
  ) {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const config: Record<string, unknown> = {};
    if (enabledHarnesses.length > 0) config.enabledHarnesses = enabledHarnesses;
    if (enabledTools.length > 0) config.enabledTools = enabledTools;
    fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify(config) + "\n");
  }

  it("mounts project path", () => {
    seedConfig();
    const mc = defaultMountConfig();
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    expect(mounts).toContain("/home/user/foo:/root/foo");
  });

  it("mounts project read-only when configured", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.project_readonly = true;
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    expect(mounts).toContain("/home/user/foo:/root/foo:ro");
  });

  it("mounts extra_readonly paths", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.extra_readonly = ["/data/shared"];
    fs.mkdirSync("/data/shared", { recursive: true });
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    expect(mounts).toContain("/data/shared:/data/shared:ro");
  });

  it("mounts extra_readwrite paths", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.extra_readwrite = ["/tmp/cache"];
    fs.mkdirSync("/tmp/cache", { recursive: true });
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    expect(mounts).toContain("/tmp/cache:/tmp/cache");
  });

  it("mounts ssh-agent-relay when forward_ssh_agent is true", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.forward_ssh_agent = true;
    const relayDir = path.join(home, ".ssh-agent-relay");
    fs.mkdirSync(relayDir, { recursive: true });
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const sshMount = mounts.find(m => m.includes(".ssh-agent-relay"));
    expect(sshMount).toBeDefined();
    expect(sshMount).toContain(":ro");
  });

  it("skips ssh-agent-relay when forward_ssh_agent is false", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.forward_ssh_agent = false;
    fs.mkdirSync(path.join(home, ".ssh-agent-relay"), { recursive: true });
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const sshMount = mounts.find(m => m.includes(".ssh-agent-relay"));
    expect(sshMount).toBeUndefined();
  });

  it("mounts .gitconfig when present", () => {
    seedConfig();
    const mc = defaultMountConfig();
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n");
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const gitMount = mounts.find(m => m.includes(".gitconfig"));
    expect(gitMount).toBeDefined();
    expect(gitMount).toContain(":ro");
  });

  it("deduplicates mounts by container path", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.extra_readonly = ["/home/user/foo"];
    fs.mkdirSync("/home/user/foo", { recursive: true });
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const projectMounts = mounts.filter(m => m.includes("/root/foo"));
    expect(projectMounts).toHaveLength(1);
  });

  it("mounts auth config from host when auth_mode=shared and host file exists", () => {
    seedConfig(["claude"]);
    const mc = defaultMountConfig();
    mc.auth_mode = "shared";
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude.json"), "{}");
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const authMount = mounts.find(m => m.includes(".claude.json"));
    expect(authMount).toBeDefined();
    expect(authMount).toContain(path.join(home, ".claude.json"));
  });

  it("mounts auth config from managed dir when auth_mode=per_project", () => {
    seedConfig(["claude"]);
    const mc = defaultMountConfig();
    mc.auth_mode = "per_project";
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const authMount = mounts.find(m => m.includes(".claude.json"));
    expect(authMount).toBeDefined();
    expect(authMount).toContain(CONFIGS_DIR);
  });

  it("mounts history config from host when history_mode=shared and host dir exists", () => {
    seedConfig(["claude"]);
    const mc = defaultMountConfig();
    mc.history_mode = "shared";
    fs.mkdirSync(path.join(home, ".local/state/claude"), { recursive: true });
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const historyMount = mounts.find(
      m => m.includes(".local/state/claude") && !m.includes(CONFIGS_DIR),
    );
    expect(historyMount).toBeDefined();
    expect(historyMount).toContain(path.join(home, ".local/state/claude"));
  });

  it("mounts history config from managed dir when history_mode=isolated", () => {
    seedConfig(["claude"]);
    const mc = defaultMountConfig();
    mc.history_mode = "isolated";
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const historyMount = mounts.find(m => m.includes(".local/state/claude"));
    expect(historyMount).toBeDefined();
    expect(historyMount).toContain(CONFIGS_DIR);
  });

  it("mounts settings config from managed dir regardless of auth_mode", () => {
    seedConfig(["claude"]);
    const mc = defaultMountConfig();
    mc.auth_mode = "shared";
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const settingsMount = mounts.find(
      m =>
        m.includes("/root/.claude")
        && !m.includes(".claude.json")
        && !m.includes("state"),
    );
    expect(settingsMount).toBeDefined();
    expect(settingsMount).toContain(CONFIGS_DIR);
  });

  it("mounts container.bashrc when present", () => {
    seedConfig();
    const mc = defaultMountConfig();
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(CONTAINER_BASHRC_PATH, "# bashrc\n");
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const bashrcMount = mounts.find(m => m.includes("container.bashrc"));
    expect(bashrcMount).toBeDefined();
    expect(bashrcMount).toBe(
      `${CONTAINER_BASHRC_PATH}:/etc/container.bashrc:ro`,
    );
  });

  it("mounts home child directories as read-only when mount_home_children is true", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.mount_home_children = true;
    const childDir = path.join(home, "testchild123");
    fs.mkdirSync(childDir, { recursive: true });
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const childMount = mounts.find(m => m === `${childDir}:${childDir}:ro`);
    expect(childMount).toBeDefined();
    fs.rmSync(childDir, { recursive: true, force: true });
  });

  it("mounts ssh known_hosts when forward_ssh_agent and path provided", () => {
    seedConfig();
    const mc = defaultMountConfig();
    mc.forward_ssh_agent = true;
    mc.ssh_known_hosts_path = "/home/user/.ssh/known_hosts";
    fs.mkdirSync(path.join(home, ".ssh-agent-relay"), { recursive: true });
    fs.mkdirSync("/home/user/.ssh", { recursive: true });
    fs.writeFileSync("/home/user/.ssh/known_hosts", "");
    const { mounts } = buildMounts(
      fsReader,
      "/home/user/foo",
      "foo-abc12345",
      mc,
    );
    const knownHostsMount = mounts.find(m => m.includes("known_hosts"));
    expect(knownHostsMount).toBeDefined();
    expect(knownHostsMount).toContain("/root/.ssh/known_hosts:ro");
  });
});

describe("listRunningManagedContainers", () => {
  const runtime = new ContainerClient(mockExecutor, "docker");

  it("returns container names from stdout", () => {
    enqueue({
      status: 0,
      stdout: "container-foo-abc12345\ncontainer-bar-def67890\n",
    });
    const names = runtime.listRunningManagedContainers();
    expect(names).toEqual(["container-foo-abc12345", "container-bar-def67890"]);
  });

  it("returns empty array when ps fails", () => {
    enqueue({ status: 1 });
    const names = runtime.listRunningManagedContainers();
    expect(names).toEqual([]);
  });

  it("returns empty array for empty output", () => {
    enqueue({ status: 0, stdout: "" });
    const names = runtime.listRunningManagedContainers();
    expect(names).toEqual([]);
  });
});

describe("containerStartedAt", () => {
  const runtime = new ContainerClient(mockExecutor, "docker");

  it("returns timestamp string when status is 0", () => {
    enqueue({ status: 0, stdout: "2026-06-11T14:30:00.123456789Z\n" });
    const result = runtime.containerStartedAt("container-foo-abc12345");
    expect(result).toBe("2026-06-11T14:30:00.123456789Z");
  });

  it("returns null when status is non-zero", () => {
    enqueue({ status: 1 });
    const result = runtime.containerStartedAt("container-foo-abc12345");
    expect(result).toBeNull();
  });
});

describe("stopOrphanedContainers", () => {
  const runtime = new ContainerClient(mockExecutor, "docker");
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now");
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });
  it("stops orphaned container past threshold", () => {
    dateNowSpy.mockReturnValue(new Date("2026-06-11T14:10:00Z").getTime());

    enqueue({ status: 0, stdout: "container-myproject-abc12345\n" });
    enqueue({ status: 0, stdout: "2026-06-11T14:00:00Z\n" });
    enqueue({ status: 0 });

    stopOrphanedContainers(runtime);

    const stopCall = calls.find(c => c.args[0] === "stop");
    expect(stopCall).toBeDefined();
    expect(stopCall!.args).toContain("container-myproject-abc12345");
  });

  it("skips container within threshold", () => {
    dateNowSpy.mockReturnValue(new Date("2026-06-11T14:02:00Z").getTime());

    enqueue({ status: 0, stdout: "container-myproject-abc12345\n" });
    enqueue({ status: 0, stdout: "2026-06-11T14:00:00Z\n" });

    stopOrphanedContainers(runtime);

    const stopCall = calls.find(c => c.args[0] === "stop");
    expect(stopCall).toBeUndefined();
  });

  it("skips container when startedAt returns null", () => {
    dateNowSpy.mockReturnValue(new Date("2026-06-11T14:10:00Z").getTime());

    enqueue({ status: 0, stdout: "container-myproject-abc12345\n" });
    enqueue({ status: 1 });

    stopOrphanedContainers(runtime);

    const stopCall = calls.find(c => c.args[0] === "stop");
    expect(stopCall).toBeUndefined();
  });

  it("processes multiple containers", () => {
    dateNowSpy.mockReturnValue(new Date("2026-06-11T14:10:00Z").getTime());

    enqueue({
      status: 0,
      stdout: "container-foo-abc12345\ncontainer-bar-def67890\n",
    });
    enqueue({ status: 0, stdout: "2026-06-11T14:00:00Z\n" });
    enqueue({ status: 0, stdout: "2026-06-11T14:00:00Z\n" });
    enqueue({ status: 0 });
    enqueue({ status: 0 });

    stopOrphanedContainers(runtime);

    const stopCalls = calls.filter(c => c.args[0] === "stop");
    expect(stopCalls).toHaveLength(2);
  });
});
