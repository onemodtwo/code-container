import fs from "fs";
import path from "path";
import { PROJECTS_DIR } from "./platform/paths";

const SESSION_PREFIX = "session-";

export function trackSessionStart(sessionDir: string): string {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, `${SESSION_PREFIX}${process.pid}`);
  fs.writeFileSync(sessionFile, String(process.pid), { mode: 0o600 });
  return sessionFile;
}

export function trackSessionEnd(sessionFile: string): void {
  try {
    fs.unlinkSync(sessionFile);
  } catch {
    /* already gone */
  }
}

export function countActiveSessions(sessionDir: string): number {
  if (!fs.existsSync(sessionDir)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(sessionDir)) {
    if (!file.startsWith(SESSION_PREFIX)) continue;
    const pid = parseInt(file.slice(SESSION_PREFIX.length), 10);
    if (isNaN(pid)) continue;
    try {
      process.kill(pid, 0);
      count++;
    } catch {
      // PID not running — stale lock file from a crash; clean it up
      try {
        fs.unlinkSync(path.join(sessionDir, file));
      } catch {
        /* ignore */
      }
    }
  }
  return count;
}

export function getSessionDir(projectDirName: string): string {
  return path.join(PROJECTS_DIR, projectDirName, "sessions");
}
