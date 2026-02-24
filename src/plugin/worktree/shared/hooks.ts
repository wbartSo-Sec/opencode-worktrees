/**
 * Hook execution and configuration loading for worktrees.
 *
 * @module worktree/shared/hooks
 */

import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import type { Logger, WorktreeConfig } from "./types"
import { worktreeConfigSchema } from "./types"

/**
 * Run hook commands in the worktree directory.
 */
export async function runHooks(cwd: string, commands: string[], log: Logger): Promise<void> {
	for (const command of commands) {
		log.info(`[worktree] Running hook: ${command}`)
		try {
			// Use shell to properly handle quoted arguments and complex commands
			const result = Bun.spawnSync(["bash", "-c", command], {
				cwd,
				stdout: "inherit",
				stderr: "pipe",
			})
			if (result.exitCode !== 0) {
				const stderr = result.stderr?.toString() || ""
				log.warn(
					`[worktree] Hook failed (exit ${result.exitCode}): ${command}${stderr ? `\n${stderr}` : ""}`,
				)
			}
		} catch (error) {
			log.warn(`[worktree] Hook error: ${error}`)
		}
	}
}

/**
 * Load worktree-specific configuration from .opencode/worktree.jsonc
 * Auto-creates config file with helpful defaults if it doesn't exist.
 */
export async function loadWorktreeConfig(directory: string, log: Logger): Promise<WorktreeConfig> {
	const configPath = path.join(directory, ".opencode", "worktree.jsonc")

	try {
		const file = Bun.file(configPath)
		if (!(await file.exists())) {
			// Auto-create config with helpful defaults and comments
			const defaultConfig = `{
  "$schema": "https://registry.kdco.dev/schemas/worktree.json",

  // Worktree plugin configuration
  // Documentation: https://github.com/kdcokenny/ocx

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
`
			// Ensure .opencode directory exists
			await mkdir(path.join(directory, ".opencode"), { recursive: true })
			await Bun.write(configPath, defaultConfig)
			log.info(`[worktree] Created default config: ${configPath}`)
			return worktreeConfigSchema.parse({})
		}

		const content = await file.text()
		// Use proper JSONC parser (handles comments in strings correctly)
		const parsed = parseJsonc(content)
		if (parsed === undefined) {
			log.error(`[worktree] Invalid worktree.jsonc syntax`)
			return worktreeConfigSchema.parse({})
		}
		return worktreeConfigSchema.parse(parsed)
	} catch (error) {
		log.warn(`[worktree] Failed to load config: ${error}`)
		return worktreeConfigSchema.parse({})
	}
}
