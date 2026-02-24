/**
 * Workspace discovery and repository enumeration for multi-repo worktree management.
 *
 * This module provides functions to:
 * - Find workspace root by locating parent directory containing `main/` subdirectory
 * - Enumerate git repositories within `main/` directory
 * - Validate repository existence and git status
 * - Sanitize branch names for directory-safe usage
 *
 * @module worktree/multi-repo/discovery
 */

import { access, lstat, readdir } from "node:fs/promises"
import * as path from "node:path"
import type { Result } from "../shared"
import { Result as ResultHelper } from "../shared"

// ============================================================================
// Workspace Root Discovery
// ============================================================================

/**
 * Find workspace root by walking up directory tree looking for parent containing `main/` subdirectory.
 *
 * Walks up from startDir, checking each parent for a `main/` subdirectory.
 * Stops after 10 levels or when reaching filesystem root.
 *
 * @param startDir - Directory to start search from
 * @returns Result containing workspace root path or error message
 *
 * @example
 * const result = await findWorkspaceRoot("/Users/dev/workspace/main/repo1")
 * if (result.ok) {
 *   console.log("Workspace root:", result.value) // "/Users/dev/workspace"
 * }
 */
export async function findWorkspaceRoot(startDir: string): Promise<Result<string, string>> {
	// Guard clauses
	if (!startDir || typeof startDir !== "string") {
		return ResultHelper.err("startDir must be a non-empty string")
	}

	let currentDir = path.resolve(startDir)
	let levelsUp = 0
	const MAX_LEVELS = 10

	while (currentDir !== "/" && levelsUp < MAX_LEVELS) {
		const mainPath = path.join(currentDir, "main")

		try {
			// Check if main/ subdirectory exists
			const stats = await lstat(mainPath)
			if (stats.isDirectory()) {
				return ResultHelper.ok(currentDir)
			}
		} catch (error) {
			// main/ doesn't exist at this level, continue upward
		}

		currentDir = path.dirname(currentDir)
		levelsUp++
	}

	return ResultHelper.err(
		`Workspace root not found (no main/ subdirectory within ${MAX_LEVELS} levels from ${startDir})`,
	)
}

// ============================================================================
// Repository Discovery
// ============================================================================

/**
 * Discover git repositories in workspace's `main/` directory.
 *
 * Scans `main/` subdirectory and returns sorted list of repository names.
 * Only includes directories containing `.git` DIRECTORY (not `.git` FILE which indicates worktree).
 * Filters out symlinks and logs warnings for them.
 *
 * @param workspaceRoot - Path to workspace root (parent of `main/`)
 * @returns Result containing sorted array of repository names or error message
 *
 * @example
 * const result = await discoverRepos("/Users/dev/workspace")
 * if (result.ok) {
 *   console.log("Repos:", result.value) // ["repo1", "repo2", "repo3"]
 * }
 */
export async function discoverRepos(workspaceRoot: string): Promise<Result<string[], string>> {
	// Guard clauses
	if (!workspaceRoot || typeof workspaceRoot !== "string") {
		return ResultHelper.err("workspaceRoot must be a non-empty string")
	}

	const mainPath = path.join(workspaceRoot, "main")

	try {
		// Check if main/ exists
		await access(mainPath)
	} catch (error) {
		return ResultHelper.err(`main/ directory not found at ${mainPath}`)
	}

	try {
		const entries = await readdir(mainPath, { withFileTypes: true })
		const repos: string[] = []

		for (const entry of entries) {
			// Skip non-directories
			if (!entry.isDirectory()) {
				continue
			}

			// Check for symlinks and warn
			const entryPath = path.join(mainPath, entry.name)
			const stats = await lstat(entryPath)
			if (stats.isSymbolicLink()) {
				console.warn(`[discovery] Skipping symlink: ${entry.name}`)
				continue
			}

			// Check for .git DIRECTORY (not .git FILE which indicates worktree)
			const gitPath = path.join(entryPath, ".git")
			try {
				const gitStats = await lstat(gitPath)
				if (gitStats.isDirectory()) {
					repos.push(entry.name)
				}
			} catch (error) {
				// .git doesn't exist or not accessible, skip this directory
			}
		}

		// Return sorted list (empty array is valid, not an error)
		return ResultHelper.ok(repos.sort())
	} catch (error) {
		return ResultHelper.err(
			`Failed to read main/ directory: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

// ============================================================================
// Repository Validation
// ============================================================================

/**
 * Validate that specified repositories exist in workspace and are git repositories.
 *
 * Checks each repo name exists in `main/` AND has `.git` directory.
 * Returns list of valid repos and logs warnings for invalid ones.
 *
 * @param workspaceRoot - Path to workspace root (parent of `main/`)
 * @param repos - Array of repository names to validate
 * @returns Result containing array of valid repository names or error message
 *
 * @example
 * const result = validateRepos("/Users/dev/workspace", ["repo1", "repo2", "invalid"])
 * if (result.ok) {
 *   console.log("Valid repos:", result.value) // ["repo1", "repo2"]
 * }
 */
export function validateRepos(workspaceRoot: string, repos: string[]): Result<string[], string> {
	// Guard clauses
	if (!workspaceRoot || typeof workspaceRoot !== "string") {
		return ResultHelper.err("workspaceRoot must be a non-empty string")
	}
	if (!Array.isArray(repos)) {
		return ResultHelper.err("repos must be an array")
	}

	const validRepos: string[] = []
	const mainPath = path.join(workspaceRoot, "main")

	for (const repo of repos) {
		if (!repo || typeof repo !== "string") {
			console.warn(`[discovery] Skipping invalid repo name: ${repo}`)
			continue
		}

		const repoPath = path.join(mainPath, repo)
		const gitPath = path.join(repoPath, ".git")

		try {
			// Synchronous check for simplicity (validation is typically fast)
			// In production, consider async version if performance matters
			const fs = require("node:fs")
			const repoStats = fs.lstatSync(repoPath)
			const gitStats = fs.lstatSync(gitPath)

			if (repoStats.isDirectory() && gitStats.isDirectory()) {
				validRepos.push(repo)
			} else {
				console.warn(`[discovery] Invalid repo (not a git directory): ${repo}`)
			}
		} catch (error) {
			console.warn(`[discovery] Repo not found or not accessible: ${repo}`)
		}
	}

	return ResultHelper.ok(validRepos)
}

// ============================================================================
// Branch Name Sanitization
// ============================================================================

/**
 * Sanitize branch name for directory-safe usage.
 *
 * Replaces forward slashes with hyphens to create valid directory names.
 * Example: `feature/dark-mode` → `feature-dark-mode`
 *
 * @param branch - Git branch name
 * @returns Directory-safe branch name
 *
 * @example
 * sanitizeBranchForDir("feature/dark-mode") // "feature-dark-mode"
 * sanitizeBranchForDir("bugfix/issue-123") // "bugfix-issue-123"
 * sanitizeBranchForDir("main") // "main"
 */
export function sanitizeBranchForDir(branch: string): string {
	return branch.replace(/\//g, "-")
}

/**
 * Get feature worktree path for a branch.
 *
 * Combines workspace root with sanitized branch name to create feature directory path.
 *
 * @param workspaceRoot - Path to workspace root
 * @param branch - Git branch name
 * @returns Full path to feature worktree directory
 *
 * @example
 * getFeaturePath("/Users/dev/workspace", "feature/dark-mode")
 * // "/Users/dev/workspace/feature-dark-mode"
 */
export function getFeaturePath(workspaceRoot: string, branch: string): string {
	return path.join(workspaceRoot, sanitizeBranchForDir(branch))
}
