#!/usr/bin/env bun
/**
 * Multi-repo worktree sets CLI.
 *
 * Interactive and non-interactive command-line interface for creating,
 * managing, and removing multi-repository worktree sets.
 *
 * @module cli/worktree-sets
 */

import * as path from "node:path"
import * as prompts from "@clack/prompts"
import { createWorktreeSet, listWorktreeSets, removeWorktreeSet } from "../plugin/worktree/multi-repo/sets"
import { discoverRepos, findWorkspaceRoot, validateRepos } from "../plugin/worktree/multi-repo/discovery"
import { listPresets, loadPreset, savePreset } from "../plugin/worktree/multi-repo/config"

// ============================================================================
// ANSI Color Codes
// ============================================================================

const RED = "\x1b[0;31m"
const GREEN = "\x1b[0;32m"
const YELLOW = "\x1b[0;33m"
const CYAN = "\x1b[0;36m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

// ============================================================================
// Logger Implementation
// ============================================================================

const logger = {
	info: (msg: string) => console.log(msg),
	warn: (msg: string) => console.warn(`${YELLOW}${msg}${RESET}`),
	error: (msg: string) => console.error(`${RED}${msg}${RESET}`),
	debug: (msg: string) => {
		if (process.env.DEBUG) {
			console.log(`${CYAN}[DEBUG]${RESET} ${msg}`)
		}
	},
}

// ============================================================================
// Argument Parsing
// ============================================================================

interface ParsedArgs {
	subcommand: string
	branch?: string
	repos: string[]
	preset?: string
	base?: string
	workspace?: string
	yes: boolean
	noHooks: boolean
	name?: string // For preset save
}

function parseArgs(): ParsedArgs {
	const args: ParsedArgs = {
		subcommand: "",
		repos: [],
		yes: false,
		noHooks: false,
	}

	const argv = process.argv.slice(2)

	if (argv.length === 0) {
		return args
	}

	// First non-flag argument is the subcommand
	args.subcommand = argv[0]

	// Parse remaining arguments
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i]

		if (arg === "-y" || arg === "--yes") {
			args.yes = true
		} else if (arg === "--no-hooks") {
			args.noHooks = true
		} else if (arg === "-b" || arg === "--branch") {
			args.branch = argv[++i]
		} else if (arg === "--repos") {
			const reposArg = argv[++i]
			args.repos = reposArg ? reposArg.split(",").map((r) => r.trim()) : []
		} else if (arg === "--preset") {
			args.preset = argv[++i]
		} else if (arg === "--base") {
			args.base = argv[++i]
		} else if (arg === "-w" || arg === "--workspace") {
			args.workspace = argv[++i]
		} else if (arg === "--name") {
			args.name = argv[++i]
		}
	}

	return args
}

// ============================================================================
// Subcommand: CREATE
// ============================================================================

async function handleCreate(args: ParsedArgs) {
	prompts.intro(`${BOLD}${GREEN}Create Worktree Set${RESET}`)

	// ========================================================================
	// 1. Resolve Workspace Root
	// ========================================================================

	let workspaceRoot: string
	if (args.workspace) {
		workspaceRoot = path.resolve(args.workspace)
		logger.info(`${BOLD}Workspace:${RESET} ${CYAN}${workspaceRoot}${RESET}`)
	} else {
		const wsResult = await findWorkspaceRoot(process.cwd())
		if (!wsResult.ok) {
			prompts.cancel(`${RED}❌ ${wsResult.error}${RESET}`)
			process.exit(1)
		}
		workspaceRoot = wsResult.value
		logger.info(`${BOLD}Workspace:${RESET} ${CYAN}${workspaceRoot}${RESET}`)
	}

	// ========================================================================
	// 2. Get Branch Name (Interactive or Flag)
	// ========================================================================

	let branch: string
	if (args.branch) {
		branch = args.branch
		logger.info(`${BOLD}Branch:${RESET} ${CYAN}${branch}${RESET}`)
	} else {
		const branchInput = await prompts.text({
			message: "Branch name:",
			placeholder: "feature/dark-mode",
			validate: (value) => {
				if (!value || value.trim().length === 0) {
					return "Branch name is required"
				}
				return undefined
			},
		})

		if (prompts.isCancel(branchInput)) {
			prompts.cancel(`${RED}Operation cancelled${RESET}`)
			process.exit(0)
		}

		branch = branchInput as string
	}

	// ========================================================================
	// 3. Get Repositories (Interactive or Flags)
	// ========================================================================

	let repos: string[] = []

	// Load preset if specified
	if (args.preset) {
		const presetResult = await loadPreset(workspaceRoot, args.preset, logger)
		if (!presetResult.ok) {
			prompts.cancel(`${RED}❌ ${presetResult.error}${RESET}`)
			process.exit(1)
		}
		repos = presetResult.value
		logger.info(`${BOLD}Loaded preset "${args.preset}":${RESET} ${CYAN}${repos.join(", ")}${RESET}`)
	}

	// Merge with explicit repos if provided
	if (args.repos.length > 0) {
		repos = [...new Set([...repos, ...args.repos])]
		logger.info(`${BOLD}Repositories:${RESET} ${CYAN}${repos.join(", ")}${RESET}`)
	}

	// Interactive mode if no repos specified
	if (repos.length === 0) {
		// Check if preset is available
		const presets = await listPresets(workspaceRoot, logger)
		const presetNames = Object.keys(presets)

		let usePreset = false
		if (presetNames.length > 0) {
			const presetChoice = await prompts.select({
				message: "Use a preset or select manually?",
				options: [
					{ value: "manual", label: "Select repositories manually" },
					{ value: "preset", label: "Use a saved preset" },
				],
			})

			if (prompts.isCancel(presetChoice)) {
				prompts.cancel(`${RED}Operation cancelled${RESET}`)
				process.exit(0)
			}

			usePreset = presetChoice === "preset"
		}

		if (usePreset) {
			const presetChoice = await prompts.select({
				message: "Select a preset:",
				options: presetNames.map((name) => ({
					value: name,
					label: `${name} (${presets[name]?.join(", ")})`,
				})),
			})

			if (prompts.isCancel(presetChoice)) {
				prompts.cancel(`${RED}Operation cancelled${RESET}`)
				process.exit(0)
			}

			repos = presets[presetChoice as string] || []
		} else {
			// Discover available repos
			const discoverResult = await discoverRepos(workspaceRoot)
			if (!discoverResult.ok) {
				prompts.cancel(`${RED}❌ ${discoverResult.error}${RESET}`)
				process.exit(1)
			}

			const availableRepos = discoverResult.value
			if (availableRepos.length === 0) {
				prompts.cancel(`${RED}❌ No repositories found in ${workspaceRoot}/main/${RESET}`)
				process.exit(1)
			}

			const repoSelection = await prompts.multiselect({
				message: "Select repositories:",
				options: availableRepos.map((repo) => ({
					value: repo,
					label: repo,
				})),
				required: true,
			})

			if (prompts.isCancel(repoSelection)) {
				prompts.cancel(`${RED}Operation cancelled${RESET}`)
				process.exit(0)
			}

			repos = repoSelection as string[]
		}
	}

	if (repos.length === 0) {
		prompts.cancel(`${RED}❌ No repositories selected${RESET}`)
		process.exit(1)
	}

	// ========================================================================
	// 4. Validate Repositories
	// ========================================================================

	const validationResult = validateRepos(workspaceRoot, repos)
	if (!validationResult.ok) {
		prompts.cancel(`${RED}❌ ${validationResult.error}${RESET}`)
		process.exit(1)
	}

	const validRepos = validationResult.value
	if (validRepos.length === 0) {
		prompts.cancel(`${RED}❌ None of the specified repositories exist in ${workspaceRoot}/main/${RESET}`)
		process.exit(1)
	}

	if (validRepos.length < repos.length) {
		logger.warn(
			`Some repositories were invalid and will be skipped. Valid: ${validRepos.join(", ")}`,
		)
	}

	// ========================================================================
	// 5. Confirmation
	// ========================================================================

	console.log("")
	console.log(`${BOLD}Summary:${RESET}`)
	console.log(`  ${BOLD}Branch:${RESET}       ${CYAN}${branch}${RESET}`)
	console.log(`  ${BOLD}Base:${RESET}         ${CYAN}${args.base || "HEAD"}${RESET}`)
	console.log(`  ${BOLD}Repositories:${RESET} ${CYAN}${validRepos.join(", ")}${RESET}`)
	console.log(`  ${BOLD}Run hooks:${RESET}    ${CYAN}${args.noHooks ? "no" : "yes"}${RESET}`)
	console.log("")

	if (!args.yes) {
		const confirm = await prompts.confirm({
			message: "Proceed with creation?",
		})

		if (prompts.isCancel(confirm) || !confirm) {
			prompts.cancel(`${RED}Operation cancelled${RESET}`)
			process.exit(0)
		}
	}

	// ========================================================================
	// 6. Create Worktree Set
	// ========================================================================

	const spinner = prompts.spinner()
	spinner.start("Creating worktree set...")

	const result = await createWorktreeSet({
		workspaceRoot,
		branch,
		baseBranch: args.base,
		repos: validRepos,
		runHooksFlag: !args.noHooks,
		log: logger,
	})

	spinner.stop()

	// ========================================================================
	// 7. Display Results
	// ========================================================================

	if (result.successCount === 0) {
		prompts.cancel(`${RED}❌ All repositories failed${RESET}`)
		if (result.results.length > 0) {
			console.log("")
			console.log(`${BOLD}Errors:${RESET}`)
			for (const res of result.results) {
				if (!res.success) {
					console.log(`  ${RED}❌${RESET} ${res.repo}: ${res.error}`)
				}
			}
		}
		process.exit(1)
	}

	console.log("")
	console.log(`${GREEN}✅ Worktree set created: ${result.featurePath}${RESET}`)
	console.log("")
	console.log(`${BOLD}Results:${RESET} ${result.successCount} succeeded, ${result.failureCount} failed`)
	console.log("")

	if (result.successCount > 0) {
		console.log(`${GREEN}✅ Successful worktrees:${RESET}`)
		for (const res of result.results) {
			if (res.success && res.worktreePath) {
				console.log(`  ${GREEN}•${RESET} ${res.repo}: ${CYAN}${res.worktreePath}${RESET}`)
			}
		}
		console.log("")
	}

	if (result.failureCount > 0) {
		console.log(`${RED}❌ Failed worktrees:${RESET}`)
		for (const res of result.results) {
			if (!res.success) {
				console.log(`  ${RED}•${RESET} ${res.repo}: ${res.error}`)
			}
		}
		console.log("")
	}

	// ========================================================================
	// 8. Offer to Save as Preset
	// ========================================================================

	if (!args.preset && !args.yes) {
		const saveAsPreset = await prompts.confirm({
			message: "Save this repository selection as a preset?",
			initialValue: false,
		})

		if (!prompts.isCancel(saveAsPreset) && saveAsPreset) {
			const presetName = await prompts.text({
				message: "Preset name:",
				placeholder: "my-preset",
				validate: (value) => {
					if (!value || value.trim().length === 0) {
						return "Preset name is required"
					}
					return undefined
				},
			})

			if (!prompts.isCancel(presetName)) {
				await savePreset(workspaceRoot, presetName as string, validRepos, logger)
				console.log(`${GREEN}✅ Preset "${presetName}" saved${RESET}`)
			}
		}
	}

	prompts.outro(`${GREEN}Done!${RESET}`)
}

// ============================================================================
// Subcommand: REMOVE
// ============================================================================

async function handleRemove(args: ParsedArgs) {
	prompts.intro(`${BOLD}${RED}Remove Worktree Set${RESET}`)

	// ========================================================================
	// 1. Resolve Workspace Root
	// ========================================================================

	let workspaceRoot: string
	if (args.workspace) {
		workspaceRoot = path.resolve(args.workspace)
		logger.info(`${BOLD}Workspace:${RESET} ${CYAN}${workspaceRoot}${RESET}`)
	} else {
		const wsResult = await findWorkspaceRoot(process.cwd())
		if (!wsResult.ok) {
			prompts.cancel(`${RED}❌ ${wsResult.error}${RESET}`)
			process.exit(1)
		}
		workspaceRoot = wsResult.value
		logger.info(`${BOLD}Workspace:${RESET} ${CYAN}${workspaceRoot}${RESET}`)
	}

	// ========================================================================
	// 2. Get Branch Name (Interactive or Flag)
	// ========================================================================

	let branch: string
	if (args.branch) {
		branch = args.branch
		logger.info(`${BOLD}Branch:${RESET} ${CYAN}${branch}${RESET}`)
	} else {
		// List existing sets for selection
		const sets = await listWorktreeSets(workspaceRoot)
		if (sets.length === 0) {
			prompts.cancel(`${RED}❌ No worktree sets found in ${workspaceRoot}${RESET}`)
			process.exit(1)
		}

		const setChoice = await prompts.select({
			message: "Select a worktree set to remove:",
			options: sets.map((set) => ({
				value: set.name,
				label: `${set.name} (${set.repos.join(", ")})`,
			})),
		})

		if (prompts.isCancel(setChoice)) {
			prompts.cancel(`${RED}Operation cancelled${RESET}`)
			process.exit(0)
		}

		branch = setChoice as string
	}

	// ========================================================================
	// 3. Confirmation
	// ========================================================================

	console.log("")
	console.log(`${BOLD}${RED}WARNING:${RESET} This will remove all worktrees and delete the feature directory`)
	console.log(`  ${BOLD}Branch:${RESET} ${CYAN}${branch}${RESET}`)
	console.log("")

	if (!args.yes) {
		const confirm = await prompts.confirm({
			message: "Proceed with removal?",
			initialValue: false,
		})

		if (prompts.isCancel(confirm) || !confirm) {
			prompts.cancel(`${RED}Operation cancelled${RESET}`)
			process.exit(0)
		}
	}

	// ========================================================================
	// 4. Remove Worktree Set
	// ========================================================================

	const spinner = prompts.spinner()
	spinner.start("Removing worktree set...")

	const result = await removeWorktreeSet({
		workspaceRoot,
		branch,
		log: logger,
	})

	spinner.stop()

	// ========================================================================
	// 5. Display Results
	// ========================================================================

	console.log("")
	if (result.removedCount === 0 && result.errors.length > 0) {
		prompts.cancel(`${RED}❌ Failed to remove worktree set${RESET}`)
		console.log("")
		console.log(`${BOLD}Errors:${RESET}`)
		for (const error of result.errors) {
			console.log(`  ${RED}•${RESET} ${error}`)
		}
		process.exit(1)
	}

	console.log(`${GREEN}✅ Removed worktree set: ${result.featurePath}${RESET}`)
	console.log("")
	console.log(`${BOLD}Results:${RESET} ${result.removedCount} removed, ${result.failureCount} failed`)

	if (result.errors.length > 0) {
		console.log("")
		console.log(`${YELLOW}Warnings:${RESET}`)
		for (const error of result.errors) {
			console.log(`  ${YELLOW}•${RESET} ${error}`)
		}
	}

	prompts.outro(`${GREEN}Done!${RESET}`)
}

// ============================================================================
// Subcommand: LIST
// ============================================================================

async function handleList(args: ParsedArgs) {
	// ========================================================================
	// 1. Resolve Workspace Root
	// ========================================================================

	let workspaceRoot: string
	if (args.workspace) {
		workspaceRoot = path.resolve(args.workspace)
	} else {
		const wsResult = await findWorkspaceRoot(process.cwd())
		if (!wsResult.ok) {
			console.error(`${RED}❌ ${wsResult.error}${RESET}`)
			process.exit(1)
		}
		workspaceRoot = wsResult.value
	}

	// ========================================================================
	// 2. List Sets
	// ========================================================================

	const sets = await listWorktreeSets(workspaceRoot)

	console.log("")
	console.log(`${BOLD}Worktree Sets in ${CYAN}${workspaceRoot}${RESET}`)
	console.log("")

	if (sets.length === 0) {
		console.log(`${YELLOW}No worktree sets found${RESET}`)
		console.log("")
		return
	}

	for (const set of sets) {
		console.log(`${BOLD}${GREEN}${set.name}${RESET}`)
		console.log(`  ${BOLD}Path:${RESET} ${CYAN}${set.path}${RESET}`)
		console.log(`  ${BOLD}Repos:${RESET} ${set.repos.join(", ")}`)
		console.log("")
	}
}

// ============================================================================
// Subcommand: PRESET SAVE
// ============================================================================

async function handlePresetSave(args: ParsedArgs) {
	prompts.intro(`${BOLD}${GREEN}Save Preset${RESET}`)

	// ========================================================================
	// 1. Resolve Workspace Root
	// ========================================================================

	let workspaceRoot: string
	if (args.workspace) {
		workspaceRoot = path.resolve(args.workspace)
		logger.info(`${BOLD}Workspace:${RESET} ${CYAN}${workspaceRoot}${RESET}`)
	} else {
		const wsResult = await findWorkspaceRoot(process.cwd())
		if (!wsResult.ok) {
			prompts.cancel(`${RED}❌ ${wsResult.error}${RESET}`)
			process.exit(1)
		}
		workspaceRoot = wsResult.value
		logger.info(`${BOLD}Workspace:${RESET} ${CYAN}${workspaceRoot}${RESET}`)
	}

	// ========================================================================
	// 2. Get Preset Name (Interactive or Flag)
	// ========================================================================

	let presetName: string
	if (args.name) {
		presetName = args.name
		logger.info(`${BOLD}Preset name:${RESET} ${CYAN}${presetName}${RESET}`)
	} else {
		const nameInput = await prompts.text({
			message: "Preset name:",
			placeholder: "my-preset",
			validate: (value) => {
				if (!value || value.trim().length === 0) {
					return "Preset name is required"
				}
				return undefined
			},
		})

		if (prompts.isCancel(nameInput)) {
			prompts.cancel(`${RED}Operation cancelled${RESET}`)
			process.exit(0)
		}

		presetName = nameInput as string
	}

	// ========================================================================
	// 3. Get Repositories (Interactive or Flag)
	// ========================================================================

	let repos: string[] = []

	if (args.repos.length > 0) {
		repos = args.repos
		logger.info(`${BOLD}Repositories:${RESET} ${CYAN}${repos.join(", ")}${RESET}`)
	} else {
		// Discover available repos
		const discoverResult = await discoverRepos(workspaceRoot)
		if (!discoverResult.ok) {
			prompts.cancel(`${RED}❌ ${discoverResult.error}${RESET}`)
			process.exit(1)
		}

		const availableRepos = discoverResult.value
		if (availableRepos.length === 0) {
			prompts.cancel(`${RED}❌ No repositories found in ${workspaceRoot}/main/${RESET}`)
			process.exit(1)
		}

		const repoSelection = await prompts.multiselect({
			message: "Select repositories for this preset:",
			options: availableRepos.map((repo) => ({
				value: repo,
				label: repo,
			})),
			required: true,
		})

		if (prompts.isCancel(repoSelection)) {
			prompts.cancel(`${RED}Operation cancelled${RESET}`)
			process.exit(0)
		}

		repos = repoSelection as string[]
	}

	if (repos.length === 0) {
		prompts.cancel(`${RED}❌ No repositories selected${RESET}`)
		process.exit(1)
	}

	// ========================================================================
	// 4. Save Preset
	// ========================================================================

	await savePreset(workspaceRoot, presetName, repos, logger)

	console.log("")
	console.log(`${GREEN}✅ Preset "${presetName}" saved${RESET}`)
	console.log(`  ${BOLD}Repositories:${RESET} ${CYAN}${repos.join(", ")}${RESET}`)
	console.log("")

	prompts.outro(`${GREEN}Done!${RESET}`)
}

// ============================================================================
// Subcommand: PRESET LIST
// ============================================================================

async function handlePresetList(args: ParsedArgs) {
	// ========================================================================
	// 1. Resolve Workspace Root
	// ========================================================================

	let workspaceRoot: string
	if (args.workspace) {
		workspaceRoot = path.resolve(args.workspace)
	} else {
		const wsResult = await findWorkspaceRoot(process.cwd())
		if (!wsResult.ok) {
			console.error(`${RED}❌ ${wsResult.error}${RESET}`)
			process.exit(1)
		}
		workspaceRoot = wsResult.value
	}

	// ========================================================================
	// 2. List Presets
	// ========================================================================

	const presets = await listPresets(workspaceRoot, logger)
	const presetNames = Object.keys(presets)

	console.log("")
	console.log(`${BOLD}Saved Presets in ${CYAN}${workspaceRoot}${RESET}`)
	console.log("")

	if (presetNames.length === 0) {
		console.log(`${YELLOW}No presets found${RESET}`)
		console.log("")
		return
	}

	for (const name of presetNames) {
		const repos = presets[name]
		console.log(`${BOLD}${GREEN}${name}${RESET}`)
		console.log(`  ${BOLD}Repositories:${RESET} ${repos?.join(", ")}`)
		console.log("")
	}
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
	const args = parseArgs()

	if (!args.subcommand || args.subcommand === "help" || args.subcommand === "--help" || args.subcommand === "-h") {
		console.log(`${BOLD}${GREEN}Worktree Sets CLI${RESET}`)
		console.log("")
		console.log(`${BOLD}USAGE:${RESET}`)
		console.log(`  worktree-sets <subcommand> [options]`)
		console.log("")
		console.log(`${BOLD}SUBCOMMANDS:${RESET}`)
		console.log(`  ${GREEN}create${RESET}       Create a new worktree set`)
		console.log(`  ${RED}remove${RESET}       Remove an existing worktree set`)
		console.log(`  ${CYAN}list${RESET}         List all worktree sets`)
		console.log(`  ${YELLOW}preset save${RESET}  Save a repository selection as a preset`)
		console.log(`  ${YELLOW}preset list${RESET}  List all saved presets`)
		console.log("")
		console.log(`${BOLD}CREATE OPTIONS:${RESET}`)
		console.log(`  -b, --branch <name>       Branch name (required for non-interactive)`)
		console.log(`  --repos <repos>           Comma-separated repo names (e.g., "repo1,repo2")`)
		console.log(`  --preset <name>           Use a saved preset`)
		console.log(`  --base <branch>           Base branch to create from (default: HEAD)`)
		console.log(`  -w, --workspace <path>    Workspace root (default: auto-detect)`)
		console.log(`  -y, --yes                 Skip confirmations`)
		console.log(`  --no-hooks                Skip postCreate hooks`)
		console.log("")
		console.log(`${BOLD}REMOVE OPTIONS:${RESET}`)
		console.log(`  -b, --branch <name>       Branch name (required for non-interactive)`)
		console.log(`  -w, --workspace <path>    Workspace root (default: auto-detect)`)
		console.log(`  -y, --yes                 Skip confirmations`)
		console.log("")
		console.log(`${BOLD}LIST OPTIONS:${RESET}`)
		console.log(`  -w, --workspace <path>    Workspace root (default: auto-detect)`)
		console.log("")
		console.log(`${BOLD}PRESET SAVE OPTIONS:${RESET}`)
		console.log(`  --name <name>             Preset name (required for non-interactive)`)
		console.log(`  --repos <repos>           Comma-separated repo names`)
		console.log(`  -w, --workspace <path>    Workspace root (default: auto-detect)`)
		console.log("")
		console.log(`${BOLD}PRESET LIST OPTIONS:${RESET}`)
		console.log(`  -w, --workspace <path>    Workspace root (default: auto-detect)`)
		console.log("")
		console.log(`${BOLD}EXAMPLES:${RESET}`)
		console.log(`  # Interactive create`)
		console.log(`  ${CYAN}worktree-sets create${RESET}`)
		console.log("")
		console.log(`  # Non-interactive create`)
		console.log(`  ${CYAN}worktree-sets create --branch feature/dark-mode --repos repo1,repo2 --yes${RESET}`)
		console.log("")
		console.log(`  # Create from preset`)
		console.log(`  ${CYAN}worktree-sets create --branch feature/ui --preset frontend --yes${RESET}`)
		console.log("")
		console.log(`  # Interactive remove`)
		console.log(`  ${CYAN}worktree-sets remove${RESET}`)
		console.log("")
		console.log(`  # Non-interactive remove`)
		console.log(`  ${CYAN}worktree-sets remove --branch feature/dark-mode --yes${RESET}`)
		console.log("")
		console.log(`  # List all sets`)
		console.log(`  ${CYAN}worktree-sets list${RESET}`)
		console.log("")
		console.log(`  # Save a preset`)
		console.log(`  ${CYAN}worktree-sets preset save --name frontend --repos web,mobile${RESET}`)
		console.log("")
		console.log(`  # List presets`)
		console.log(`  ${CYAN}worktree-sets preset list${RESET}`)
		console.log("")
		process.exit(0)
	}

	// Handle subcommands
	if (args.subcommand === "create") {
		await handleCreate(args)
	} else if (args.subcommand === "remove") {
		await handleRemove(args)
	} else if (args.subcommand === "list") {
		await handleList(args)
	} else if (args.subcommand === "preset") {
		// Check for second argument (save or list)
		const presetSubcommand = process.argv[3]
		if (presetSubcommand === "save") {
			await handlePresetSave(args)
		} else if (presetSubcommand === "list") {
			await handlePresetList(args)
		} else {
			console.error(`${RED}❌ Unknown preset subcommand: ${presetSubcommand}${RESET}`)
			console.error(`${YELLOW}Valid options: save, list${RESET}`)
			process.exit(1)
		}
	} else {
		console.error(`${RED}❌ Unknown subcommand: ${args.subcommand}${RESET}`)
		console.error(`${YELLOW}Valid subcommands: create, remove, list, preset${RESET}`)
		console.error(`${YELLOW}Run 'worktree-sets help' for usage information${RESET}`)
		process.exit(1)
	}
}

// Run main and handle errors
main().catch((error) => {
	console.error(`${RED}❌ Fatal error: ${error instanceof Error ? error.message : String(error)}${RESET}`)
	if (process.env.DEBUG && error instanceof Error && error.stack) {
		console.error(error.stack)
	}
	process.exit(1)
})
