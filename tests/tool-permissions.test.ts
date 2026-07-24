import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import os from "os";
import rawFs from "fs";
import { Filesystem } from "../src/platform/fs";
import {
  mergePermissionsIntoConfig,
  ToolPermissions,
} from "../src/tool-permissions";

let tmpDir: string;
let fs: Filesystem;

beforeEach(() => {
  tmpDir = rawFs.mkdtempSync(path.join(os.tmpdir(), "tp-test-"));
  fs = new Filesystem(rawFs);
});

function writeJson(filePath: string, data: Record<string, unknown>): void {
  rawFs.mkdirSync(path.dirname(filePath), { recursive: true });
  rawFs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(rawFs.readFileSync(filePath, "utf-8"));
}

describe("mergePermissionsIntoConfig", () => {
  describe("Claude", () => {
    it("creates settings.json with permissions when no file exists", () => {
      const tp: ToolPermissions = {
        allow: ["Bash(*)", "Read"],
        deny: ["Bash(curl*)"],
      };

      mergePermissionsIntoConfig(fs, "claude", tp, tmpDir);
      const result = readJson(path.join(tmpDir, ".claude", "settings.json"));
      expect(result).toEqual({
        permissions: {
          allow: ["Bash(*)", "Read"],
          deny: ["Bash(curl*)"],
        },
      });
    });

    it("merges permissions into existing settings.json", () => {
      const settingsPath = path.join(tmpDir, ".claude", "settings.json");
      writeJson(settingsPath, {
        permissions: {
          allow: ["Read", "Bash(npm test *)"],
          deny: ["Bash(rm -rf *)"],
        },
      });

      const tp: ToolPermissions = {
        allow: ["Bash(*)", "Read", "Write"],
        deny: ["Bash(curl*)"],
      };

      mergePermissionsIntoConfig(fs, "claude", tp, tmpDir);
      const result = readJson(settingsPath);
      expect(result.permissions.allow).toEqual(
        expect.arrayContaining([
          "Read",
          "Bash(npm test *)",
          "Bash(*)",
          "Write",
        ]),
      );
      expect(result.permissions.allow).toHaveLength(4);
      expect(result.permissions.deny).toEqual(
        expect.arrayContaining(["Bash(rm -rf *)", "Bash(curl*)"]),
      );
      expect(result.permissions.deny).toHaveLength(2);
    });

    it("deduplicates permission rules", () => {
      const settingsPath = path.join(tmpDir, ".claude", "settings.json");
      writeJson(settingsPath, {
        permissions: {
          allow: ["Read"],
          deny: [],
        },
      });

      const tp: ToolPermissions = {
        allow: ["Read", "Write"],
        deny: [],
      };

      mergePermissionsIntoConfig(fs, "claude", tp, tmpDir);
      const result = readJson(settingsPath);
      expect(result.permissions.allow).toEqual(["Read", "Write"]);
    });
  });

  describe("OpenCode", () => {
    it("creates opencode.json with permission when no file exists", () => {
      const tp: ToolPermissions = {
        allow: ["Bash(*)", "Read", "Write"],
        deny: ["Bash(curl*)", "Bash(wget*)"],
      };

      mergePermissionsIntoConfig(fs, "opencode", tp, tmpDir);
      const result = readJson(path.join(tmpDir, ".opencode", "opencode.json"));
      expect(result.permission).toBeDefined();
      expect(result.permission.bash).toEqual({
        "*": "allow",
        "curl *": "deny",
        "wget *": "deny",
      });
      expect(result.permission.read).toBe("allow");
      expect(result.permission.edit).toBe("allow");
    });

    it("merges permissions into existing opencode.json", () => {
      const configPath = path.join(tmpDir, ".opencode", "opencode.json");
      writeJson(configPath, {
        permission: {
          read: "ask",
          bash: { "*": "ask", "git *": "allow" },
        },
      });

      const tp: ToolPermissions = {
        allow: ["Bash(*)", "Read", "Write"],
        deny: ["Bash(curl*)"],
      };

      mergePermissionsIntoConfig(fs, "opencode", tp, tmpDir);
      const result = readJson(configPath);
      expect(result.permission.read).toBe("allow");
      expect(result.permission.bash["git *"]).toBe("allow");
      expect(result.permission.bash["*"]).toBe("allow");
      expect(result.permission.bash["curl *"]).toBe("deny");
      expect(result.permission.edit).toBe("allow");
    });

    it("translates multi-word tool names correctly", () => {
      const tp: ToolPermissions = {
        allow: ["WebFetch", "WebSearch", "TodoRead", "TodoWrite", "LSP"],
        deny: [],
      };

      mergePermissionsIntoConfig(fs, "opencode", tp, tmpDir);
      const result = readJson(path.join(tmpDir, ".opencode", "opencode.json"));
      expect(result.permission.webfetch).toBe("allow");
      expect(result.permission.websearch).toBe("allow");
      expect(result.permission.task).toBe("allow");
      expect(result.permission.lsp).toBe("allow");
    });

    it("maps Write/Edit/MultiEdit to edit", () => {
      const tp: ToolPermissions = {
        allow: ["Write", "Edit", "MultiEdit"],
        deny: [],
      };

      mergePermissionsIntoConfig(fs, "opencode", tp, tmpDir);
      const result = readJson(path.join(tmpDir, ".opencode", "opencode.json"));
      expect(result.permission.edit).toBe("allow");
    });
  });

  describe("unknown harness", () => {
    it("does nothing for unknown harness ids", () => {
      const tp: ToolPermissions = { allow: ["*"], deny: [] };
      mergePermissionsIntoConfig(fs, "unknown", tp, tmpDir);
      // Should not throw, no files created
      expect(rawFs.existsSync(path.join(tmpDir, ".unknown"))).toBe(false);
    });
  });
});
