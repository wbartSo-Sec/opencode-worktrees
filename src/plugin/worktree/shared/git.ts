/**
 * Git operations and branch name validation.
 *
 * @module worktree/shared/git
 */

import { z } from "zod"
import type { Result } from "./result"
import { Result as ResultHelper } from "./result"

/**
 * Git branch name validation - blocks invalid refs and shell metacharacters
 * Characters blocked: control chars (0x00-0x1f, 0x7f), ~^:?*[]\\, and shell metacharacters
 */
export function isValidBranchName(name: string): boolean {
	// Check for control characters
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i)
		if (code <= 0x1f || code === 0x7f) return false
	}
	// Check for invalid git ref characters and shell metacharacters
	if (/[~^:?*[\]\\;&|`$()]/.test(name)) return false
	return true
}

export const branchNameSchema = z
	.string()
	.min(1, "Branch name cannot be empty")
	.max(255, "Branch name too long")
	.refine((name) => !name.startsWith("-"), {
		message: "Branch name cannot start with '-' (prevents option injection)",
	})
	.refine((name) => !name.startsWith("/") && !name.endsWith("/"), {
		message: "Branch name cannot start or end with '/'",
	})
	.refine((name) => !name.includes("//"), {
		message: "Branch name cannot contain '//'",
	})
	.refine((name) => !name.includes("@{"), {
		message: "Branch name cannot contain '@{' (git reflog syntax)",
	})
	.refine((name) => !name.includes(".."), {
		message: "Branch name cannot contain '..'",
	})
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Control character detection is intentional for security
	.refine((name) => !/[\x00-\x1f\x7f ~^:?*[\]\\]/.test(name), {
		message: "Branch name contains invalid characters",
	})
	.refine((name) => isValidBranchName(name), "Contains invalid git ref characters")
	.refine((name) => !name.startsWith(".") && !name.endsWith("."), "Cannot start or end with dot")
	.refine((name) => !name.endsWith(".lock"), "Cannot end with .lock")

/**
 * Execute a git command safely using Bun.spawn with explicit array.
 * Avoids shell interpolation entirely by passing args as array.
 */
export async function git(args: string[], cwd: string): Promise<Result<string, string>> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		if (exitCode !== 0) {
			return ResultHelper.err(stderr.trim() || `git ${args[0]} failed`)
		}
		return ResultHelper.ok(stdout.trim())
	} catch (error) {
		return ResultHelper.err(error instanceof Error ? error.message : String(error))
	}
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const result = await git(["rev-parse", "--verify", branch], cwd)
	return result.ok
}
