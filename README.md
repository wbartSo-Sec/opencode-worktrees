Not affliated with the OpenCode team.
____
# Multi-Repo Worktree Management

> Internal tool for managing git worktrees across multiple repositories simultaneously.

Batch-create isolated git worktrees across selected repos for feature work that spans multiple repositories. All worktrees share the same branch name and live under a single feature directory, giving you (and OpenCode) access to all repos at once.

## Quick Start

```bash
# Interactive mode - pick repos with checkboxes
bun run src/cli/worktree-sets.ts create

# Non-interactive mode
bun run src/cli/worktree-sets.ts create \
  --branch feat-SAR-1234 \
  --repos platform-service,findings-service,awesome_project \
  --yes
```

## Installation

Add to your shell config (`~/.zshrc` or `~/.bashrc`):

```bash
alias worktree-sets='bun run /Path/To/opencode-worktrees/src/cli/worktree-sets.ts'
```

Reload: `source ~/.zshrc`

Now you can just run: `worktree-sets create`

## Repository Structure

Your workspace should have this layout:

```
repos/
├── main/                    # Primary clones
│   ├── platform-service/
│   ├── findings-service/
│   ├── awesome_project/
│   └── ...
├── feat-SAR-1234/           # Worktree set for feature
│   ├── platform-service/
│   ├── findings-service/
│   └── awesome_project/
└── fix-BUG-5678/            # Another worktree set
    ├── platform-service/
    └── findings-service/
```

Each feature directory contains worktrees for selected repos, all on the same branch.

## Usage

### Create a Worktree Set

**Interactive mode** (recommended):
```bash
worktree-sets create
```

This will prompt you for:
1. Branch name (e.g., `feat-SAR-1234`)
2. Base branch (default: `HEAD`)
3. Preset selection (if you have saved presets) or manual repo selection
4. Multi-select checkbox to pick repos
5. Confirmation before creation

**Non-interactive mode**:
```bash
worktree-sets create \
  --branch feat-SAR-1234 \
  --repos platform-service,findings-service,awesome_project \
  --workspace ~/repos \
  --yes
```

**Flags**:
- `-b, --branch <name>` — Branch name (required)
- `--repos <list>` — Comma-separated repo names
- `--preset <name>` — Use a saved preset instead of --repos
- `--base <branch>` — Base branch (default: HEAD)
- `-w, --workspace <path>` — Workspace root (default: auto-detect from CWD)
- `-y, --yes` — Skip confirmations
- `--no-hooks` — Skip postCreate hooks from `.opencode/worktree.jsonc`

### Remove a Worktree Set

**Interactive**:
```bash
worktree-sets remove
```

**Non-interactive**:
```bash
worktree-sets remove --branch feat-SAR-1234 --yes
```

This removes ALL worktrees in the feature directory and deletes the feature directory itself.

### List All Worktree Sets

```bash
worktree-sets list
```

Shows all existing worktree sets with their repos.

### Presets (Save Frequently-Used Repo Groups)

**Save a preset**:
```bash
worktree-sets preset save \
  --name backend \
  --repos platform-service,findings-service,auth-service
```

**List presets**:
```bash
worktree-sets preset list
```

**Use a preset**:
```bash
worktree-sets create --branch feat-SAR-1234 --preset backend --yes
```

Presets are saved to `.worktree-sets.jsonc` in your workspace root.

## Examples

### Common Workflow

```bash
# 1. Create worktree set for multi-repo feature
cd ~/repos/main/platform-service
worktree-sets create

# Interactive prompts:
# Branch name: feat-SAR-1234
# Base branch: main
# Select repos: [x] platform-service, [x] findings-service, [ ] auth-service
# Confirm: Yes

# 2. Work on the feature
cd ~/repos/feat-SAR-1234
opencode  # Opens with all selected repos visible

# 3. When done, remove the set
cd ~/repos
worktree-sets remove --branch feat-SAR-1234 --yes
```

### Using Presets for Common Combinations

```bash
# Save common repo groups
worktree-sets preset save --name backend --repos platform-service,findings-service,auth-service
worktree-sets preset save --name frontend --repos ui-components,web-app
worktree-sets preset save --name data --repos data-utils,backend-utils,licence_tools

# Create sets quickly
worktree-sets create --branch feat-SAR-1234 --preset backend --yes
worktree-sets create --branch feat-SAR-5678 --preset frontend --yes
```

### Branch Names with Slashes

Branch names like `feature/dark-mode` are supported. The directory name will be sanitized to `feature-dark-mode` while git keeps the original branch name:

```bash
worktree-sets create --branch feature/dark-mode --repos ui-components --yes

# Creates: ~/repos/feature-dark-mode/ui-components/
# Git branch: feature/dark-mode
```

## Configuration

### Per-Repo Hooks

Each repo can have its own `.opencode/worktree.jsonc` for file sync and hooks:

```jsonc
{
  "sync": {
    "copyFiles": [".env", ".env.local"],
    "symlinkDirs": ["node_modules"]
  },
  "hooks": {
    "postCreate": ["pnpm install"],
    "preDelete": ["docker compose down"]
  }
}
```

During multi-repo set creation, each repo's config is loaded and applied.

### Workspace Presets

The `.worktree-sets.jsonc` file in your workspace root stores presets:

```jsonc
{
  "presets": {
    "backend": ["platform-service", "findings-service", "auth-service"],
    "frontend": ["ui-components", "web-app", "design-system"],
    "data": ["data-utils", "backend-utils", "licence_tools"]
  }
}
```

## How It Works

1. **Discovery**: Scans `main/` directory for git repositories (checks for `.git` directory)
2. **Creation**: For each selected repo:
   - Creates git worktree at `{workspace}/{sanitized-branch}/{repo-name}`
   - If branch exists: checks out existing branch
   - If branch doesn't exist: creates new branch from base
   - Loads `.opencode/worktree.jsonc` from main repo
   - Copies files (e.g., `.env`)
   - Symlinks directories (e.g., `node_modules`)
   - Runs postCreate hooks (e.g., `pnpm install`)
3. **Continue-on-error**: If one repo fails, others still get created (failures are reported at the end)
4. **Auto-launch**: Opens OpenCode in the feature directory (all repos visible)
5. **Removal**: Runs preDelete hooks → removes all worktrees → deletes feature directory

## Troubleshooting

### "Workspace root not found"

The CLI looks for a parent directory containing a `main/` subdirectory. If you're not inside a workspace, use `--workspace`:

```bash
worktree-sets create --workspace ~/repos --branch feat-123 --repos repo-a --yes
```

### "Repository not found: repo-x"

The repo doesn't exist in `main/` or isn't a git repository. Check:
```bash
ls ~/repos/main/
# Verify repo-x exists and has a .git directory
```

### Branch already exists in some repos

The CLI handles this gracefully:
- If branch exists: checks it out into the worktree
- If branch doesn't exist: creates it from base branch

Each repo is handled independently.

### Partial failures

If some repos fail during creation, the CLI will:
- Create worktrees for repos that succeed
- Report all failures with error details
- Still launch OpenCode if ANY repo succeeded

You can then fix the issues and manually add the failed repos, or remove the set and try again.

## CLI Reference

```
USAGE:
  worktree-sets <subcommand> [options]

SUBCOMMANDS:
  create       Create a new worktree set
  remove       Remove an existing worktree set
  list         List all worktree sets
  preset save  Save a repository selection as a preset
  preset list  List all saved presets

CREATE OPTIONS:
  -b, --branch <name>       Branch name (required for non-interactive)
  --repos <repos>           Comma-separated repo names
  --preset <name>           Use a saved preset
  --base <branch>           Base branch (default: HEAD)
  -w, --workspace <path>    Workspace root (default: auto-detect)
  -y, --yes                 Skip confirmations
  --no-hooks                Skip postCreate hooks

REMOVE OPTIONS:
  -b, --branch <name>       Branch name (required for non-interactive)
  -w, --workspace <path>    Workspace root (default: auto-detect)
  -y, --yes                 Skip confirmations

PRESET SAVE OPTIONS:
  --name <name>             Preset name
  --repos <repos>           Comma-separated repo names
  -w, --workspace <path>    Workspace root (default: auto-detect)

EXAMPLES:
  # Interactive creation
  worktree-sets create

  # Non-interactive creation
  worktree-sets create -b feat-SAR-1234 --repos platform-service,findings-service --yes

  # Using a preset
  worktree-sets create -b feat-SAR-1234 --preset backend --yes

  # Remove a set
  worktree-sets remove -b feat-SAR-1234 --yes

  # List all sets
  worktree-sets list

  # Save a preset
  worktree-sets preset save --name backend --repos platform-service,findings-service
```

---

**Note**: This tool also includes an OpenCode plugin that provides single-repo worktree functionality with automatic terminal spawning. The plugin exposes `worktree_create`, `worktree_delete`, `worktree_set_create`, `worktree_set_delete`, and `worktree_set_list` tools for AI-driven workflows. See [AGENTS.md](./AGENTS.md) for plugin documentation and code style guidelines.
