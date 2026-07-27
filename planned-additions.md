# Planned Additions

## Fully Config-Generated Dockerfile

### Current State

The Dockerfile at the repo root is manually maintained. Each tool and harness has:

- A hardcoded `ARG INSTALL_*=false` declaration
- A hardcoded conditional `RUN if [ "$INSTALL_*" = "true" ]; then ... fi` block

The `install` field in each harness YAML (`harnesses/*.yaml`) mirrors what the Dockerfile already does via build args, but is currently documentation-only — the Dockerfile is never generated from it.

`tool-packs.ts` also has `dockerfileLines` that mirror the Dockerfile, and is similarly unused at runtime.

### Goal

Replace the hand-written Dockerfile with one generated from the harness YAML configs and tool pack definitions. Adding or removing a tool/harness becomes a single YAML/config change with no Dockerfile editing required.

### Design

#### 1. Extend YAML schema for tools

Create `tools/*.yaml` files following the same pattern as `harnesses/*.yaml`:

```yaml
id: bun
name: Bun
detect:
  command: bun
install:
  - 'BUN_INSTALL="$HOME/.bun" curl -fsSL https://bun.sh/install | bash'
  - 'echo ''export PATH="$HOME/.bun/bin:$PATH"'' >> ~/.bashrc'
config:
  - host: ~/.bun
    container: /root/.bun
    kind: directory
    role: data
  - host: ~/.bunfig.toml
    container: /root/.bunfig.toml
    kind: file
    role: data
```

For tools with `detect.command: null` (always-enabled like `python`, `enhanced-tools`), the `detect` field would be optional or use a special marker.

#### 2. Dockerfile generation function

Add `src/dockerfile-generator.ts` with:

```ts
function generateDockerfile(
  harnessPacks: Record<string, HarnessPack>,
  toolPacks: Record<string, ToolPack>,
): string;
```

This function produces a complete Dockerfile string:

- Static base (FROM, apt packages, nvm/node, container.bashrc)
- Tool section: `ARG INSTALL_*=false` + conditional RUN for each tool
- Harness section: `ARG INSTALL_*=false` + conditional RUN for each harness
- Final PATH export

#### 3. Integration points

- `docker.ts::buildImage()` calls `generateDockerfile()` and writes the result to `DOCKERFILE_PATH` before building
- `setup.ts::runSetup()` generates the Dockerfile on first run
- The static `Dockerfile` in the repo root becomes a generated artifact (or is removed from `package.json` `files`)

#### 4. Build arg map derivation

`docker.ts` already derives `HARNESS_BUILD_ARG_MAP` from packs via `getHarnessBuildArgMap()`. The same approach extends to tools — each pack's `buildArgName` is used instead of a hardcoded map.

The `TOOL_BUILD_ARG_MAP` in `docker.ts` is replaced with:

```ts
function getToolBuildArgMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [id, pack] of Object.entries(TOOL_PACKS)) {
    map[id] = pack.buildArgName;
  }
  return map;
}
```

### Files to Change

| File                          | Action                                                  |
| ----------------------------- | ------------------------------------------------------- |
| `tools/*.yaml` (12 files)     | Create — one per tool                                   |
| `src/tool-loader.ts`          | Create — mirror of harness-loader.ts for tools          |
| `src/tool-packs.ts`           | Rewrite — use loader (same pattern as harness-packs.ts) |
| `src/dockerfile-generator.ts` | Create — generates Dockerfile from packs                |
| `src/docker.ts`               | Update — generate Dockerfile before build               |
| `src/setup.ts`                | Update — generate Dockerfile on first run               |
| `Dockerfile`                  | Remove or regenerate as artifact                        |
| `package.json`                | Update `files` field                                    |

### Migration Path

1. Create `tools/*.yaml` files mirroring `tool-packs.ts` entries
2. Create `src/tool-loader.ts` (adapt from `harness-loader.ts`)
3. Rewrite `src/tool-packs.ts` to use loader
4. Create `src/dockerfile-generator.ts`
5. Update `docker.ts` to generate Dockerfile before build
6. Remove hardcoded `Dockerfile` from `package.json` `files`
7. Update tests

### Tradeoffs

- **Pro:** Single source of truth for tool/harness installation
- **Pro:** Adding a tool = creating a YAML file, no Dockerfile editing
- **Pro:** Tools and harnesses use the same config format
- **Con:** More code to maintain (generator + schemas)
- **Con:** Generated Dockerfile is harder to debug manually
- **Con:** Need to handle edge cases (multi-line RUN, architecture-specific installs)
