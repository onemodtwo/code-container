# Implementation Plan: Aligning code-container v3 with `modifications2.md`

## Scope

This plan describes changes to the current codebase (v3.5.1, `@aerovato/container`) to
align it with the fork described in `modifications2.md`. The current code is already
multi-tool-capable and Ubuntu-based — the two key distinctions from the original
`modifications.md`. What follows are the remaining gaps.

---

## Section 1: Architecture and Scope Changes

### 1.1 Single Dockerfile replaces four-stage build

**Current state:** v3 generates four Dockerfiles programmatically
(`src/dockerfile-core.ts`, `src/dockerfile-tools.ts`, `src/dockerfile-harness.ts`)
and builds them as an image pipeline (Core → Tools → Harness → User). The final
User Dockerfile lives at `~/.code-container/Dockerfile.User` (template in
`resources/Dockerfile.User`). Build stages are defined by `BUILD_STAGES` in
`src/docker.ts`.

**Target:** A single `Dockerfile` with build arguments, managed (overwritten on
reinstall). Build targets are removed.

**Actions:**

| #    | File                        | Change                                                                                                                                                    |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1a | `src/dockerfile-core.ts`    | **Remove.** Core logic (base image, timezone, packages, NVM, prompt) inlined into single Dockerfile template.                                             |
| 1.1b | `src/dockerfile-tools.ts`   | **Remove.** Tool installation moved into Dockerfile via `ARG`-based conditional layers or build-time config.                                              |
| 1.1c | `src/dockerfile-harness.ts` | **Remove.** Harness installation moved into Dockerfile via `ARG`-based conditional layers or build-time config.                                           |
| 1.1d | `src/docker.ts`             | Replace `buildImage()` — remove stage iteration. Call `docker build` against the single managed `Dockerfile` with `--build-arg` flags from `config.json`. |
| 1.1e | `src/types.ts`              | Remove `BuildTarget` enum (`"full"                                                                                                                        | "tools" | "harness" | "user"`). Replace with a single build command (no target). |
| 1.1f | `src/args.ts`               | Remove `BUILD_TARGETS` and the `build [TARGET]` subcommand. `container build` has no target argument.                                                     |
| 1.1g | `src/platform/paths.ts`     | Remove `CORE_DOCKERFILE_PATH`, `TOOLS_DOCKERFILE_PATH`, `HARNESS_DOCKERFILE_PATH`. Add `DOCKERFILE_PATH` pointing to `~/.code-container/Dockerfile`.      |
| 1.1h | `src/setup.ts`              | Update `runSetup()` to copy the packaged `Dockerfile` to `DOCKERFILE_PATH` if absent (managed file logic).                                                |
| 1.1i | Create `Dockerfile`         | At repo root: single managed Dockerfile. Structure sketch:                                                                                                |

- `FROM ubuntu:24.04`
- Core packages (`apt-get install curl git build-essential sudo ...`)
- NVM + Node.js 22 installation (kept per §10.7 decision)
- Per-tool conditional install sections gated by `ARG INSTALL_<TOOL>=false`
  (e.g., `ARG INSTALL_CLAUDE=false`, `ARG INSTALL_OPENCODE=false`, etc.)
- Per-harness conditional install sections gated by similar ARGs
- `container.bashrc` COPY and shell config (if not mounted at runtime)
  The v2 fork's Dockerfile (`modifications/diffs/src.txt` lines 21–33) shows
  a single `RUN` with tool installs — adapt this pattern for Ubuntu with
  `apt-get` and multi-tool ARGs. |
  | 1.1j | `src/commands/shared.ts` | Remove `getBuildDirty()` and stale-build detection (no build targets = no dirty tracking needed). |
  | 1.1k | `src/commands/build.ts` | Simplify to single-target build. |
  | 1.1l | `src/commands/upgrade.ts` | Remove stale-image rebuild logic if present. |

**Reference:** `modifications/diffs/src.txt` shows the v2 approach:

- `buildImageRaw()` took `baseImage`, `timezone`, `claudeVersion` as args
- Single `Dockerfile` was copied from package to `APPDATA_DIR`
- Build context was an empty temp dir
- No `BUILD_STAGES` array, no `ensureUserDockerfile()`, no per-target logic

### 1.2 Managed vs. user-owned file distinction

**Current state:** `runSetup()` in `src/setup.ts` creates `APPDATA_DIR`, `CONFIGS_DIR`,
`TEMP_DIR`, and seeds `Dockerfile.User` if absent. The `USER_DOCKERFILE_PATH` is
user-owned (copied once). There is no explicit lifecycle policy called out.

**Target:** Documented lifecycle policy:

- **Managed** (`Dockerfile`, `container.bashrc`, `ssh-agent-relay.py`): overwritten
  on every install.
- **User-owned** (`config.json`, per-project `override.json`): written once, never
  overwritten.

**Actions:**

| #    | File                     | Change                                                                                                                             |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1.2a | `src/setup.ts`           | `runSetup()`: always overwrite managed files (Dockerfile, container.bashrc, ssh-agent-relay.py); never overwrite user-owned files. |
| 1.2b | `src/setup.ts`           | `runMigration()`: preserve user-owned files during migration; only touch managed files.                                            |
| 1.2c | `src/platform/paths.ts`  | Add `CONFIG_JSON_PATH` → `path.join(APPDATA_DIR, "config.json")`.                                                                  |
| 1.2d | `scripts/postinstall.js` | Create/update (see Section 2.3).                                                                                                   |

---

## Section 2: Configuration System

### 2.1 JSON configuration replaces text-file mounts and flags

**Current state:** `SettingsStore` reads/writes `settings.json` with a Zod schema
defined in `src/types.ts`. The settings object contains `dockerRunFlags` and
`dockerExecFlags` arrays and a `systemMounts.ssh` boolean. There is no `config.json`
based system.

The mount system uses `getMounts()` in `src/container.ts` which iterates over
`HARNESS_PACKS` and `TOOL_PACKS` config arrays to build `--mount` flags. Mounts
are stored in `CONFIGS_DIR` (~/.code-container/configs/). No per-project overrides.

**Target:** A `config.json` at `~/.code-container/config.json` with a Zod schema
(like `mount-config.ts` from the diff). This file is the single global config source.
All config fields have typed defaults; invalid JSON falls back with a warning.

**Actions:**

| #    | File                                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1a | **Create** `src/mount-config.ts`                                         | Port from `modifications/diffs/src.txt` (lines 1399–1543). Contains: `GlobalMountConfigSchema`, `ProjectOverrideSchema`, `MountConfig` type, `parseFile()`, `loadGlobalConfig()`, `loadMountConfig()`, `ensureHostConfig()`. Adjust defaults: `base_image: "ubuntu:24.04"`, `container_runtime: "docker"` (auto-detected). Remove `claude_version`. Rename Claude-specific fields to general names.                                                                                                                                                                           |
| 2.1b | `src/types.ts`                                                           | Merge `Settings` and `SettingsSchema` into `mount-config.ts`'s schema rather than removing in isolation. `Settings` is used pervasively: `src/main.ts` (setDefaultSettings), `src/config.ts` (SettingsStore), `src/container.ts` (createNewContainer, execInteractive), `src/onboarding.ts`, all command files. The `MountConfigSchema` from mount-config.ts should incorporate `dockerRunFlags`, `dockerExecFlags`, `enabledTools`, `enabledHarnesses`, `runtime`, `ssh.enabled` (and other current Settings fields). Then update all call sites to use the new schema type. |
| 2.1c | `src/config.ts`                                                          | Refactor `SettingsStore` to delegate to `mount-config.ts` for global config. Or replace entirely with `mount-config.ts`'s approach. Keep `ensureConfigExists()` and `configMountSourcePath()` as they are used by the config migration workflow.                                                                                                                                                                                                                                                                                                                              |
| 2.1d | `src/platform/paths.ts`                                                  | Add `PROJECTS_DIR` → `path.join(APPDATA_DIR, "projects")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2.1e | Remove `MOUNTS.txt`, `DOCKER_FLAGS.txt`, `DOCKER_RUN_FLAGS.txt` remnants | These don't exist in v3, but ensure any references in `src/setup.ts` migration code are updated to match the new config system.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Reference:** The v2 diff at `modifications/diffs/src.txt` lines 1399–1543 shows
the complete `mount-config.ts` implementation with Zod schemas, per-project
override merging, and `ensureHostConfig()`.

### 2.2 Per-project override system

**Current state:** No per-project overrides exist. All mounts are derived from
pack definitions (`HARNESS_PACKS` / `TOOL_PACKS`) and the global SSH mount toggle.

**Target:** Per-project `~/.code-container/projects/<name>-<hash>/override.json`.
Merge strategy: most fields override global; array fields append; global-only
fields (base_image, timezone, container_runtime, data_branches) cannot be
overridden.

**Actions:**

| #    | File                     | Change                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.2a | `src/mount-config.ts`    | Already includes `ProjectOverrideSchema` and `loadMountConfig()` merge logic (see 2.1a).                                                                                                                                                                                                                     |
| 2.2b | `src/container.ts`       | `getMounts()` → replace with `buildMounts()` from 4.1a. Call `loadMountConfig()` at entry.                                                                                                                                                                                                                   |
| 2.2c | `src/platform/paths.ts`  | Add `generateProjectDirName()` and `generateProjectHash()` (port from v2 diff `src/config.ts` lines 488–510). Format: `<project-basename>-<8-char-sha1-hash>`, where the hash is derived from the canonicalized project path (resolve symlinks via `fs.realpathSync()`, strip trailing slashes, then SHA-1). |
| 2.2d | `src/commands/create.ts` | On first container creation for a project: call `ensureProjectDir()` to create project config dir and seed `override.json`.                                                                                                                                                                                  |

### 2.3 Install-time seeding via install.json / postinstall.js

**Current state:** v3 has `scripts/` directory but no `postinstall.js` (it was
removed in v3.4.0 per Changelog.md: "Runtime setup and V2→V3 migration moved
from the npm `postinstall` hook into CLI startup (`src/setup.ts`)"). Seeding
is handled by `runSetup()` and `runMigration()` in `src/setup.ts`, which are
called at startup (not install time). The v2-era code in
`modifications/diffs/scripts.txt` (lines 355–370) shows the old v2 upstream
postinstall that created MOUNTS.txt etc. — that code no longer exists in v3.
The v2 fork's postinstall (lines 136–414) wrote config.json instead, which is
the approach we need to create from scratch.

**Target:** A `postinstall.js` that reads `install.json`, auto-detects runtime,
discovers env paths, writes `config.json`, and overwrites managed files.
The v2 fork's implementation (`code-container-orig/scripts/postinstall.js` in
`modifications/diffs/scripts.txt` lines 136–414) is the complete reference.

**Actions:**

| #    | File                            | Change                                                                                                                                                     |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.3a | Create `install.json`           | At repo root. Contains: `base_image`, `timezone`, `data_branches`, `tool_permissions` default deny list, `forward_ssh_agent`, `ssh_known_hosts_path`, etc. |
| 2.3b | Create `scripts/postinstall.js` | No postinstall.js exists in v3 — create from scratch. Port v2 fork logic from `modifications/diffs/scripts.txt` lines 136–414. Key functions:              |

**`detectRuntime(preference)`** (lines 177–185): If preference is `"podman"` or
`"docker"`, use it. If `"auto"`, check `podman --version` first, then
`docker --version`. Default to `"podman"`.

**`findKnownHostsPath()`** (lines 220–255): Check `~/.ssh/known_hosts`, then
`/etc/ssh/ssh_known_hosts`, then parse `GlobalKnownHostsFile` directive from
`/etc/ssh/ssh_config` and files in `/etc/ssh/ssh_config.d/`.

**`findEnvPath(pattern, label)`** (lines 262–284): Run `find` across search
roots (`/data`, `/data2`, `$HOME`) with the given pattern,
`-maxdepth 8 -print -quit`. Strip `/bin/activate` suffix. Respect
`ENV_SEARCH_TIMEOUT_MS`.

**Config generation** (lines 289–328): On first install, build `defaultConfig`
from `install.json` values + auto-discovery results, write to
`~/.code-container/config.json` with `mode: 0o600`.

**Config migration** (lines 330–414): On reinstall, parse existing
`config.json`, compute missing/removed keys against the current schema,
re-discover `ssh_known_hosts_path` specifically (not default to `""`),
write back with changes logged.

**Managed files** (lines 211–215): Always overwrite `Dockerfile`,
`container.bashrc`, and `ssh-agent-relay.py` from package copies. The current
v3 postinstall only copies user-owned Dockerfiles if absent — this needs to
change to the always-overwrite approach.

**Cleanup migration** (lines 382–414): Remove stale core mounts from
`MOUNTS.txt` that no longer belong there (core mounts are now handled
in-memory). This is a v2→v2.x migration that may not apply to v3, but the
pattern is instructive for any migration the postinstall script needs to
handle between versions.

### 2.4 Config migration on reinstall

**Current state:** `runMigration()` in `src/setup.ts` handles v2→v3 migration
(moves MOUNTS.txt, DOCKER_FLAGS.txt, DOCKER_RUN_FLAGS.txt to archive, deletes
`completedInit`/`acceptedTos` keys). Version is tracked via `migrationVersion`.

**Target:** When new config fields are added, detect missing keys and add with
defaults. Auto-discovered fields are re-discovered. Deprecated keys are removed
with a log message.

**Actions:**

| #    | File           | Change                                                                                                                                                                |
| ---- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.4a | `src/setup.ts` | Extend `runMigration()`: read `config.json`, compare keys against current schema, add missing keys, remove deprecated keys, re-discover auto fields. Log each change. |
| 2.4b | `src/setup.ts` | Bump `CURRENT_MIGRATION_VERSION` and add migration functions for each version.                                                                                        |

---

## Section 3: Container Runtime

### 3.1 Podman support (preferred over Docker)

**Current state:** Already implemented. `ContainerClient` accepts `"docker" | "podman"`
as its `bin` parameter. `Settings.runtime` stores the choice. Auto-detection during
onboarding prefers Podman on Linux. The `--group-add keep-groups` flag is not
currently added — Podman containers may lack supplementary group access.

**Target:** Configurable runtime with Podman preferred. Add `--group-add keep-groups`
when Podman is detected.

**Actions:**

| #    | File                      | Change                                                                                                                                                                                                                         |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1a | `src/container-client.ts` | `run()`: when `this.bin === "podman"`, append `--group-add keep-groups` to args. Note: `--group-add` is a container creation flag and must NOT be added to `exec()` (which uses `docker exec` and does not support this flag). |
| 3.1b | `src/mount-config.ts`     | Schema `container_runtime` field defaults to auto-detected or `"docker"`.                                                                                                                                                      |

---

## Section 4: Mount System

**Current state:** `getMounts()` in `src/container.ts` builds a flat list:
project path + harness pack configs + tool pack configs + optional SSH mount.
No ordering, no deduplication, no ancestor protection, no symlink walking,
no venv auto-detection, no data branches, no LD_LIBRARY_PATH support.

**Target:** Replace `getMounts()` with the layered `buildMounts()` from the v2
diff (`src/mounts.ts`), adapted for the multi-tool context and Ubuntu base.

**Actions:**

| #    | File                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1a | `src/container.ts`                      | Replace `getMounts()` with `buildMounts()` ported from `modifications/diffs/src.txt` lines 1681–2047 (the v2 `mounts.ts`). **Important:** The v2 code uses `import * as fs from "fs"` directly. v3 uses the `Filesystem` abstraction (`src/platform/fs.ts`) via the `Executor` pattern. The ported code must be adapted to use `fs.existsSync()`, `fs.readdirSync()`, `fs.realpathSync()`, `fs.lstatSync()`, and `fs.readlinkSync()` via the v3 `Filesystem` class (which wraps `fs/promises`). If the v3 `Filesystem` abstraction does not expose `realpathSync` or `lstatSync`, these operations must be added to `Filesystem` or the `Executor` abstraction before this step. Adapt for v3: mount ordering, dedup, home children, asymmetric specs, ancestor protection, symlink auto-mounting, venv auto-detection, data branches, LD_LIBRARY_PATH, project read-only mode. |
| 4.1b | `src/container.ts`                      | `createNewContainer()`: accept `MountConfig` from `loadMountConfig()`, pass to `buildMounts()`. Set env vars (`PENV_PATH`, `RENV_PATH`, `LD_LIBRARY_PATH`, `SSH_AUTH_SOCK`). Add `--security-opt no-new-privileges`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4.1c | `src/container.ts`                      | `execInteractive()`: pass env vars matching the container's mount config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4.1d | `src/types.ts` or `src/mount-config.ts` | Add `MountConfig` type (already in `mount-config.ts` from 2.1a).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4.1e | `src/commands/create.ts`                | Pass relevant fields from `MountConfig` to `createNewContainer()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Key mount features to port from the v2 diff:

| Feature                      | v2 implementation                                                                                                                                             | Port target                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Mount ordering               | `buildMounts()` ordered list (data → toolchain → home children → extra ro → LD_PATH → venv → R → project rw → extra rw → symlinks → SSH → claude → gitconfig) | `src/container.ts` `buildMounts()`                       |
| Dedup by container path      | `mountIndex` Map + `hostPathSet`                                                                                                                              | Keep                                                     |
| Home children auto-mount     | Enumerate non-hidden `$HOME` children, filter symlinks by target                                                                                              | Keep                                                     |
| Asymmetric mount specs       | `hostPath:containerPath` syntax in `extra_readonly`/`extra_readwrite`                                                                                         | Keep (already partially supported by `buildBindMount()`) |
| Ancestor protection          | `addWriteWithProtection()` walks up dir tree, adds ro mounts                                                                                                  | Add to `buildMounts()`                                   |
| Symlink auto-mounting        | `walkForSymlinks()` with configurable depth                                                                                                                   | Add                                                      |
| Venv interpreter auto-detect | `resolveVenvInterpreterMount()`                                                                                                                               | Add                                                      |
| LD_LIBRARY_PATH              | Mount + env var                                                                                                                                               | Add                                                      |
| Data branches                | `data_branches` config field                                                                                                                                  | Add to `MountConfig` schema                              |
| Project read-only mode       | `project_readonly` config                                                                                                                                     | Add to `MountConfig` schema                              |

---

## Section 5: Security Hardening

### 5.1 Read-only tool settings

**Current state:** Config files mounted from `CONFIGS_DIR` are writable by default
(`buildBindMount()` without `readonly`).

**Target:** Settings files mounted read-only. Agent cannot self-modify permissions.

**Actions:**

| #    | File                    | Change                                                                                                |
| ---- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| 5.1a | `src/types.ts`          | Add `readonly` field to `ConfigMount` type.                                                           |
| 5.1b | `src/platform/paths.ts` | `buildBindMount()`: accept optional mode parameter (already does, but ensure harness configs use it). |
| 5.1c | `src/container.ts`      | `buildMounts()`: mark settings files as read-only mounts.                                             |
| 5.1d | `src/harness-packs.ts`  | Mark settings files in pack configs as read-only where appropriate.                                   |

### 5.2 Default permission deny list

**Current state:** No deny list concept. Permissions are not managed by the
harness tool — each tool handles its own permissions internally.

**Target:** A `claude_permissions` (or general `tool_permissions`) field in
`config.json` with pre-approved tools and denied network-making shell commands.

**Actions:**

| #    | File                                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.2a | `src/mount-config.ts`                             | Add `tool_permissions` field to schema with `allow` and `deny` arrays. Default: `allow: ["*"]`, deny list from `install.json`.                                                                                                                                                                                                                                                                                                        |
| 5.2b | `install.json`                                    | Include the deny list from `modifications2.md` Section 5.2.                                                                                                                                                                                                                                                                                                                                                                           |
| 5.2c | `src/mount-config.ts` or new `src/permissions.ts` | Write permissions into each project's `settings.json` on project dir creation. **Note:** This applies specifically to tools that use `settings.json` for permission management (primarily Claude Code). Other tools (OpenCode, Codex, Gemini, Copilot) have their own config mechanisms and are not addressed by this step. The implementation should be tool-aware and only write `settings.json` when the relevant tool is enabled. |
| 5.2d | `src/container.ts`                                | Mount project `settings.json` read-only into container at the appropriate tool config path.                                                                                                                                                                                                                                                                                                                                           |

### 5.3 No-new-privileges security option

**Current state:** Not set.

**Target:** All containers created with `--security-opt no-new-privileges`.

**Actions:**

| #    | File                      | Change                                                   |
| ---- | ------------------------- | -------------------------------------------------------- |
| 5.3a | `src/container-client.ts` | `run()`: add `--security-opt no-new-privileges` to args. |

### 5.4 Config directory protection

**Current state:** Not implemented. Any path can be used as a project directory.

**Target:** Reject project paths inside `~/.code-container/`.

**Actions:**

| #    | File                                                 | Change                                                |
| ---- | ---------------------------------------------------- | ----------------------------------------------------- |
| 5.4a | `src/commands/shared.ts` or `src/commands/create.ts` | `resolveTarget()`: reject paths inside `APPDATA_DIR`. |

### 5.5 Path canonicalization

**Current state:** `generateContainerName()` in `src/platform/paths.ts` does
basic path canonicalization (trims trailing slashes, WSL path mapping). It does
NOT resolve symlinks or provide a stable hash.

**Target:** Canonicalize before hashing (resolve symlinks, strip trailing
slashes) so the same physical directory always maps to the same container name.

**Actions:**

| #    | File                    | Change                                                                                                                                      |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.5a | `src/platform/paths.ts` | `generateContainerName()`: use `fs.realpathSync()` to resolve symlinks before hashing. Fall back to `path.resolve()` if path doesn't exist. |

---

## Section 6: Auth and History Modes

**Current state:** Tool configs are copied from host to `CONFIGS_DIR` during
first-time setup (`migrateHarnessConfigs()` in `src/onboarding.ts`). Auth files
are mounted from `CONFIGS_DIR` on every run. There is no shared vs. per-project
distinction.

**Target:** Default to **shared mode**: mount auth files directly from the host.
Per-project mode available as opt-in.

### Auth files per harness tool:

| Tool     | Auth/config files                             | Host source paths                                 |
| -------- | --------------------------------------------- | ------------------------------------------------- |
| Claude   | `.claude.json` (auth), `.claude/` (settings)  | `~/.claude.json`, `~/.claude/`                    |
| OpenCode | `.config/opencode/`, `.local/state/opencode/` | `~/.config/opencode/`, `~/.local/state/opencode/` |
| Codex    | `.codex/`                                     | `~/.codex/`                                       |
| Gemini   | `.gemini/`                                    | `~/.gemini/`                                      |
| Copilot  | `.copilot/`                                   | `~/.copilot/`                                     |

**Actions:**

| #    | File                                    | Change                                                                                                                                                   |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1a | `src/mount-config.ts`                   | Add `auth_mode` and `history_mode` fields with values `"shared"                                                                                          | "per_project"`. Default: `"shared"`. |
| 6.1b | `src/onboarding.ts`                     | `migrateHarnessConfigs()`: in shared mode, skip copying auth files (they'll be mounted from host). In per-project mode, copy as before.                  |
| 6.1c | `src/container.ts`                      | `buildMounts()`: mount auth files from host (shared) or from project dir (per_project). Mount history dirs from host (shared) or project dir (isolated). |
| 6.1d | `src/platform/paths.ts`                 | Add `PROJECTS_DIR` (already planned in 2.1d).                                                                                                            |
| 6.1e | `src/config.ts` or new `src/project.ts` | Add `ensureProjectDir()` to create project subdirectories (claude-projects, claude-statsig, override.json, settings.json).                               |

---

## Section 7: SSH Agent Forwarding

**Current state:** v3 has a simple SSH mount toggle (`systemMounts.ssh`) that
mounts `~/.ssh` read-only into the container. There is no agent forwarding, no
relay script, no known_hosts auto-discovery.

**Target:** When enabled, mount `~/.ssh-agent-relay/`, set `SSH_AUTH_SOCK`, and
mount `known_hosts`. Add relay script and auto-discovery.

**Actions:**

| #    | File                        | Change                                                                                                 |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| 7.1a | `src/mount-config.ts`       | Add `forward_ssh_agent: boolean` and `ssh_known_hosts_path: string` fields.                            |
| 7.1b | `src/container.ts`          | `buildMounts()`: if `forward_ssh_agent`, mount relay dir and known_hosts. Set `SSH_AUTH_SOCK` env var. |
| 7.1c | Create `ssh-agent-relay.py` | Python 3 asyncio relay script (port from v2 description).                                              |
| 7.1d | `src/onboarding.ts`         | During setup: auto-discover SSH known_hosts path, store in config.                                     |
| 7.1e | `scripts/postinstall.js`    | Auto-discover known_hosts path at install time.                                                        |
| 7.1f | `src/container.ts`          | `createNewContainer()`: warn if forwarding enabled but relay socket not found.                         |

---

## Section 8: Session Tracking

**Current state:** `ContainerClient.attachedSessionCount()` uses `docker top` +
counting bash processes. `stopContainerIfLastSession()` in `src/container.ts`
calls this to decide whether to stop. This is unreliable (process table scanning).

**Target:** File-based session tracking. Each exec session writes a PID lock file.
`countActiveSessions()` checks live PIDs via `process.kill(pid, 0)` and cleans up
stale lock files from crashes.

**Actions:**

| #    | File                      | Change                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1a | `src/container-client.ts` | Remove `attachedSessionCount()` — no longer needed.                                                                                                                                                                                                                                                                                                                                    |
| 8.1b | Create `src/session.ts`   | Port `trackSessionStart()`, `trackSessionEnd()`, `countActiveSessions()` from v2 diff (`src/docker.ts` lines 1012–1078). Session dir: `~/.code-container/projects/<name>-<hash>/sessions/`. **Dependency:** Requires `PROJECTS_DIR` (§2.1d) and `generateProjectDirName()` (§2.2c) to be implemented first — the session dir path depends on the per-project directory infrastructure. |
| 8.1c | `src/container.ts`        | `stopContainerIfLastSession()`: use file-based count from `session.ts` instead of `attachedSessionCount()`.                                                                                                                                                                                                                                                                            |
| 8.1d | `src/commands/run.ts`     | `runCommand()`: call `trackSessionStart()` before exec, `trackSessionEnd()` in `finally` block.                                                                                                                                                                                                                                                                                        |
| 8.1e | `src/commands/attach.ts`  | `attachCommand()`: same session tracking.                                                                                                                                                                                                                                                                                                                                              |
| 8.1f | `src/container-client.ts` | Add `execInteractive()` variant that returns and supports session tracking.                                                                                                                                                                                                                                                                                                            |

---

## Section 9: Container Shell Environment

### 9.1 Runtime-mounted bashrc

**Current state:** Shell prompt is baked into the Dockerfile via
`DEFAULT_PROMPT_COMMAND` in `src/dockerfile-core.ts`. Changes require a rebuild.

**Target:** External `container.bashrc` mounted at runtime at
`/etc/container.bashrc`. Changes take effect on `container remove + container run`
without rebuild.

**Actions:**

| #    | File                      | Change                                                                                                                             |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 9.1a | Create `container.bashrc` | Port prompt, aliases, `act`/`deact` functions from v2 description.                                                                 |
| 9.1b | (removed)                 | §1.1a already removes `dockerfile-core.ts` (including `DEFAULT_PROMPT_COMMAND`). The prompt moves to `container.bashrc` via §9.1a. |
| 9.1c | `src/container.ts`        | `buildMounts()`: mount `CONTAINER_BASHRC_PATH` at `/etc/container.bashrc:ro`.                                                      |
| 9.1d | `src/platform/paths.ts`   | Add `CONTAINER_BASHRC_PATH` → `path.join(APPDATA_DIR, "container.bashrc")`.                                                        |
| 9.1e | `src/setup.ts`            | `runSetup()`: copy `container.bashrc` from package to `CONTAINER_BASHRC_PATH`.                                                     |

### 9.2 Environment activation helpers

**Current state:** No `act`/`deact` functions. Python/R envs are not managed by
the harness.

**Target:** `container.bashrc` provides `act` and `deact`. `PENV_PATH` and
`RENV_PATH` injected as env vars.

**Actions:**

| #    | File                  | Change                                                                                    |
| ---- | --------------------- | ----------------------------------------------------------------------------------------- |
| 9.2a | `container.bashrc`    | Add `act` and `deact` functions (see modifications2.md Section 9.2).                      |
| 9.2b | `src/mount-config.ts` | Ensure `penv_path` and `renv_path` in schema.                                             |
| 9.2c | `src/container.ts`    | `createNewContainer()` and `execInteractive()`: set `PENV_PATH` and `RENV_PATH` env vars. |

### 9.3 Shell aliases

**Current state:** No aliases.

**Target:** Aliases in `container.bashrc` (`l`, `la`, `ll`, `lg`, `lt`, `..`,
`...`, `....`).

**Actions:**

| #    | File               | Change                                                              |
| ---- | ------------------ | ------------------------------------------------------------------- |
| 9.3a | `container.bashrc` | Add aliases and colored prompt (see modifications2.md Section 9.3). |

---

## Section 10: Removed Features

### 10.1 Multi-stage build pipeline removed

**Target:** Remove `BUILD_STAGES`, multi-target `buildImage()`, build-dirty tracking.
**Actions:** Already covered by items 1.1a–1.1l.

### 10.2 Config copy workflow replaced

**Current state:** `migrateHarnessConfigs()` copies configs from host to `CONFIGS_DIR`.
On container creation, configs are mounted from `CONFIGS_DIR`.

**Target:** In shared mode, mount config files directly from host (skip copy).
In per-project mode, copy only auth files to project dir.

**Actions:**

| #     | File                | Change                                                                                                                                 |
| ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 10.2a | `src/onboarding.ts` | `migrateHarnessConfigs()`: in shared auth mode, skip copying auth files. In per-project mode, copy to project dir (not `CONFIGS_DIR`). |
| 10.2b | `src/container.ts`  | `buildMounts()`: mount from host (shared) or project dir (per-project).                                                                |

### 10.3 MOUNTS.txt, DOCKER_FLAGS.txt, DOCKER_RUN_FLAGS.txt removed

**Current state:** These files were removed from v3 entirely. The v3 postinstall
script does not exist (removed in v3.4.0). The v2-era diff in
`modifications/diffs/scripts.txt` (lines 355–370) shows the old v2 upstream
postinstall that created these files — that code is long gone. However,
`src/setup.ts` `migrateV2ToV3()` (lines 50–53) still has dead migration code
that archives these files if found, which is vestigial from v2→v3 migration.

**Target:** Clean up the vestigial references. Neither the new postinstall.js
nor any runtime code should reference these files. All mount and flag
configuration lives in `config.json`.

**Actions:**

| #     | File                                       | Change                                                                                                                                               |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.3a | `scripts/postinstall.js`                   | The new postinstall.js (from §2.3b) must NOT create these files. Ensure no code creates `MOUNTS.txt`, `DOCKER_FLAGS.txt`, or `DOCKER_RUN_FLAGS.txt`. |
| 10.3b | `src/config.ts` or `src/platform/paths.ts` | These constants (`MOUNTS_PATH`, `FLAGS_PATH`, `RUN_FLAGS_PATH`) do not exist in v3 — no action needed.                                               |
| 10.3c | `src/setup.ts`                             | Remove v2→v3 migration code that archives these files (no longer needed if they are never created).                                                  |

**Reference:** The v2 fork's `postinstall.js` (`code-container-orig` side in
the diff) has zero references to `MOUNTS.txt`, `DOCKER_FLAGS.txt`, or
`DOCKER_RUN_FLAGS.txt`. Instead it writes `config.json` directly.

### 10.4 shell-quote dependency removed

**Current state:** Not a dependency. `package.json` already has only `zod` and
`@clack/prompts` as runtime deps. No action needed.

### 10.4a Migrate and cleanup shell scripts

**Current state:** The v2 fork includes `scripts/migrate.sh` and
`scripts/cleanup.sh` (see `modifications/diffs/scripts.txt` lines 1–131) for
moving config files from the project root to `~/.code-container/configs/`.
These are manual migration aids, not runtime-critical.

**Relevance:** v3 already handles config migration programmatically in
`src/onboarding.ts` (`migrateHarnessConfigs()`). These shell scripts are not
needed unless there is a desire to support a manual migration path for users
upgrading from very old versions. Add them as optional if the manual upgrade
path is desired; otherwise skip.

### 10.5 args.ts and flags.ts modules removed

**Current state:** The v2 had separate `args.ts` and `flags.ts`. v3 has `src/args.ts`
for argument parsing (retained) but no `src/flags.ts`. The argument parsing approach
is already simplified compared to upstream. No action needed — `src/args.ts` is
not the same module that was removed; it's the v3 replacement.

### 10.6 Test infrastructure removed

**Current state:** v3 HAS test infrastructure: `tests/`, `vitest.config.ts`,
`__mocks__/`, ESLint, Prettier, Husky. This contradicts modifications2.md's
"removed" stance. **Decision:** Keep test infrastructure — it's valuable. The
modifications2.md target document was for a different fork's priorities. Not
all forks need to strip tests. This is an intentional deviation from
modifications2.md for this fork.

### 10.7 NVM/Node.js installation removed from image

**Current state:** NVM and Node.js 22 ARE installed in the Core Dockerfile
(`DEFAULT_CORE_COMMANDS` in `dockerfile-core.ts`). The modifications2.md says to
remove them, relying on host's Node.js via `.nvm` mount. **Decision:** Keep NVM
in image for multi-tool support. Many tools (OpenCode, Codex, Copilot, Gemini
CLI) are npm packages that need Node.js at build time. The host's `.nvm` mount
provides additional Node.js versions at runtime. This is an intentional
deviation from modifications2.md for multi-tool support.

| #    | File      | Change                                                             |
| ---- | --------- | ------------------------------------------------------------------ |
| 10.7 | No change | Keep NVM/Node.js in the image for tool installation at build time. |

---

## Section 11: Project Structure Changes

### Files to create

| File                            | Source reference                                     | Section |
| ------------------------------- | ---------------------------------------------------- | ------- |
| `Dockerfile`                    | Single managed Dockerfile (Ubuntu-based, multi-tool) | 1.1i    |
| `install.json`                  | Organization-wide install defaults                   | 2.3a    |
| `container.bashrc`              | Runtime shell environment                            | 9.1a    |
| `ssh-agent-relay.py`            | SSH agent socket relay                               | 7.1c    |
| `scripts/postinstall.js`        | Install-time seeding & config migration              | 2.3b    |
| `src/mount-config.ts`           | Config loading, Zod schemas, per-project merge       | 2.1a    |
| `src/session.ts`                | File-based session tracking                          | 8.1b    |
| `src/permissions.ts` (optional) | Permission injection for project settings.json       | 5.2c    |
| `src/project.ts` (optional)     | Project directory management                         | 6.1e    |

### Files to remove

| File                        | Reason                          |
| --------------------------- | ------------------------------- |
| `src/dockerfile-core.ts`    | Superseded by single Dockerfile |
| `src/dockerfile-tools.ts`   | Superseded by single Dockerfile |
| `src/dockerfile-harness.ts` | Superseded by single Dockerfile |
| `resources/Dockerfile.User` | Superseded by single Dockerfile |

### Files to modify significantly

| File                      | Nature of changes                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/container.ts`        | Rewrite `getMounts()` → `buildMounts()`, add env var injection, ancestor protection, session tracking integration, SSH agent forwarding |
| `src/docker.ts`           | Replace multi-stage build with single-image build                                                                                       |
| `src/container-client.ts` | Add `--group-add keep-groups` for Podman, `--security-opt no-new-privileges`, session tracking support                                  |
| `src/config.ts`           | Refactor to delegate to `mount-config.ts` or replace with new config approach                                                           |
| `src/setup.ts`            | Update migration logic for `config.json`, managed vs user-owned file policy                                                             |
| `src/onboarding.ts`       | Shared auth mode support, skip copy in shared mode, auto-discovery                                                                      |
| `src/commands/create.ts`  | Per-project setup on first run, `ensureProjectDir()`                                                                                    |
| `src/commands/run.ts`     | Session tracking integration                                                                                                            |
| `src/commands/attach.ts`  | Session tracking integration                                                                                                            |
| `src/commands/shared.ts`  | Remove build-dirty tracking, add config-dir protection                                                                                  |
| `src/args.ts`             | Remove build targets                                                                                                                    |
| `src/types.ts`            | Remove deprecated types                                                                                                                 |
| `src/platform/paths.ts`   | Add new paths, update container name generation                                                                                         |

---

## Implementation Order

| Phase       | Sections      | Description                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1** | 2.1, 2.2, 2.4 | Create `config.json` system (`mount-config.ts`), per-project overrides, migration. **Note:** Phase 1 defines the schema; Phase 7 creates `postinstall.js` that seeds `config.json` from `install.json`. The runtime fallback (`ensureHostConfig()` in mount-config.ts) creates a default `config.json` if absent, so Phases 1–6 work without a postinstall. |
| **Phase 2** | 4, 6.1e       | Mount system rewrite (`buildMounts()` with all features). Depends on Phase 1 (schema).                                                                                                                                                                                                                                                                      |
| **Phase 3** | 1.1           | Collapse to single Dockerfile (independent of Phase 2, but do after to avoid build-path conflicts).                                                                                                                                                                                                                                                         |
| **Phase 4** | 5, 6          | Security hardening + auth/history modes. Depends on Phase 1 (schema) and Phase 2 (mounts).                                                                                                                                                                                                                                                                  |
| **Phase 5** | 7, 8          | SSH agent forwarding + file-based session tracking. Depends on Phase 2 (mounts). §8.1b specifically depends on §2.1d (PROJECTS_DIR) and §2.2c (generateProjectDirName).                                                                                                                                                                                     |
| **Phase 6** | 9             | Container shell environment (`container.bashrc`). Depends on Phase 2 (mounts).                                                                                                                                                                                                                                                                              |
| **Phase 7** | 2.3, 11       | Install-time seeding (`install.json`, `postinstall.js`) + file cleanup. Depends on Phase 1 (schema).                                                                                                                                                                                                                                                        |
