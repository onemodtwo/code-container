# Modifications to code-container

This document describes all modifications made to this fork of [code-container](https://github.com/kevinMEH/code-container) (upstream version 2.5.0). The fork is a substantial rework that narrows the scope to Claude Code exclusively, replaces the multi-tool harness installer with a security-hardened, configuration-driven mount system, and adds first-class support for enterprise/HPC environments (CephFS, Podman, SSH agent forwarding, shared R/Python environments).

The original is a general-purpose Docker harness for multiple AI coding tools (Claude, OpenCode, Codex, Copilot, Gemini). This fork strips multi-tool support and rebuilds the project around a single concern: running Claude Code in an isolated container with fine-grained control over what the agent can see and modify.

---

## 1. Architecture and Scope Changes

### Single-tool focus

The upstream project installs and configures five coding tools inside the container image (Claude Code, OpenCode, Codex, GitHub Copilot, Gemini CLI). This fork removes all tools except Claude Code. The Dockerfile installs only Claude Code via the official install script. The rationale is that multi-tool support adds image size, attack surface, and configuration complexity that is unnecessary when only Claude Code is needed.

### Single Dockerfile replaces four-stage build

Upstream uses a four-stage image build pipeline (`Dockerfile.Core` -> `Dockerfile.Packages` -> `Dockerfile.Harness` -> `Dockerfile.User`) with intermediate images. The `container build` command accepts a target argument (`full`, `packages`, `harness`, `user`) to rebuild from a specific stage.

This fork collapses the pipeline into a single `Dockerfile` with build arguments. The rationale is that the multi-stage pipeline exists to support user customization layers, but this fork treats the Dockerfile as a managed file (overwritten on reinstall) and uses runtime mounts instead of baked-in customization. The single Dockerfile is simpler to maintain and produces one image layer.

```dockerfile
ARG BASE_IMAGE
FROM $BASE_IMAGE

ARG TZ
ARG CLAUDE_VERSION

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
    && dnf install -y ... \
    && curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLAUDE_VERSION} \
    && dnf clean all
```

Build-time parameters (`base_image`, `timezone`, `claude_version`) are read from `config.json` and passed as `--build-arg` flags by the CLI.

### Base image changed from Ubuntu to Rocky Linux

Upstream uses `ubuntu:24.04`. This fork defaults to `rockylinux:9`. The rationale is compatibility with RHEL-based HPC/enterprise environments where shared libraries on network filesystems (CephFS, NFS) are compiled against RHEL 9 system libraries. The base image is configurable via `config.json` and can be changed to any image.

### Managed vs. user-owned file distinction

This fork introduces a clear lifecycle policy:

- **Managed files** (`Dockerfile`, `container.bashrc`, `ssh-agent-relay.py`) are overwritten on every `npm install`. They are repo-owned infrastructure.
- **User-owned files** (`config.json`, per-project `override.json`) are written once at first install and never overwritten. They contain environment-specific settings.

Upstream does not make this distinction explicitly -- it copies user-editable Dockerfiles only if they do not already exist, and uses `MOUNTS.txt` and `DOCKER_FLAGS.txt` as freeform text files that the user edits.

---

## 2. Configuration System

### JSON configuration replaces text-file mounts and flags

Upstream uses three text files for runtime configuration:
- `MOUNTS.txt` -- one mount spec per line
- `DOCKER_FLAGS.txt` -- Docker CLI flags passed to every command
- `DOCKER_RUN_FLAGS.txt` -- flags passed only to `docker run`

This fork replaces all three with a structured JSON configuration at `~/.code-container/config.json` validated by a Zod schema. Every configurable field has a typed default, and invalid JSON or unexpected types fall back to schema defaults with a warning rather than crashing.

The rationale is that structured configuration is less error-prone than freeform text files, enables validation, and makes it possible to document every field with its type and default value.

### Per-project override system

Upstream has no per-project configuration. All containers share the same mounts and flags.

This fork adds `~/.code-container/projects/<name>-<hash>/override.json` for per-project overrides. The merge strategy is:

- Most fields: project value overrides global value
- Array fields (`extra_readonly`, `extra_readwrite`, `extra_ld_library_path`): project values are appended to global values (additive merge)
- Global-only fields (`base_image`, `timezone`, `container_runtime`, `data_branches`): cannot be overridden per-project

The new `mount-config.ts` module handles loading and merging:

```typescript
export function loadMountConfig(projectDirName: string): MountConfig {
  const global = loadGlobalConfig();
  const override = parseFile(ProjectOverrideSchema, ...);
  return {
    network: override.network ?? global.network,
    extra_readonly: [...global.extra_readonly, ...(override.extra_readonly ?? [])],
    // ... etc
  };
}
```

### Install-time seeding via `install.json`

A new `install.json` file (checked into the repo) provides organization-wide defaults that are written into `config.json` at first install. This allows organizations to fork the repo, set their preferred defaults (data paths, timezone, runtime, permissions), and have those defaults apply to all users who install from the fork.

The `postinstall.js` script reads `install.json`, auto-detects the container runtime (Podman preferred, Docker fallback), discovers Python/R environment paths by searching the filesystem, discovers the SSH `known_hosts` path, and writes the result to `config.json`.

On reinstall (when `config.json` already exists), the script performs a migration: adding missing keys with defaults and removing deprecated keys, while preserving all user-set values.

### Config migration on reinstall

When the tool adds new configuration fields, `postinstall.js` detects the missing keys and adds them with sensible defaults. Auto-discovered fields (like `ssh_known_hosts_path`) are re-discovered rather than defaulting to empty. Deprecated keys are removed with a log message showing their old value. This means users do not need to manually edit `config.json` after upgrading.

---

## 3. Container Runtime

### Podman support (preferred over Docker)

Upstream hardcodes `docker` as the container runtime. This fork makes the runtime configurable (`container_runtime` in `config.json`) and prefers Podman.

All `docker` CLI calls are replaced with a `runtimeCmd` variable set at startup:

```typescript
let runtimeCmd = "podman";
export function setRuntimeCmd(cmd: string): void {
  runtimeCmd = cmd;
}
```

The rationale is that Podman is daemonless and rootless by default (no socket permissions, no background process), and critically supports `--group-add keep-groups`, which passes the host user's supplementary group memberships into the container. This is essential for accessing group-gated network filesystems (CephFS, NFS).

When Podman is detected, `createNewContainer` adds `--group-add keep-groups` automatically.

---

## 4. Mount System

The mount system is the most extensively modified area. Upstream's approach is a flat list of hardcoded core mounts plus freeform `MOUNTS.txt` entries. This fork replaces it with a declarative, layered mount builder.

### Mount ordering and deduplication

`buildMounts()` in `mounts.ts` constructs the mount list in a specific order:

1. Data branches (read-only)
2. Language toolchain hidden directories (read-only)
3. Non-hidden `$HOME` children (read-only)
4. Extra read-only paths
5. `LD_LIBRARY_PATH` paths (read-only)
6. Venv interpreter auto-mount (read-only)
7. R environment auto-mount (read-only)
8. Project path (read-write, with read-only option)
9. Extra read-write paths (with ancestor protection)
10. Project symlink targets (read or write, depending on config)
11. SSH agent relay directory
12. Claude config files (settings, auth, history, statsig)
13. Git config

Mounts are deduplicated by container destination path. Read-write mounts upgrade earlier read-only mounts for the same destination.

### Home directory children (auto-mounted)

When `mount_home_children` is true (default), non-hidden children of `$HOME` are individually bind-mounted read-only. Hidden directories are excluded (security), except for five language toolchain directories: `.nvm`, `.cargo`, `.rustup`, `.local`, `.pyenv`.

Symlinks among home children are filtered: symlinks into hidden directories are skipped, symlinks to `~/.code-container/` are skipped, symlinks to paths outside `$HOME` are only mounted if the target is under an explicitly configured path.

### Asymmetric mount specs

Mount entries in `extra_readonly` and `extra_readwrite` support `hostPath:containerPath` syntax for mounting host files at different container paths. This is used, for example, to mount `~/.claude/CLAUDE.md` at `/root/.claude/CLAUDE.md` inside the container.

### Ancestor directory protection for writable mounts

When a read-write path is mounted, its ancestor directories on the host are automatically protected with read-only mounts. Without this, Podman would expose the parent directories with no access restrictions. The `addWriteWithProtection()` function walks up the directory tree, adding read-only mounts for each ancestor until it reaches one already covered by an existing mount.

### Project symlink auto-mounting

A new feature controlled by `project_symlink_mounts` (`"read"`, `"write"`, or `"off"`). When enabled, `buildMounts()` walks the project directory tree (to a configurable depth) looking for symlinks. Targets outside the project path are auto-mounted so the symlinks are not dead inside the container.

### Venv interpreter auto-detection

When `penv_path` points to a Python venv whose interpreter is a symlink to an external location (common with uv, pyenv, asdf, conda), `resolveVenvInterpreterMount()` detects the real interpreter path and adds a read-only mount for it. This prevents "python not found" errors when the venv's `bin/python` symlink would otherwise be a dead link.

### Data branches

A new `data_branches` config field (global only) mounts specified paths read-only into every container. Seeded from `install.json` (default: `["/data", "/data2"]`). Upstream has no equivalent -- mount paths were specified manually in `MOUNTS.txt`.

### LD_LIBRARY_PATH support

A new `extra_ld_library_path` config field. Paths listed here are mounted read-only **and** set as `LD_LIBRARY_PATH` inside the container. This supports site-specific shared libraries (e.g., Intel MKL, vendor BLAS) that mounted binaries were linked against.

### Project read-only mode

Per-project `override.json` supports `project_readonly: true` to mount the project directory read-only. Useful for analysis or review sessions where the agent should not modify project files.

---

## 5. Security Hardening

### Read-only Claude settings

Claude's `settings.json` is mounted **read-only** inside the container at `/root/.claude/settings.json`. The agent cannot modify its own permissions during a session. The file is written from `claude_permissions` in `config.json` when a project directory is first created.

### Default permission deny list

The default permissions (from `install.json`) pre-approve all standard Claude tools but deny explicit network-making shell commands:

```json
"deny": [
  "Bash(curl*)", "Bash(wget*)", "Bash(pip*)", "Bash(pip3*)",
  "Bash(uv*)", "Bash(cargo*)", "Bash(npm*)", "Bash(npx*)",
  "Bash(yarn*)", "Bash(pnpm*)", "Bash(apt*)", "Bash(apt-get*)",
  "Bash(conda*)", "Bash(mamba*)", "Bash(micromamba*)",
  "Bash(ssh*)", "Bash(scp*)", "Bash(sftp*)", "Bash(rsync*)",
  "Bash(nc*)", "Bash(netcat*)", "Bash(socat*)", "Bash(ftp*)",
  "Bash(telnet*)"
]
```

Upstream uses `{ allow: ["*"], deny: [] }` by default with no network restrictions.

### No-new-privileges security option

All containers are created with `--security-opt no-new-privileges`, preventing privilege escalation via setuid/setgid binaries inside the container. Upstream does not set this.

### Config directory protection

`container run` rejects project paths inside `~/.code-container/`, preventing an agent from mounting the configuration directory as a project and reading or modifying config files.

### Path canonicalization

Project paths are canonicalized (symlinks resolved, trailing slashes stripped) before hashing. This prevents the same physical directory from appearing as different containers when accessed via different paths or symlinks.

---

## 6. Claude Auth and History Modes

### Shared vs. per-project auth (`claude_auth_mode`)

Upstream copies `~/.claude.json` into a per-project config directory at init time. This fork defaults to **shared** mode: `~/.claude.json` from the host is mounted directly (read-write, since Claude writes to it on startup). Re-authentication on the host takes effect in all containers immediately.

Per-project mode is available by setting `claude_auth_mode: "per_project"` -- useful for isolating OAuth tokens when different projects use different authentication.

### Shared vs. isolated history (`claude_history_mode`)

Upstream isolates conversation history per container. This fork defaults to **shared** mode: the host's `~/.claude/projects/` is mounted directly, so conversation history is continuous across host and container sessions for the same project. Claude Code namespaces by project path hash, so projects do not bleed into each other.

Isolated mode is available per-project for cases where clean-slate sessions are preferred.

---

## 7. SSH Agent Forwarding

An entirely new feature. When `forward_ssh_agent` is `true`:

1. `~/.ssh-agent-relay/` is mounted read-only into the container
2. `SSH_AUTH_SOCK` is set to `~/.ssh-agent-relay/agent.sock` inside the container
3. The configured `ssh_known_hosts_path` is mounted at `/root/.ssh/known_hosts` (read-only)

This enables `git push`/`git clone` over SSH inside the container using the host's SSH agent credentials, without copying private keys into the container.

### Relay script

A Python 3 asyncio relay script (`ssh-agent-relay.py`) listens on a stable Unix socket and proxies connections to the current SSH agent socket. This solves the problem of ephemeral agent sockets that change path on every SSH reconnect -- the relay socket never moves, so containers always find it.

The relay is launched from `~/.ssh/rc` (documented in the README with a complete setup snippet) and runs indefinitely, following symlink updates automatically.

### Known hosts auto-discovery

At install time, `postinstall.js` searches for the SSH `known_hosts` file in standard locations (`~/.ssh/known_hosts`, `/etc/ssh/ssh_known_hosts`) and parses `GlobalKnownHostsFile` directives from `/etc/ssh/ssh_config.d/`. The discovered path is stored in `config.json`.

---

## 8. Session Tracking

### File-based session tracking replaces process table scanning

Upstream counts active sessions by scanning the host's process table for `docker exec` commands matching the container name and project path. This is unreliable -- Docker may not clean up ExecIDs immediately after an exec session exits.

This fork uses file-based session tracking. Each exec session writes a lock file named by its PID into `~/.code-container/projects/<name>/sessions/`. On exit, the file is deleted. `countActiveSessions()` checks for live PIDs (using `process.kill(pid, 0)`) and cleans up stale lock files from crashes.

```typescript
export function trackSessionStart(sessionDir: string): string {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, `session-${process.pid}`);
  fs.writeFileSync(sessionFile, String(process.pid), { mode: 0o600 });
  return sessionFile;
}
```

---

## 9. Container Shell Environment

### Runtime-mounted bashrc

Upstream bakes the shell prompt into the Dockerfile's `.bashrc` echo commands. This fork externalizes shell configuration to `container.bashrc`, which is mounted at runtime at `/etc/container.bashrc`. Changes to the shell environment take effect on `container remove` + `container run` without requiring a rebuild.

### Environment activation helpers

`container.bashrc` provides `act` and `deact` functions for activating/deactivating Python and R environments. `PENV_PATH` and `RENV_PATH` are injected as environment variables at container start from `config.json` values.

```bash
act     # activate Python and/or R environments
deact   # deactivate (also aliased as `quit`)
```

### Shell aliases

The bashrc includes convenience aliases (`l`, `la`, `ll`, `lg`, `lt` for `ls` variants; `..`, `...`, `....` for `cd` navigation) and a colored prompt showing `[container] dirname (branch) $`.

---

## 10. Removed Features

### Multi-tool harness installation removed

The upstream Dockerfile installs OpenCode, Codex, Gemini CLI, and GitHub Copilot alongside Claude Code. All of these are removed. The `SHARED_DIRS` constant that tracked config directories for these tools (`.codex`, `.copilot`, `.opencode`, `.gemini`) is removed.

### Config copy workflow removed

Upstream copies Claude, Codex, Copilot, OpenCode, and Gemini config directories from `$HOME` into `~/.code-container/configs/` at init time, then mounts `configs/` into the container. This fork mounts Claude files directly from the host (in shared mode) or copies only Claude's auth file (in per-project mode). The `configs/` directory and the multi-tool copy logic are removed.

### MOUNTS.txt, DOCKER_FLAGS.txt, DOCKER_RUN_FLAGS.txt removed

Replaced by `config.json` as described in section 2.

### shell-quote dependency removed

Upstream depends on `shell-quote` (for parsing Docker flag files). This fork removes it since there are no flag files to parse. The only runtime dependency is `zod` for schema validation.

### args.ts and flags.ts modules removed

Upstream has a dedicated argument parser (`args.ts`) that handles `--` separator for passing Docker flags, and a flags loader (`flags.ts`) for parsing flag files. Both are removed. Argument parsing is inlined in `main.ts` with a simpler structure.

### Test infrastructure removed

Upstream includes a test suite (`tests/`, `vitest.config.ts`, `__mocks__/`) and dev tooling (ESLint, Prettier, Husky). This fork does not include tests or linting infrastructure. The `devDependencies` are reduced to `@types/node` and `typescript` only.

### NVM/Node.js installation removed from image

Upstream installs NVM and Node.js 22 inside the container image. This fork relies on the host's Node.js installation being available through the mounted home directory (via `.nvm` toolchain mount). The container image is kept minimal.

---

## 11. Project Structure Changes

### Files added

| File | Purpose |
|---|---|
| `src/mount-config.ts` | Configuration loading, schema validation, per-project merge logic |
| `container.bashrc` | Container shell environment (mounted at runtime) |
| `install.json` | Organization-wide install defaults |
| `ssh-agent-relay.py` | SSH agent socket relay for persistent forwarding |

### Files removed (relative to upstream)

| File | Reason |
|---|---|
| `src/args.ts` | Argument parsing inlined in `main.ts` |
| `src/flags.ts` | Flag files replaced by `config.json` |
| `resources/Dockerfile.Core` | Four-stage build collapsed to single Dockerfile |
| `resources/Dockerfile.Harness` | Same |
| `resources/Dockerfile.Packages` | Same |
| `resources/Dockerfile.User` | Same |
| `eslint.config.mjs` | Dev tooling not included |
| `vitest.config.ts` | Test infrastructure not included |
| `tsconfig.test.json` | Same |
| `tests/*` | Same |
| `__mocks__/*` | Same |
| `docs/*` | Replaced by comprehensive README |

### Files significantly rewritten

| File | Nature of changes |
|---|---|
| `src/main.ts` | Argument parsing inlined; runtime detection added; `mount-config` integration |
| `src/config.ts` | Removed multi-tool configs/copies; added per-project directory management, path canonicalization, Claude permissions injection |
| `src/docker.ts` | Configurable runtime; file-based sessions; build args; `--security-opt no-new-privileges`; `--group-add keep-groups` for Podman; runtime bashrc mount |
| `src/mounts.ts` | Complete rewrite -- declarative mount builder with deduplication, home child enumeration, symlink filtering, ancestor protection, venv auto-detection |
| `src/commands.ts` | Removed init copy workflow; added mount config integration; session tracking; SSH agent warnings |
| `scripts/postinstall.js` | Rewritten for `config.json` seeding, runtime detection, env path discovery, config migration |
| `Dockerfile` | Single file; Rocky Linux base; build args; minimal packages; runtime bashrc mount |
| `README.md` | Complete rewrite documenting all features, configuration, security model |
| `AGENTS.md` | Rewritten for fork's architecture |
| `package.json` | Simplified; removed multi-tool deps; added `engines` field |
