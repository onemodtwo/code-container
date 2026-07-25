# Code Container

Isolated environments for AI coding agents. One image, one container per project, minimal host exposure.

> This is a fork of [container (v3.5.1)](https://github.com/aerovato/container) by aerovato, supporting multiple AI coding tools with a hardened security model and host-only configuration.

**Requirements:** [Node.js](https://nodejs.org/) (for building), [Bun](https://bun.sh/) (for compiling the binary), and a container runtime ([Podman](https://podman.io/) preferred or [Docker](https://www.docker.com/)).

## How it works

- Your project directory is mounted **read-write by default** — overrideable to read-only per project
- Configured data branches (default: none — add via `data_branches` in `config.json`) and non-hidden directories under `$HOME` are mounted **read-only** — the agent can browse and use them but cannot modify them
- Hidden directories (`.ssh`, `.aws`, `.gnupg`, etc.) are **never mounted** — with the exception of language toolchain directories (`.nvm`, `.cargo`, `.rustup`, `.local`, `.pyenv`) which are mounted read-only when `mount_home_children` is true
- Your AI tool's `settings.json` is **read-only inside the container** — the agent cannot change its own permissions
- Your AI tool's conversation history and credentials are **shared with your host session** by default — continuity across host and container sessions for the same project
- All configuration lives in `~/.code-container/` which is never mounted — an agent cannot read or modify it

## Supported tools

The container supports multiple AI coding tools. Each tool is auto-detected at install and its config/history/auth files are mounted into the container. The following tools are supported:

| Tool                   | Install command                                   | Config dir           | Auth file        | History dir               | Instructions file |
| ---------------------- | ------------------------------------------------- | -------------------- | ---------------- | ------------------------- | ----------------- |
| **Claude Code**        | `curl -fsSL https://claude.ai/install.sh \| bash` | `~/.claude`          | `~/.claude.json` | `~/.local/state/claude`   | `CLAUDE.md`       |
| **OpenCode**           | `npm install -g opencode-ai`                      | `~/.config/opencode` | —                | `~/.local/state/opencode` | `AGENTS.md`       |
| **OpenAI Codex**       | `npm install -g @openai/codex`                    | `~/.codex`           | —                | —                         | `AGENTS.md`       |
| **Pi**                 | `npm install -g @earendil-works/pi-coding-agent`  | `~/.pi`              | —                | —                         | —                 |
| **Gemini CLI**         | `npm install -g @google/gemini-cli`               | `~/.gemini`          | —                | —                         | —                 |
| **GitHub Copilot CLI** | `npm install -g @github/copilot`                  | `~/.copilot`         | —                | —                         | —                 |
| **Grok Build**         | `curl -fsSL https://x.ai/cli/install.sh \| bash`  | `~/.grok`            | —                | —                         | —                 |
| **Cursor CLI**         | `curl https://cursor.com/install -fsS \| bash`    | `~/.cursor`          | —                | —                         | —                 |

The `auth_mode` and `history_mode` settings control how auth and history files are mounted. In **shared mode** (default), files are mounted directly from the host. In **per_project**/**isolated** mode, files are copied into the project config directory at first run.

## Prerequisites

- **Container runtime**: Podman (preferred) or Docker — see below
- Linux, macOS, or WSL (**POSIX required** — the install script uses `find` and other POSIX tools; native Windows is not supported)
- Node.js >= 16.0.0 (for npm install — Node 16 is end-of-life; upgrade to Node 18 LTS or later when possible)
- Your AI coding tool authenticated on the **host** before first use

### Container runtime

The tool supports both **Podman** and **Docker**. **Podman is strongly preferred** and detected automatically at install.

**Podman** is daemonless and rootless by default — no socket permissions, no background process, no setup required. Critically, Podman supports `--group-add keep-groups`, which passes the host user's supplementary group memberships into the container. This is essential for accessing network filesystems (CephFS, NFS) that gate directories like `/data` by group membership. Without it, the container may see those paths but receive permission errors. If Podman is installed, nothing further is needed.

**Docker** requires access to the Docker daemon. On shared VMs where you lack sudo access, the system socket (`/var/run/docker.sock`) may be root-only. `docker --version` will work but `docker info` will fail — this is the relevant distinction.

Docker does not support `--group-add keep-groups`. When using Docker, the container will not inherit the host user's supplementary groups. Access to group-gated paths on network filesystems will fail with permission errors. The workaround is to add specific GIDs explicitly — find them with `id` on the host and add `"extra_args": ["--group-add", "<gid>"]` entries in `config.json` — but this is manual and fragile. **Use Podman if at all possible.**

If Docker is your only option and `docker info` fails, set up rootless Docker:

```bash
dockerd-rootless-setuptool.sh check    # verify prerequisites
dockerd-rootless-setuptool.sh install  # install rootless daemon
```

If the systemd service fails to start (common on shared VMs), start the daemon manually by adding this to your `~/.bashrc`:

```bash
# Rootless Docker — only needed when podman is not available
if ! command -v podman &>/dev/null; then
  export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
  if ! docker info &>/dev/null 2>&1; then
    nohup dockerd-rootless.sh &>/tmp/dockerd-rootless-$(id -u).log &
    disown
    for i in $(seq 1 10); do
      [ -S "/run/user/$(id -u)/docker.sock" ] && break
      sleep 0.5
    done
  fi
fi
```

## Installation

Clone the repo, install dependencies, build, and install:

```bash
git clone <internal-repo-url>
cd code-container
npm install
npm run build
```

By default, `npm install -g` creates symlinks back to the repo — if the repo moves or is deleted, the `container` command breaks. To copy the binary instead (recommended):

```bash
npm config set install-links true
```

If you have permission to write to the global npm prefix:

```bash
npm install -g .
```

If not (no sudo access), install to your user-local prefix:

```bash
npm install -g . --prefix ~/.local
```

> **Note:** `npm install` only needs to be run once (or when `package.json` changes). `npm run build` must be run before every install or reinstall — the compiled `dist/container` binary is not committed to the repo.

For the local install, `~/.local/bin` must be on your `PATH`. Add to `~/.bashrc` if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Installation creates `~/.code-container/` with all config files, copies the default Dockerfile, and auto-detects your container runtime and Python/R environment paths.

## Setup

### 1. Authenticate your AI coding tool on the host

```bash
claude  # or: opencode, codex, etc. — follow the login prompt, then exit
```

### 2. Build the container image

```bash
container build    # takes a few minutes; run once per machine or after config changes
```

`container build` can be run from any directory — it is not project-specific.

### 3. Run

```bash
cd /path/to/your/project
container
```

On first run for a project, `container` creates a config directory at `~/.code-container/projects/<projectname>-<hash>/` and copies your AI tool's credentials and settings into it. You land directly in the project directory inside the container.

```bash
claude       # start Claude Code — history from your last session is available
act          # activate Python and/or R environments
```

## Commands

```bash
container                        # Start container for current directory
container run /path/to/project   # Start container for a specific project
container build                  # Build (or rebuild) the container image
container init [path]            # Re-copy configs from host to project dir
container stop [path]            # Stop the container
container remove [path]          # Remove the container (preserves project config)
container list                   # List all containers and their hashes
container settings               # Open config.json in editor
container version                # Show version
container upgrade                # Upgrade to latest version
```

## Configuration

All configuration lives in `~/.code-container/` — never mounted into containers, never reachable by an agent.

### Priority chain

From lowest to highest priority:

1. **Schema defaults** — compiled into the binary; silent fallback if files are missing
2. **`~/.code-container/config.json`** — global defaults for every container on this machine
3. **`~/.code-container/projects/<name>-<hash>/override.json`** — per-project overrides

---

### Global: `~/.code-container/config.json`

Created at install with all fields populated. Change a value here to apply it to all projects that have no per-project override.

```json
{
  "base_image": "ubuntu:24.04",
  "timezone": "America/New_York",
  "container_runtime": "podman",
  "data_branches": [],
  "auth_mode": "shared",
  "history_mode": "shared",
  "network": "bridge",
  "keep_alive": false,
  "mount_home_children": true,
  "penv_path": "",
  "renv_path": "",
  "extra_readonly": [],
  "extra_readwrite": [],
  "extra_ld_library_path": [],
  "project_symlink_mounts": "read",
  "project_symlink_depth": 3,
  "forward_ssh_agent": true,
  "ssh_known_hosts_path": "/discovered/path/to/known_hosts",
  "tool_permissions": {
    "allow": [
      "Bash(*)",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "Agent",
      "TodoRead",
      "TodoWrite",
      "NotebookRead",
      "NotebookEdit",
      "LSP"
    ],
    "deny": [
      "Bash(curl*)",
      "Bash(wget*)",
      "Bash(pip*)",
      "Bash(pip3*)",
      "Bash(uv*)",
      "Bash(cargo*)",
      "Bash(npm*)",
      "Bash(npx*)",
      "Bash(yarn*)",
      "Bash(pnpm*)",
      "Bash(apt*)",
      "Bash(apt-get*)",
      "Bash(conda*)",
      "Bash(mamba*)",
      "Bash(micromamba*)",
      "Bash(ssh*)",
      "Bash(scp*)",
      "Bash(sftp*)",
      "Bash(rsync*)",
      "Bash(nc*)",
      "Bash(netcat*)",
      "Bash(socat*)",
      "Bash(ftp*)",
      "Bash(telnet*)"
    ]
  }
}
```

**`base_image` and `timezone` are build-time only** — baked into the image, require `container build` to apply, cannot be overridden per-project.

**`container_runtime` and `data_branches`** are global only — no per-project override.

| Field                    | Per-project override? | Description                                                                                                                                                                                                                                      |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base_image`             | No — build-time only  | Base container image. Requires `container build` to apply.                                                                                                                                                                                       |
| `timezone`               | No — build-time only  | Container timezone. Any valid tz database name (e.g. `"Europe/London"`). Requires `container build` to apply.                                                                                                                                    |
| `container_runtime`      | No — global only      | `"podman"` or `"docker"`. Set by auto-detection at install. Change if you need to switch runtimes.                                                                                                                                               |
| `data_branches`          | No — global only      | Paths mounted read-only into every container. Edit to match your environment.                                                                                                                                                                    |
| `auth_mode`              | Yes — unusual         | `"shared"` or `"per_project"`. See [Auth and re-authentication](#auth-and-re-authentication). Typically left at the global default; override only if one project uses a different auth method than all others.                                   |
| `history_mode`           | Yes                   | `"shared"` or `"isolated"`. See [Session history](#session-history).                                                                                                                                                                             |
| `network`                | Yes                   | Docker/Podman network mode. `"bridge"` required for API access. Use `"none"` to disable.                                                                                                                                                         |
| `keep_alive`             | Yes                   | When `true`, container keeps running after you exit the shell.                                                                                                                                                                                   |
| `mount_home_children`    | Yes                   | Mount non-hidden directories under `$HOME` read-only, plus language toolchain directories (`.nvm`, `.cargo`, `.rustup`, `.local`, `.pyenv`).                                                                                                     |
| `penv_path`              | Yes                   | Path to the Python environment. Relative paths are resolved against the project directory. Set to `.venv` for a project-local venv, or an absolute path for a shared environment. Empty string (default) means no Python environment configured. |
| `renv_path`              | Yes                   | Path to the R environment. Discovered at install; edit if not found or to change.                                                                                                                                                                |
| `extra_readonly`         | Yes — additive        | Additional paths to mount read-only. Entries may be `"path"` (symmetric) or `"hostPath:containerPath"` (asymmetric, e.g. `"/home/user/.foo:/root/.foo"`). Note: paths containing a literal `:` character are not supported.                      |
| `extra_readwrite`        | Yes — additive        | Additional paths to mount read-write. Same `"path"` or `"hostPath:containerPath"` syntax as `extra_readonly`.                                                                                                                                    |
| `extra_ld_library_path`  | Yes — additive        | Directories to mount read-only **and** prepend to `LD_LIBRARY_PATH` inside the container. Use for site-specific shared library installations (e.g. Intel MKL, vendor BLAS) that mounted binaries were linked against.                            |
| `project_symlink_mounts` | Yes                   | `"read"` (default), `"write"`, or `"off"`. Auto-mount targets of symlinks found in the project directory tree. See [Project symlink mounts](#project-symlink-mounts).                                                                            |
| `project_symlink_depth`  | Yes                   | How many directory levels deep to walk when scanning for symlinks. Default `3`.                                                                                                                                                                  |
| `forward_ssh_agent`      | Yes                   | `true`/`false`. Mount the SSH agent relay and set `SSH_AUTH_SOCK` inside the container. See [SSH agent forwarding](#ssh-agent-forwarding).                                                                                                       |
| `ssh_known_hosts_path`   | Yes                   | Path to the SSH known_hosts file to mount into the container. Auto-discovered at install. See [SSH agent forwarding](#ssh-agent-forwarding).                                                                                                     |

---

### Per-project: `~/.code-container/projects/<projectname>-<hash>/override.json`

Created as `{}` on first `container run` for a project. Add only the fields you want to deviate from the global defaults. The following is an example only — include only what you need to change.

> **Tip:** If you know you need project-specific overrides before launching a container, run `container init [path]` first. This creates the project directory and `override.json` without starting a container, so you can edit `override.json` and then run `container` without needing a remove-and-recreate cycle.

```json
{
  "network": "none",
  "penv_path": "/path/to/a/project-specific/penv"
}
```

| Field                    | Description                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                | Override network mode for this project.                                                                                                                                |
| `keep_alive`             | Override keep-alive behaviour for this project.                                                                                                                        |
| `project_readonly`       | When `true`, mount the project directory read-only. Useful for analysis or review sessions. Default `false`.                                                           |
| `auth_mode`              | Override auth mode for this project. Unusual — typically only needed if one project uses OAuth while all others use an API key. Accepts `"shared"` or `"per_project"`. |
| `history_mode`           | Override history mode for this project. More commonly useful — keep most projects on shared history while isolating specific ones. Accepts `"shared"` or `"isolated"`. |
| `mount_home_children`    | Override home mount behaviour for this project.                                                                                                                        |
| `penv_path`              | Override Python environment path for this project.                                                                                                                     |
| `renv_path`              | Override R environment path for this project.                                                                                                                          |
| `extra_readonly`         | Added to the global `extra_readonly` list. Supports `"hostPath:containerPath"` syntax.                                                                                 |
| `extra_readwrite`        | Added to the global `extra_readwrite` list. Supports `"hostPath:containerPath"` syntax.                                                                                |
| `extra_ld_library_path`  | Added to the global `extra_ld_library_path` list. Paths are mounted read-only and prepended to `LD_LIBRARY_PATH`.                                                      |
| `project_symlink_mounts` | Override symlink auto-mount mode for this project. `"read"`, `"write"`, or `"off"`.                                                                                    |
| `project_symlink_depth`  | Override symlink scan depth for this project. Integer >= 1.                                                                                                            |
| `forward_ssh_agent`      | `true` or `false`. Override whether SSH agent forwarding is enabled for this project.                                                                                  |
| `ssh_known_hosts_path`   | Override the known_hosts file path for this project.                                                                                                                   |

Find the `<hash>` by running `container list` — it is the suffix of the container name.

#### Determining `extra_ld_library_path` entries

Use this when a binary mounted into the container fails with `error while loading shared libraries`. The typical cause is that the binary was linked against a site-specific library (e.g. Intel MKL, a vendor BLAS, a custom compiler runtime) that isn't in the container's standard library paths.

**Step 1 — find the missing library (e.g. `libmissing.so`) on the host:**

```bash
find /opt /usr /lib64 -name "libmissing.so*" 2>/dev/null
```

**Step 2 — verify the binary's full dependency chain:**

```bash
# Direct dependencies of the failing binary:
ldd /path/to/binary

# If a direct dependency is also "not found", check its dependencies too:
ldd /path/to/libdependency.so
```

**Step 3 — check whether the host uses `LD_LIBRARY_PATH` to expose these libraries:**

```bash
echo $LD_LIBRARY_PATH | tr ':' '\n'
```

Any paths here that contain the missing libraries should be added to `extra_ld_library_path`.

**Step 4 — add to `override.json` and test:**

```json
{
  "extra_ld_library_path": ["/opt/vendor/product/lib"]
}
```

Then `container remove` + `container run`. Repeat `ldd` inside the container if errors persist — there may be transitive dependencies in additional directories.

**Site-specific environments and libraries:** `install.json` only seeds values that are appropriate for all users. If your site has shared Python or R environments, custom library installations, or other infrastructure that not every user needs but that you will need routinely, add the relevant entries directly to your `~/.code-container/config.json` after installation — they will persist across reinstalls and this global entry will avoid having to put these entries into every override.json. For example, an environment built against a site-installed Python at `/opt/python3.11` and an R installation at `/opt/R/3.3.1` backed by Intel MKL (e.g. the environments in sweng/snapfish/penv and sweng/snapfish/renv) would require:

```json
"extra_readonly": ["/usr/local/bin/R-3.3.1", "/opt/R/3.3.1", "/opt/python3.11"],
"extra_ld_library_path": [
  "/opt/python3.11/lib64",
  "/opt/intel/compilers_and_libraries_2019.4.243/linux/compiler/lib/intel64_lin",
  "/opt/intel/compilers_and_libraries_2019.4.243/linux/mkl/lib/intel64_lin",
  "/opt/intel/compilers_and_libraries_2019.4.243/linux/tbb/lib/intel64/gcc4.1"
]
```

Note that `/opt/python3.11/lib64` appears in both `extra_ld_library_path` (to set `LD_LIBRARY_PATH` for the dynamic linker to find `libpython3.11.so.1.0`) and is covered by the `/opt/python3.11` entry in `extra_readonly` (which makes the Python standard library accessible). The `extra_ld_library_path` mount of the subdirectory is redundant once the parent is in `extra_readonly`, but the `LD_LIBRARY_PATH` env var entry it provides is still required.
These entries are additive with any per-project `override.json` entries.

---

### Configuration lifecycle

After `npm install`, users work with files in `~/.code-container/`. The policy differs by file type:

- **Managed files** (`Dockerfile`, `container.bashrc`) are overwritten on every reinstall. They are infrastructure — their content is owned by the repo, and updates should flow through automatically. If you customise them directly, your changes will be lost on the next `npm install`. Instead, fork the repo or create a branch for your use and modify them there.

- **User-owned files** (`config.json`, per-project `override.json`) are written once and never touched again by the installer. They contain your environment-specific settings (paths, preferences, per-project overrides) that the repo cannot know in advance and must not clobber.

| File                                         | Repo source                | Policy                                         | Purpose                                    |
| -------------------------------------------- | -------------------------- | ---------------------------------------------- | ------------------------------------------ |
| `~/.code-container/Dockerfile`               | `Dockerfile`               | Managed — overwritten on reinstall             | Image definition                           |
| `~/.code-container/container.bashrc`         | `container.bashrc`         | Managed — overwritten on reinstall             | Container shell setup (mounted at runtime) |
| `~/.code-container/config.json`              | seeded from `install.json` | User-owned — written once at first install     | Your runtime config                        |
| `~/.code-container/projects/*/override.json` | none (created as `{}`)     | User-owned — written once at first project run | Per-project overrides                      |

**Upgrading config.json:** when a new version of the tool adds a field to `config.json`, reinstalling (`npm run build && npm install -g .`) will automatically add any missing keys using the install defaults and remove any deprecated keys. Auto-discovered fields (like `ssh_known_hosts_path`) are re-discovered at that time. The schema default applies silently at runtime if a key is absent without a reinstall.

Changes to `~/.code-container/config.json` that affect **runtime behaviour** (mounts, network, env paths) take effect on the next `container remove` + `container run`.

Changes to `base_image` or `timezone` affect the **image itself** and require `container build` followed by `container remove` + `container run`.

Changes to `container.bashrc` take effect on `container remove` + `container run` alone — no rebuild needed, since it is mounted at runtime rather than baked into the image.

---

### Install defaults: `install.json`

Checked into the repo. Every field in this file is written verbatim into `~/.code-container/config.json` at install time. `install.json` is only read during `npm install` — after that, users edit `config.json` directly. No defaults are hardcoded in the tool itself.

| Field                    | Description                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base_image`             | Base container image. Requires `container build` to apply.                                                                                                                                                                                       |
| `timezone`               | Container timezone (tz database name). Requires `container build` to apply.                                                                                                                                                                      |
| `container_runtime`      | `"auto"` detects at install (prefers podman), or set `"podman"` / `"docker"` explicitly.                                                                                                                                                         |
| `data_branches`          | Paths mounted read-only into every container.                                                                                                                                                                                                    |
| `network`                | Default container network mode. `"bridge"` required for API access.                                                                                                                                                                              |
| `keep_alive`             | Keep container running after shell exit.                                                                                                                                                                                                         |
| `mount_home_children`    | Mount non-hidden directories under `$HOME` read-only, plus language toolchain directories (`.nvm`, `.cargo`, `.rustup`, `.local`, `.pyenv`).                                                                                                     |
| `auth_mode`              | `"shared"` or `"per_project"`. See [Auth and re-authentication](#auth-and-re-authentication).                                                                                                                                                    |
| `history_mode`           | `"shared"` or `"isolated"`. See [Session history](#session-history).                                                                                                                                                                             |
| `penv_path`              | Path to the Python environment. Relative paths are resolved against the project directory. Set to `.venv` for a project-local venv, or an absolute path for a shared environment. Empty string (default) means no Python environment configured. |
| `renv_path`              | Path to the R environment. Discovered at install; edit if not found or to change. Empty string means not discovered.                                                                                                                             |
| `extra_readonly`         | Additional paths to mount read-only. Entries may be `"path"` or `"hostPath:containerPath"`.                                                                                                                                                      |
| `extra_readwrite`        | Additional paths to mount read-write. Same syntax as `extra_readonly`.                                                                                                                                                                           |
| `extra_ld_library_path`  | Directories to mount read-only and prepend to `LD_LIBRARY_PATH` inside the container.                                                                                                                                                            |
| `penv_pattern`           | Glob pattern used to search for the Python environment at install time.                                                                                                                                                                          |
| `renv_pattern`           | Glob pattern used to search for the R environment at install time.                                                                                                                                                                               |
| `env_search_timeout_s`   | How many seconds to spend searching for `penv`/`renv` at install time before giving up.                                                                                                                                                          |
| `project_symlink_mounts` | Default auto-mount mode for project directory symlinks: `"read"`, `"write"`, or `"off"`.                                                                                                                                                         |
| `project_symlink_depth`  | Directory depth to scan for symlinks in the project tree.                                                                                                                                                                                        |
| `forward_ssh_agent`      | Whether to enable SSH agent forwarding. See [SSH agent forwarding](#ssh-agent-forwarding).                                                                                                                                                       |
| `ssh_known_hosts_path`   | Path to the SSH known_hosts file. Auto-discovered at install by checking standard locations and `/etc/ssh/ssh_config.d/`. See [SSH agent forwarding](#ssh-agent-forwarding).                                                                     |
| `tool_permissions`       | Default tool permissions written into each new project's `settings.json`. See [Tool permissions](#tool-permissions).                                                                                                                             |

---

### Customizing the container image

Edit `~/.code-container/Dockerfile` to add tools or packages, then rebuild:

```bash
# Example: add database clients (base image is Ubuntu — use apt)
RUN apt-get update && apt-get install -y postgresql-client

container build
```

The image includes `git`, `jq`, `ca-certificates`, and R runtime libraries (`libgfortran`, `libquadmath`, `libtirpc`, `libicu`, `tre`). Compilers and language runtimes are intentionally excluded — use the host-mounted toolchains (`~/.cargo`, `~/.rustup`, `penv_path`, `renv_path`) instead. If you need a compiler inside the container, add the relevant host paths to `extra_readonly` in `config.json` (global) or `override.json` (per-project).

## What gets mounted

| Host path                                                  | Container path                           | Mode                     | Controlled by                                                                   |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `data_branches` (default: none)                            | Same path                                | read-only                | `config.json`                                                                   |
| Non-hidden dirs in `$HOME`                                 | Same path                                | read-only                | `mount_home_children` in `config.json` / `override.json`                        |
| `~/.nvm`, `~/.cargo`, `~/.rustup`, `~/.local`, `~/.pyenv`  | Same path                                | read-only                | `mount_home_children` (toolchain exception — see below)                         |
| `ssh_known_hosts_path`                                     | `/root/.ssh/known_hosts`                 | read-only                | `forward_ssh_agent` + `ssh_known_hosts_path` in `config.json` / `override.json` |
| `extra_readonly` paths                                     | Same path (or configured container path) | read-only                | `config.json` + `override.json`                                                 |
| `extra_ld_library_path` paths                              | Same path                                | read-only                | `config.json` + `override.json` (also sets `LD_LIBRARY_PATH`)                   |
| `$PROJECT_PATH`                                            | `$PROJECT_PATH`                          | **read-write** (default) | `project_readonly` in `override.json`                                           |
| `extra_readwrite` paths                                    | Same path (or configured container path) | **read-write**           | `config.json` + `override.json`                                                 |
| Tool auth file (see [Supported tools](#supported-tools))   | Tool-specific                            | **read-write**           | `auth_mode`                                                                     |
| Tool history dir (see [Supported tools](#supported-tools)) | Tool-specific                            | read-write               | `history_mode`                                                                  |
| Tool config dir (see [Supported tools](#supported-tools))  | Tool-specific                            | read-only                | always                                                                          |
| `~/.gitconfig`                                             | `/root/.gitconfig`                       | read-only                | always                                                                          |
| `~/.code-container/container.bashrc`                       | `/etc/container.bashrc`                  | read-only                | always                                                                          |

Paths are mounted at their original host paths so `find /data -name activate` works identically inside and outside the container.

Mounts are computed at container **creation** time. New non-hidden directories added to `$HOME` after the container is created are not visible until the container is removed and recreated.

### Symlinks in mounted locations

**Symlinks to unmounted locations are dead links.** If a symlink inside a mounted directory (e.g. `/data/a-link → /off-limits/path`) resolves to a path that is not mounted in the container, the link target simply does not exist in the container's namespace — the symlink is broken and inaccessible. This is the safe default: unexposed paths stay unexposed.

**Symlinks to writable locations are writable through the link.** If a symlink in a read-only mount (e.g. `/data/link-to-files → /writable/files`) resolves to a path that _is_ mounted read-write (via `extra_readwrite`), writes through the symlink work — the kernel follows the link into the read-write mount. The read-only flag on the containing directory only prevents writes directly into that mount, not through symlinks that exit it.

**Home child symlinks are filtered.** Because `mount_home_children` individually bind-mounts each non-hidden `$HOME` child, symlinks there require explicit checks:

| `~/a-link` resolves to                                       | Behaviour                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Hidden dir under `$HOME` (e.g. `~/.ssh`)                     | Skipped — except language toolchain directories (`.nvm`, `.cargo`, `.rustup`, `.local`, `.pyenv`) which are mounted read-only |
| `~/.code-container/`                                         | Skipped — config directory is never exposed                                                                                   |
| Path outside `$HOME`, not in any configured mount            | Skipped — not intentionally exposed                                                                                           |
| Path outside `$HOME`, in `extra_readonly` or `data_branches` | Mounted read-only                                                                                                             |
| Path outside `$HOME`, in `extra_readwrite` or project path   | Mounted read-write                                                                                                            |
| Non-hidden path within `$HOME`                               | Mounted read-only (or read-write if also in `extra_readwrite`)                                                                |

**Symlink paths in `extra_readonly` / `extra_readwrite` work, with one caveat.** The runtime resolves the symlink on the host side before mounting — the real content is bind-mounted at the symlink path in the container. The symlink arrow is not preserved; the path appears as a real directory inside the container. All internal checks (home child filtering, venv auto-detection) use resolved real paths for comparison, so coverage is detected correctly regardless of whether a configured path is a symlink or a real path. The one thing to be aware of: the mount appears at the **path-as-configured**, not the real path. If you configure `/home/user/link` (symlink to `/data/files`), the content is accessible in the container at `/home/user/link` — `/data/files` is not separately mounted unless explicitly configured.

### Project symlink mounts

The `project_symlink_mounts` setting controls whether symlink targets found inside the project directory tree are automatically mounted. Without this, symlinks that point outside the project path would be dead links inside the container.

| Value              | Behaviour                                                                 |
| ------------------ | ------------------------------------------------------------------------- |
| `"read"` (default) | Symlink targets are auto-mounted read-only                                |
| `"write"`          | Symlink targets are auto-mounted read-write (with ancestor ro protection) |
| `"off"`            | No auto-mounting; symlinks to unmounted targets remain dead links         |

`project_symlink_depth` (default `3`, overridable per-project) controls how many directory levels deep the scan walks. Hidden directories are never scanned.

If a symlink target is inaccessible on the host (broken link), a warning is printed and the mount is skipped. If a target is already covered by an existing mount, it is silently skipped — no duplicate mounts.

**`"write"` mode caution:** if you set `project_symlink_mounts` to `"write"` but lack write permission to a symlink target, the mount attempt will fail when the container starts. Prefer `"read"` unless you specifically need to write through project symlinks.

## Workflow

### First time ever (once per machine)

```bash
git clone <internal-repo-url>
cd code-container
npm install -g .         # or: npm install -g . --prefix ~/.local
container build          # can be run from any directory
```

### First time on a new project

```bash
cd /path/to/your/project
container
```

### Every subsequent session

```bash
cd /path/to/your/project
container        # re-attaches to the running container
```

### If using tmux (recommended)

tmux is not installed in the container — run it on the host instead. With `keep_alive: true`, the container keeps running after you exit the shell, so you can open multiple host tmux windows and attach to the same container from each one.

```bash
# On the host, inside a tmux session:
container          # enter the container (attach to running container if already started)
claude             # start your AI tool (e.g. claude, opencode, codex)

Ctrl+B, D          # detach from the host tmux window — container keeps running
                   # open another tmux window and run `container` again for a second session

# When done for the day:
container stop     # from the host
```

### Maintenance

```bash
container build     # after updating config.json build-time fields, or to upgrade your AI tool
container init      # copy/refresh tool credentials for current project (only needed in per_project auth mode)
container remove    # recreate a container with updated mounts/network config
container list      # see all containers and their name-hash identifiers
```

## Environment activation

Two helper functions are baked into the container shell:

```bash
act     # activate Python and/or R environments
deact   # deactivate (also aliased as quit)
```

`penv_path` and `renv_path` are empty by default. Set them in `config.json` (global) or `override.json` (per-project) to enable environment activation. Relative paths are resolved against the project directory — e.g. `"penv_path": ".venv"` points to `<project>/.venv`. To override for a specific project, set them in that project's `override.json`.

Unlike Python (`penv_path`), R does not have interpreter symlink auto-detection. If your `renv_path` points outside the standard data branches and home directory, the renv directory itself is auto-mounted if not already covered. However, a site-installed R interpreter (e.g. at `/opt/R/3.3.1`) that the renv links against must still be added to `extra_readonly` explicitly.

## Language toolchains

The container image includes build essentials (`gcc`, `g++`, `make`, `cmake`, `pkg-config`, `python3`, `jq`) so native extensions and compiled dependencies work out of the box.

Language version managers that install into `$HOME` are auto-mounted read-only when `mount_home_children` is true. Unlike most hidden directories (which are excluded for security), the following are treated as an exception:

| Directory   | Tool                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `~/.nvm`    | Node Version Manager — per-version `node`, `npm`, `npx`                          |
| `~/.cargo`  | Rust — `cargo`, crate registry, env (see security note below)                    |
| `~/.rustup` | Rust toolchain — `rustc`, standard libraries, cross-compilation targets          |
| `~/.local`  | User-local installs — `~/.local/bin`, `~/.local/lib`, `pip install --user`, etc. |
| `~/.pyenv`  | Python version manager                                                           |

`~/.local` is mounted in full rather than as selective subdirs because `~/.local/bin` commonly contains symlinks into `~/.local/share` (e.g. pipx installs scripts there), which would be dead links inside the container if `~/.local/share` were excluded.

All mounts are read-only — the agent can use these tools but cannot modify the toolchain. If you use a tool not in this list (e.g. `~/.rbenv`, `~/.sdkman`), add it to `extra_readonly` in `config.json`.

For toolchains installed outside `$HOME` (e.g. a site-wide Go installation at `/usr/local/go`), add to `extra_readonly` or ensure the path is under a configured `data_branch`.

## SSH agent forwarding

When `forward_ssh_agent` is `true` in `config.json`, the host's `$SSH_AUTH_SOCK` socket is passed into the container via the `-e SSH_AUTH_SOCK=...` environment variable. This lets processes inside the container authenticate SSH operations (e.g. `git push` over SSH, `git clone git@...`) using the same credentials as the host — without copying private keys into the container.

Additionally, `ssh_known_hosts_path` is mounted at `/root/.ssh/known_hosts` read-only, so the container can verify host keys.

This is designed for users who work over SSH with agent forwarding from a remote machine. In that setup, the host has no private keys of its own — credentials live on the login node and are forwarded over the SSH connection. Without this feature, a container launched on that host would also lose agent access.

### Configuration

Set `forward_ssh_agent` to `false` in `config.json` to disable agent forwarding machine-wide. To disable for a specific project, set `"forward_ssh_agent": false` in that project's `override.json`.

`ssh_known_hosts_path` is auto-discovered at install time by checking `~/.ssh/known_hosts`, `/etc/ssh/ssh_known_hosts`, and parsing any `GlobalKnownHostsFile` directives found in `/etc/ssh/ssh_config.d/`. The discovered path is stored in `config.json` and can be edited manually if it changes.

**`Bash(ssh*)` is denied by default.** Agent forwarding is primarily useful for `git` operations (which use the agent directly) and library-level SSH connections. If you need interactive `ssh` commands inside the container, remove `Bash(ssh*)` from the `deny` list in the project's `settings.json`.

## Finding pre-built environments

Any paths configured in `data_branches` and non-hidden `$HOME` directories are mounted at their original paths inside the container. Use standard shell tools to locate environments:

```bash
find ~ -name "activate" 2>/dev/null | grep myenv
```

To activate manually:

```bash
source ~/envs/myenv/bin/activate
# or
conda activate ~/shared/envs/myenv
```

## Tool-specific behavior

The sections below document behavior specific to individual tools. The general configuration system (config.json, override.json, mounts) applies to all tools equally.

### Session history

Each tool stores conversation history in its own directory. Controlled by `history_mode`:

- **`"shared"` (default)** — mounts the host's history directory directly. History is continuous across host sessions and container sessions for the same project. The purpose of the container is to sandbox destructive actions, not to isolate memory — shared history is the right default.
- **`"isolated"`** — mounts a per-project copy. Each container starts with independent history. Use this when you specifically want a clean-slate session, or to prevent an agent from writing crafted history that could influence future sessions.

Overrideable per-project in `override.json`.

#### Claude Code

Claude Code stores conversation history in `~/.local/state/claude/`, namespaced by a hash of the project path. Different projects never share history regardless of mode.

- **Shared:** mounts `~/.local/state/claude/` directly
- **Isolated:** copies to `~/.code-container/projects/<name>-<hash>/claude-state/`

### Auth and re-authentication

Controlled by `auth_mode`:

- **`"shared"` (default)** — mounts the tool's auth file from the host directly, read-write. Re-authentication on the host takes effect in all containers immediately — no further action needed. **Security note:** because the host credential file is mounted read-write, a compromised agent could tamper with it. This is an accepted tradeoff for the convenience of shared auth — if this is a concern, use `"per_project"` mode to isolate credentials per project.
- **`"per_project"`** — copies the auth file into the project config dir at first run and mounts it read-write so token refreshes can write back. If a session expires and cannot refresh automatically, re-authenticate on the host and run `container init [path]` to push the updated credentials into the project config.

#### Claude Code

Claude Code uses `~/.claude.json` for authentication (API key, OAuth tokens). Claude writes to this file on startup (startup counter, token refresh).

- **Shared:** mounts `~/.claude.json` from the host directly, read-write
- **Per-project:** copies `~/.claude.json` into `~/.code-container/projects/<name>-<hash>/` at first run

### Claude instructions (CLAUDE.md)

Claude Code reads `CLAUDE.md` files to load persistent instructions — from the project root, parent directories, and `~/.claude/CLAUDE.md` (user-level). The project-level `CLAUDE.md` is automatically available inside the container because the project directory is mounted read-write.

The user-level `~/.claude/CLAUDE.md` is also accessible inside the container — the harness config mount maps `~/.claude` to `/root/.claude` (read-only), so any `CLAUDE.md` in that directory is available at `/root/.claude/CLAUDE.md`.

> **Security note:** The `~/.claude` directory mount is read-only, so the agent cannot modify user-level instructions from inside the container. The project-level `CLAUDE.md` is intentionally writable (it is part of the project), but user-level files should not be.

### Agent instructions (AGENTS.md)

Many AI coding tools (OpenCode, Codex, and others) use `AGENTS.md` as their default instructions file. Like `CLAUDE.md`, project-level `AGENTS.md` is automatically available inside the container because the project directory is mounted read-write.

User-level instructions files are also accessible via the tool's config directory mount. For example, OpenCode mounts `~/.config/opencode` to `/root/.config/opencode`, so `~/.config/opencode/AGENTS.md` is available at `/root/.config/opencode/AGENTS.md` inside the container.

The same security considerations as `CLAUDE.md` apply — config directory mounts are read-only, so the agent cannot modify user-level instructions from inside the container.

### Tool permissions

Your tool's `settings.json` is mounted **read-only** inside the container. The agent cannot change its own permissions during a session. The file lives at:

```
~/.code-container/projects/<projectname>-<hash>/settings.json
```

To update permissions, edit this file on the host and re-run `container init [path]`. Changes take effect on the next session.

### Default permissions

Permissions are not hardcoded — they come from `tool_permissions` in `~/.code-container/config.json`, which is seeded from `install.json` at install time. When a new project is created, its `settings.json` is written from that value. Edit `config.json` to change the default for all future projects; edit a project's `settings.json` directly to change an existing one.

The permissions shipped in `install.json` pre-approve all standard tools and deny explicit network-making shell commands:

```json
"tool_permissions": {
  "allow": [
    "Bash(*)", "Read", "Write", "Edit", "MultiEdit",
    "Glob", "Grep", "WebFetch", "WebSearch",
    "Agent", "TodoRead", "TodoWrite", "NotebookRead", "NotebookEdit", "LSP"
  ],
  "deny": [
    "Bash(curl*)",   "Bash(wget*)",    "Bash(pip*)",     "Bash(pip3*)",
    "Bash(uv*)",     "Bash(cargo*)",   "Bash(npm*)",     "Bash(npx*)",
    "Bash(yarn*)",   "Bash(pnpm*)",    "Bash(apt*)",     "Bash(apt-get*)",
    "Bash(conda*)",  "Bash(mamba*)",   "Bash(micromamba*)",
    "Bash(ssh*)",    "Bash(scp*)",     "Bash(sftp*)",    "Bash(rsync*)",
    "Bash(nc*)",     "Bash(netcat*)",  "Bash(socat*)",   "Bash(ftp*)",
    "Bash(telnet*)"
  ]
}
```

To allow everything with no restrictions, set in `config.json`:

```json
"tool_permissions": { "allow": ["*"], "deny": [] }
```

**Known gap:** Python, R, and Node can make network calls through their standard libraries (`requests`, `httr`, `http`, etc.) without invoking any denied command. This is accepted — denying those interpreters would break running code against project environments.

## Per-project state

```
~/.code-container/projects/<projectname>-<hash>/
├── override.json       # Per-project config overrides (created as {} on first run)
└── sessions/           # PID lock files for active container sessions
```

`container remove` does **not** delete this directory. To fully reset a project, remove the container and delete `~/.code-container/projects/<projectname>-<hash>/`.

## Security

- The project directory is the only writable mount by default — the agent cannot permanently modify your home directory or any `data_branches` paths. Set `project_readonly: true` in `override.json` to make it read-only too.
- Hidden directories (`.ssh`, `.aws`, `.gnupg`, credentials) are never mounted — the only exceptions are language toolchain directories (`.nvm`, `.cargo`, `.rustup`, `.local`, `.pyenv`) which are mounted read-only. `~/.cargo` includes `credentials.toml` (crates.io API tokens); `~/.local` includes `~/.local/share` application state. These are accepted tradeoffs for toolchain usability — if this is a concern, add them to `extra_readonly` selectively instead and set `mount_home_children: false`
- When `forward_ssh_agent` is `true`, the host's SSH agent socket and the configured `ssh_known_hosts_path` are accessible inside the container, giving code inside the container access to SSH credentials via the host agent and the ability to verify host keys. `Bash(ssh*)` is denied by default so the agent cannot be used for direct SSH sessions, but `git` operations over SSH and library-level SSH connections are not blocked by that rule. Set `"forward_ssh_agent": false` in `override.json` if this exposure is not acceptable for a specific project
- All configuration is in `~/.code-container/` which is never mounted — an agent cannot read or modify it; `container run ~/.code-container/...` is rejected outright
- Your tool's `settings.json` is read-only — the agent cannot escalate its own permissions
- Containers run with `--security-opt no-new-privileges` — setuid/setgid binaries inside the container cannot grant elevated privileges
- Explicit network-making commands (`curl`, `wget`, `pip`, `ssh`, `scp`, etc.) are denied by default
- Network access is on by default (`bridge`) because your tool requires it to reach its API — network calls through Python/R/Node standard libraries are not blocked
- The container image build uses an empty build context — no files from `~/.code-container/` are sent to the container daemon
- Project paths are canonicalized (symlinks resolved) before hashing — accessing a project via a symlink and its real path always maps to the same container and config directory

**Shared auth mode:** The tool's auth file is mounted read-write in the container so it can refresh tokens. A compromised agent could tamper with this file. Switch to `auth_mode: "per_project"` to isolate credentials if this is a concern.

**Still true:** files written to the project directory, or content placed in conversation history, can contain information the agent read from read-only mounts. Always review agent output before committing.

## Uninstalling

```bash
npm uninstall -g @onemodtwo/code-container
rm -rf ~/.code-container
```

---

## For AI Assistants

This section is for AI coding assistants helping a user set up or configure `container`.

**Important:** Do not run the `container` command yourself — it opens an interactive shell you cannot exit. All setup steps must be run by the user.

### Setting up container for a user

Work through the [Setup](#setup) section above with the user, one step at a time, confirming each step succeeds before proceeding. Ensure your AI tool is authenticated on the host before `container build`.

### Adding packages to the container

Edit `~/.code-container/Dockerfile` following the [Customizing the container image](#customizing-the-container-image) section, then ask the user to run `container build`.

### Adding mount paths

Edit `~/.code-container/config.json` (global) or `~/.code-container/projects/<name>-<hash>/override.json` (per-project). No rebuild needed, but existing containers must be removed and recreated for mount changes to take effect.

### Changing network access for a project

Edit `~/.code-container/projects/<name>-<hash>/override.json` and set `"network": "none"` or `"network": "bridge"`. Find the hash with `container list`.

### Configuring tool permissions

Follow the [Tool permissions](#tool-permissions) section. Edit `~/.code-container/projects/<name>-<hash>/settings.json` on the host, then ask the user to run `container init [path]`.

## Troubleshooting

### Podman: `sd-bus call: Process org.freedesktop.systemd1 exited with status 1`

Some crun builds (with `+SYSTEMD`) fail to communicate with systemd during container creation. Symptoms: every `podman run` or `container build` fails with an `Input/output error` at any `RUN` step.

**Fix:** Install `runc` and configure podman to use it with cgroupfs:

```bash
sudo apt-get install -y runc
mkdir -p ~/.config/containers
cat > ~/.config/containers/containers.conf << 'EOF'
[engine]
cgroup_manager = "cgroupfs"
oci_runtime = "runc"
EOF
```

Verify with `podman run --rm ubuntu:24.04 echo hello`.

## Windows support

Native Windows is **not supported**. The install script and container tooling require POSIX utilities (`find`, `sed`, etc.). Use **WSL** (Windows Subsystem for Linux) on Windows — install WSL with `wsl --install`, then follow the Linux instructions inside the WSL distribution.

## License

[BSD 3-Clause](LICENSE.md)
