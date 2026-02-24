/**
 * OCX Worktree Plugin
 *
 * Creates isolated git worktrees for AI development sessions with
 * seamless terminal spawning across macOS, Windows, and Linux.
 *
 * Inspired by opencode-worktree-session by Felix Anhalt
 * https://github.com/felixAnhalt/opencode-worktree-session
 * License: MIT
 *
 * Rewritten for OCX with production-proven patterns.
 */

import type { Database } from "bun:sqlite"
import { access, copyFile, cp, mkdir, rm, stat, symlink } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type Plugin, tool } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import type { OpencodeClient } from "./kdco-primitives/types"
import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"

import { getProjectId } from "./kdco-primitives/get-project-id"
import type { Logger, Result } from "./worktree/shared"
import {
	Result as ResultHelper,
	WorktreeError,
	branchExists,
	branchNameSchema,
	copyFiles,
	git,
	loadWorktreeConfig,
	runHooks,
	symlinkDirs,
} from "./worktree/shared"
import {
	addSession,
	clearPendingDelete,
	getPendingDelete,
	getSession,
	getWorktreePath,
	initStateDb,
	removeSession,
	setPendingDelete,
} from "./worktree/state"
import { openTerminal } from "./worktree/terminal"
import { createWorktreeSet, listWorktreeSets, removeWorktreeSet } from "./worktree/multi-repo/sets"
import { loadPreset } from "./worktree/multi-repo/config"
import { findWorkspaceRoot, validateRepos } from "./worktree/multi-repo/discovery"

/** Maximum retries for database initialization */
const DB_MAX_RETRIES = 3

/** Delay between retry attempts in milliseconds */
const DB_RETRY_DELAY_MS = 100

/** Maximum depth to traverse session parent chain */
const MAX_SESSION_CHAIN_DEPTH = 10

// =============================================================================
// SESSION FORKING HELPERS
// =============================================================================

/**
 * Check if a path exists, distinguishing ENOENT from other errors (Law 4)
 */
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch (e: unknown) {
		if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
			return false
		}
		throw e // Re-throw permission errors, etc.
	}
}

/**
 * Copy file if source exists. Returns true if copied, false if source doesn't exist.
 * Throws on copy failure (Law 4: Fail Loud)
 */
async function copyIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await copyFile(src, dest)
	return true
}

/**
 * Copy directory contents if source exists.
 * @param src - Source directory path
 * @param dest - Destination directory path
 * @returns true if copy was performed, false if source doesn't exist
 */
async function copyDirIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await cp(src, dest, { recursive: true })
	return true
}

interface ForkResult {
	forkedSession: { id: string }
	rootSessionId: string
	planCopied: boolean
	delegationsCopied: boolean
}

/**
 * Fork a session and copy associated plans/delegations.
 * Cleans up forked session on failure (atomic operation).
 */
async function forkWithContext(
	client: OpencodeClient,
	sessionId: string,
	projectId: string,
	getRootSessionIdFn: (sessionId: string) => Promise<string>,
): Promise<ForkResult> {
	// Guard clauses (Law 1)
	if (!client) throw new WorktreeError("client is required", "forkWithContext")
	if (!sessionId) throw new WorktreeError("sessionId is required", "forkWithContext")
	if (!projectId) throw new WorktreeError("projectId is required", "forkWithContext")

	// Get root session ID with error wrapping
	let rootSessionId: string
	try {
		rootSessionId = await getRootSessionIdFn(sessionId)
	} catch (e) {
		throw new WorktreeError("Failed to get root session ID", "forkWithContext", e)
	}

	// Fork session
	const forkedSessionResponse = await client.session.fork({
		path: { id: sessionId },
		body: {},
	})
	const forkedSession = forkedSessionResponse.data
	if (!forkedSession?.id) {
		throw new WorktreeError("Failed to fork session: no session data returned", "forkWithContext")
	}

	// Copy data with cleanup on failure
	let planCopied = false
	let delegationsCopied = false

	try {
		const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
		const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")

		const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
		const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)

		await mkdir(destWorkspaceDir, { recursive: true })
		await mkdir(destDelegationsDir, { recursive: true })

		// Copy plan
		const srcPlan = path.join(workspaceBase, projectId, rootSessionId, "plan.md")
		const destPlan = path.join(destWorkspaceDir, "plan.md")
		planCopied = await copyIfExists(srcPlan, destPlan)

		// Copy delegations
		const srcDelegations = path.join(delegationsBase, projectId, rootSessionId)
		delegationsCopied = await copyDirIfExists(srcDelegations, destDelegationsDir)
	} catch (error) {
		client.app
			.log({
				body: {
					service: "worktree",
					level: "error",
					message: `forkWithContext: Copy failed, cleaning up forked session: ${error}`,
				},
			})
			.catch(() => {})
		// Clean up orphaned directories
		const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
		const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")
		const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
		const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)
		await rm(destWorkspaceDir, { recursive: true, force: true }).catch((e) => {
			client.app
				.log({
					body: {
						service: "worktree",
						level: "error",
						message: `forkWithContext: Failed to clean up workspace dir ${destWorkspaceDir}: ${e}`,
					},
				})
				.catch(() => {})
		})
		await rm(destDelegationsDir, { recursive: true, force: true }).catch((e) => {
			client.app
				.log({
					body: {
						service: "worktree",
						level: "error",
						message: `forkWithContext: Failed to clean up delegations dir ${destDelegationsDir}: ${e}`,
					},
				})
				.catch(() => {})
		})
		await client.session.delete({ path: { id: forkedSession.id } }).catch((e) => {
			client.app
				.log({
					body: {
						service: "worktree",
						level: "error",
						message: `forkWithContext: Failed to clean up forked session ${forkedSession.id}: ${e}`,
					},
				})
				.catch(() => {})
		})
		throw new WorktreeError(
			`Failed to copy session data: ${error instanceof Error ? error.message : String(error)}`,
			"forkWithContext",
			error,
		)
	}

	return { forkedSession, rootSessionId, planCopied, delegationsCopied }
}

// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================

/** Database instance - initialized once per plugin lifecycle */
let db: Database | null = null

/** Project root path - stored on first initialization */
let projectRoot: string | null = null

/** Flag to prevent duplicate cleanup handler registration */
let cleanupRegistered = false

/**
 * Register process cleanup handlers for graceful database shutdown.
 * Ensures WAL checkpoint and proper close on process termination.
 *
 * NOTE: process.once() is an EventEmitter method that never throws.
 * The boolean guard is defense-in-depth for idempotency, not error recovery.
 *
 * @param database - The database instance to clean up
 */
function registerCleanupHandlers(database: Database): void {
	if (cleanupRegistered) return // Early exit guard
	cleanupRegistered = true

	const cleanup = () => {
		try {
			database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
			database.close()
		} catch {
			// Best effort cleanup - process is exiting anyway
		}
	}

	process.once("SIGTERM", cleanup)
	process.once("SIGINT", cleanup)
	process.once("beforeExit", cleanup)
}

/**
 * Get the database instance, initializing if needed.
 * Includes retry logic for transient initialization failures.
 *
 * @returns Database instance
 * @throws {Error} if initialization fails after all retries
 */
async function getDb(log: Logger): Promise<Database> {
	if (db) return db

	if (!projectRoot) {
		throw new Error("Database not initialized: projectRoot not set. Call initDb() first.")
	}

	let lastError: Error | null = null

	for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
		try {
			db = await initStateDb(projectRoot)
			registerCleanupHandlers(db)
			return db
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error))
			log.warn(`Database init attempt ${attempt}/${DB_MAX_RETRIES} failed: ${lastError.message}`)

			if (attempt < DB_MAX_RETRIES) {
				Bun.sleepSync(DB_RETRY_DELAY_MS)
			}
		}
	}

	throw new Error(
		`Failed to initialize database after ${DB_MAX_RETRIES} attempts: ${lastError?.message}`,
	)
}

/**
 * Initialize the database with the project root path.
 * Must be called once before any getDb() calls.
 */
async function initDb(root: string, log: Logger): Promise<Database> {
	projectRoot = root
	return getDb(log)
}

// =============================================================================
// GIT MODULE
// =============================================================================

async function createWorktree(
	repoRoot: string,
	branch: string,
	baseBranch?: string,
): Promise<Result<string, string>> {
	const worktreePath = await getWorktreePath(repoRoot, branch)

	// Ensure parent directory exists
	await mkdir(path.dirname(worktreePath), { recursive: true })

	const exists = await branchExists(repoRoot, branch)

	if (exists) {
		// Checkout existing branch into worktree
		const result = await git(["worktree", "add", worktreePath, branch], repoRoot)
		return result.ok ? ResultHelper.ok(worktreePath) : result
	} else {
		// Create new branch from base
		const base = baseBranch ?? "HEAD"
		const result = await git(["worktree", "add", "-b", branch, worktreePath, base], repoRoot)
		return result.ok ? ResultHelper.ok(worktreePath) : result
	}
}

async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
): Promise<Result<void, string>> {
	const result = await git(["worktree", "remove", "--force", worktreePath], repoRoot)
	return result.ok ? ResultHelper.ok(undefined) : ResultHelper.err(result.error)
}

// =============================================================================
// PLUGIN ENTRY
// =============================================================================

export const WorktreePlugin: Plugin = async (ctx) => {
	const { directory, client } = ctx

	const log = {
		debug: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "debug", message: msg } })
				.catch(() => {}),
		info: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "info", message: msg } })
				.catch(() => {}),
		warn: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "warn", message: msg } })
				.catch(() => {}),
		error: (msg: string) =>
			client.app
				.log({ body: { service: "worktree", level: "error", message: msg } })
				.catch(() => {}),
	}

	// Initialize SQLite database
	const database = await initDb(directory, log)

	return {
		tool: {
			worktree_create: tool({
				description:
					"Create a new git worktree for isolated development. A new terminal will open with OpenCode in the worktree.",
				args: {
					branch: tool.schema
						.string()
						.describe("Branch name for the worktree (e.g., 'feature/dark-mode')"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to create from (defaults to HEAD)"),
				},
				async execute(args, toolCtx) {
					// Validate branch name at boundary
					const branchResult = branchNameSchema.safeParse(args.branch)
					if (!branchResult.success) {
						return `❌ Invalid branch name: ${branchResult.error.issues[0]?.message}`
					}

					// Validate base branch name at boundary
					if (args.baseBranch) {
						const baseResult = branchNameSchema.safeParse(args.baseBranch)
						if (!baseResult.success) {
							return `❌ Invalid base branch name: ${baseResult.error.issues[0]?.message}`
						}
					}

					// Create worktree
					const result = await createWorktree(directory, args.branch, args.baseBranch)
					if (!result.ok) {
						return `Failed to create worktree: ${result.error}`
					}

					const worktreePath = result.value

					// Sync files from main worktree
					const worktreeConfig = await loadWorktreeConfig(directory, log)
					const mainWorktreePath = directory // The repo root is the main worktree

					// Copy files
					if (worktreeConfig.sync.copyFiles.length > 0) {
						await copyFiles(mainWorktreePath, worktreePath, worktreeConfig.sync.copyFiles, log)
					}

					// Symlink directories
					if (worktreeConfig.sync.symlinkDirs.length > 0) {
						await symlinkDirs(mainWorktreePath, worktreePath, worktreeConfig.sync.symlinkDirs, log)
					}

					// Run postCreate hooks
					if (worktreeConfig.hooks.postCreate.length > 0) {
						await runHooks(worktreePath, worktreeConfig.hooks.postCreate, log)
					}

					// Fork session with context (replaces --session resume)
					const projectId = await getProjectId(worktreePath, client)
					const { forkedSession, planCopied, delegationsCopied } = await forkWithContext(
						client,
						toolCtx.sessionID,
						projectId,
						async (sid) => {
							// Walk up parentID chain to find root session
							let currentId = sid
							for (let depth = 0; depth < MAX_SESSION_CHAIN_DEPTH; depth++) {
								const session = await client.session.get({ path: { id: currentId } })
								if (!session.data?.parentID) return currentId
								currentId = session.data.parentID
							}
							return currentId
						},
					)

					log.debug(
						`Forked session ${forkedSession.id}, plan: ${planCopied}, delegations: ${delegationsCopied}`,
					)

					// Spawn worktree with forked session
					const terminalResult = await openTerminal(
						worktreePath,
						`opencode --session ${forkedSession.id}`,
						args.branch,
					)

					if (!terminalResult.success) {
						log.warn(`[worktree] Failed to open terminal: ${terminalResult.error}`)
					}

					// Record session for tracking (used by delete flow)
					addSession(database, {
						id: forkedSession.id,
						branch: args.branch,
						path: worktreePath,
						createdAt: new Date().toISOString(),
					})

					return `Worktree created at ${worktreePath}\n\nA new terminal has been opened with OpenCode.`
				},
			}),

			worktree_delete: tool({
				description:
					"Delete the current worktree and clean up. Changes will be committed before removal.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
				},
				async execute(_args, toolCtx) {
					// Find current session's worktree
					const session = getSession(database, toolCtx?.sessionID ?? "")
					if (!session) {
						return `No worktree associated with this session`
					}

					// Set pending delete for session.idle (atomic operation)
					setPendingDelete(database, { branch: session.branch, path: session.path }, client)

					return `Worktree marked for cleanup. It will be removed when this session ends.`
				},
			}),

			worktree_set_create: tool({
				description:
					"Create worktrees across multiple repositories under a shared feature directory. Useful for multi-repo development where you need the same feature branch checked out in several repositories simultaneously.",
				args: {
					branch: tool.schema
						.string()
						.describe("Branch name for the worktree set (e.g., 'feature/dark-mode')"),
					repos: tool.schema
						.array(tool.schema.string())
						.describe("Repository names to create worktrees for (e.g., ['web', 'api', 'database'])"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to create from (defaults to HEAD)"),
					preset: tool.schema
						.string()
						.optional()
						.describe("Preset name to load repository list from .worktree-sets.jsonc"),
					workspace: tool.schema
						.string()
						.optional()
						.describe("Workspace root directory (auto-detected if not provided)"),
				},
				async execute(args, _toolCtx) {
					// Validate branch name at boundary
					const branchResult = branchNameSchema.safeParse(args.branch)
					if (!branchResult.success) {
						return `❌ Invalid branch name: ${branchResult.error.issues[0]?.message}`
					}

					// Resolve workspace root
					let workspaceRoot: string
					if (args.workspace) {
						workspaceRoot = args.workspace
					} else {
						const wsResult = await findWorkspaceRoot(directory)
						if (!wsResult.ok) {
							return `❌ ${wsResult.error}`
						}
						workspaceRoot = wsResult.value
					}

					// Determine repository list (preset, explicit repos, or merge both)
					let repos: string[] = []

					if (args.preset) {
						const presetResult = await loadPreset(workspaceRoot, args.preset, log)
						if (!presetResult.ok) {
							return `❌ ${presetResult.error}`
						}
						repos = presetResult.value
					}

					// Merge explicit repos with preset repos if both provided
					if (args.repos.length > 0) {
						repos = [...new Set([...repos, ...args.repos])]
					}

					// Validate we have repos
					if (repos.length === 0) {
						return `❌ No repositories specified. Provide either 'repos' or 'preset'.`
					}

					// Validate repos exist
					const validationResult = validateRepos(workspaceRoot, repos)
					if (!validationResult.ok) {
						return `❌ Repository validation failed: ${validationResult.error}`
					}

					const validRepos = validationResult.value
					if (validRepos.length === 0) {
						return `❌ None of the specified repositories exist in ${workspaceRoot}/main/`
					}

					// Create worktree set
					const result = await createWorktreeSet({
						workspaceRoot,
						branch: args.branch,
						baseBranch: args.baseBranch,
						repos: validRepos,
						runHooksFlag: true,
						log,
					})

					// Format summary
					const summary = [
						`✅ Worktree set created: ${result.featurePath}`,
						``,
						`📊 Results: ${result.successCount} succeeded, ${result.failureCount} failed`,
						``,
					]

					if (result.successCount > 0) {
						summary.push(`✅ Successful worktrees:`)
						for (const res of result.results) {
							if (res.success && res.worktreePath) {
								summary.push(`  - ${res.repo}: ${res.worktreePath}`)
							}
						}
						summary.push(``)
					}

					if (result.failureCount > 0) {
						summary.push(`❌ Failed worktrees:`)
						for (const res of result.results) {
							if (!res.success && res.error) {
								summary.push(`  - ${res.repo}: ${res.error}`)
							}
						}
						summary.push(``)
					}

					if (result.successCount > 0) {
						summary.push(`OpenCode has been launched in the feature directory.`)
					}

					return summary.join("\n")
				},
			}),

			worktree_set_delete: tool({
				description:
					"Delete all worktrees in a multi-repo feature set. Removes all worktrees for the specified branch and cleans up the feature directory.",
				args: {
					branch: tool.schema
						.string()
						.describe("Branch name of the worktree set to delete (e.g., 'feature/dark-mode')"),
					workspace: tool.schema
						.string()
						.optional()
						.describe("Workspace root directory (auto-detected if not provided)"),
				},
				async execute(args, _toolCtx) {
					// Resolve workspace root
					let workspaceRoot: string
					if (args.workspace) {
						workspaceRoot = args.workspace
					} else {
						const wsResult = await findWorkspaceRoot(directory)
						if (!wsResult.ok) {
							return `❌ ${wsResult.error}`
						}
						workspaceRoot = wsResult.value
					}

					// Remove worktree set
					const result = await removeWorktreeSet({
						workspaceRoot,
						branch: args.branch,
						log,
					})

					// Format summary
					const summary = [`✅ Worktree set removal complete`, ``]

					if (result.removedCount > 0) {
						summary.push(`✅ Removed ${result.removedCount} worktree(s)`)
					}

					if (result.failureCount > 0) {
						summary.push(`❌ Failed to remove ${result.failureCount} worktree(s)`)
					}

					if (result.errors.length > 0) {
						summary.push(``, `⚠️  Errors:`)
						for (const error of result.errors) {
							summary.push(`  - ${error}`)
						}
					}

					if (result.removedCount === 0 && result.failureCount === 0) {
						summary.push(`ℹ️  No worktrees found at ${result.featurePath}`)
					}

					return summary.join("\n")
				},
			}),

			worktree_set_list: tool({
				description:
					"List all existing multi-repo worktree sets in the workspace. Shows which repositories are included in each feature set.",
				args: {
					workspace: tool.schema
						.string()
						.optional()
						.describe("Workspace root directory (auto-detected if not provided)"),
				},
				async execute(args, _toolCtx) {
					// Resolve workspace root
					let workspaceRoot: string
					if (args.workspace) {
						workspaceRoot = args.workspace
					} else {
						const wsResult = await findWorkspaceRoot(directory)
						if (!wsResult.ok) {
							return `❌ ${wsResult.error}`
						}
						workspaceRoot = wsResult.value
					}

					// List worktree sets
					const sets = await listWorktreeSets(workspaceRoot)

					// Format output
					if (sets.length === 0) {
						return `ℹ️  No worktree sets found in ${workspaceRoot}`
					}

					const summary = [`📋 Worktree sets in ${workspaceRoot}:`, ``]

					for (const set of sets) {
						summary.push(`🌿 ${set.name}`)
						summary.push(`   Repos: ${set.repos.join(", ")}`)
						summary.push(`   Path: ${set.path}`)
						summary.push(``)
					}

					return summary.join("\n")
				},
			}),
		},

		event: async ({ event }: { event: Event }): Promise<void> => {
			if (event.type !== "session.idle") return

			// Handle pending delete
			const pendingDelete = getPendingDelete(database)
			if (pendingDelete) {
				const { path: worktreePath, branch } = pendingDelete

				// Run preDelete hooks before cleanup
				const config = await loadWorktreeConfig(directory, log)
				if (config.hooks.preDelete.length > 0) {
					await runHooks(worktreePath, config.hooks.preDelete, log)
				}

				// Commit any uncommitted changes
				const addResult = await git(["add", "-A"], worktreePath)
				if (!addResult.ok) log.warn(`[worktree] git add failed: ${addResult.error}`)

				const commitResult = await git(
					["commit", "-m", "chore(worktree): session snapshot", "--allow-empty"],
					worktreePath,
				)
				if (!commitResult.ok) log.warn(`[worktree] git commit failed: ${commitResult.error}`)

				// Remove worktree
				const removeResult = await removeWorktree(directory, worktreePath)
				if (!removeResult.ok) {
					log.warn(`[worktree] Failed to remove worktree: ${removeResult.error}`)
				}

				// Clear pending delete atomically
				clearPendingDelete(database)

				// Remove session from database
				removeSession(database, branch)
			}
		},
	}
}

export default WorktreePlugin
