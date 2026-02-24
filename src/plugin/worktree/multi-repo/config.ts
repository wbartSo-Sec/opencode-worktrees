/**
 * Multi-repo worktree sets configuration management.
 *
 * @module worktree/multi-repo/config
 */

import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"
import type { Logger } from "../shared/types"
import { Result } from "../shared/result"

// ============================================================================
// Schema & Types
// ============================================================================

/**
 * Worktree sets configuration schema.
 * Config file: .worktree-sets.jsonc
 */
export const worktreeSetsConfigSchema = z.object({
	/** Named presets mapping preset name to array of repository paths */
	presets: z.record(z.string(), z.array(z.string())).default({}),
})

export type WorktreeSetsConfig = z.infer<typeof worktreeSetsConfigSchema>

// ============================================================================
// Config Loading & Saving
// ============================================================================

/**
 * Load worktree sets configuration from workspace root.
 * Auto-creates config file with helpful comments if it doesn't exist.
 * Returns empty defaults on parse errors (never crashes).
 *
 * @param workspaceRoot - Absolute path to workspace root directory
 * @param log - Logger instance for structured logging
 * @returns Parsed and validated configuration
 *
 * @example
 * ```typescript
 * const config = await loadSetsConfig("/path/to/workspace", logger)
 * console.log(config.presets)  // { "frontend": ["web", "mobile"], ... }
 * ```
 */
export async function loadSetsConfig(workspaceRoot: string, log: Logger): Promise<WorktreeSetsConfig> {
	const configPath = path.join(workspaceRoot, ".worktree-sets.jsonc")

	try {
		const file = Bun.file(configPath)
		if (!(await file.exists())) {
			// Auto-create config with helpful defaults and comments
			const defaultConfig = `{
  // Worktree Sets Configuration
  // Define named presets for multi-repository worktree operations
  // Documentation: https://github.com/kdcokenny/ocx

  "presets": {
    // Example preset: "frontend" includes web and mobile repos
    // "frontend": ["web", "mobile", "design-system"],

    // Example preset: "backend" includes API and database repos
    // "backend": ["api", "database", "auth-service"],

    // Example preset: "fullstack" combines multiple repos
    // "fullstack": ["web", "api", "database"]
  }
}
`
			await Bun.write(configPath, defaultConfig)
			log.info(`[worktree-sets] Created default config: ${configPath}`)
			return worktreeSetsConfigSchema.parse({})
		}

		const content = await file.text()
		// Use proper JSONC parser (handles comments in strings correctly)
		const parsed = parseJsonc(content)
		if (parsed === undefined) {
			log.error(`[worktree-sets] Invalid .worktree-sets.jsonc syntax`)
			return worktreeSetsConfigSchema.parse({})
		}
		return worktreeSetsConfigSchema.parse(parsed)
	} catch (error) {
		log.warn(`[worktree-sets] Failed to load config: ${error}`)
		return worktreeSetsConfigSchema.parse({})
	}
}

/**
 * Save worktree sets configuration to workspace root.
 * Writes JSONC with helpful comments.
 *
 * @param workspaceRoot - Absolute path to workspace root directory
 * @param config - Configuration object to save
 *
 * @example
 * ```typescript
 * await saveSetsConfig("/path/to/workspace", {
 *   presets: { "frontend": ["web", "mobile"] }
 * })
 * ```
 */
export async function saveSetsConfig(workspaceRoot: string, config: WorktreeSetsConfig): Promise<void> {
	const configPath = path.join(workspaceRoot, ".worktree-sets.jsonc")

	// Build JSONC content with comments
	const lines = ["{", '  // Worktree Sets Configuration', '  // Define named presets for multi-repository worktree operations', "", '  "presets": {']

	const presetEntries = Object.entries(config.presets)
	for (let i = 0; i < presetEntries.length; i++) {
		const [name, repos] = presetEntries[i]
		const isLast = i === presetEntries.length - 1
		const reposJson = JSON.stringify(repos)
		lines.push(`    ${JSON.stringify(name)}: ${reposJson}${isLast ? "" : ","}`)
	}

	lines.push("  }", "}")

	await Bun.write(configPath, lines.join("\n") + "\n")
}

// ============================================================================
// Preset Management
// ============================================================================

/**
 * Save or update a preset in the configuration.
 * Creates/overwrites the preset with the given repositories.
 *
 * @param workspaceRoot - Absolute path to workspace root directory
 * @param name - Preset name (e.g., "frontend", "backend")
 * @param repos - Array of repository paths
 * @param log - Logger instance for structured logging
 *
 * @example
 * ```typescript
 * await savePreset("/path/to/workspace", "frontend", ["web", "mobile"], logger)
 * ```
 */
export async function savePreset(
	workspaceRoot: string,
	name: string,
	repos: string[],
	log: Logger,
): Promise<void> {
	const config = await loadSetsConfig(workspaceRoot, log)
	config.presets[name] = repos
	await saveSetsConfig(workspaceRoot, config)
	log.info(`[worktree-sets] Saved preset "${name}" with ${repos.length} repo(s)`)
}

/**
 * Load a preset by name from the configuration.
 * Returns Result with repositories array or error message.
 *
 * @param workspaceRoot - Absolute path to workspace root directory
 * @param name - Preset name to load
 * @param log - Logger instance for structured logging
 * @returns Result containing repositories array or error message
 *
 * @example
 * ```typescript
 * const result = await loadPreset("/path/to/workspace", "frontend", logger)
 * if (result.ok) {
 *   console.log(result.value)  // ["web", "mobile"]
 * } else {
 *   console.error(result.error)  // "Preset 'frontend' not found"
 * }
 * ```
 */
export async function loadPreset(
	workspaceRoot: string,
	name: string,
	log: Logger,
): Promise<Result<string[], string>> {
	const config = await loadSetsConfig(workspaceRoot, log)
	const repos = config.presets[name]

	if (!repos) {
		return Result.err(`Preset '${name}' not found`)
	}

	return Result.ok(repos)
}

/**
 * List all available presets from the configuration.
 * Returns a record mapping preset names to repository arrays.
 *
 * @param workspaceRoot - Absolute path to workspace root directory
 * @param log - Logger instance for structured logging
 * @returns Record of all presets
 *
 * @example
 * ```typescript
 * const presets = await listPresets("/path/to/workspace", logger)
 * console.log(presets)  // { "frontend": ["web", "mobile"], "backend": ["api"] }
 * ```
 */
export async function listPresets(workspaceRoot: string, log: Logger): Promise<Record<string, string[]>> {
	const config = await loadSetsConfig(workspaceRoot, log)
	return config.presets
}
