import * as vscode from 'vscode';
import * as path from 'path';
import { DashboardPanel } from './dashboardPanel';
import { MCPManager } from './mcpManager';
import { ThreatModelingSidebarProvider } from './sidebarProvider';
import { PRWatcher } from './prWatcher';
import { ConfluenceWatcher } from './confluenceWatcher';
import { ProductManager } from './productManager';
import { installCopilotFiles } from './copilotInstaller';
import { checkForUpdates } from './autoUpdater';

let mcpManager: MCPManager;
let prWatcher: PRWatcher;
let confluenceWatcher: ConfluenceWatcher;

export async function activate(context: vscode.ExtensionContext) {
	console.log('🛡️ Extension activating...');

	// Install Copilot customization files (prompts, agents, skills) to user profile
	installCopilotFiles(context);

	// Check for extension updates from GitHub Releases (non-blocking)
	checkForUpdates(context).catch(() => { /* silent */ });

	// Helper to safely register commands (prevents crash if two instances run simultaneously)
	function safeRegisterCommand(id: string, handler: (...args: any[]) => any) {
		try {
			const cmd = vscode.commands.registerCommand(id, handler);
			context.subscriptions.push(cmd);
		} catch {
			console.warn(`Command '${id}' already registered – skipping.`);
		}
	}
	
	// Initialize MCP Manager
	mcpManager = new MCPManager();
	context.subscriptions.push(mcpManager);

	// Register sidebar view provider
	console.log('Registering provider for view:', ThreatModelingSidebarProvider.viewType);
	const provider = new ThreatModelingSidebarProvider(context.extensionUri, context);
	try {
		const registration = vscode.window.registerWebviewViewProvider(
			ThreatModelingSidebarProvider.viewType,
			provider
		);
		context.subscriptions.push(registration);
		console.log('✅ Provider registered successfully');
	} catch (error) {
		console.error('❌ Failed to register provider:', error);
		vscode.window.showErrorMessage('Failed to register Threat Modeling provider: ' + error);
	}
	
	// Register the dashboard command - starts MCP servers then opens dashboard
	safeRegisterCommand('ai-threat-modeling.openDashboard', async () => {
		// Start MCP servers first
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Starting MCP Servers...',
			cancellable: false
		}, async (progress) => {
			progress.report({ message: 'Starting MCP servers...' });
				const started = await mcpManager.startAllMCPServers(context);
				if (started) {
					progress.report({ message: 'MCP Servers started successfully' });
					vscode.window.showInformationMessage('✅ MCP Servers are running');
			}
		});
		
		// Then open dashboard
		DashboardPanel.createOrShow(context, mcpManager);
	});

	// Register MCP control commands
	safeRegisterCommand('ai-threat-modeling.startMCP', async () => {
		await mcpManager.startAllMCPServers(context);
	});

	safeRegisterCommand('ai-threat-modeling.stopMCP', async () => {
		await mcpManager.stopConfluenceServer();
		vscode.window.showInformationMessage('MCP Servers stopped');
	});

	// Command to set all tokens at once
	safeRegisterCommand('ai-threat-modeling.setTokens', async () => {
		const options = await vscode.window.showQuickPick([
			{ label: '🔧 Configure All Credentials', description: 'Set up GitHub and Jira tokens', value: 'all' },
			{ label: '🐙 GitHub Setup (Optional)', description: 'Set GitHub Personal Access Token', value: 'github' },
			{ label: '🎫 Jira Setup (On-Prem)', description: 'Set Jira Personal Access Token', value: 'jira' }
		], {
			placeHolder: 'What would you like to configure?'
		});

		if (!options) {
			return;
		}

		switch (options.value) {
			case 'all':
				await mcpManager.setGitHubToken(context);
				await mcpManager.setJiraToken(context);
				vscode.window.showInformationMessage('✅ All credentials configured! You can now start MCP servers.');
				break;
			case 'github':
				await mcpManager.setGitHubToken(context);
				vscode.window.showInformationMessage('✅ GitHub token configured!');
				break;
			case 'jira':
				await mcpManager.setJiraToken(context);
				vscode.window.showInformationMessage('✅ Jira on-prem credentials configured!');
				break;
		}
	});

	safeRegisterCommand('ai-threat-modeling.configureMCP', async () => {
		vscode.commands.executeCommand('ai-threat-modeling.setTokens');
	});

	// ── PR Watcher ──────────────────────────────────────────────────────────
	prWatcher = new PRWatcher(context);
	context.subscriptions.push(prWatcher);

	// Auto-start the watcher if any features already have PR Watch enabled
	prWatcher.startIfWatched();

	// Auto-triggered by PR watcher when a new/updated PR is detected
	safeRegisterCommand('ai-threat-modeling.analyzePR', async (args: { productId: string; featureId: string; prUrl: string }) => {
		// Ensure MCP servers are running and dashboard is open
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Starting MCP Servers...',
			cancellable: false
		}, async (progress) => {
			progress.report({ message: 'Starting servers for PR analysis...' });
			await mcpManager.startAllMCPServers(context);
		});

		// Open dashboard with PR analysis
		DashboardPanel.createOrShow(context, mcpManager);
		// Trigger analysis via dashboard message
		if (DashboardPanel.currentPanel) {
			DashboardPanel.currentPanel.triggerPRAnalysis(args.productId, args.featureId, args.prUrl);
		}
	});

	safeRegisterCommand('ai-threat-modeling.startPRWatcher', () => {
		prWatcher.start();
		vscode.window.showInformationMessage('🔄 PR Watcher started — monitoring repositories for new pull requests.');
	});

	safeRegisterCommand('ai-threat-modeling.stopPRWatcher', () => {
		prWatcher.stop();
		vscode.window.showInformationMessage('⏹️ PR Watcher stopped.');
	});

	// ── Confluence Watcher ──────────────────────────────────────────────────
	confluenceWatcher = new ConfluenceWatcher(context);
	context.subscriptions.push(confluenceWatcher);

	// Auto-start the watcher if any features already have Confluence Watch enabled
	confluenceWatcher.startIfWatched();

	// Auto-triggered by Confluence watcher when a page version changes
	safeRegisterCommand('ai-threat-modeling.reanalyzeConfluence', async (args: { productId: string; featureId: string; pageUrl: string }) => {
		// Ensure MCP servers are running and dashboard is open
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Starting MCP Servers...',
			cancellable: false
		}, async (progress) => {
			progress.report({ message: 'Starting servers for Confluence re-analysis...' });
			await mcpManager.startAllMCPServers(context);
		});

		// Open dashboard and trigger delta analysis
		DashboardPanel.createOrShow(context, mcpManager);
		if (DashboardPanel.currentPanel) {
			DashboardPanel.currentPanel.triggerConfluenceDeltaAnalysis(args.productId, args.featureId);
		}
	});

	safeRegisterCommand('ai-threat-modeling.startConfluenceWatcher', () => {
		confluenceWatcher.start();
		vscode.window.showInformationMessage('📄 Confluence Watcher started — monitoring pages for specification changes.');
	});

	safeRegisterCommand('ai-threat-modeling.stopConfluenceWatcher', () => {
		confluenceWatcher.stop();
		vscode.window.showInformationMessage('⏹️ Confluence Watcher stopped.');
	});

	safeRegisterCommand('ai-threat-modeling.scanWorkspace', async () => {
		const pm = new ProductManager(context);
		const result = await pm.scanAndImport();
		if (result.productsAdded === 0 && result.featuresAdded === 0) {
			vscode.window.showInformationMessage('No new products/features found on disk.');
		} else {
			vscode.window.showInformationMessage(
				`Imported ${result.productsAdded} product(s) and ${result.featuresAdded} feature(s) from workspace.`
			);
			// Refresh dashboard if open
			if (DashboardPanel.currentPanel) {
				DashboardPanel.currentPanel.refreshProducts();
			}
		}
	});

	// ── Validation Gate ──────────────────────────────────────────────────────
	safeRegisterCommand('ai-threat-modeling.validateAnalysis', async (args?: { featureFolder?: string }) => {
		const { ValidationGate } = await import('./validationGate.js');
		const featureFolder = args?.featureFolder;
		if (!featureFolder) {
			vscode.window.showErrorMessage('No feature folder specified for validation.');
			return;
		}
		const gate = new ValidationGate();
		const results = gate.validateFeature(featureFolder);
		const allErrors = [...results.design.errors, ...results.repo.errors];
		const allWarnings = [...results.design.warnings, ...results.repo.warnings];

		if (allErrors.length === 0) {
			const warnMsg = allWarnings.length > 0 ? ` (${allWarnings.length} warning(s))` : '';
			vscode.window.showInformationMessage(`✅ Validation passed${warnMsg}`);
		} else {
			vscode.window.showWarningMessage(`❌ Validation failed: ${allErrors[0]}`);
		}
		// Log all details to output channel
		const outputChannel = vscode.window.createOutputChannel('Threat Modeling Validation');
		outputChannel.clear();
		outputChannel.appendLine('=== Validation Results ===');
		outputChannel.appendLine(`\nDesign: ${results.design.passed ? 'PASS' : 'FAIL'}`);
		results.design.errors.forEach((e: string) => outputChannel.appendLine(`  ❌ ${e}`));
		results.design.warnings.forEach((w: string) => outputChannel.appendLine(`  ⚠️ ${w}`));
		outputChannel.appendLine(`\nRepo: ${results.repo.passed ? 'PASS' : 'FAIL'}`);
		results.repo.errors.forEach((e: string) => outputChannel.appendLine(`  ❌ ${e}`));
		results.repo.warnings.forEach((w: string) => outputChannel.appendLine(`  ⚠️ ${w}`));
		outputChannel.show(true);
	});

	// ── Knowledge Base ───────────────────────────────────────────────────────
	safeRegisterCommand('ai-threat-modeling.addLesson', async (args?: { productFolder?: string; title?: string; domain?: string; body?: string; product?: string }) => {
		const { KnowledgeManager } = await import('./knowledgeManager.js');
		const productFolder = args?.productFolder;
		if (!productFolder) {
			vscode.window.showErrorMessage('No product folder specified.');
			return;
		}
		const title = args?.title || await vscode.window.showInputBox({ prompt: 'Lesson title (short insight)' });
		if (!title) { return; }
		const domain = args?.domain || await vscode.window.showInputBox({ prompt: 'Domain (e.g., Authentication, API, Storage)' });
		if (!domain) { return; }
		const body = args?.body || await vscode.window.showInputBox({ prompt: 'Lesson body (what you learned)' });
		if (!body) { return; }

		const km = new KnowledgeManager(productFolder);
		const lesson = km.addLesson({
			title,
			domain,
			tags: [domain.toLowerCase()],
			product: args?.product || path.basename(productFolder),
			body
		});
		vscode.window.showInformationMessage(`📚 Lesson ${lesson.id} saved to knowledge base.`);
	});
}

export function deactivate() {
	if (confluenceWatcher) {
		confluenceWatcher.dispose();
	}
	if (prWatcher) {
		prWatcher.dispose();
	}
	if (mcpManager) {
		mcpManager.dispose();
	}
}
