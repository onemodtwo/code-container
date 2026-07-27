# Modifications from upstream (v3.5.1)

This document details all changes made to the codebase since the last
upstream release (`ddb4d9de`, tagged `v3.5.1`). The fork is published as
`@onemodtwo/code-container` (v3.6.0).

## Package Identity

| Field       | v3.5.1 (upstream)                      | v3.6.0 (fork)                               |
| ----------- | -------------------------------------- | ------------------------------------------- |
| Name        | `@aerovato/container`                  | `@onemodtwo/code-container`                 |
| License     | MIT                                    | BSD-3-Clause                                |
| Author      | kevinMEH                               | kevinMEH, onemodtwo                         |
| Binary      | `dist/js/main.js` (Node)               | `dist/container` (Bun compiled)             |
| Image label | `aerovato.container=v3`                | `onemodtwo.code-container=v3`               |
| Image name  | `aerovato/container-v3-harness:latest` | `localhost/onemodtwo/code-container:latest` |

## Architecture Overview

The upstream used a four-stage Dockerfile generation pipeline
(`dockerfile-core.ts` -> `dockerfile-tools.ts` -> `dockerfile-harness.ts` -> user
Dockerfile) and a flat `SettingsSchema` with limited mount configuration.

The fork replaces this with:

- A **single managed Dockerfile** with ARG-gated conditional tool/harness installs
- A **config-driven mount system** (`mount-config.ts`) with 25+ configurable fields
- **Per-project overrides** via `override.json`
- **File-based session tracking** replacing process-table scanning
- **Tool permission management** for Claude and OpenCode
- A **runtime-mounted bashrc** for container shell configuration
- An **install-time seeding system** (`postinstall.js` + `install.json`)

## New Files

| File                             | Purpose                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                     | Single managed Dockerfile (166 lines). Ubuntu 24.04 base with ARG-gated installs for 12 tools and 10 harnesses. Replaces the four-stage build pipeline.                                                                |
| `container.bashrc`               | Runtime shell config (87 lines). Mounted at `/etc/container.bashrc`. Provides colored prompt with git branch, aliases, `act`/`deact` environment activation, bash completion, history settings, SSH agent passthrough. |
| `install.json`                   | Organization-wide install defaults (68 lines). Seeds `config.json` at install time with base image, tool permissions deny-list, mount defaults.                                                                        |
| `scripts/postinstall.js`         | Install-time setup (289 lines). Auto-detects container runtime, discovers SSH/Python/R paths, writes `config.json`, copies managed files, handles config migration on reinstall.                                       |
| `scripts/build-local.sh`         | Platform-aware build script (30 lines). Detects OS/architecture, runs `bun build --compile` for the correct target.                                                                                                    |
| `src/harness-loader.ts`          | Config-driven harness loader (160 lines). Reads YAML configs from `harnesses/`, validates with Zod, applies platform overrides, derives `config` paths from `host`, builds `HarnessPack` objects.                      |
| `src/mount-config.ts`            | Configuration backbone (209 lines). `GlobalMountConfigSchema` (Zod), `ProjectOverrideSchema`, `loadMountConfig()` (global + per-project merge), `generateProjectDirName()`.                                            |
| `src/session.ts`                 | File-based session tracking (47 lines). PID lock files in `~/.code-container/projects/<name>-<hash>/sessions/`. Replaces unreliable process-table scanning.                                                            |
| `src/tool-permissions.ts`        | Permission management (186 lines). Translates canonical allow/deny rules into Claude `settings.json` and OpenCode `opencode.json` formats. Supports deep merging.                                                      |
| `harnesses/*.yaml` (10 files)    | YAML harness definitions. One file per harness with `id`, `name`, `detect.command`, `install` commands, and `config` mount entries with required `role` annotations. Adding a harness = creating a YAML file.          |
| `planned-additions.md`           | Roadmap for fully config-generated Dockerfile (tool YAML configs + generator).                                                                                                                                         |
| `tests/harness-loader.test.ts`   | Harness loader tests (7 tests). Validates YAML parsing, Zod schema, config derivation, platform overrides.                                                                                                             |
| `tests/mount-config.test.ts`     | Schema validation, config loading, project dir name generation, override merging tests (184 lines).                                                                                                                    |
| `tests/session.test.ts`          | Session lifecycle, PID counting, stale lock cleanup tests (131 lines).                                                                                                                                                 |
| `tests/tool-permissions.test.ts` | Permission translation and merging tests (223 lines).                                                                                                                                                                  |

## Removed Files

| File                            | Reason                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| `src/dockerfile-core.ts`        | Four-stage build pipeline replaced by single managed Dockerfile.      |
| `src/dockerfile-tools.ts`       | Tool Dockerfile generation replaced by ARG-gated RUN blocks.          |
| `src/dockerfile-harness.ts`     | Harness Dockerfile generation replaced by ARG-gated RUN blocks.       |
| `resources/Dockerfile.User`     | User customization template removed; managed Dockerfile at repo root. |
| `.github/workflows/publish.yml` | CI/CD workflow removed.                                               |
| `.github/README/banner.jpg`     | Banner image removed.                                                 |
| `AGENTS.md`                     | AI assistant rules file removed.                                      |
| `skills/container/` (5 files)   | Cursor/OpenCode skill references removed.                             |
| `website/` (entire directory)   | Astro marketing website removed.                                      |
| `__mocks__/fs/promises.ts`      | Unused mock removed.                                                  |

## Source Code Changes

### Configuration System (`src/mount-config.ts`)

New module replacing the old `SettingsSchema` in `types.ts`. Defines:

- **`GlobalMountConfigSchema`** — 25+ fields: `base_image`, `timezone`, `container_runtime`, `data_branches`, `network`, `keep_alive`, `mount_home_children`, `auth_mode`, `history_mode`, `penv_path`, `renv_path`, `extra_readonly`, `extra_readwrite`, `extra_ld_library_path`, `project_symlink_mounts`, `project_symlink_depth`, `forward_ssh_agent`, `ssh_known_hosts_path`, `tool_permissions` (allow/deny arrays), plus backward-compatible fields.
- **`ProjectOverrideSchema`** — Per-project overrides. Scalar fields override global; array fields are additive; global-only fields (`base_image`, `timezone`, etc.) cannot be overridden.
- **`loadMountConfig(projectDirName)`** — Merges global config with per-project `override.json`.
- Config stored at `~/.code-container/config.json` (was `settings.json`).

### Mount System (`src/container.ts`)

Complete rewrite of mount construction. `getMounts()` replaced by `buildMounts()` (~300 lines) implementing:

- **Layered mount ordering:** data branches -> toolchain hidden dirs -> home children -> extra read-only -> LD_LIBRARY_PATH -> venv interpreter -> R env -> project (rw) -> extra read-write -> project symlinks -> SSH agent -> tool configs -> git config -> container.bashrc
- **Deduplication:** `mountIndex` Map deduplicates by container path; read-write upgrades earlier read-only mounts
- **Home children:** Non-hidden `$HOME` children mounted read-only; symlinks filtered by target
- **Asymmetric specs:** `hostPath:containerPath` syntax in extra mounts
- **Ancestor protection:** `addWriteWithProtection()` walks up directory tree adding read-only mounts
- **Symlink auto-mounting:** Configurable (`read`/`write`/`off`), depth-limited
- **Venv interpreter detection:** Resolves symlinks to detect real interpreter path
- **Project mounted at `/root/<name>:<hostPath>`** instead of `<path>:<path>`
- **`--volume` format** replacing `--mount` format
- **Permissions file mounted read-only** on top of writable settings directory

### Tool Permissions (`src/tool-permissions.ts`)

New module managing AI tool permissions:

- `mergePermissionsIntoConfig()` writes allow/deny rules into Claude `settings.json` and OpenCode `opencode.json`
- Translates canonical format (`Bash(*)`, `Read`, `Write`) into each tool's native format
- Writes to **project-specific** config directory (`~/.code-container/projects/<name>/configs/`) to prevent cross-project contamination
- Permissions file mounted **read-only** inside container to prevent AI self-escalation

### Session Tracking (`src/session.ts`)

Replaced unreliable `ContainerClient.attachedSessionCount()` (process-table scanning) with file-based PID lock files:

- `trackSessionStart()` / `trackSessionEnd()` write/remove lock files
- `countActiveSessions()` checks live PIDs via `kill -0` and cleans stale locks
- Lock files at `~/.code-container/projects/<name>-<hash>/sessions/`

### Docker Build System (`src/docker.ts`)

Completely rewritten:

- Removed four-stage build pipeline (`BUILD_ORDER`, `shouldBuild()`, `clearBuildDirty()`)
- `TOOL_BUILD_ARG_MAP` still hardcoded for tools (pending tool YAML refactor)
- `HARNESS_BUILD_ARG_MAP` **derived dynamically** from `HARNESS_PACKS` via `getHarnessBuildArgMap()` — no more hardcoded dictionary
- Added `copyManagedDockerfile()` to install packaged Dockerfile
- `buildImage()` reads enabled tools/harnesses from config, constructs `--build-arg` flags, builds single image

### Setup (`src/setup.ts`)

- Removed entire `runMigration()` function (v2-to-v3 migration)
- Added `PROJECTS_DIR` and `CONTAINER_BASHRC_PATH` directory creation
- Added `ensureHostConfig()` call
- Added managed file copy for `container.bashrc`

### Path Constants (`src/platform/paths.ts`)

Removed: `ARCHIVE_DIR`, `SETTINGS_PATH`, `CORE_DOCKERFILE_PATH`, `TOOLS_DOCKERFILE_PATH`, `HARNESS_DOCKERFILE_PATH`

Added: `CONFIG_JSON_PATH`, `PROJECTS_DIR`, `DOCKERFILE_PATH`, `CONTAINER_BASHRC_PATH`

### Harness Packs (`src/harness-packs.ts` + `harnesses/*.yaml`)

Completely rewritten from hardcoded TypeScript to config-driven YAML:

- **10 YAML files** in `harnesses/` — one per harness with `id`, `name`, `detect.command`, `install` commands, and `config` mount entries
- **`role` required** on every mount entry — prevents silent fallback to managed dir
- **`config` derived** from `host` by stripping `~/` — no manual path duplication
- **Platform overrides** — optional `platforms` section merges by `container` path match
- **`buildArgName`** computed from `id` (e.g. `claude` → `INSTALL_CLAUDE`)
- **`src/harness-loader.ts`** — Zod schemas, YAML parsing, platform resolution, `loadAllHarnessPacks()`
- **`src/harness-packs.ts`** — now 3 lines: `export const HARNESS_PACKS = loadAllHarnessPacks()`
- **`src/docker.ts`** — `HARNESS_BUILD_ARG_MAP` derived from packs via `getHarnessBuildArgMap()` instead of hardcoded dictionary

Adding a harness is now: create `harnesses/new-harness.yaml`. No TypeScript changes needed.

### Other Source Changes

- **`src/types.ts`** — Removed `BuildTarget`, `DockerfileCoreConfig`, `SettingsSchema`. `Settings` is now alias for `GlobalConfig`. `BaseConfigMount` gains `role` and `readonly` fields.
- **`src/container-client.ts`** — Removed `attachedSessionCount()`.
- **`src/args.ts`** — Removed `BUILD_TARGETS` and build target parsing.
- **`src/main.ts`** — Removed `runMigration()`, uses `CONFIG_JSON_PATH`.
- **`src/onboarding.ts`** — Simplified build calls, respects auth/history modes.
- **`src/commands/*.ts`** — Updated parameter passing (projectDirName instead of settings).
- **`src/update-check.ts`** — Updated GitHub API URL.

## Dockerfile

Single managed `Dockerfile` at repo root (166 lines):

- **Base:** `ubuntu:24.04`
- **Shell:** `source /etc/container.bashrc` in `/root/.bashrc`; conditional PATH exports per tool
- **Core packages:** build-essential, git, curl, wget, unzip, ca-certificates, libssl-dev, zlib1g-dev, libffi-dev, vim, tree
- **NVM + Node.js 22** installed and linked to `/usr/local/bin/`
- **12 tool ARGs:** PYTHON, BUN, ENHANCED_TOOLS, DENO, RUST, GO, UV, GH, AWS, GCLOUD, AZURE, NEOVIM
- **10 harness ARGs:** CLAUDE, OPENCODE, CODEX, PI, GEMINI, COPILOT, GROK, CURSOR, NITRO, ANTIGRAVITY
- Each tool/harness gated by `RUN if [ "$INSTALL_*" = "true" ]` conditional

## Security Hardening

1. `--security-opt no-new-privileges` on all containers
2. Tool permissions deny-list (curl, wget, pip, ssh, apt, npm, etc.) in `install.json`
3. Tool settings mounted read-only; permissions file mounted read-only on top
4. Auth files marked `readonly: true`
5. `~/.code-container/` never mounted; project paths inside it rejected
6. Path canonicalization via `fs.realpathSync()` prevents symlink-based escapes
7. `~/.gitconfig` mounted read-only
8. Config file written with `mode: 0o600`
9. SSH agent forwarding opt-in (`forward_ssh_agent: false` by default)
10. Hidden directories (`.ssh`, `.aws`, `.gnupg`) never mounted
11. Ancestor directory protection for writable mounts

## Container Runtime

- **Bashrc:** Runtime-mounted `container.bashrc` provides prompt, aliases, environment activation, bash completion, history settings
- **PATH:** Consolidated `.local/bin` export; bun uses `$HOME/.bun/bin`; install scripts suppressed from modifying `.bashrc`
- **Env vars:** `PENV_PATH`, `RENV_PATH`, `LD_LIBRARY_PATH`, `SSH_AUTH_SOCK` forwarded from config
- **Mount format:** `--volume` (was `--mount`)
- **Podman:** `--group-add keep-groups` added automatically

## Test Changes

**New test files:**

- `tests/harness-loader.test.ts` (7 tests) — YAML parsing, Zod validation, config derivation, platform overrides
- `tests/mount-config.test.ts` (184 lines)
- `tests/session.test.ts` (131 lines)
- `tests/tool-permissions.test.ts` (223 lines)

**Modified test files:**

- `tests/args.test.ts` — Removed build target tests
- `tests/commands.test.ts` — Rewired for new config path, removed stateStore
- `tests/config.test.ts` — Adapted for new config path
- `tests/docker.test.ts` — Extensive changes for new build system; mocked harness packs
- `tests/onboarding.test.ts` — Simplified build calls; mocked harness packs
- `tests/platform/paths.test.ts` — Updated path constants
- `tests/setup.test.ts` — Removed migration tests, added managed file tests
- `tests/tos.test.ts` — Adapted for new config path

## Commit Log

```
665927c refactor: config-driven harness system with YAML configs
87514ef fix: mount permissions file read-only on top of writable settings dir
0b86352 fix: remove readonly from claude/opencode .config settings dirs
68ce453 fix: remove readonly from opencode/opentui .local/share data dirs
3c376c3 Fix coloring of container prompt in container.bashrc
1d79f59 fix: consolidate .local/bin PATH export to single unconditional line
1afdee9 fix: suppress install scripts from modifying .bashrc to prevent PATH duplicates
dc028fd fix: ensure project configs dir exists before mounting settings
9bfc5c7 fix: make container.bashrc the single source of shell config
0365110 fix: write tool permissions to project-specific config dir instead of global
c979e24 feat: wire tool_permissions into harness configs for Claude and OpenCode
65f0ff4 fix: swap host/container path order in project mount
b3a3f81 fix: use --volume instead of --mount for bind mount format
270ece3 README: add troubleshooting section for podman crun/systemd issue
1599861 precommit: auto-stage prettier fixes instead of failing
183fcd7 Update .gitignore and package-lock.json
be2a67e README: add install-links config note and requirements callout
22d0ad9 build standalone binary for current platform
87cfdb9 fix README: add missing npm install step to installation instructions
fa3321c split build: 'build' for JS only, 'build:release' adds binary
ed58c86 fix README: remove stale /data, /data2 default references
0d64a9b bump version to 3.6.0
2beada9 v3.6.0: config-driven mounts, security hardening, package rename
```
