/**
 * Multi-repo worktree set creation.
 *
 * Creates git worktrees across multiple repositories under a shared feature directory,
 * with per-repo file synchronization, hook execution, and continue-on-error handling.
 *
 * @module worktree/multi-repo/sets
 */

import { lstat, mkdir, readdir, rm } from "node:fs/promises"
import * as path from "node:path"
import type { Logger, Result } from "../shared"
import {
	Result as ResultHelper,
	branchExists,
	branchNameSchema,
	copyFiles,
	git,
	loadWorktreeConfig,
	runHooks,
	symlinkDirs,
} from "../shared"
import { openTerminal } from "../terminal"
import { getFeaturePath, sanitizeBranchForDir } from "./discovery"

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Options for creating a worktree set across multiple repositories.
 */
export interface CreateSetOptions {
	/** Workspace root directory (parent of main/) */
	workspaceRoot: string
	/** Branch name to create/checkout in each repository */
	branch: string
	/** Base branch to fork from (defaults to HEAD) */
	baseBranch?: string
	/** Repository names to create worktrees for */
	repos: string[]
	/** Whether to run postCreate hooks (default: true) */
	runHooksFlag?: boolean
	/** Logger for structured output */
	log: Logger
}

/**
 * Result of worktree creation for a single repository.
 */
export interface RepoResult {
	/** Repository name */
	repo: string
	/** Whether worktree creation succeeded */
	success: boolean
	/** Path to created worktree (only present on success) */
	worktreePath?: string
	/** Error message (only present on failure) */
	error?: string
}

/**
 * Result of creating a worktree set across multiple repositories.
 */
export interface SetCreationResult {
	/** Path to feature directory containing all worktrees */
	featurePath: string
	/** Per-repository results (success or failure) */
	results: RepoResult[]
	/** Number of repositories that succeeded */
	successCount: number
	/** Number of repositories that failed */
	failureCount: number
}

// ============================================================================
// Core Creation Function
// ============================================================================

/**
 * Create worktrees for multiple repositories under a shared feature directory.
 *
 * This function:
 * 1. Validates branch name against git ref rules
 * 2. Creates feature directory: `{workspaceRoot}/{sanitizedBranch}/`
 * 3. For each repository (sequentially):
 *    - Creates worktree at `{featurePath}/{repoName}`
 *    - Loads per-repo config from `{mainRepoPath}/.opencode/worktree.jsonc`
 *    - Syncs files (copyFiles, symlinkDirs) from main worktree
 *    - Runs postCreate hooks if enabled
 * 4. Continues on error (failed repos don't abort remaining repos)
 * 5. Auto-launches opencode in feature directory if any repo succeeded
 * 6. Removes empty feature directory if all repos failed
 *
 * @param options - Creation options
 * @returns Promise resolving to SetCreationResult with per-repo results
 *
 * @example
 * const result = await createWorktreeSet({
 *   workspaceRoot: "/Users/dev/workspace",
 *   branch: "feature/dark-mode",
 *   repos: ["repo1", "repo2", "repo3"],
 *   runHooksFlag: true,
 *   log: console,
 * })
 *
 * console.log(`Created ${result.successCount}/${result.results.length} worktrees`)
 * if (result.successCount > 0) {
 *   console.log(`Feature directory: ${result.featurePath}`)
 * }
 */
export async function createWorktreeSet(options: CreateSetOptions): Promise<SetCreationResult> {
	const { workspaceRoot, branch, baseBranch, repos, runHooksFlag = true, log } = options

	// ========================================================================
	// 1. Validate Branch Name
	// ========================================================================

	const branchResult = branchNameSchema.safeParse(branch)
	if (!branchResult.success) {
		const errorMsg = branchResult.error.issues[0]?.message ?? "Invalid branch name"
		log.error(`[worktree-set] ${errorMsg}`)

		// Return empty result with all repos failed
		return {
			featurePath: "",
			results: repos.map((repo) => ({
				repo,
				success: false,
				error: `Invalid branch name: ${errorMsg}`,
			})),
			successCount: 0,
			failureCount: repos.length,
		}
	}

	// ========================================================================
	// 2. Setup Feature Directory
	// ========================================================================

	const sanitizedBranch = sanitizeBranchForDir(branch)
	const featurePath = getFeaturePath(workspaceRoot, branch)

	log.info(`[worktree-set] Creating feature directory: ${featurePath}`)

	// Check if feature directory already contains worktrees
	try {
		const entries = await readdir(featurePath).catch(() => [])
		for (const entry of entries) {
			const gitFile = path.join(featurePath, entry, ".git")
			try {
				// Check if .git exists (either file or directory indicates worktree/repo)
				const file = Bun.file(gitFile)
				if (await file.exists()) {
					log.error(`[worktree-set] Feature directory already contains worktrees: ${featurePath}`)
					return {
						featurePath,
						results: repos.map((repo) => ({
							repo,
							success: false,
							error: "Feature directory already contains worktrees",
						})),
						successCount: 0,
						failureCount: repos.length,
					}
				}
			} catch {
				// Entry doesn't have .git, continue
			}
		}
	} catch {
		// Directory doesn't exist yet, which is fine
	}

	// Create feature directory
	await mkdir(featurePath, { recursive: true })

	// ========================================================================
	// 3. Process Each Repository (Sequential, Continue-on-Error)
	// ========================================================================

	const results: RepoResult[] = []
	let successCount = 0
	let failureCount = 0

	for (const repo of repos) {
		log.info(`[worktree-set] Processing repository: ${repo}`)

		try {
			// Compute paths
			const mainRepoPath = path.join(workspaceRoot, "main", repo)
			const worktreePath = path.join(featurePath, repo)

			// Check if branch exists in this repo
			const exists = await branchExists(mainRepoPath, branch)

			// Create worktree (checkout existing or create new from base)
			let gitResult: Result<string, string>
			if (exists) {
				log.debug(`[worktree-set] Checking out existing branch: ${branch}`)
				gitResult = await git(["worktree", "add", worktreePath, branch], mainRepoPath)
			} else {
				const base = baseBranch ?? "HEAD"
				log.debug(`[worktree-set] Creating new branch from ${base}: ${branch}`)
				gitResult = await git(["worktree", "add", "-b", branch, worktreePath, base], mainRepoPath)
			}

			if (!gitResult.ok) {
				log.warn(`[worktree-set] Failed to create worktree for ${repo}: ${gitResult.error}`)
				results.push({
					repo,
					success: false,
					error: gitResult.error,
				})
				failureCount++
				continue
			}

			log.info(`[worktree-set] Created worktree for ${repo} at ${worktreePath}`)

			// ================================================================
			// 4. Load Per-Repo Configuration
			// ================================================================

			const worktreeConfig = await loadWorktreeConfig(mainRepoPath, log)

			// ================================================================
			// 5. Sync Files (copyFiles, symlinkDirs)
			// ================================================================

			if (worktreeConfig.sync.copyFiles.length > 0) {
				log.debug(`[worktree-set] Copying ${worktreeConfig.sync.copyFiles.length} files for ${repo}`)
				await copyFiles(mainRepoPath, worktreePath, worktreeConfig.sync.copyFiles, log)
			}

			if (worktreeConfig.sync.symlinkDirs.length > 0) {
				log.debug(
					`[worktree-set] Symlinking ${worktreeConfig.sync.symlinkDirs.length} directories for ${repo}`,
				)
				await symlinkDirs(mainRepoPath, worktreePath, worktreeConfig.sync.symlinkDirs, log)
			}

			// ================================================================
			// 6. Run postCreate Hooks
			// ================================================================

			if (runHooksFlag && worktreeConfig.hooks.postCreate.length > 0) {
				log.debug(`[worktree-set] Running ${worktreeConfig.hooks.postCreate.length} hooks for ${repo}`)
				await runHooks(worktreePath, worktreeConfig.hooks.postCreate, log)
			}

			// Record success
			results.push({
				repo,
				success: true,
				worktreePath,
			})
			successCount++
		} catch (error) {
			log.warn(`[worktree-set] Exception while processing ${repo}: ${error}`)
			results.push({
				repo,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			})
			failureCount++
		}
	}

	// ========================================================================
	// 7. Summary and Post-Processing
	// ========================================================================

	log.info(`[worktree-set] Summary: ${successCount} succeeded, ${failureCount} failed`)

	// Print per-repo results
	for (const result of results) {
		if (result.success) {
			log.info(`  ✅ ${result.repo}: ${result.worktreePath}`)
		} else {
			log.error(`  ❌ ${result.repo}: ${result.error}`)
		}
	}

	// ========================================================================
	// 8. Auto-Launch or Cleanup
	// ========================================================================

	if (successCount > 0) {
		// At least one repo succeeded - launch opencode
		log.info(`[worktree-set] Launching opencode in ${featurePath}`)
		const terminalResult = await openTerminal(featurePath, "opencode", sanitizedBranch)
		if (!terminalResult.success) {
			log.warn(`[worktree-set] Failed to open terminal: ${terminalResult.error}`)
		}
	} else {
		// All repos failed - remove empty feature directory
		log.error(`[worktree-set] All repositories failed, removing empty directory: ${featurePath}`)
		try {
			await rm(featurePath, { recursive: true, force: true })
		} catch (error) {
			log.warn(`[worktree-set] Failed to remove empty directory: ${error}`)
		}
	}

	return {
		featurePath,
		results,
		successCount,
		failureCount,
	}
}

// ============================================================================
// Removal Type Definitions
// ============================================================================

/**
 * Options for removing a worktree set.
 */
export interface RemoveSetOptions {
	/** Workspace root directory (parent of main/) */
	workspaceRoot: string
	/** Branch name (will be sanitized for directory name) */
	branch: string
	/** Logger for structured output */
	log: Logger
}

/**
 * Result of removing a worktree set.
 */
export interface SetRemovalResult {
	/** Path to the feature directory that was processed */
	featurePath: string
	/** Number of worktrees successfully removed */
	removedCount: number
	/** Number of worktrees that failed to remove */
	failureCount: number
	/** Array of error messages from failed removals */
	errors: string[]
}

/**
 * Information about an existing worktree set.
 */
export interface SetInfo {
	/** Set name (sanitized branch name) */
	name: string
	/** Array of repository names in this set */
	repos: string[]
	/** Absolute path to the set directory */
	path: string
}

// ============================================================================
// Removal Function
// ============================================================================

/**
 * Remove all worktrees in a feature set directory.
 *
 * Sequentially removes worktrees (NOT parallel) to avoid race conditions:
 * 1. Verify feature directory exists
 * 2. Scan for worktree directories (directories with .git FILES, not DIRECTORIES)
 * 3. For each worktree:
 *    - Load per-repo config from main repo
 *    - Run preDelete hooks
 *    - Resolve main repo via `git rev-parse --path-format=absolute --git-common-dir`
 *    - Run `git worktree remove --force {worktreePath}` from MAIN repo
 * 4. Delete feature directory with `rm -rf`
 *
 * Continues on error - if one worktree removal fails, tries the rest.
 *
 * @param options - Removal options (workspaceRoot, branch, log)
 * @returns Promise resolving to SetRemovalResult with counts and errors
 *
 * @example
 * ```typescript
 * const result = await removeWorktreeSet({
 *   workspaceRoot: "/Users/dev/workspace",
 *   branch: "feature/dark-mode",
 *   log: console,
 * })
 * console.log(`Removed ${result.removedCount} worktrees, ${result.failureCount} failures`)
 * ```
 */
export async function removeWorktreeSet(options: RemoveSetOptions): Promise<SetRemovalResult> {
	const { workspaceRoot, branch, log } = options
	const featurePath = getFeaturePath(workspaceRoot, branch)
	const errors: string[] = []
	let removedCount = 0
	let failureCount = 0

	// ========================================================================
	// 1. Verify Feature Directory Exists
	// ========================================================================

	try {
		const stats = await lstat(featurePath)
		if (!stats.isDirectory()) {
			return {
				featurePath,
				removedCount: 0,
				failureCount: 0,
				errors: [`Feature path exists but is not a directory: ${featurePath}`],
			}
		}
	} catch (error) {
		return {
			featurePath,
			removedCount: 0,
			failureCount: 0,
			errors: [`Feature directory not found: ${featurePath}`],
		}
	}

	// ========================================================================
	// 2. Scan Feature Directory for Worktrees
	// ========================================================================

	let entries: string[]
	try {
		entries = await readdir(featurePath)
	} catch (error) {
		return {
			featurePath,
			removedCount: 0,
			failureCount: 0,
			errors: [
				`Failed to read feature directory: ${error instanceof Error ? error.message : String(error)}`,
			],
		}
	}

	// ========================================================================
	// 3. Remove Each Worktree Sequentially
	// ========================================================================

	for (const entry of entries) {
		const wtPath = path.join(featurePath, entry)
		const gitFile = path.join(wtPath, ".git")

		try {
			// Check if .git is a FILE (worktree marker)
			const stats = await lstat(gitFile).catch(() => null)
			if (!stats || !stats.isFile()) {
				// Not a worktree, skip silently
				continue
			}

			log.info(`[worktree-sets] Removing worktree: ${wtPath}`)

			// Resolve main repo path via git rev-parse
			const commonDirResult = await git(
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				wtPath,
			)

			if (!commonDirResult.ok) {
				const errMsg = `Failed to resolve main repo for ${entry}: ${commonDirResult.error}`
				log.warn(`[worktree-sets] ${errMsg}`)
				errors.push(errMsg)
				failureCount++
				continue
			}

			// Remove trailing /.git from path
			const mainRepoPath = commonDirResult.value.replace(/\/\.git$/, "")

			// Load config from main repo (for preDelete hooks)
			const config = await loadWorktreeConfig(mainRepoPath, log)

			// Run preDelete hooks in worktree directory
			if (config.hooks.preDelete.length > 0) {
				log.info(
					`[worktree-sets] Running ${config.hooks.preDelete.length} preDelete hook(s) for ${entry}`,
				)
				await runHooks(wtPath, config.hooks.preDelete, log)
			}

			// Remove worktree from MAIN repo
			const removeResult = await git(["worktree", "remove", "--force", wtPath], mainRepoPath)

			if (!removeResult.ok) {
				const errMsg = `Failed to remove worktree ${entry}: ${removeResult.error}`
				log.warn(`[worktree-sets] ${errMsg}`)
				errors.push(errMsg)
				failureCount++
			} else {
				log.info(`[worktree-sets] Successfully removed worktree: ${entry}`)
				removedCount++
			}
		} catch (error) {
			const errMsg = `Unexpected error removing ${entry}: ${error instanceof Error ? error.message : String(error)}`
			log.warn(`[worktree-sets] ${errMsg}`)
			errors.push(errMsg)
			failureCount++
		}
	}

	// ========================================================================
	// 4. Delete Feature Directory
	// ========================================================================

	try {
		log.info(`[worktree-sets] Removing feature directory: ${featurePath}`)
		await rm(featurePath, { recursive: true, force: true })
		log.info(`[worktree-sets] Successfully removed feature directory`)
	} catch (error) {
		const errMsg = `Failed to remove feature directory: ${error instanceof Error ? error.message : String(error)}`
		log.warn(`[worktree-sets] ${errMsg}`)
		errors.push(errMsg)
	}

	return {
		featurePath,
		removedCount,
		failureCount,
		errors,
	}
}

// ============================================================================
// Listing Function
// ============================================================================

/**
 * List all existing worktree sets in the workspace.
 *
 * Scans workspace root for sibling directories (non-`main/`) and identifies
 * those containing worktrees (subdirectories with .git FILES).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Promise resolving to array of SetInfo objects
 *
 * @example
 * ```typescript
 * const sets = await listWorktreeSets("/Users/dev/workspace")
 * sets.forEach(set => {
 *   console.log(`${set.name}: ${set.repos.join(", ")}`)
 * })
 * // Output:
 * // feature-dark-mode: web, api, database
 * // bugfix-issue-123: web, mobile
 * ```
 */
export async function listWorktreeSets(workspaceRoot: string): Promise<SetInfo[]> {
	const sets: SetInfo[] = []

	try {
		const entries = await readdir(workspaceRoot, { withFileTypes: true })

		for (const entry of entries) {
			// Skip non-directories and the main/ directory
			if (!entry.isDirectory() || entry.name === "main") {
				continue
			}

			const setPath = path.join(workspaceRoot, entry.name)
			const repos: string[] = []

			try {
				// Scan set directory for worktrees
				const setEntries = await readdir(setPath, { withFileTypes: true })

				for (const setEntry of setEntries) {
					if (!setEntry.isDirectory()) {
						continue
					}

					const gitFile = path.join(setPath, setEntry.name, ".git")
					try {
						const stats = await lstat(gitFile)
						if (stats.isFile()) {
							// This is a worktree
							repos.push(setEntry.name)
						}
					} catch (error) {
						// .git doesn't exist or not accessible, skip
					}
				}

				// Only include sets that have at least one worktree
				if (repos.length > 0) {
					sets.push({
						name: entry.name,
						repos: repos.sort(),
						path: setPath,
					})
				}
			} catch (error) {
				// Failed to read set directory, skip silently
				continue
			}
		}

		return sets.sort((a, b) => a.name.localeCompare(b.name))
	} catch (error) {
		// Failed to read workspace root, return empty array
		return []
	}
}
