# opencode-worktree

> Isolated branches for AI experiments. Git worktrees that spawn their own terminal.

A plugin for [OpenCode](https://github.com/sst/opencode) that creates isolated git worktrees for risky AI development sessions. Each worktree gets its own terminal window with OpenCode running inside.

## Why This Exists

AI makes risky changes. Sometimes it wants to refactor half the codebase, try a wild architectural idea, or experiment with something that might break everything.

You don't want to stash your current work. You don't want to commit half-done code. You need isolation.

This plugin solves that:

- **Zero-friction isolation** - Create a worktree with one tool call. No manual git commands.
- **Auto-spawns terminal** - A new terminal opens automatically with OpenCode ready to work.
- **Clean exit** - Changes are committed and worktrees cleaned up when the session ends.
- **File sync** - Copy `.env` files, symlink `node_modules`, run post-create hooks.

## Installation

Install via [OCX](https://github.com/kdcokenny/ocx), the package manager for OpenCode extensions:

```bash
# Install OCX
curl -fsSL https://ocx.kdco.dev/install.sh | sh

# Initialize and add the plugin
ocx init
ocx registry add --name kdco https://registry.kdco.dev
ocx add kdco/worktree
```

Want the full experience? Install `kdco-workspace` instead - it bundles worktrees with background agents, planning tools, and notifications:

```bash
ocx add kdco/workspace
```

## How It Works

```
1. Create      →  worktree_create("feature/dark-mode")
2. Terminal    →  New window opens with OpenCode at .opencode/worktrees/feature/dark-mode
3. Work        →  AI experiments in complete isolation from your main branch
4. Delete      →  worktree_delete() commits changes and cleans up
```

Worktrees are stored in `.opencode/worktrees/<branch-name>/` within your repository.

## Usage

The plugin adds two tools:

| Tool | Purpose |
|------|---------|
| `worktree_create(branch, baseBranch?)` | Create a new git worktree for isolated development. A new terminal will open with OpenCode in the worktree. |
| `worktree_delete(reason)` | Delete the current worktree and clean up. Changes will be committed before removal. |

### Creating a Worktree

```
worktree_create:
  branch: "feature/dark-mode"
  baseBranch: "main"  # optional, defaults to HEAD
```

The AI calls this and:
1. Git worktree is created at `.opencode/worktrees/feature/dark-mode`
2. Files are synced based on `.opencode/worktree.jsonc` config
3. Post-create hooks run (e.g., `pnpm install`)
4. A new terminal window opens with OpenCode

### Deleting a Worktree

```
worktree_delete:
  reason: "Feature complete, merging to main"
```

The AI calls this and:
1. Pre-delete hooks run (e.g., `docker compose down`)
2. All changes are committed with a snapshot message
3. Git worktree is removed with `--force`
4. Session state is cleaned up

## Platform Support

The plugin detects your terminal and spawns appropriately:

| Platform | Terminals Supported |
|----------|---------------------|
| **macOS** | Ghostty, iTerm2, Kitty, WezTerm, Alacritty, Warp, Terminal.app |
| **Linux** | Kitty, WezTerm, Alacritty, Ghostty, Foot, GNOME Terminal, Konsole, XFCE4 Terminal, xterm |
| **Windows** | Windows Terminal (wt.exe), cmd.exe fallback |
| **tmux** | Creates new tmux window (any platform) |
| **WSL** | Uses Windows Terminal via wt.exe interop |

### Priority Detection

1. **tmux** - If inside tmux, creates new window (takes priority on any platform)
2. **WSL** - Detects Windows Subsystem for Linux, uses wt.exe
3. **Environment vars** - Checks `TERM_PROGRAM`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, etc.
4. **Fallback** - Uses system defaults (Terminal.app on macOS, xterm on Linux)

## Configuration

The plugin auto-creates `.opencode/worktree.jsonc` on first use:

```jsonc
{
  "$schema": "https://registry.kdco.dev/schemas/worktree.json",

  "sync": {
    // Files to copy from main worktree to new worktrees
    // Example: [".env", ".env.local", "dev.sqlite"]
    "copyFiles": [],

    // Directories to symlink (saves disk space)
    // Example: ["node_modules"]
    "symlinkDirs": [],

    // Patterns to exclude from copying
    "exclude": []
  },

  "hooks": {
    // Commands to run after worktree creation
    // Example: ["pnpm install", "docker compose up -d"]
    "postCreate": [],

    // Commands to run before worktree deletion
    // Example: ["docker compose down"]
    "preDelete": []
  }
}
```

### Common Configurations

**Node.js project:**
```jsonc
{
  "sync": {
    "copyFiles": [".env", ".env.local"],
    "symlinkDirs": ["node_modules"]
  },
  "hooks": {
    "postCreate": ["pnpm install"]
  }
}
```

**Docker-based project:**
```jsonc
{
  "sync": {
    "copyFiles": [".env"]
  },
  "hooks": {
    "postCreate": ["docker compose up -d"],
    "preDelete": ["docker compose down"]
  }
}
```

## Limitations

### Security

- Branch names are validated against git ref rules and shell metacharacters
- File sync paths are validated to prevent directory traversal (no `..` or absolute paths)
- Hook commands run with user privileges in the worktree directory

### Terminal Spawning

- Ghostty on macOS uses inline commands to avoid permission dialogs for temp scripts
- Kitty tab support requires `allow_remote_control` in kitty config (falls back to new window)
- Some terminals don't support tabs; a new OS window is opened instead

## FAQ

### What happens to my changes if I forget to delete the worktree?

Changes remain in the worktree directory (`.opencode/worktrees/<branch>/`). The branch still exists in git. You can manually check it out or delete it later.

### Can I have multiple worktrees open at once?

Yes. Each worktree gets its own terminal and OpenCode session. They're fully independent.

### Does this work with my existing git workflow?

Yes. It uses standard git worktrees under the hood. You can `git worktree list` to see them, merge branches normally, etc.

### Why spawn a new terminal instead of using the current one?

Isolation. The worktree session is independent - you can close it, the original terminal keeps working. If the AI breaks something, your main session is unaffected.

## Manual Installation

If you prefer not to use OCX, copy the source from [`src/`](./src) to `.opencode/plugin/`.

**Caveats:**
- Manually install dependencies (`jsonc-parser`)
- Updates require manual re-copying

## Part of the OCX Ecosystem

This plugin is part of the [KDCO Registry](https://github.com/kdcokenny/ocx/tree/main/registry/src/kdco). For the full experience, combine with:

- [opencode-workspace](https://github.com/kdcokenny/opencode-workspace) - Structured planning with rule injection
- [opencode-background-agents](https://github.com/kdcokenny/opencode-background-agents) - Async delegation with persistent outputs
- [opencode-notify](https://github.com/kdcokenny/opencode-notify) - Native OS notifications

## License

MIT
