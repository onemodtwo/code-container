import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fs, vol } from "memfs";
import {
  APPDATA_DIR,
  CONFIGS_DIR,
  TEMP_DIR,
  CONFIG_JSON_PATH,
  STATE_PATH,
} from "../src/platform/paths";
import { configMountSourcePath, ensureConfigExists, SettingsStore, StateStore } from "../src/config";
import { FsReader, Filesystem } from "../src/platform/fs";
import { maybeCheckForUpdate } from "../src/update-check";
import { ConfigMount } from "../src/types";

const CONFIG_DIR = path.dirname(CONFIG_JSON_PATH);
const fsReader = new Filesystem(fs as unknown as FsReader);

vi.mock("fs");

beforeEach(() => {
  vol.reset();
});

describe("SettingsStore", () => {
  it("returns default config when file does not exist", () => {
    const store = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    const result = store.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.base_image).toBe("ubuntu:24.04");
    expect(result.value.runtime).toBeUndefined();
    expect(result.value.enabledHarnesses).toBeUndefined();
  });

  it("loads parsed settings from valid JSON", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({ runtime: "docker", onboardingVersion: 3 }),
    );
    const store = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    const result = store.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtime).toBe("docker");
    expect(result.value.onboardingVersion).toBe(3);
  });

  it("returns error on invalid JSON", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, "not json");
    const store = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    const result = store.load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_json");
  });

  it("returns error when settings fail Zod validation", () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({ runtime: "not_a_runtime" }),
    );
    const store = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    const result = store.load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("validation_failed");
  });
});

describe("StateStore", () => {
  it("returns empty object when file does not exist", () => {
    const store = new StateStore(fsReader, STATE_PATH);
    const result = store.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({});
  });

  it("loads state from valid JSON", () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ lastUpgradeTime: 123 }),
    );
    const store = new StateStore(fsReader, STATE_PATH);
    const result = store.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      lastUpgradeTime: 123,
    });
  });

  it("returns error on invalid JSON", () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, "bad");
    const store = new StateStore(fsReader, STATE_PATH);
    const result = store.load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_json");
  });
});

describe("SettingsStore save", () => {
  it("writes settings as JSON and creates dirs", () => {
    const store = new SettingsStore(fsReader, CONFIG_JSON_PATH);
    const result = store.save({ runtime: "docker" });
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(CONFIG_JSON_PATH, "utf-8") as string;
    expect(JSON.parse(content)).toEqual({ runtime: "docker" });
    expect(fs.existsSync(APPDATA_DIR)).toBe(true);
  });
});

describe("StateStore save", () => {
  it("writes state as JSON and creates dirs", () => {
    const store = new StateStore(fsReader, STATE_PATH);
    const result = store.save({ lastUpgradeTime: 456 });
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(STATE_PATH, "utf-8") as string;
    expect(JSON.parse(content)).toEqual({ lastUpgradeTime: 456 });
    expect(fs.existsSync(TEMP_DIR)).toBe(true);
  });
});

describe("maybeCheckForUpdate", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("skips check if upgraded within one day", async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ lastUpgradeTime: Date.now() - 1000 }),
    );
    const store = new StateStore(fsReader, STATE_PATH);
    const result = await maybeCheckForUpdate(store, "3.0.0");
    expect(result).toBe(null);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns update info when newer version available", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v3.1.0" }),
    });
    const store = new StateStore(fsReader, STATE_PATH);
    const result = await maybeCheckForUpdate(store, "3.0.0");
    expect(result).toEqual({ current: "3.0.0", latest: "3.1.0" });
  });

  it("returns null for same version", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v3.0.0" }),
    });
    const store = new StateStore(fsReader, STATE_PATH);
    const result = await maybeCheckForUpdate(store, "3.0.0");
    expect(result).toBe(null);
  });

  it("returns null and does not update state on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("network"));
    const store = new StateStore(fsReader, STATE_PATH);
    const result = await maybeCheckForUpdate(store, "3.0.0");
    expect(result).toBe(null);
    const saved = store.load();
    if (saved.ok) {
      expect(saved.value.lastUpgradeTime).toBeUndefined();
    }
  });
});

describe("configMountSourcePath", () => {
  it("returns CONFIGS_DIR/config", () => {
    const mount: ConfigMount = {
      host: "~/.claude",
      config: ".claude",
      mount: "/root/.claude",
      kind: "directory",
    };
    expect(configMountSourcePath(mount)).toBe(path.join(CONFIGS_DIR, ".claude"));
  });

  it("handles nested config paths", () => {
    const mount: ConfigMount = {
      host: "~/.local/state/claude",
      config: ".local/state/claude",
      mount: "/root/.local/state/claude",
      kind: "directory",
    };
    expect(configMountSourcePath(mount)).toBe(
      path.join(CONFIGS_DIR, ".local/state/claude"),
    );
  });

  it("handles file config paths", () => {
    const mount: ConfigMount = {
      host: "~/.claude.json",
      config: ".claude.json",
      mount: "/root/.claude.json",
      kind: "file",
    };
    expect(configMountSourcePath(mount)).toBe(
      path.join(CONFIGS_DIR, ".claude.json"),
    );
  });
});

describe("ensureConfigExists", () => {
  it("creates a directory config when it does not exist", () => {
    fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    const mount: ConfigMount = {
      host: "~/.claude",
      config: ".claude",
      mount: "/root/.claude",
      kind: "directory",
    };
    ensureConfigExists(fsReader, mount);
    const dest = path.join(CONFIGS_DIR, ".claude");
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).isDirectory()).toBe(true);
  });

  it("creates a file config with default contents when it does not exist", () => {
    fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    const mount: ConfigMount = {
      host: "~/.claude.json",
      config: ".claude.json",
      mount: "/root/.claude.json",
      kind: "file",
      defaultContents: "{}\n",
    };
    ensureConfigExists(fsReader, mount);
    const dest = path.join(CONFIGS_DIR, ".claude.json");
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).isFile()).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toBe("{}\n");
  });

  it("creates a file config with empty contents when no default provided", () => {
    fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    const mount: ConfigMount = {
      host: "~/.test",
      config: ".test",
      mount: "/root/.test",
      kind: "file",
    };
    ensureConfigExists(fsReader, mount);
    const dest = path.join(CONFIGS_DIR, ".test");
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toBe("");
  });

  it("skips creation when directory config already exists", () => {
    const dest = path.join(CONFIGS_DIR, ".claude");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "settings.json"), "{}");
    const mount: ConfigMount = {
      host: "~/.claude",
      config: ".claude",
      mount: "/root/.claude",
      kind: "directory",
    };
    ensureConfigExists(fsReader, mount);
    // Original file should still be there
    expect(fs.existsSync(path.join(dest, "settings.json"))).toBe(true);
  });

  it("skips creation when file config already exists", () => {
    const dest = path.join(CONFIGS_DIR, ".claude.json");
    fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    fs.writeFileSync(dest, '{"custom": true}');
    const mount: ConfigMount = {
      host: "~/.claude.json",
      config: ".claude.json",
      mount: "/root/.claude.json",
      kind: "file",
      defaultContents: "{}\n",
    };
    ensureConfigExists(fsReader, mount);
    expect(fs.readFileSync(dest, "utf-8")).toBe('{"custom": true}');
  });

  it("replaces wrong kind: file where directory expected", () => {
    const dest = path.join(CONFIGS_DIR, ".claude");
    fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    // Create a FILE at the path where a directory is expected
    fs.writeFileSync(dest, "I am a file");
    const mount: ConfigMount = {
      host: "~/.claude",
      config: ".claude",
      mount: "/root/.claude",
      kind: "directory",
    };
    ensureConfigExists(fsReader, mount);
    expect(fs.statSync(dest).isDirectory()).toBe(true);
  });

  it("replaces wrong kind: directory where file expected", () => {
    const dest = path.join(CONFIGS_DIR, ".claude.json");
    fs.mkdirSync(CONFIGS_DIR, { recursive: true });
    fs.mkdirSync(dest);
    const mount: ConfigMount = {
      host: "~/.claude.json",
      config: ".claude.json",
      mount: "/root/.claude.json",
      kind: "file",
      defaultContents: "{}\n",
    };
    ensureConfigExists(fsReader, mount);
    expect(fs.statSync(dest).isFile()).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toBe("{}\n");
  });

  it("creates parent directories when needed", () => {
    const mount: ConfigMount = {
      host: "~/.local/state/claude",
      config: ".local/state/claude",
      mount: "/root/.local/state/claude",
      kind: "directory",
    };
    ensureConfigExists(fsReader, mount);
    const dest = path.join(CONFIGS_DIR, ".local/state/claude");
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).isDirectory()).toBe(true);
  });
});
