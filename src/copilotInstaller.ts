import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Installs Copilot customization files (prompts, agents, instructions, skills)
 * to the correct locations so they work in any workspace.
 *
 * Discovery behaviour (from Copilot Chat source):
 *   Prompts:      user-level  <profile>/prompts/*.prompt.md         ✅ works globally
 *   Agents:       workspace   .github/agents/*.agent.md              ❌ workspace-only
 *   Instructions: user-level  <profile>/instructions/*.instructions.md ✅ works globally
 *   Skills:       workspace   .github/skills/<name>/SKILL.md         ❌ workspace-only
 *
 * Agents and skills ONLY work from the workspace's .github/ folder, so we also
 * copy them into the current workspace's .github/ if it doesn't already have them.
 */
export function installCopilotFiles(context: vscode.ExtensionContext): void {
	const profileDir = getUserProfileDir();
	const extensionGitHub = path.join(context.extensionPath, '.github');
	if (!fs.existsSync(extensionGitHub)) {
		console.warn('.github folder not found in extension — skipping Copilot file install');
		return;
	}

	let installed = 0;
	const isCursor = isCursorEditor();

	// ── User-level (work globally) ───────────────────────────────────────────

	if (!isCursor && profileDir) {
		// VS Code: Prompts → user profile
		installed += copyFiles(
			path.join(extensionGitHub, 'prompts'),
			path.join(profileDir, 'prompts'),
			'.prompt.md'
		);

		// VS Code: Instructions → user profile (only stride-format)
		installed += copyFiles(
			path.join(extensionGitHub, 'instructions'),
			path.join(profileDir, 'instructions'),
			'.instructions.md',
			['stride-format.instructions.md']
		);
	}

	if (isCursor) {
		// Cursor: Agents → ~/.cursor/agents/ (user-level, works globally)
		// Cursor requires plain .md files with `name` field in frontmatter
		installed += copyFiles(
			path.join(extensionGitHub, 'agents', 'cursor'),
			path.join(os.homedir(), '.cursor', 'agents'),
			'.md'
		);

		// Cursor: Skills → ~/.cursor/skills/ (user-level, works globally)
		installed += copySkillFolders(
			path.join(extensionGitHub, 'skills'),
			path.join(os.homedir(), '.cursor', 'skills')
		);
	}

	// ── Workspace-level ──────────────────────────────────────────────────────

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceRoot = workspaceFolders[0].uri.fsPath;

		if (!isCursor) {
			// VS Code: Agents + Skills → workspace .github/
			const workspaceGitHub = path.join(workspaceRoot, '.github');

			installed += copyFiles(
				path.join(extensionGitHub, 'agents'),
				path.join(workspaceGitHub, 'agents'),
				'.agent.md'
			);

			installed += copySkillFolders(
				path.join(extensionGitHub, 'skills'),
				path.join(workspaceGitHub, 'skills')
			);
		} else {
			// Cursor: Also copy to workspace .cursor/ for project-level
			const workspaceCursor = path.join(workspaceRoot, '.cursor');

			installed += copyFiles(
				path.join(extensionGitHub, 'agents', 'cursor'),
				path.join(workspaceCursor, 'agents'),
				'.md'
			);

			installed += copySkillFolders(
				path.join(extensionGitHub, 'skills'),
				path.join(workspaceCursor, 'skills')
			);
		}
	}

	if (installed > 0) {
		console.log(`📄 Installed ${installed} Copilot customization file(s) (${isCursor ? 'Cursor' : 'VS Code'})`);

		// Add auto-generated files to .gitignore
		if (workspaceFolders && workspaceFolders.length > 0) {
			const gitignoreEntries = isCursor
				? ['.cursor/agents/threat-modeler.md', '.cursor/skills/full-threat-pipeline/']
				: ['.github/agents/threat-modeler.agent.md', '.github/skills/full-threat-pipeline/'];
			addToGitignore(workspaceFolders[0].uri.fsPath, gitignoreEntries);
		}
	}
}

/**
 * Removes previously installed Copilot files from the user profile.
 * Called on extension deactivation or uninstall.
 */
export function uninstallCopilotFiles(context: vscode.ExtensionContext): void {
	const profileDir = getUserProfileDir();
	const extensionGitHub = path.join(context.extensionPath, '.github');
	if (!fs.existsSync(extensionGitHub)) { return; }

	const isCursor = isCursorEditor();

	// Remove user-level files
	if (!isCursor && profileDir) {
		removeFiles(path.join(extensionGitHub, 'prompts'), path.join(profileDir, 'prompts'), '.prompt.md');
		removeFiles(path.join(extensionGitHub, 'instructions'), path.join(profileDir, 'instructions'), '.instructions.md', ['stride-format.instructions.md']);
	}

	if (isCursor) {
		removeFiles(path.join(extensionGitHub, 'agents', 'cursor'), path.join(os.homedir(), '.cursor', 'agents'), '.md');
		removeSkillFolders(path.join(extensionGitHub, 'skills'), path.join(os.homedir(), '.cursor', 'skills'));
	}

	// Remove workspace-level files
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceRoot = workspaceFolders[0].uri.fsPath;

		if (!isCursor) {
			const workspaceGitHub = path.join(workspaceRoot, '.github');
			removeFiles(path.join(extensionGitHub, 'agents'), path.join(workspaceGitHub, 'agents'), '.agent.md');
			removeSkillFolders(path.join(extensionGitHub, 'skills'), path.join(workspaceGitHub, 'skills'));
		} else {
			const workspaceCursor = path.join(workspaceRoot, '.cursor');
			removeFiles(path.join(extensionGitHub, 'agents', 'cursor'), path.join(workspaceCursor, 'agents'), '.md');
			removeSkillFolders(path.join(extensionGitHub, 'skills'), path.join(workspaceCursor, 'skills'));
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isCursorEditor(): boolean {
	// Cursor sets appName to "Cursor" vs VS Code's "Visual Studio Code"
	return vscode.env.appName.toLowerCase().includes('cursor');
}

function getUserProfileDir(): string | null {
	// VS Code stores user profile in:
	//   Windows: %APPDATA%/Code/User
	//   macOS:   ~/Library/Application Support/Code/User
	//   Linux:   ~/.config/Code/User
	const platform = os.platform();
	if (platform === 'win32') {
		const appData = process.env.APPDATA;
		if (appData) { return path.join(appData, 'Code', 'User'); }
	} else if (platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
	} else {
		return path.join(os.homedir(), '.config', 'Code', 'User');
	}
	return null;
}

function copyFiles(
	srcDir: string,
	destDir: string,
	extension: string,
	whitelist?: string[]
): number {
	if (!fs.existsSync(srcDir)) { return 0; }

	const files = fs.readdirSync(srcDir).filter(f => f.endsWith(extension));
	const filtered = whitelist ? files.filter(f => whitelist.includes(f)) : files;
	let count = 0;

	for (const file of filtered) {
		const dest = path.join(destDir, file);
		if (!fs.existsSync(dest)) {
			fs.mkdirSync(destDir, { recursive: true });
			fs.copyFileSync(path.join(srcDir, file), dest);
			count++;
		}
	}
	return count;
}

function removeFiles(
	srcDir: string,
	destDir: string,
	extension: string,
	whitelist?: string[]
): void {
	if (!fs.existsSync(srcDir) || !fs.existsSync(destDir)) { return; }

	const files = fs.readdirSync(srcDir).filter(f => f.endsWith(extension));
	const filtered = whitelist ? files.filter(f => whitelist.includes(f)) : files;

	for (const file of filtered) {
		const dest = path.join(destDir, file);
		if (fs.existsSync(dest)) {
			fs.unlinkSync(dest);
		}
	}
}

function addToGitignore(workspaceRoot: string, entries: string[]): void {
	const gitignorePath = path.join(workspaceRoot, '.gitignore');
	const marker = '# Auto-generated by AI Threat Modeling extension (do not commit)';

	let content = '';
	if (fs.existsSync(gitignorePath)) {
		content = fs.readFileSync(gitignorePath, 'utf-8');
	}

	// Only add entries that aren't already present
	const newEntries = entries.filter(e => !content.includes(e));
	if (newEntries.length === 0) { return; }

	const block = `\n${marker}\n${newEntries.join('\n')}\n`;
	fs.writeFileSync(gitignorePath, content.trimEnd() + block, 'utf-8');
}

function copySkillFolders(srcDir: string, destDir: string): number {
	if (!fs.existsSync(srcDir)) { return 0; }
	let count = 0;
	const skillDirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter(d => d.isDirectory());
	for (const dir of skillDirs) {
		const srcSkill = path.join(srcDir, dir.name, 'SKILL.md');
		const destSkillDir = path.join(destDir, dir.name);
		const destSkill = path.join(destSkillDir, 'SKILL.md');
		if (fs.existsSync(srcSkill) && !fs.existsSync(destSkill)) {
			fs.mkdirSync(destSkillDir, { recursive: true });
			fs.copyFileSync(srcSkill, destSkill);
			count++;
		}
	}
	return count;
}

function removeSkillFolders(srcDir: string, destDir: string): void {
	if (!fs.existsSync(srcDir) || !fs.existsSync(destDir)) { return; }
	const skillDirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter(d => d.isDirectory());
	for (const dir of skillDirs) {
		const destSkillDir = path.join(destDir, dir.name);
		if (fs.existsSync(destSkillDir)) {
			fs.rmSync(destSkillDir, { recursive: true, force: true });
		}
	}
}
