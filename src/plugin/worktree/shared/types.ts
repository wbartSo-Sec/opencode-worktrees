/**
 * Shared type definitions for worktree operations.
 *
 * @module worktree/shared/types
 */

import { z } from "zod"

/** Logger interface for structured logging */
export interface Logger {
	debug: (msg: string) => void
	info: (msg: string) => void
	warn: (msg: string) => void
	error: (msg: string) => void
}

/**
 * Worktree plugin configuration schema.
 * Config file: .opencode/worktree.jsonc
 */
export const worktreeConfigSchema = z.object({
	sync: z
		.object({
			/** Files to copy from main worktree (relative paths only) */
			copyFiles: z.array(z.string()).default([]),
			/** Directories to symlink from main worktree (saves disk space) */
			symlinkDirs: z.array(z.string()).default([]),
			/** Patterns to exclude from copying (reserved for future use) */
			exclude: z.array(z.string()).default([]),
		})
		.default(() => ({ copyFiles: [], symlinkDirs: [], exclude: [] })),
	hooks: z
		.object({
			/** Commands to run after worktree creation */
			postCreate: z.array(z.string()).default([]),
			/** Commands to run before worktree deletion */
			preDelete: z.array(z.string()).default([]),
		})
		.default(() => ({ postCreate: [], preDelete: [] })),
})

export type WorktreeConfig = z.infer<typeof worktreeConfigSchema>

export class WorktreeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly cause?: unknown,
	) {
		super(`${operation}: ${message}`)
		this.name = "WorktreeError"
	}
}
