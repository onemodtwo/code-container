import path from "path";
import os from "os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fs, vol } from "memfs";
import { FsReader, Filesystem } from "../src/platform/fs";
import {
  APPDATA_DIR,
  CONFIG_JSON_PATH,
  PROJECTS_DIR,
} from "../src/platform/paths";
import {
  loadGlobalConfig,
  loadMountConfig,
  ensureHostConfig,
  generateProjectHash,
  generateProjectDirName,
  HOST_CONFIG_PATH,
} from "../src/mount-config";

vi.mock("fs");

const fsReader = new Filesystem(fs as unknown as FsReader);

beforeEach(() => {
  vol.reset();
});

describe("loadGlobalConfig", () => {
  it("returns defaults when config.json does not exist", () => {
    const config = loadGlobalConfig();
    expect(config.base_image).toBe("ubuntu:24.04");
    expect(config.timezone).toBe("UTC");
    expect(config.container_runtime).toBe("docker");
    expect(config.auth_mode).toBe("shared");
    expect(config.history_mode).toBe("shared");
    expect(config.keep_alive).toBe(false);
    expect(config.mount_home_children).toBe(true);
  });

  it("loads config from config.json", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({
        base_image: "debian:bookworm",
        timezone: "US/Eastern",
        auth_mode: "per_project",
        enabledHarnesses: ["claude"],
      }) + "\n",
    );
    const config = loadGlobalConfig();
    expect(config.base_image).toBe("debian:bookworm");
    expect(config.timezone).toBe("US/Eastern");
    expect(config.auth_mode).toBe("per_project");
    expect(config.enabledHarnesses).toEqual(["claude"]);
  });

  it("returns defaults on invalid JSON", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "not json");
    const config = loadGlobalConfig();
    expect(config.base_image).toBe("ubuntu:24.04");
  });
});

describe("loadMountConfig", () => {
  function seedGlobal(overrides: Record<string, unknown> = {}) {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify(overrides) + "\n");
  }

  it("returns global config when no override exists", () => {
    seedGlobal({ auth_mode: "per_project" });
    const mc = loadMountConfig("foo-abc12345");
    expect(mc.auth_mode).toBe("per_project");
    expect(mc.history_mode).toBe("shared");
    expect(mc.project_readonly).toBe(false);
  });

  it("applies project override for auth_mode", () => {
    seedGlobal({ auth_mode: "shared" });
    const projectDir = path.join(PROJECTS_DIR, "foo-abc12345");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "override.json"),
      JSON.stringify({ auth_mode: "per_project" }) + "\n",
    );
    const mc = loadMountConfig("foo-abc12345");
    expect(mc.auth_mode).toBe("per_project");
    expect(mc.history_mode).toBe("shared");
  });

  it("applies project override for history_mode", () => {
    seedGlobal({ history_mode: "shared" });
    const projectDir = path.join(PROJECTS_DIR, "bar-def67890");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "override.json"),
      JSON.stringify({ history_mode: "isolated" }) + "\n",
    );
    const mc = loadMountConfig("bar-def67890");
    expect(mc.history_mode).toBe("isolated");
  });

  it("merges extra_readonly from global and override", () => {
    seedGlobal({ extra_readonly: ["/data/shared"] });
    const projectDir = path.join(PROJECTS_DIR, "baz-12345678");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "override.json"),
      JSON.stringify({ extra_readonly: ["/tmp/cache"] }) + "\n",
    );
    const mc = loadMountConfig("baz-12345678");
    expect(mc.extra_readonly).toContain("/data/shared");
    expect(mc.extra_readonly).toContain("/tmp/cache");
  });

  it("applies project_readonly from override", () => {
    seedGlobal();
    const projectDir = path.join(PROJECTS_DIR, "ro-test-12345678");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "override.json"),
      JSON.stringify({ project_readonly: true }) + "\n",
    );
    const mc = loadMountConfig("ro-test-12345678");
    expect(mc.project_readonly).toBe(true);
  });
});

describe("ensureHostConfig", () => {
  it("creates config.json when it does not exist", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    ensureHostConfig();
    expect(fs.existsSync(HOST_CONFIG_PATH)).toBe(true);
    const content = JSON.parse(
      fs.readFileSync(HOST_CONFIG_PATH, "utf-8") as string,
    );
    expect(content.base_image).toBe("ubuntu:24.04");
    expect(content.auth_mode).toBe("shared");
  });

  it("does not overwrite existing config.json", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(
      HOST_CONFIG_PATH,
      JSON.stringify({ base_image: "custom:latest" }) + "\n",
    );
    ensureHostConfig();
    const content = JSON.parse(
      fs.readFileSync(HOST_CONFIG_PATH, "utf-8") as string,
    );
    expect(content.base_image).toBe("custom:latest");
  });
});

describe("generateProjectHash", () => {
  it("returns an 8-character hex hash", () => {
    const hash = generateProjectHash("/home/user/project");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns the same hash for the same path", () => {
    const h1 = generateProjectHash("/home/user/project");
    const h2 = generateProjectHash("/home/user/project");
    expect(h1).toBe(h2);
  });

  it("returns different hashes for different paths", () => {
    const h1 = generateProjectHash("/home/user/project-a");
    const h2 = generateProjectHash("/home/user/project-b");
    expect(h1).not.toBe(h2);
  });
});

describe("generateProjectDirName", () => {
  it("returns project-name-hash format", () => {
    const name = generateProjectDirName("/home/user/myproject");
    expect(name).toMatch(/^myproject-[0-9a-f]{8}$/);
  });

  it("is deterministic for the same path", () => {
    const n1 = generateProjectDirName("/home/user/project");
    const n2 = generateProjectDirName("/home/user/project");
    expect(n1).toBe(n2);
  });
});
