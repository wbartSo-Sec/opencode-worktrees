/**
 * File synchronization utilities for worktrees.
 *
 * @module worktree/shared/sync
 */

import { mkdir, rm, stat, symlink } from "node:fs/promises"
import * as path from "node:path"
import type { Logger } from "./types"

/**
 * Validate that a path is safe (no escape from base directory)
 */
export function isPathSafe(filePath: string, baseDir: string, log: Logger): boolean {
	// Reject absolute paths
	if (path.isAbsolute(filePath)) {
		log.warn(`[worktree] Rejected absolute path: ${filePath}`)
		return false
	}
	// Reject obvious path traversal
	if (filePath.includes("..")) {
		log.warn(`[worktree] Rejected path traversal: ${filePath}`)
		return false
	}
	// Verify resolved path stays within base directory
	const resolved = path.resolve(baseDir, filePath)
	if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
		log.warn(`[worktree] Path escapes base directory: ${filePath}`)
		return false
	}
	return true
}

/**
 * Copy files from source directory to target directory.
 * Skips missing files silently (production pattern).
 */
export async function copyFiles(
	sourceDir: string,
	targetDir: string,
	files: string[],
	log: Logger,
): Promise<void> {
	for (const file of files) {
		if (!isPathSafe(file, sourceDir, log)) continue

		const sourcePath = path.join(sourceDir, file)
		const targetPath = path.join(targetDir, file)

		try {
			const sourceFile = Bun.file(sourcePath)
			if (!(await sourceFile.exists())) {
				log.debug(`[worktree] Skipping missing file: ${file}`)
				continue
			}

			// Ensure target directory exists
			const targetFileDir = path.dirname(targetPath)
			await mkdir(targetFileDir, { recursive: true })

			// Copy file
			await Bun.write(targetPath, sourceFile)
			log.info(`[worktree] Copied: ${file}`)
		} catch (error) {
			const isNotFound =
				error instanceof Error &&
				(error.message.includes("ENOENT") || error.message.includes("no such file"))
			if (isNotFound) {
				log.debug(`[worktree] Skipping missing: ${file}`)
			} else {
				log.warn(`[worktree] Failed to copy ${file}: ${error}`)
			}
		}
	}
}

/**
 * Create symlinks for directories from source to target.
 * Uses absolute paths for symlink targets.
 */
export async function symlinkDirs(
	sourceDir: string,
	targetDir: string,
	dirs: string[],
	log: Logger,
): Promise<void> {
	for (const dir of dirs) {
		if (!isPathSafe(dir, sourceDir, log)) continue

		const sourcePath = path.join(sourceDir, dir)
		const targetPath = path.join(targetDir, dir)

		try {
			// Check if source directory exists
			const fileStat = await stat(sourcePath).catch(() => null)
			if (!fileStat || !fileStat.isDirectory()) {
				log.debug(`[worktree] Skipping missing directory: ${dir}`)
				continue
			}

			// Ensure parent directory exists
			const targetParentDir = path.dirname(targetPath)
			await mkdir(targetParentDir, { recursive: true })

			// Remove existing target if it exists (might be empty dir from git)
			await rm(targetPath, { recursive: true, force: true })

			// Create symlink (use absolute path for source)
			await symlink(sourcePath, targetPath, "dir")
			log.info(`[worktree] Symlinked: ${dir}`)
		} catch (error) {
			log.warn(`[worktree] Failed to symlink ${dir}: ${error}`)
		}
	}
}
