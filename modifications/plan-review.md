# Review of modifications/plan.md

## Status

**All fixes from this review have been applied to `plan.md`.** The plan is now
accurate and ready for implementation.

## Scope

Review of the implementation plan against `modifications2.md` (target spec),
`modifications/diffs/src.txt` (v2 source diff), `modifications/diffs/scripts.txt`
(v2 scripts diff), and the actual v3 codebase.

---

## Critical Issues

### C1. Sections 2.3 and 10.3: Incorrect "current state" claims about postinstall.js

The plan states:

> **Current state (§2.3):** The current `code-container/scripts/postinstall.js`
> (from the diff) creates `Dockerfile.User`, `Dockerfile.Packages`, `MOUNTS.txt`,
> `DOCKER_FLAGS.txt`, and `DOCKER_RUN_FLAGS.txt` — the exact text-file approach
> `modifications2.md` replaces.

> **Current state (§10.3):** The current `code-container/scripts/postinstall.js`
> (see `modifications/diffs/scripts.txt` lines 355–370) CREATES these files
> with comment headers.

**This is wrong.** The current v3 codebase has **no** `postinstall.js` at all.
The Changelog.md entry for v3.4.0 (line 73–74) explicitly states:

> Runtime setup and V2→V3 migration moved from the npm `postinstall` hook into
> CLI startup (`src/setup.ts`); the `Dockerfile.User` template is now embedded,
> so the standalone binary has no bundled file dependencies
>
> Removed `scripts/postinstall.js`

The diff in `modifications/diffs/scripts.txt` shows **v2-era** code: `a/code-container/scripts/postinstall.js`
(the old v2 upstream postinstall that created MOUNTS.txt) being replaced by
`b/code-container-orig/scripts/postinstall.js` (the v2 fork postinstall that
created config.json). Neither of these files exists in the current v3 codebase.

**Impact:** The entire framing of §10.3 is wrong. The v3 postinstall.js that
creates MOUNTS.txt does not exist — it was already removed. The action items
(10.3a, 10.3b, 10.3c) to remove MOUNTS.txt creation are no-ops in v3.

However, `src/setup.ts` line 50–53 still has `migrateV2ToV3()` archiving
MOUNTS.txt, DOCKER_FLAGS.txt, and DOCKER_RUN_FLAGS.txt. This is dead migration
code that will never fire on a fresh v3 install but should still be cleaned up
(§10.3c is still valid for this reason, but the justification is wrong).

**Fix required:** Rewrite §2.3 and §10.3 current-state descriptions to reflect
that postinstall.js does not exist and needs to be created fresh, not rewritten.
Remove the claim that the current postinstall creates MOUNTS.txt.

### C2. Section 2.3: Description of "current postinstall" conflates v2 code with v3

> The current `code-container/scripts/postinstall.js` (from the diff) creates
> `Dockerfile.User`, `Dockerfile.Packages`, `MOUNTS.txt`, `DOCKER_FLAGS.txt`,
> and `DOCKER_RUN_FLAGS.txt`

This sentence treats the diff output as if it describes the current v3 code.
The diff shows v2 code. The v3 code that exists today is in `src/setup.ts`
(`runSetup()`, `runMigration()`), not in any postinstall script.

**Fix required:** Clarify that the v3 migration/seeding logic lives in
`src/setup.ts`, not in a postinstall script. The postinstall.js needs to be
created from scratch (not "rewritten"), using the v2 fork's logic as the
implementation reference.

---

## Significant Issues

### S1. Section 2.1b: Underestimates Settings/SettingsSchema refactoring scope

> Remove `Settings` and `SettingsSchema` types duplicated by `mount-config.ts`.

`Settings` is used pervasively across the codebase:

- `src/main.ts` line 44: `setDefaultSettings()` accepts and returns `Settings`
- `src/main.ts` line 105: `settingsResult` typed as `Result<Settings>`
- `src/config.ts` line 50–72: `SettingsStore` loads/saves `Settings`
- `src/container.ts` line 28–35: `createNewContainer()` takes `Settings`
- `src/container.ts` line 47–53: `execInteractive()` takes `Settings`
- `src/container.ts` line 55–62: `stopOrphanedContainers()` indirectly uses Settings
- `src/onboarding.ts`: throughout (settings parameter, finalSettings)
- All command files: `src/commands/run.ts`, `create.ts`, `attach.ts`, `build.ts`, `stop.ts`, `remove.ts`, `list.ts`, `settings.ts`, `upgrade.ts`

The plan cannot simply "remove" Settings — it must specify how each Settings
field maps to the new mount-config.ts schema, or explain that Settings is
extended (not replaced) to incorporate mount-config fields. The most practical
approach is likely to merge the mount-config schema into SettingsSchema rather
than creating a parallel system.

**Fix required:** Add a mapping table showing how each current `Settings` field
maps to the new mount-config schema. Clarify whether `SettingsStore` is
replaced, extended, or coexists with `mount-config.ts`.

### S2. Section 4.1a: Doesn't account for v3 Filesystem abstraction

> Replace `getMounts()` with `buildMounts()` ported from `modifications/diffs/src.txt`
> lines 1681–2047

The v2 `mounts.ts` (from the diff) uses:

```typescript
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
```

and calls `fs.existsSync()`, `fs.readdirSync()`, `fs.realpathSync()`, etc.
directly.

The v3 `container.ts` uses the `Filesystem` abstraction:

```typescript
import { Filesystem } from "./platform/fs";
```

and the `Executor` abstraction for process management.

A direct port of the v2 mount code will not compile in v3 because:

1. `fs.existsSync()` → needs `fs.existsSync()` via the `Filesystem` abstraction
2. `fs.readdirSync()` → needs `fs.readdirSync()` via the `Filesystem` abstraction
3. `fs.realpathSync()` → the v3 `Filesystem` abstraction may not expose this
4. `os.homedir()` → this can stay, but should use `homeDir()` from paths.ts

The plan must either:
(a) Port mount functions to use the v3 `Filesystem` abstraction, or
(b) Use the `Executor` abstraction to run filesystem operations, or
(c) Note that the `Filesystem` abstraction needs to be extended to support
the operations that `buildMounts()` requires.

**Fix required:** Add a note that the v2 mount code must be adapted to v3's
`Filesystem` abstraction, not ported verbatim. List the specific filesystem
operations that need to be supported (readdir, realpath, lstat, readlink,
exists).

### S3. Section 3.1a: Incorrectly says --group-add keep-groups for exec()

> `run()` and `exec()`: when `this.bin === "podman"`, append `--group-add keep-groups` to args.

`--group-add` is a container creation flag, valid for `docker run` but NOT
for `docker exec`. Adding it to exec would cause a runtime error. The v2 fork
code (from the diff, line 952) only added it in `createNewContainer()`:

```typescript
if (runtimeCmd === "podman") {
  args.push("--group-add", "keep-groups");
}
```

**Fix required:** Change §3.1a to only add `--group-add keep-groups` to
`run()`, not `exec()`.

### S4. Section 9.1b: Redundant with Section 1.1a

> §9.1b: Remove `DEFAULT_PROMPT_COMMAND` (remove baked-in prompt).
> §1.1a: **Remove.** Core logic (base image, timezone, packages, NVM, prompt)
> inlined into single Dockerfile template.

Both sections target `src/dockerfile-core.ts`. If §1.1a removes the entire file,
§9.1b has nothing to do. If the Dockerfile is being replaced by a single
managed Dockerfile, the prompt should be in that Dockerfile (or in
container.bashrc as §9.1 describes), not in a removed file.

**Fix required:** Remove §9.1b or rephrase it to clarify that the prompt
moves to `container.bashrc` (which is what §9.1c already describes).

### S5. Section 8.1b: Session dir path assumes project dir name generation exists

> Session dir: `~/.code-container/projects/<name>-<hash>/sessions/`

This path depends on `generateProjectDirName()` which is planned in §2.2c but
not yet created. The session tracking implementation (§8.1b) cannot work without
the project directory infrastructure (§2.2c and §2.1d which adds PROJECTS_DIR).

**Fix required:** Note that §8.1b depends on §2.1d and §2.2c. The session
tracking should be implemented after the per-project config infrastructure.

---

## Minor Issues

### M1. Section 1.1: Missing detail on single Dockerfile content

> Create `Dockerfile` at repo root: single managed Dockerfile (Ubuntu-based,
> installs all tools from `tool-packs.ts` / `harness-packs.ts` via build args
> or conditional layers)

The plan doesn't specify what the Dockerfile should contain. For a
multi-tool-supporting fork, the Dockerfile needs to:

- Use `ubuntu:24.04` as base (per modifications2.md)
- Install core packages (curl, git, build-essential, etc.)
- Install NVM + Node.js (per plan's §10.7 decision to keep it)
- Install each tool via conditional RUN layers or ARG-gated sections
- Install each harness via conditional RUN layers or ARG-gated sections

The v2 fork's Dockerfile (from the diff, line 21–33) shows a single RUN
with `dnf install` and Claude install. The modifications2.md target would
need `apt-get` (Ubuntu) and multi-tool installation.

**Fix required:** Add a brief sketch of the Dockerfile structure or reference
the v2 fork's approach as a starting point that needs expansion.

### M2. Section 10.3b: MOUNTS_PATH, FLAGS_PATH, RUN_FLAGS_PATH don't exist in v3

> Remove `MOUNTS_PATH`, `FLAGS_PATH`, `RUN_FLAGS_PATH` constants if they
> still exist (v3 may have already removed them — verify).

I verified: these constants do NOT exist in `src/platform/paths.ts`. The v3
codebase has no references to these text files except in `src/setup.ts`
`migrateV2ToV3()` (line 50–53) which archives them.

**Fix required:** Change "if they still exist — verify" to a definitive
"these constants do not exist in v3; no action needed for 10.3b."

### M3. Section 5.2c: "Write permissions into each project's settings.json"

> Write permissions into each project's `settings.json` on project dir creation.

This is Claude-specific. For multi-tool support, the plan should note:

- Claude uses `settings.json` for permission allow/deny lists
- Other tools (OpenCode, Codex, etc.) have their own config mechanisms
- The permission deny list should be tool-aware, not just Claude-specific

**Fix required:** Add a note that this applies specifically to tools that
use `settings.json` for permissions (primarily Claude Code), and that
other tools' permission systems are not addressed by this plan.

### M4. Section 2.2c: Missing detail on project dir name format

> Add `generateProjectDirName()` and `generateProjectHash()` (port from v2
> diff `src/config.ts` lines 488–510).

The v2 code shows:

```typescript
export function generateProjectHash(projectPath: string): string {
  return crypto
    .createHash("sha1")
    .update(canonicalizeProjectPath(projectPath))
    .digest("hex")
    .substring(0, 8);
}
export function generateProjectDirName(projectPath: string): string {
  const canonicalPath = canonicalizeProjectPath(projectPath);
  const projectName = path.basename(canonicalPath);
  const hash = generateProjectHash(projectPath);
  return `${projectName}-${hash}`;
}
```

The plan should specify the format: `<basename>-<8-char-sha1-hash>`.

**Fix required:** Add the format specification to §2.2c.

### M5. Section 6.1: Missing detail on which tool configs are "auth" files

> In shared mode, skip copying auth files (they'll be mounted from host).
> In per-project mode, copy as before.

The plan doesn't specify which files constitute "auth" files for each tool.
From harness-packs.ts:

- Claude: `~/.claude.json` (auth), `~/.claude/` (settings), `~/.local/state/claude/`
- OpenCode: `~/.config/opencode/`, `~/.local/state/opencode/`, `~/.local/share/opencode/`
- Codex: `~/.codex/`
- Gemini: `~/.gemini/`
- Copilot: `~/.copilot/`

For shared auth mode, the auth-relevant files (tokens, credentials) need to be
identified per tool. For Claude, `.claude.json` is the auth file. For other
tools, this may vary.

**Fix required:** Add a table mapping each harness to its auth files.

### M6. Implementation order: Phase ordering could be improved

The plan's implementation order is:

| Phase | Description                                                            |
| ----- | ---------------------------------------------------------------------- |
| 1     | config.json system (mount-config.ts), per-project overrides, migration |
| 2     | Mount system rewrite (buildMounts)                                     |
| 3     | Single Dockerfile                                                      |
| 4     | Security + auth/history                                                |
| 5     | SSH agent forwarding + session tracking                                |
| 6     | Container shell environment                                            |
| 7     | Install-time seeding + file cleanup                                    |

Issues:

- Phase 3 (single Dockerfile) is placed after Phase 2 (mount system), but the
  mount system is independent of the Dockerfile format. Mount system could be
  implemented first.
- Phase 7 (postinstall.js) depends on mount-config.ts schema (Phase 1), but
  postinstall.js is what seeds config.json in the first place. There's a
  chicken-and-egg issue: the runtime code in Phase 1 reads config.json, but
  config.json is created by postinstall.js in Phase 7. In practice, the
  `ensureHostConfig()` function from mount-config.ts creates a default
  config.json if absent, so this works. But the plan should note this
  dependency.

**Fix required:** Note that postinstall.js depends on the schema from Phase 1,
and that `ensureHostConfig()` provides a fallback for users who haven't run
the postinstall.

---

## Correctness Checks

### Items verified as correct:

- **§1.1:** The v2 approach (single Dockerfile with build args) is correctly
  described. The v2 diff shows `buildImageRaw(baseImage, timezone, claudeVersion)`.
- **§1.2:** Managed vs user-owned file distinction is correctly described.
- **§2.1:** The mount-config.ts port from v2 diff (lines 1399–1543) is the
  correct source. The schema fields, merge logic, and ensureHostConfig()
  function are all present in the diff.
- **§2.2:** Per-project override system is correctly described with the right
  merge strategy.
- **§2.3:** The v2 fork's postinstall.js functions (detectRuntime,
  findKnownHostsPath, findEnvPath) are correctly referenced with line numbers.
- **§2.4:** Config migration logic is correctly described.
- **§3.1:** Podman preference and group-add keep-groups concept are correct.
- **§4:** The mount feature table is comprehensive and accurately reflects the
  v2 diff.
- **§5:** Security hardening items (no-new-privileges, config dir protection,
  path canonicalization) are all correct.
- **§6:** Auth/history mode concepts are correct.
- **§7:** SSH agent forwarding is correctly described.
- **§8:** File-based session tracking is correctly described with the right
  v2 diff reference.
- **§9:** Container shell environment is correctly described.
- **§10.1–10.5:** Removed features are correctly identified.
- **§10.6:** Correctly notes that v3 has tests and decides to keep them.
- **§10.7:** Correctly notes that v3 has NVM and decides to keep it for
  multi-tool support.
- **§11:** File create/remove/modify tables are comprehensive.

---

## Summary

| Category    | Count | Items  |
| ----------- | ----- | ------ |
| Critical    | 2     | C1, C2 |
| Significant | 5     | S1–S5  |
| Minor       | 6     | M1–M6  |

The plan is fundamentally sound in its architecture and feature coverage. The
critical issues are factual errors about the current v3 state that affect the
framing and justification of several action items. The significant issues are
scope-underestimations and a portability concern that would block implementation.
The minor issues are missing details that would improve clarity.
