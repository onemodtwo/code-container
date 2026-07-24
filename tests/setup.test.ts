import { describe, it, expect, vi, beforeEach } from "vitest";
import { fs, vol } from "memfs";
import {
  APPDATA_DIR,
  CONFIGS_DIR,
  TEMP_DIR,
  USER_DOCKERFILE_PATH,
  CONFIG_JSON_PATH,
  PROJECTS_DIR,
} from "../src/platform/paths";
import { FsReader, Filesystem } from "../src/platform/fs";
import { runSetup, USER_DOCKERFILE_TEMPLATE } from "../src/setup";

const fsReader = new Filesystem(fs as unknown as FsReader);

vi.mock("fs");

beforeEach(() => {
  vol.reset();
});

describe("runSetup", () => {
  it("creates runtime directories and seeds Dockerfile.User", () => {
    runSetup(fsReader);

    expect(fs.existsSync(APPDATA_DIR)).toBe(true);
    expect(fs.existsSync(CONFIGS_DIR)).toBe(true);
    expect(fs.existsSync(TEMP_DIR)).toBe(true);
    expect(fs.existsSync(PROJECTS_DIR)).toBe(true);
    expect(fs.readFileSync(USER_DOCKERFILE_PATH, "utf-8")).toBe(
      USER_DOCKERFILE_TEMPLATE,
    );
    expect(fs.existsSync(CONFIG_JSON_PATH)).toBe(true);
  });

  it("does not overwrite an existing Dockerfile.User", () => {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.writeFileSync(USER_DOCKERFILE_PATH, "FROM custom\n");

    runSetup(fsReader);

    expect(fs.readFileSync(USER_DOCKERFILE_PATH, "utf-8")).toBe(
      "FROM custom\n",
    );
  });
});
