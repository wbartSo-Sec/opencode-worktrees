# AGENTS.md — opencode-worktree

OpenCode plugin that creates isolated git worktrees with automatic cross-platform terminal spawning. Runs on **Bun** as an OpenCode plugin (not a standalone app).

## Project Structure

```
src/plugin/
  worktree.ts              # Main plugin entry — tool definitions (single + multi-repo)
  worktree/
    terminal.ts            # Cross-platform terminal spawning (tmux, macOS, Linux, Windows, WSL)
    state.ts               # SQLite state persistence (single-repo sessions)
    shared/                # Shared utilities (extracted for reuse)
      index.ts             # Barrel re-exports
      result.ts            # Result type for fallible operations
      types.ts             # Logger, WorktreeError, WorktreeConfig
      git.ts               # git(), branchExists(), branchNameSchema
      sync.ts              # copyFiles(), symlinkDirs(), isPathSafe()
      hooks.ts             # runHooks(), loadWorktreeConfig()
    multi-repo/            # Multi-repo worktree set management
      config.ts            # .worktree-sets.jsonc schema, preset load/save
      discovery.ts         # Workspace root detection, repo enumeration
      sets.ts              # Set creation, removal, listing
  kdco-primitives/         # Shared utilities (extracted for reuse across kdco plugins)
    index.ts               # Barrel re-exports
    types.ts               # OpencodeClient type
    shell.ts               # Shell escaping (bash, batch, AppleScript)
    mutex.ts               # Promise-based mutex
    get-project-id.ts      # Git root commit SHA → project ID
    log-warn.ts            # Logging with OpenCode client fallback
    temp.ts                # Temp directory (resolves macOS symlinks)
    terminal-detect.ts     # tmux detection
    with-timeout.ts        # Promise timeout wrapper
src/cli/
  worktree-sets.ts         # CLI for multi-repo worktree management
```

## Build / Lint / Test

**Runtime**: Bun (uses `bun:sqlite`, `Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.sleep`, `Bun.randomUUIDv7`)

**Build**: `package.json` exists with dependencies for multi-repo CLI. The plugin source is synced directly from [kdcokenny/ocx](https://github.com/kdcokenny/ocx) and consumed by OpenCode's plugin system at runtime.

**Linter/Formatter**: Biome (evidenced by `biome-ignore` directives in source). No local biome config — config lives in the upstream OCX monorepo.

```bash
# Install dependencies
bun install

# Run CLI
bun run src/cli/worktree-sets.ts --help

# If you add biome locally:
# bunx biome check src/
# bunx biome check --write src/
```

## Dependencies

- `zod` — schema validation at boundaries
- `jsonc-parser` — parse `.opencode/worktree.jsonc` config
- `@clack/prompts` — interactive CLI prompts (multi-select, text input, spinners)
- `@opencode-ai/plugin` — plugin/tool registration API
- `@opencode-ai/sdk` — OpenCode client types and session management
- `bun:sqlite` — built-in SQLite for state persistence

## Multi-Repo Worktree Sets

The plugin supports batch creation of git worktrees across multiple repositories under a shared feature directory, enabling AI to work on multi-repo features with all repos accessible in one OpenCode session.

### Directory Structure

Multi-repo sets use a sibling-to-main/ structure:

```
workspace/
├── main/               # Primary clones
│   ├── repo-a/
│   ├── repo-b/
│   └── repo-c/
├── feat-123/           # Worktree set for feature
│   ├── repo-a/
│   └── repo-b/
└── fix-456/            # Another worktree set
    └── repo-c/
```

Each feature directory contains worktrees for selected repos, all on the same branch.

### Configuration

Presets are stored in `.worktree-sets.jsonc` at workspace root:

```jsonc
{
  "presets": {
    "frontend": ["ui-components", "web-app", "design-system"],
    "backend": ["api-server", "auth-service", "database"]
  }
}
```

### CLI Usage

```bash
# Create worktree set (interactive)
bun run src/cli/worktree-sets.ts create

# Create worktree set (non-interactive)
bun run src/cli/worktree-sets.ts create --branch feat-123 --repos repo-a,repo-b --yes

# Use a preset
bun run src/cli/worktree-sets.ts create --branch feat-123 --preset frontend --yes

# Remove worktree set
bun run src/cli/worktree-sets.ts remove --branch feat-123 --yes

# List all worktree sets
bun run src/cli/worktree-sets.ts list

# Save preset
bun run src/cli/worktree-sets.ts preset save --name my-set --repos repo-a,repo-b

# List presets
bun run src/cli/worktree-sets.ts preset list
```

### Plugin Tools

AI can invoke multi-repo operations via plugin tools:
- `worktree_set_create(branch, repos[], preset?, workspace?)` - Create set
- `worktree_set_delete(branch, workspace?)` - Remove set
- `worktree_set_list(workspace?)` - List existing sets

### Single-Repo vs Multi-Repo

| Aspect | Single-Repo | Multi-Repo Sets |
|--------|------------|----------------|
| Location | `~/.local/share/opencode/worktree/` | `{workspace}/{branch-name}/` (sibling to main/) |
| Session forking | Yes (preserves plan context) | No (feature dir isn't a git repo) |
| Terminal launch | `opencode --session {id}` | `opencode` (in feature dir) |
| State tracking | SQLite per project | Filesystem (scan for .git files) |
| Use case | Single-repo features | Multi-repo features, coordinated changes |

## Code Style

### Formatting

- **Tabs** for indentation (not spaces)
- **Biome** for lint/format — respect existing `biome-ignore` directives with reason comments
- Double quotes for strings
- Trailing commas in multi-line structures
- Lines kept reasonable (~100 chars soft, no hard limit observed)

### Imports

- **`node:` prefix** for all Node.js builtins: `import * as path from "node:path"`
- **Type-only imports** with `import type`: `import type { Database } from "bun:sqlite"`
- **Ordering**: Bun builtins → Node builtins → external packages → internal modules
- Barrel re-exports in `kdco-primitives/index.ts` — import from barrel, not individual files

```typescript
// Correct
import type { Database } from "bun:sqlite"
import { access, copyFile } from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"
import { getProjectId } from "./kdco-primitives/get-project-id"

// Wrong
import path from "path"           // Missing node: prefix
import { Database } from "bun:sqlite"  // Should be import type
```

### Naming

| Kind | Convention | Example |
|------|-----------|---------|
| Functions/variables | camelCase | `createWorktree`, `branchExists` |
| Classes/Types/Interfaces | PascalCase | `WorktreeError`, `TerminalResult`, `Session` |
| Constants | SCREAMING_SNAKE | `DB_MAX_RETRIES`, `STABILIZATION_DELAY_MS` |
| Type aliases from zod | PascalCase | `type WorktreeConfig = z.infer<typeof worktreeConfigSchema>` |
| Schema variables | camelCase + `Schema` suffix | `branchNameSchema`, `sessionSchema` |
| Zod schemas for env detection | camelCase + `Schema` suffix | `wslEnvSchema`, `macTerminalEnvSchema` |

### Types

- **No `as any`**, no `@ts-ignore`, no `@ts-expect-error`
- Use `z.infer<typeof schema>` for types derived from Zod schemas
- Prefer `interface` for object shapes, `type` for unions/aliases
- `readonly` on Result type fields: `readonly ok: true`, `readonly value: T`
- Generic error handling: `catch (e: unknown)` with type narrowing

### Error Handling

**Result pattern** for fallible operations (git commands):
```typescript
interface OkResult<T> { readonly ok: true; readonly value: T }
interface ErrResult<E> { readonly ok: false; readonly error: E }
type Result<T, E> = OkResult<T> | ErrResult<E>
```

**Custom Error classes** with operation context:
```typescript
class WorktreeError extends Error {
    constructor(message: string, public readonly operation: string, public readonly cause?: unknown) {
        super(`${operation}: ${message}`)
        this.name = "WorktreeError"
    }
}
```

**Guard clauses** (early returns) at function boundaries — validated inputs first:
```typescript
if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("initStateDb requires a valid project root path")
}
```

**Zod validation at boundaries** — parse external input, trust internals:
```typescript
const parsed = sessionSchema.parse(session)  // Throws on invalid
const result = branchNameSchema.safeParse(args.branch)  // Returns success/error
```

**Cleanup patterns**: `try-finally` for resource cleanup, `.catch(() => {})` for fire-and-forget logging.

### Comments & Documentation

- **JSDoc** on all exported functions with `@param`, `@returns`, `@throws`, `@example`
- **Module-level JSDoc** with `@module` tag at top of each file
- **Section separators** using `// ===...===` banners with section titles
- **Inline comments** for non-obvious logic — security notes, race condition warnings
- `biome-ignore` directives include a reason: `// biome-ignore lint/suspicious/noControlCharactersInRegex: Control character detection is intentional for security`

### Architecture Patterns

- **Singleton module state**: `let db: Database | null = null` with lazy init via `getDb()`
- **Mutex for concurrency**: `tmuxMutex.runExclusive()` to serialize tmux commands
- **Temp scripts with self-cleanup**: `trap 'rm -f "$0"' EXIT` in shell scripts
- **Detached processes**: `Bun.spawn(..., { detached: true })` + `proc.unref()`
- **SQLite state**: WAL mode, busy timeout, singleton row pattern for pending ops
- **Platform detection**: Environment variable inspection → `switch(process.platform)`

### Security

- Branch names validated against git ref rules AND shell metacharacters
- File sync paths validated to prevent directory traversal (`isPathSafe`)
- Shell arguments passed as arrays to `Bun.spawn` — no string interpolation
- Null byte rejection before any shell escaping (`assertShellSafe`)
- Array-based git commands: `git(["rev-parse", "--verify", branch], cwd)`

### Function Structure

Functions follow a consistent pattern:
1. Guard clauses / input validation (early returns)
2. Main logic
3. Error wrapping with context
4. Cleanup in `finally` blocks

### Git Conventions

Commits follow: `sync: synced file(s) with kdcokenny/ocx` (automated sync from upstream monorepo).
