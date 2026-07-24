import path from "path";
import { StateSchema, Result, StateData, ConfigMount, Settings } from "./types";
import { Filesystem } from "./platform/fs";
import { CONFIGS_DIR } from "./platform/paths";
import { GlobalMountConfigSchema } from "./mount-config";

export function configMountSourcePath(config: ConfigMount): string {
  return path.join(CONFIGS_DIR, config.config);
}

export function ensureConfigExists(fs: Filesystem, config: ConfigMount): void {
  const destPath = configMountSourcePath(config);

  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    if (config.kind === "file" && stat.isFile()) return;
    if (config.kind === "directory" && stat.isDirectory()) return;
    fs.rmSync(destPath, { recursive: true, force: true });
  }

  const parentDir = path.dirname(destPath);
  if (!fs.existsSync(parentDir)) {
    fs.secureMkdir(parentDir);
  }

  if (config.kind === "file") {
    fs.secureWriteFile(destPath, config.defaultContents ?? "");
    return;
  }

  fs.secureMkdir(destPath);
}

function parseConfig(content: string): Result<Settings> {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const result = GlobalMountConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: "validation_failed" };
  }
  return { ok: true, value: result.data };
}

function parseState(content: string): Result<StateData> {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const result = StateSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: "validation_failed" };
  }
  return { ok: true, value: result.data };
}

export class SettingsStore {
  private readonly configPath: string;

  constructor(
    private fs: Filesystem,
    filePath: string,
  ) {
    this.configPath = filePath;
  }

  load(): Result<Settings> {
    if (!this.fs.existsSync(this.configPath)) {
      return { ok: true, value: GlobalMountConfigSchema.parse({}) };
    }
    const content = this.fs.readFileSync(this.configPath, "utf-8");
    return parseConfig(content);
  }

  save(data: Settings): Result<void> {
    this.fs.ensureAppdataDir();
    try {
      this.fs.secureWriteFile(this.configPath, JSON.stringify(data, null, 2));
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: "permission_denied" };
    }
  }
}

export class StateStore {
  constructor(
    private fs: Filesystem,
    private filePath: string,
  ) {}

  load(): Result<StateData> {
    if (!this.fs.existsSync(this.filePath)) {
      return { ok: true, value: {} };
    }
    const content = this.fs.readFileSync(this.filePath, "utf-8");
    return parseState(content);
  }

  save(data: StateData): Result<void> {
    this.fs.ensureTempDir();
    try {
      this.fs.secureWriteFile(this.filePath, JSON.stringify(data, null, 2));
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: "permission_denied" };
    }
  }
}
