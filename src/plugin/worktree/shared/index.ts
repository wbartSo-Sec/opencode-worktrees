/**
 * Shared utilities for worktree operations.
 *
 * This module provides common types and utilities for worktree management,
 * extracted for reuse across single-repo and multi-repo implementations.
 *
 * @module worktree/shared
 */

// Result types
export type { ErrResult, OkResult, Result } from "./result"
export { Result } from "./result"

// Core types
export type { Logger, WorktreeConfig } from "./types"
export { WorktreeError, worktreeConfigSchema } from "./types"

// Git operations
export { branchExists, branchNameSchema, git, isValidBranchName } from "./git"

// File synchronization
export { copyFiles, isPathSafe, symlinkDirs } from "./sync"

// Hooks and configuration
export { loadWorktreeConfig, runHooks } from "./hooks"
