import path from "path";
import { Filesystem } from "./platform/fs";
import { CONFIGS_DIR } from "./platform/paths";

export interface ToolPermissions {
  allow: string[];
  deny: string[];
}

const TOOL_NAME_MAP: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  glob: "glob",
  grep: "grep",
  webfetch: "webfetch",
  websearch: "websearch",
  agent: "task",
  todoread: "task",
  todowrite: "task",
  notebookread: "read",
  notebookedit: "edit",
  lsp: "lsp",
};

const HARNESS_PERMISSION_FILES: Record<string, string> = {
  claude: "settings.json",
  opencode: "opencode.json",
};

const HARNESS_CONFIG_DIRS: Record<string, string> = {
  claude: ".claude",
  opencode: ".opencode",
};

function parseRule(rule: string): { tool: string; pattern: string } {
  const match = rule.match(/^(\w+)\((.+)\)$/);
  if (match) {
    const tool =
      TOOL_NAME_MAP[match[1].toLowerCase()] || match[1].toLowerCase();
    let pattern = match[2];

    if (
      tool === "bash"
      && pattern.endsWith("*")
      && !pattern.includes(" ")
      && pattern !== "*"
    ) {
      pattern = pattern.slice(0, -1) + " *";
    }

    return { tool, pattern };
  }

  const tool = TOOL_NAME_MAP[rule.toLowerCase()] || rule.toLowerCase();
  return { tool, pattern: "" };
}

function translateToOpenCodePermissions(
  tp: ToolPermissions,
): Record<string, unknown> {
  const permission: Record<string, unknown> = {};

  for (const rule of tp.allow) {
    const { tool, pattern } = parseRule(rule);
    if (tool === "*") {
      permission["*"] = "allow";
    } else if (pattern === "") {
      permission[tool] = "allow";
    } else {
      if (!permission[tool]) {
        permission[tool] = {};
      }
      if (typeof permission[tool] === "string") {
        const prevValue = permission[tool] as string;
        permission[tool] = { "*": prevValue };
      }
      (permission[tool] as Record<string, string>)[pattern] = "allow";
    }
  }

  for (const rule of tp.deny) {
    const { tool, pattern } = parseRule(rule);
    if (tool === "*") {
      permission["*"] = "deny";
    } else if (pattern === "") {
      permission[tool] = "deny";
    } else {
      if (!permission[tool]) {
        permission[tool] = {};
      }
      if (typeof permission[tool] === "string") {
        const prevValue = permission[tool] as string;
        permission[tool] = { "*": prevValue };
      }
      (permission[tool] as Record<string, string>)[pattern] = "deny";
    }
  }

  return permission;
}

function deepMergePermission(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "object" && value !== null) {
      if (typeof result[key] === "object" && result[key] !== null) {
        result[key] = deepMergePermission(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

export function mergePermissionsIntoConfig(
  fs: Filesystem,
  harnessId: string,
  tp: ToolPermissions,
  configsDir: string = CONFIGS_DIR,
): void {
  const configDir = HARNESS_CONFIG_DIRS[harnessId];
  const fileName = HARNESS_PERMISSION_FILES[harnessId];
  if (!configDir || !fileName) return;

  const configPath = path.join(configsDir, configDir);
  const filePath = path.join(configPath, fileName);

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configPath, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, "utf-8") as string);
    } catch {
      // If JSON is invalid, start fresh
    }
  }

  let merged: Record<string, unknown>;

  if (harnessId === "claude") {
    const existingPerms = (existing.permissions ?? {}) as Record<
      string,
      unknown
    >;
    const existingAllow = (existingPerms.allow ?? []) as string[];
    const existingDeny = (existingPerms.deny ?? []) as string[];

    merged = {
      ...existing,
      permissions: {
        allow: [...new Set([...existingAllow, ...tp.allow])],
        deny: [...new Set([...existingDeny, ...tp.deny])],
      },
    };
  } else if (harnessId === "opencode") {
    const newPermission = translateToOpenCodePermissions(tp);
    merged = {
      ...existing,
      permission: deepMergePermission(
        (existing.permission ?? {}) as Record<string, unknown>,
        newPermission,
      ),
    };
  } else {
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n");
}
