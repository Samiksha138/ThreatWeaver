import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export class MCPManager {
	private confluenceOutputChannel: vscode.OutputChannel;
	private repositoryOutputChannel: vscode.OutputChannel;
	private isConfluenceRunning: boolean = false;
	private isJiraRunning: boolean = false;

	constructor() {
		this.confluenceOutputChannel = vscode.window.createOutputChannel('MCP Confluence Server');
		this.repositoryOutputChannel = vscode.window.createOutputChannel('MCP Repository Analysis');
	}

	/**
	 * Set or update Confluence authorization token
	 */
	public async setConfluenceToken(context: vscode.ExtensionContext): Promise<void> {
		const token = await vscode.window.showInputBox({
			prompt: 'Enter your Confluence Authorization Token (format: ODMyOTgwOTU5NDY4...)',
			password: true,
			ignoreFocusOut: true,
			placeHolder: 'Token value without "Token " prefix'
		});

		if (token) {
			await context.secrets.store('confluence.token', token);
			vscode.window.showInformationMessage('✅ Confluence token saved securely');
		}
	}

	/**
	 * Set or update Jira on-prem token
	 */
	public async setJiraToken(context: vscode.ExtensionContext): Promise<void> {
		const existingUrl = await context.secrets.get('jira.baseUrl');
		const baseUrl = await vscode.window.showInputBox({
			title: 'Jira Base URL (Step 1/2)',
			prompt: 'Enter your on-prem Jira base URL (e.g. https://jira.your-company.com)',
			value: existingUrl ?? '',
			placeHolder: 'https://jira.your-company.com',
			ignoreFocusOut: true,
			validateInput: v => v.trim() ? null : 'Jira base URL is required'
		});
		if (!baseUrl) { return; }

		const token = await vscode.window.showInputBox({
			title: 'Jira Personal Access Token (Step 2/2)',
			prompt: 'Enter your Jira Personal Access Token (on-prem)',
			password: true,
			ignoreFocusOut: true,
			placeHolder: 'Jira PAT value'
		});
		if (!token) { return; }

		await context.secrets.store('jira.baseUrl', baseUrl.trim().replace(/\/$/, ''));
		await context.secrets.store('jira.token', token.trim());
		vscode.window.showInformationMessage('✅ Jira credentials saved securely');
	}

	/**
	 * Set or update GitHub Personal Access Token
	 */
	public async setGitHubToken(context: vscode.ExtensionContext): Promise<void> {
		const token = await vscode.window.showInputBox({
			prompt: 'Enter your GitHub Personal Access Token (format: ghp_...)',
			password: true,
			ignoreFocusOut: true,
			placeHolder: 'Token value starting with ghp_',
			validateInput: (value) => {
				return value.trim() ? null : 'GitHub token cannot be empty';
			}
		});

		if (!token || !token.trim()) {
			vscode.window.showWarningMessage('GitHub token is required for GitHub repository analysis');
			return;
		}

		await context.secrets.store('github.token', token.trim());
		vscode.window.showInformationMessage('✅ GitHub token saved securely');
	}

	/**
	 * Update mcp.json file with current credentials
	 */
	private async updateMCPJsonFile(context: vscode.ExtensionContext): Promise<boolean> {
		try {
			const platform = os.platform();
			let mcpConfigPath: string;

			// Check for user-defined custom path first
			const customPath = vscode.workspace.getConfiguration('aiThreatModeling').get<string>('mcpConfigPath', '').trim();
			if (customPath) {
				mcpConfigPath = customPath;
				this.confluenceOutputChannel.appendLine(`ℹ️  Using custom MCP config path from settings: ${mcpConfigPath}`);
			} else {
				// Detect IDE (VS Code or Cursor) and use appropriate path
				const isCursorIDE = vscode.env.appName.toLowerCase().includes('cursor');

				if (isCursorIDE) {
					mcpConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
				} else if (platform === 'win32') {
					mcpConfigPath = path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json');
				} else if (platform === 'darwin') {
					mcpConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
				} else {
					mcpConfigPath = path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
				}
			}

			// Detect IDE (VS Code or Cursor) — still needed for format decision
			const isCursor = vscode.env.appName.toLowerCase().includes('cursor');

			// Log which IDE and path is being used
			this.confluenceOutputChannel.appendLine(`ℹ️  Detected IDE: ${vscode.env.appName} (${isCursor ? 'Cursor' : 'VS Code'})`);
			this.confluenceOutputChannel.appendLine(`ℹ️  MCP config path: ${mcpConfigPath}${customPath ? ' (custom)' : ' (default)'}`);

			// Get stored credentials
			const githubToken = await context.secrets.get('github.token');
			const jiraToken = await context.secrets.get('jira.token');
			const jiraBaseUrl = await context.secrets.get('jira.baseUrl');

			// Determine command based on platform and IDE for better compatibility
			let atlassianCommand: string;
			let atlassianArgs: string[];
			
			if (isCursor && platform === 'win32') {
				// Cursor on Windows: Use wsl to run npx (Cursor requires WSL for stdio MCP)
				atlassianCommand = 'wsl';
				atlassianArgs = ['npx', '-y', 'mcp-remote@latest', 'https://mcp.atlassian.com/v1/mcp'];
			} else if (platform === 'win32') {
				// VS Code on Windows: Use npx directly
				atlassianCommand = 'npx';
				atlassianArgs = ['-y', 'mcp-remote@latest', 'https://mcp.atlassian.com/v1/mcp'];
			} else {
				// macOS/Linux: Use shell to access PATH
				atlassianCommand = '/bin/sh';
				atlassianArgs = ['-c', 'npx -y mcp-remote@latest https://mcp.atlassian.com/v1/mcp'];
			}

			// Create mcp.json content with Atlassian cloud and HTTP-based servers
			const servers: any = {
				"atlassian": {
					type: 'stdio',
					command: atlassianCommand,
					args: atlassianArgs
				}
			};

			// Add GitHub server if token is provided
			if (githubToken) {
				servers["mcp_github"] = {
					url: 'https://api.githubcopilot.com/mcp/',
					type: 'http',
					headers: {
						'Authorization': `Bearer ${githubToken}`
					}
				};
			}

			// Add Jira on-prem server if token + base URL are provided
			if (jiraToken && jiraBaseUrl) {
				// Use community mcp-atlassian package (supports Jira Server/Data Center)
				const jiraArgs = isCursor && platform === 'win32'
					? ['npx', '-y', '@aashari/mcp-server-atlassian-jira']
					: ['-y', '@aashari/mcp-server-atlassian-jira'];
				servers["jira_oss"] = {
					type: 'stdio',
					command: isCursor && platform === 'win32' ? 'wsl' : (platform === 'win32' ? 'npx' : '/bin/sh'),
					args: platform !== 'win32' ? ['-c', `ATLASSIAN_SITE_URL=${jiraBaseUrl} ATLASSIAN_API_TOKEN=${jiraToken} npx -y @aashari/mcp-server-atlassian-jira`] : jiraArgs,
					env: platform === 'win32' ? {
						ATLASSIAN_SITE_URL: jiraBaseUrl,
						ATLASSIAN_API_TOKEN: jiraToken
					} : {}
				};
			}

			// mcpConfig building is deferred — we merge into the existing file below

			// Log configuration summary
			this.confluenceOutputChannel.appendLine('');
			this.confluenceOutputChannel.appendLine('🛠️  MCP Configuration Summary:');
			this.confluenceOutputChannel.appendLine(`   - Platform: ${platform}`);
			this.confluenceOutputChannel.appendLine(`   - Format: ${isCursor ? 'Cursor IDE (mcpServers)' : 'VS Code (servers)'}`);
			this.confluenceOutputChannel.appendLine(`   - Atlassian Command: ${atlassianCommand} ${atlassianArgs.join(' ')}`);
			this.confluenceOutputChannel.appendLine(`   - Atlassian Cloud MCP: ✅ Enabled`);
			this.confluenceOutputChannel.appendLine(`   - GitHub MCP: ${githubToken ? '✅ Enabled' : '❌ Not configured'}`);
			this.confluenceOutputChannel.appendLine(`   - Jira on-prem MCP: ${jiraToken && jiraBaseUrl ? '✅ Enabled' : '❌ Not configured'}`);
			this.confluenceOutputChannel.appendLine('');
			
			if (platform !== 'win32') {
				this.confluenceOutputChannel.appendLine('ℹ️  macOS/Linux: Using shell wrapper for better PATH access');
				this.confluenceOutputChannel.appendLine('ℹ️  If npx errors occur, ensure Node.js is installed: https://nodejs.org');
				this.confluenceOutputChannel.appendLine('');
			}

			// Ensure directory exists
			const mcpDir = path.dirname(mcpConfigPath);
			if (!fs.existsSync(mcpDir)) {
				fs.mkdirSync(mcpDir, { recursive: true });
				this.confluenceOutputChannel.appendLine(`📁 Created directory: ${mcpDir}`);
			}

			// Read existing mcp.json and merge — only overwrite the extension's own server keys,
			// preserving any other MCP servers configured by other extensions or the user.
			let existingConfig: any = {};
			if (fs.existsSync(mcpConfigPath)) {
				try {
					existingConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
					this.confluenceOutputChannel.appendLine(`📖 Read existing mcp.json (keys: ${Object.keys(existingConfig).join(', ')})`);
				} catch (parseErr) {
					this.confluenceOutputChannel.appendLine(`⚠️  Could not parse existing mcp.json, will overwrite: ${parseErr}`);
				}
			}

			if (isCursor) {
				existingConfig.mcpServers = { ...(existingConfig.mcpServers || {}), ...servers };
			} else {
				existingConfig.inputs = existingConfig.inputs || [];
				existingConfig.servers = { ...(existingConfig.servers || {}), ...servers };
			}

			fs.writeFileSync(mcpConfigPath, JSON.stringify(existingConfig, null, '\t'));
			this.confluenceOutputChannel.appendLine(`✅ Updated mcp.json at: ${mcpConfigPath}`);
			this.confluenceOutputChannel.appendLine(`📄 Content: ${JSON.stringify(existingConfig, null, 2).substring(0, 200)}...`);
			return true;
		} catch (error) {
			this.confluenceOutputChannel.appendLine(`❌ Failed to update mcp.json: ${error}`);
			return false;
		}
	}

	/**
	 * Start all MCP servers - updates mcp.json first, then starts servers
	 */
	public async startAllMCPServers(context: vscode.ExtensionContext): Promise<boolean> {
		// Update mcp.json with current credentials
		this.confluenceOutputChannel.appendLine('📝 Updating mcp.json configuration...');
		const updated = await this.updateMCPJsonFile(context);
		if (!updated) {
			vscode.window.showErrorMessage('Failed to update mcp.json. Please check credentials.');
			return false;
		}

		let allStarted = true;

		// Start Confluence server
		const confluenceStarted = await this.startConfluenceServer(context);
		allStarted = allStarted && confluenceStarted;

		// Start GitHub server only if token is configured
		const githubToken = await context.secrets.get('github.token');
		if (githubToken) {
			this.startGitHubServer();
		} else {
			this.repositoryOutputChannel.appendLine('ℹ️ GitHub token not configured. Skipping GitHub MCP server.');
		}

		// Start Jira on-prem server if credentials are configured
		const jiraToken = await context.secrets.get('jira.token');
		const jiraBaseUrl = await context.secrets.get('jira.baseUrl');
		if (jiraToken && jiraBaseUrl) {
			this.startJiraServer();
		} else {
			this.repositoryOutputChannel.appendLine('ℹ️ Jira token not configured. Skipping Jira MCP server.');
		}

		if (allStarted) {
			vscode.window.showInformationMessage('✅ MCP servers started and mcp.json updated!');
		}

		return allStarted;
	}

	/**
	 * Start Atlassian MCP server (Atlassian cloud configuration)
	 */
	private async startConfluenceServer(context: vscode.ExtensionContext): Promise<boolean> {
		if (this.isConfluenceRunning) {
			this.confluenceOutputChannel.appendLine('✅ Atlassian MCP Server is already configured');
			return true;
		}

		try {
			this.confluenceOutputChannel.show(true);
			this.confluenceOutputChannel.appendLine('═══════════════════════════════════════════');
			this.confluenceOutputChannel.appendLine('🚀 Atlassian MCP Server Configuration');
			this.confluenceOutputChannel.appendLine('═══════════════════════════════════════════');
			this.confluenceOutputChannel.appendLine('');
			this.confluenceOutputChannel.appendLine('📡 Atlassian Cloud MCP Server:');
			this.confluenceOutputChannel.appendLine('   Type: stdio');
			this.confluenceOutputChannel.appendLine('   Command: npx -y mcp-remote@latest https://mcp.atlassian.com/v1/mcp');
			this.confluenceOutputChannel.appendLine('   ℹ️  Provides access to: Confluence, Jira, and other Atlassian services');
			this.confluenceOutputChannel.appendLine('   ℹ️  Authentication: Atlassian will prompt for OAuth when first used');
			this.confluenceOutputChannel.appendLine('');
			this.confluenceOutputChannel.appendLine('✅ Atlassian MCP Server configured');

			this.isConfluenceRunning = true;
			vscode.window.showInformationMessage('✅ Atlassian MCP Server configured');

			return true;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.confluenceOutputChannel.appendLine(`❌ Failed to configure server: ${errorMessage}`);
			vscode.window.showErrorMessage(`Failed to configure Atlassian MCP: ${errorMessage}`);
			return false;
		}
	}

	/**
	 * Start GitHub MCP server (HTTP-based configuration)
	 */
	private startGitHubServer(): void {
		this.repositoryOutputChannel.show(true);
		this.repositoryOutputChannel.appendLine('═══════════════════════════════════════════');
		this.repositoryOutputChannel.appendLine('🚀 MCP GitHub Server Configuration');
		this.repositoryOutputChannel.appendLine('═══════════════════════════════════════════');
		this.repositoryOutputChannel.appendLine('Type: http');
		this.repositoryOutputChannel.appendLine('URL: https://api.githubcopilot.com/mcp/');
		this.repositoryOutputChannel.appendLine('Headers: Authorization');
		this.repositoryOutputChannel.appendLine('✅ GitHub MCP Server is configured (HTTP-based)');
	}

	/**
	 * Start Jira on-prem MCP server (stdio via community package)
	 */
	private startJiraServer(): void {
		this.repositoryOutputChannel.show(true);
		this.repositoryOutputChannel.appendLine('═══════════════════════════════════════════');
		this.repositoryOutputChannel.appendLine('🚀 MCP Jira On-Prem Server Configuration');
		this.repositoryOutputChannel.appendLine('═══════════════════════════════════════════');
		this.repositoryOutputChannel.appendLine('Type: stdio');
		this.repositoryOutputChannel.appendLine('Package: @aashari/mcp-server-atlassian-jira');
		this.repositoryOutputChannel.appendLine('✅ Jira on-prem MCP Server configured (stdio)');

		this.isJiraRunning = true;
		vscode.window.showInformationMessage('✅ Jira on-prem MCP Server configured');
	}

	/**
	 * Stop Confluence MCP server
	 */
	public async stopConfluenceServer(): Promise<void> {
		if (this.isConfluenceRunning) {
			this.confluenceOutputChannel.appendLine('⏹️ Stopping MCP Servers...');
			this.isConfluenceRunning = false;
			this.isJiraRunning = false;
			this.confluenceOutputChannel.appendLine('✅ MCP Servers stopped');
		}
	}

	/**
	 * Check if servers are running
	 */
	public isServerRunning(): boolean {
		return this.isConfluenceRunning;
	}

	public isConfluenceActive(): boolean {
		return this.isConfluenceRunning;
	}

	public isJiraActive(): boolean {
		return this.isJiraRunning;
	}

	/**
	 * Detect repository type from URL
	 */
	private detectRepositoryType(repositoryUrl: string): 'bitbucket' | 'git' | 'unknown' {
		if (repositoryUrl.includes('bitbucket')) {
			return 'bitbucket';
		} else if (repositoryUrl.includes('github.com') || repositoryUrl.includes('gitlab') || repositoryUrl.match(/\.git$/)) {
			return 'git';
		}
		return 'unknown';
	}

	/**
	 * Fetch Confluence page
	 */
	public async fetchConfluencePage(confluenceUrl: string): Promise<string | null> {
		if (!this.isConfluenceRunning) {
			this.confluenceOutputChannel.appendLine('⚠️ Confluence MCP Server is not running');
			return null;
		}

		try {
			this.confluenceOutputChannel.appendLine(`📄 Fetching Confluence page: ${confluenceUrl}`);
			return `Use the MCP Confluence tool to fetch page URL: ${confluenceUrl}`;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.confluenceOutputChannel.appendLine(`❌ Failed to fetch page: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch repository (supports both Bitbucket and generic Git)
	 */
	public async fetchBitbucketRepo(repositoryUrl: string): Promise<string | null> {
		const repoType = this.detectRepositoryType(repositoryUrl);

		if (repoType === 'bitbucket') {
			return this.fetchBitbucketRepository(repositoryUrl);
		} else if (repoType === 'git') {
			return this.fetchGitRepository(repositoryUrl);
		} else {
			this.repositoryOutputChannel.appendLine(`⚠️ Unknown repository type: ${repositoryUrl}`);
			vscode.window.showWarningMessage('Unknown repository type. Please provide a Bitbucket or Git repository URL.');
			return null;
		}
	}

	/**
	 * Main entry point for repository analysis - routes based on scope
	 */
	public async fetchRepositoryWithScope(
		repositoryUrl: string,
		scope: 'full' | 'pr' | 'subdirectory',
		scopeData: {
			prUrl?: string;
			subdirectoryPaths?: string[];
		}
	): Promise<string | null> {
		const repoType = this.detectRepositoryType(repositoryUrl);

		// Route based on scope
		switch (scope) {
			case 'pr':
				if (!scopeData.prUrl) {
					this.repositoryOutputChannel.appendLine('❌ PR URL is required for PR scope');
					return null;
				}
				// Detect if it's Bitbucket or GitHub PR
				if (scopeData.prUrl.includes('bitbucket')) {
					return this.fetchBitbucketPullRequest(scopeData.prUrl);
				} else if (scopeData.prUrl.includes('github')) {
					return this.fetchGitHubPullRequest(scopeData.prUrl);
				} else {
					this.repositoryOutputChannel.appendLine('❌ Unknown PR URL type');
					return null;
				}

			case 'subdirectory':
				if (!scopeData.subdirectoryPaths || scopeData.subdirectoryPaths.length === 0) {
					this.repositoryOutputChannel.appendLine('❌ Subdirectory paths are required for subdirectory scope');
					return null;
				}
				if (repoType === 'bitbucket') {
					return this.fetchBitbucketSubdirectory(repositoryUrl, scopeData.subdirectoryPaths);
				} else if (repoType === 'git') {
					return this.fetchGitHubSubdirectory(repositoryUrl, scopeData.subdirectoryPaths);
				}
				break;

			case 'full':
			default:
				// Full repository analysis
				if (repoType === 'bitbucket') {
					return this.fetchBitbucketRepository(repositoryUrl);
				} else if (repoType === 'git') {
					return this.fetchGitRepository(repositoryUrl);
				}
				break;
		}

		this.repositoryOutputChannel.appendLine(`⚠️ Unknown repository type: ${repositoryUrl}`);
		return null;
	}

	/**
	 * Fetch Bitbucket repository using MCP
	 */
	private async fetchBitbucketRepository(repositoryUrl: string): Promise<string | null> {
		if (!this.isConfluenceRunning) {
			this.repositoryOutputChannel.appendLine('⚠️ Atlassian MCP Server is not configured');
			return null;
		}

		try {
			this.repositoryOutputChannel.appendLine(`📦 Fetching Bitbucket repository: ${repositoryUrl}`);
			
			// Extract project and repo name from URL
			const urlMatch = repositoryUrl.match(/projects\/([^/]+)\/repos\/([^/]+)/);
			if (!urlMatch) {
				this.repositoryOutputChannel.appendLine(`❌ Invalid Bitbucket URL format: ${repositoryUrl}`);
				return null;
			}

			const project = urlMatch[1];
			const repo = urlMatch[2];
			
			this.repositoryOutputChannel.appendLine(`Project: ${project}`);
			this.repositoryOutputChannel.appendLine(`Repository: ${repo}`);
			
			return `Analyze the Bitbucket repository:
Project: ${project}
Repository: ${repo}
Repository URL: ${repositoryUrl}

Use Atlassian MCP tools to fetch Bitbucket Cloud repository data. For on-prem Bitbucket, use the Bitbucket REST API directly.`;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to fetch Bitbucket repository: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch generic Git repository
	 */
	private async fetchGitRepository(repositoryUrl: string): Promise<string | null> {
		try {
			this.repositoryOutputChannel.appendLine(`📦 Analyzing Git repository: ${repositoryUrl}`);
			
			// Extract repository name from URL
			let repoName = repositoryUrl;
			const githubMatch = repositoryUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
			const gitlabMatch = repositoryUrl.match(/gitlab\.[^/]+\/([^/]+)\/([^/]+?)(\.git)?$/);
			
			if (githubMatch) {
				repoName = `${githubMatch[1]}/${githubMatch[2]}`;
				this.repositoryOutputChannel.appendLine(`GitHub Repository: ${repoName}`);
				const owner = githubMatch[1];
				const repo = githubMatch[2];
				
				return `Use the MCP GitHub tool to analyze the repository:
Owner: ${owner}
Repository: ${repo}

First, use mcp_mcp_github_get_file_contents to explore the repository structure.
Then use mcp_mcp_github_search_code to find security-relevant code patterns.
Use mcp_mcp_github_list_commits if needed to understand recent changes.
Analyze the repository structure and code to identify security-relevant components.

Repository URL: ${repositoryUrl}
Repository Name: ${repoName}`;
			} else if (gitlabMatch) {
				repoName = `${gitlabMatch[1]}/${gitlabMatch[2]}`;
				this.repositoryOutputChannel.appendLine(`GitLab Repository: ${repoName}`);
			} else {
				this.repositoryOutputChannel.appendLine(`Generic Git Repository: ${repositoryUrl}`);
			}
			
			return `Analyze the Git repository at: ${repositoryUrl}

Repository URL: ${repositoryUrl}
Repository Name: ${repoName}`;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to analyze Git repository: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch Bitbucket Pull Request using MCP
	 */
	private async fetchBitbucketPullRequest(prUrl: string): Promise<string | null> {
		if (!this.isConfluenceRunning) {
			this.repositoryOutputChannel.appendLine('⚠️ Atlassian MCP Server is not configured');
			return null;
		}

		try {
			this.repositoryOutputChannel.appendLine(`🔍 Analyzing Bitbucket Pull Request: ${prUrl}`);
			
			// Extract PR details from URL: /projects/PROJ/repos/REPO/pull-requests/123
			const prMatch = prUrl.match(/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/);
			if (!prMatch) {
				this.repositoryOutputChannel.appendLine(`❌ Invalid Bitbucket PR URL format: ${prUrl}`);
				return null;
			}

			const project = prMatch[1];
			const repo = prMatch[2];
			const prId = prMatch[3];
			
			this.repositoryOutputChannel.appendLine(`Project: ${project}, Repository: ${repo}, PR #${prId}`);
			
			return `Use the MCP Bitbucket tool to analyze ONLY this specific pull request:
Project: ${project}
Repository: ${repo}
Pull Request ID: ${prId}

Use Atlassian MCP tools to get PR details, diff, and comments for Bitbucket Cloud.
For on-prem Bitbucket, use the Bitbucket REST API: GET /rest/api/1.0/projects/{project}/repos/{repo}/pull-requests/{id}/diff

DO NOT list all PRs. Focus ONLY on PR #${prId}.
Analyze the changed files for security threats introduced by this pull request.`;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to fetch Bitbucket PR: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch GitHub Pull Request using MCP
	 */
	private async fetchGitHubPullRequest(prUrl: string): Promise<string | null> {
		try {
			this.repositoryOutputChannel.appendLine(`🔍 Analyzing GitHub Pull Request: ${prUrl}`);
			
			// Extract PR details: github.com/owner/repo/pull/123
			const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
			if (!prMatch) {
				this.repositoryOutputChannel.appendLine(`❌ Invalid GitHub PR URL format: ${prUrl}`);
				return null;
			}

			const owner = prMatch[1];
			const repo = prMatch[2];
			const prNumber = prMatch[3];
			
			this.repositoryOutputChannel.appendLine(`Owner: ${owner}, Repository: ${repo}, PR #${prNumber}`);
			
			return `Use the MCP GitHub tool to analyze ONLY this specific pull request:
Owner: ${owner}
Repository: ${repo}
Pull Request Number: ${prNumber}

Use mcp_mcp_github_pull_request_read to get PR details and changed files.
DO NOT list all PRs. Focus ONLY on PR #${prNumber}.
Analyze the changed files for security threats introduced by this pull request.`;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to fetch GitHub PR: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch Bitbucket Diff Scan (branch comparison)
	 */
	private async fetchBitbucketDiff(repositoryUrl: string, baseBranch: string, compareBranch: string): Promise<string | null> {
		if (!this.isConfluenceRunning) {
			this.repositoryOutputChannel.appendLine('⚠️ Atlassian MCP Server is not configured');
			return null;
		}

		try {
			this.repositoryOutputChannel.appendLine(`📊 Diff Scan: ${compareBranch} vs ${baseBranch}`);
			
			const urlMatch = repositoryUrl.match(/projects\/([^/]+)\/repos\/([^/]+)/);
			if (!urlMatch) {
				this.repositoryOutputChannel.appendLine(`❌ Invalid Bitbucket URL format: ${repositoryUrl}`);
				return null;
			}

			const project = urlMatch[1];
			const repo = urlMatch[2];
			
			return `Use the MCP Bitbucket tool to compare branches:
Project: ${project}
Repository: ${repo}
Base Branch: ${baseBranch}
Compare Branch: ${compareBranch}

Use mcp_mcp_bitbucket_listing_all_repositories to verify the repository exists.
Use Bitbucket diff/compare tools to identify files changed between ${baseBranch} and ${compareBranch}.
Analyze ONLY the changed files for security threats.`;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to fetch diff: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch GitHub Diff Scan (branch comparison)
	 */
	private async fetchGitHubDiff(repositoryUrl: string, baseBranch: string, compareBranch: string): Promise<string | null> {
		try {
			this.repositoryOutputChannel.appendLine(`📊 Diff Scan: ${compareBranch} vs ${baseBranch}`);
			
			const githubMatch = repositoryUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
			if (!githubMatch) {
				this.repositoryOutputChannel.appendLine(`❌ Invalid GitHub URL format: ${repositoryUrl}`);
				return null;
			}

			const owner = githubMatch[1];
			const repo = githubMatch[2];
			
			return `Use the MCP GitHub tool to compare branches:
Owner: ${owner}
Repository: ${repo}
Base Branch: ${baseBranch}
Compare Branch: ${compareBranch}

Use mcp_mcp_github_list_commits with base=${baseBranch} and head=${compareBranch} to see commits.
Analyze ONLY the files changed between these branches for security threats.`;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to fetch GitHub diff: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch Bitbucket Subdirectory Scan
	 */
	private async fetchBitbucketSubdirectory(repositoryUrl: string, subdirectoryPaths: string[]): Promise<string | null> {
		if (!this.isConfluenceRunning) {
			this.repositoryOutputChannel.appendLine('⚠️ Atlassian MCP Server is not configured');
			return null;
		}

		try {
			this.repositoryOutputChannel.appendLine(`📁 Subdirectory Scan: ${subdirectoryPaths.join(', ')}`);
			
			const urlMatch = repositoryUrl.match(/projects\/([^/]+)\/repos\/([^/]+)/);
			if (!urlMatch) {
				this.repositoryOutputChannel.appendLine(`❌ Invalid Bitbucket URL format: ${repositoryUrl}`);
				return null;
			}

			const project = urlMatch[1];
			const repo = urlMatch[2];
			const pathList = subdirectoryPaths.map(p => `  - ${p}`).join('\n');
			
			return `Analyze ONLY these specific subdirectories in the Bitbucket repository:
Project: ${project}
Repository: ${repo}
Subdirectory Paths:
${pathList}

Use Bitbucket MCP tools to fetch PR diffs filtered to these paths. Refer to Phase 1 of the full-threat-pipeline skill for the detailed fetch strategy. Focus analysis ONLY on files within the specified subdirectories.`;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to fetch subdirectory: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Fetch GitHub Subdirectory Scan
	 */
	private async fetchGitHubSubdirectory(repositoryUrl: string, subdirectoryPaths: string[]): Promise<string | null> {
		try {
			this.repositoryOutputChannel.appendLine(`📁 Subdirectory Scan: ${subdirectoryPaths.join(', ')}`);
			
			const githubMatch = repositoryUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
			if (!githubMatch) {
				this.repositoryOutputChannel.appendLine(`❌ Invalid GitHub URL format: ${repositoryUrl}`);
				return null;
			}

			const owner = githubMatch[1];
			const repo = githubMatch[2];
			const pathList = subdirectoryPaths.map(p => `  - ${p}`).join('\n');
			
			return `Use the MCP GitHub tool to analyze ONLY these specific subdirectories:
Owner: ${owner}
Repository: ${repo}
Subdirectory Paths:
${pathList}

Use mcp_mcp_github_get_file_contents with path parameter to fetch files.
Use mcp_mcp_github_search_code with path filter for: ${subdirectoryPaths.join(', ')}
DO NOT analyze the entire repository. Focus only on the specified paths.`;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			this.repositoryOutputChannel.appendLine(`❌ Failed to fetch GitHub subdirectory: ${errorMessage}`);
			return null;
		}
	}

	/**
	 * Dispose and cleanup
	 */
	public dispose(): void {
		this.stopConfluenceServer();
		this.confluenceOutputChannel.dispose();
		this.repositoryOutputChannel.dispose();
	}
}
