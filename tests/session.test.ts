import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fs, vol } from "memfs";
import {
  trackSessionStart,
  trackSessionEnd,
  countActiveSessions,
  getSessionDir,
} from "../src/session";
import { PROJECTS_DIR } from "../src/platform/paths";

vi.mock("fs");
const mockFs = fs as unknown as typeof import("fs");

beforeEach(() => {
  vol.reset();
  vi.restoreAllMocks();
});

describe("trackSessionStart", () => {
  it("creates session dir and writes PID file", () => {
    const sessionDir = "/projects/foo/sessions";
    const sessionFile = trackSessionStart(sessionDir);
    expect(sessionFile).toBe(
      path.join(sessionDir, `session-${process.pid}`),
    );
    expect(mockFs.existsSync(sessionFile)).toBe(true);
    const content = mockFs.readFileSync(sessionFile, "utf-8");
    expect(String(process.pid)).toBe(String(Number(content)));
  });

  it("creates session dir with mode 0o700", () => {
    const sessionDir = "/projects/foo/sessions";
    trackSessionStart(sessionDir);
    const stat = mockFs.statSync(sessionDir);
    // 0o700 = 448 decimal
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("overwrites existing session file for same PID", () => {
    const sessionDir = "/projects/foo/sessions";
    trackSessionStart(sessionDir);
    // Call again — should not throw
    trackSessionStart(sessionDir);
    expect(mockFs.existsSync(sessionDir)).toBe(true);
  });
});

describe("trackSessionEnd", () => {
  it("deletes the session file", () => {
    const sessionFile = "/projects/foo/sessions/session-12345";
    mockFs.mkdirSync("/projects/foo/sessions", { recursive: true });
    mockFs.writeFileSync(sessionFile, "12345");
    trackSessionEnd(sessionFile);
    expect(mockFs.existsSync(sessionFile)).toBe(false);
  });

  it("does not throw when file is already gone", () => {
    expect(() => trackSessionEnd("/nonexistent/file")).not.toThrow();
  });
});

describe("countActiveSessions", () => {
  it("returns 0 when session dir does not exist", () => {
    expect(countActiveSessions("/nonexistent")).toBe(0);
  });

  it("returns 0 when session dir is empty", () => {
    mockFs.mkdirSync("/projects/foo/sessions", { recursive: true });
    expect(countActiveSessions("/projects/foo/sessions")).toBe(0);
  });

  it("counts live processes and cleans stale ones", () => {
    const sessionDir = "/projects/foo/sessions";
    mockFs.mkdirSync(sessionDir, { recursive: true });

    // Write three session files: two live, one stale
    mockFs.writeFileSync(
      path.join(sessionDir, "session-100"),
      "100",
    );
    mockFs.writeFileSync(
      path.join(sessionDir, "session-200"),
      "200",
    );
    mockFs.writeFileSync(
      path.join(sessionDir, "session-99999999"),
      "99999999",
    );

    // Mock process.kill: 100 and 200 are "alive", others throw
    vi.spyOn(process, "kill").mockImplementation(
      (pid: number, signal?: string | number) => {
        if (pid === 100 || pid === 200) return true;
        throw new Error("ESRCH");
      },
    );

    const count = countActiveSessions(sessionDir);
    expect(count).toBe(2);

    // The stale file should have been cleaned up
    expect(mockFs.existsSync(
      path.join(sessionDir, "session-99999999"),
    )).toBe(false);
  });

  it("ignores non-session files", () => {
    const sessionDir = "/projects/foo/sessions";
    mockFs.mkdirSync(sessionDir, { recursive: true });
    mockFs.writeFileSync(path.join(sessionDir, "random.txt"), "hi");
    mockFs.writeFileSync(
      path.join(sessionDir, `session-${process.pid}`),
      String(process.pid),
    );
    const count = countActiveSessions(sessionDir);
    expect(count).toBe(1);
  });

  it("skips files with non-numeric PIDs", () => {
    const sessionDir = "/projects/foo/sessions";
    mockFs.mkdirSync(sessionDir, { recursive: true });
    mockFs.writeFileSync(path.join(sessionDir, "session-abc"), "abc");
    const count = countActiveSessions(sessionDir);
    expect(count).toBe(0);
  });
});

describe("getSessionDir", () => {
  it("returns PROJECTS_DIR/projectDirName/sessions", () => {
    const result = getSessionDir("foo-abc12345");
    expect(result).toBe(
      path.join(PROJECTS_DIR, "foo-abc12345", "sessions"),
    );
  });

  it("ignores absolute input and uses PROJECTS_DIR prefix", () => {
    const result = getSessionDir("/projects/foo-abc12345");
    expect(result).toBe(
      path.join(PROJECTS_DIR, "/projects/foo-abc12345", "sessions"),
    );
  });
});
