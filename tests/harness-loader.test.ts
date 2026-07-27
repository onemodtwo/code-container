import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";
import { loadHarnessPack } from "../src/harness-loader";
import { Executor } from "../src/platform/shell";

vi.mock("fs");

function makeExecutor(detectCommand: string): Executor {
  return {
    spawnSync(command: string, args: string[]) {
      if (
        (command === "which" || command === "where")
        && args[0] === detectCommand
      ) {
        return { status: 0, stdout: `/usr/bin/${detectCommand}`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    },
  };
}

beforeEach(() => {
  vol.reset();
});

describe("loadHarnessPack", () => {
  it("parses a valid harness config", () => {
    const yaml = `
id: test-harness
name: Test Harness
detect:
  command: test-binary
install:
  - "RUN npm install -g test-harness"
config:
  - host: ~/.test-harness
    container: /root/.test-harness
    kind: directory
    role: data
`;
    const pack = loadHarnessPack(yaml);
    expect(pack.id).toBe("test-harness");
    expect(pack.name).toBe("Test Harness");
    const executor = makeExecutor("test-binary");
    expect(pack.shouldEnable(executor)).toBe(true);
    expect(pack.dockerfileLines).toEqual(["RUN npm install -g test-harness"]);
    expect(pack.buildArgName).toBe("INSTALL_TEST-HARNESS");
    expect(pack.config).toHaveLength(1);
    expect(pack.config[0].host).toBe("~/.test-harness");
    expect(pack.config[0].config).toBe(".test-harness");
    expect(pack.config[0].mount).toBe("/root/.test-harness");
    expect(pack.config[0].kind).toBe("directory");
    expect(pack.config[0].role).toBe("data");
  });

  it("derives config path from host by stripping ~/", () => {
    const yaml = `
id: test
name: Test
detect:
  command: test
config:
  - host: ~/.local/state/test
    container: /root/.local/state/test
    kind: directory
    role: data
`;
    const pack = loadHarnessPack(yaml);
    expect(pack.config[0].config).toBe(".local/state/test");
  });

  it("requires role on every mount entry", () => {
    const yaml = `
id: test
name: Test
detect:
  command: test
config:
  - host: ~/.test
    container: /root/.test
    kind: directory
`;
    expect(() => loadHarnessPack(yaml)).toThrow();
  });

  it("parses file kind with default_contents", () => {
    const yaml = `id: test
name: Test
detect:
  command: test
config:
  - host: ~/.test.json
    container: /root/.test.json
    kind: file
    role: auth
    readonly: true
    default_contents: '{}\\n'
`;
    const pack = loadHarnessPack(yaml);
    expect(pack.config[0].kind).toBe("file");
    expect(pack.config[0].readonly).toBe(true);
    if (pack.config[0].kind === "file") {
      expect(pack.config[0].defaultContents).toBe("{}\\n");
    }
  });

  it("applies platform overrides to detect command", () => {
    const yaml = `
id: test
name: Test
detect:
  command: test-generic
config:
  - host: ~/.test
    container: /root/.test
    kind: directory
    role: data
platforms:
  linux:
    detect:
      command: test-linux
`;
    const pack = loadHarnessPack(yaml);
    const linuxExecutor = makeExecutor("test-linux");
    const genericExecutor = makeExecutor("test-generic");
    expect(pack.shouldEnable(linuxExecutor)).toBe(true);
    expect(pack.shouldEnable(genericExecutor)).toBe(false);
  });

  it("merges platform config overrides by container path", () => {
    const yaml = `
id: test
name: Test
detect:
  command: test
config:
  - host: ~/.test
    container: /root/.test
    kind: directory
    role: data
  - host: ~/.test2
    container: /root/.test2
    kind: directory
    role: settings
platforms:
  linux:
    config:
      - host: ~/.test-linux
        container: /root/.test
        kind: directory
        role: auth
`;
    const pack = loadHarnessPack(yaml);
    expect(pack.config).toHaveLength(2);
    expect(pack.config[0].host).toBe("~/.test-linux");
    expect(pack.config[0].role).toBe("auth");
    expect(pack.config[1].host).toBe("~/.test2");
  });

  it("returns shouldEnable=false for unknown command", () => {
    const yaml = `
id: test
name: Test
detect:
  command: nonexistent-binary-xyz
config:
  - host: ~/.test
    container: /root/.test
    kind: directory
    role: data
`;
    const pack = loadHarnessPack(yaml);
    expect(pack.shouldEnable(makeExecutor("something-else"))).toBe(false);
  });
});
