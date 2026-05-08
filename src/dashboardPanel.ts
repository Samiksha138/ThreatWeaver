import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProductManager } from './productManager';
import { ThreatAnalyzer } from './threatAnalyzer';
import { ReportGenerator } from './reportGenerator';
import { MCPManager } from './mcpManager';
import { sendEvent, sendError } from './telemetry';

export class DashboardPanel {
	public static currentPanel: DashboardPanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private readonly _context: vscode.ExtensionContext;
	private _disposables: vscode.Disposable[] = [];
	private readonly _productManager: ProductManager;
	private readonly _threatAnalyzer: ThreatAnalyzer;
	private readonly _reportGenerator: ReportGenerator;
	private readonly _mcpManager: MCPManager;

	public static createOrShow(context: vscode.ExtensionContext, mcpManager: MCPManager) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (DashboardPanel.currentPanel) {
			DashboardPanel.currentPanel._panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'threatModelingDashboardPanel',
			'Threat Modeling Dashboard',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [],
				enableCommandUris: true,
				enableFindWidget: true
			}
		);

		DashboardPanel.currentPanel = new DashboardPanel(panel, context, mcpManager);
	}

	private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, mcpManager: MCPManager) {
		this._panel = panel;
		this._context = context;
		this._mcpManager = mcpManager;
		this._productManager = new ProductManager(context);
		this._threatAnalyzer = new ThreatAnalyzer(context, mcpManager);
		this._reportGenerator = new ReportGenerator();

		this._update();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._panel.webview.onDidReceiveMessage(
			async message => {
				try {
					switch (message.command) {
						case 'getProducts':
							this._sendProducts();
							break;
						case 'addProduct':
							await this._productManager.addProduct(message.productName);
							this._sendProducts();
							break;
						case 'scanWorkspace': {
							const result = await this._productManager.scanAndImport();
							if (result.productsAdded === 0 && result.featuresAdded === 0) {
								vscode.window.showInformationMessage('No new products/features found on disk.');
							} else {
								vscode.window.showInformationMessage(
									`Imported ${result.productsAdded} product(s) and ${result.featuresAdded} feature(s) from workspace.`
								);
							}
							this._sendProducts();
							break;
						}
						case 'addFeature':
							await this._productManager.addFeature(message.productId, message.feature);
							this._sendProducts();
							break;
						case 'editFeature':
							await this._productManager.editFeature(message.productId, message.featureId, message.feature);
							this._sendProducts();
							break;
						case 'showError':
							vscode.window.showErrorMessage(message.message);
							break;
						case 'confirmDeleteProduct':
							const confirmProduct = await vscode.window.showWarningMessage(
								'Delete this product and all its features?',
								{ modal: true },
								'Delete'
							);
							if (confirmProduct === 'Delete') {
								await this._productManager.deleteProduct(message.productId);
								this._sendProducts();
							}
							break;
						case 'confirmDeleteFeature':
							const confirmFeature = await vscode.window.showWarningMessage(
								'Delete this feature?',
								{ modal: true },
								'Delete'
							);
							if (confirmFeature === 'Delete') {
								await this._productManager.deleteFeature(message.productId, message.featureId);
								this._sendProducts();
							}
							break;
						case 'analyze':
							await this._analyze(message.productId, message.featureId);
							break;
						case 'generateReport':
							await this._generateReport(message.productId, message.featureId);
							break;
						case 'publishToConfluence':
							await this._publishToConfluence(message.productId, message.featureId);
							break;
						case 'createJiraIssues':
							await this._createJiraIssues(message.productId, message.featureId);
							break;
						case 'togglePRWatch':
							await this._productManager.updateFeature(message.productId, message.featureId, {
								prWatchEnabled: message.enabled
							});
							this._sendProducts();
							if (message.enabled) {
								// Auto-start the PR watcher immediately
								vscode.commands.executeCommand('ai-threat-modeling.startPRWatcher');
								vscode.window.showInformationMessage(
									`🔄 PR watching enabled for "${message.featureName}". New PRs will be automatically analyzed.`
								);
							}
							break;
						case 'toggleConfluenceWatch':
							await this._productManager.updateFeature(message.productId, message.featureId, {
								confluenceWatchEnabled: message.enabled
							});
							this._sendProducts();
							if (message.enabled) {
								// Auto-start the Confluence watcher immediately
								vscode.commands.executeCommand('ai-threat-modeling.startConfluenceWatcher');
								vscode.window.showInformationMessage(
									`📄 Confluence watching enabled for "${message.featureName}". Spec changes will auto-trigger re-analysis.`
								);
							}
							break;
					case 'getRiskMetrics':
						await this._sendRiskMetrics();
						break;
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					vscode.window.showErrorMessage(`Action failed: ${errorMessage}`);
				}
			},
			null,
			this._disposables
		);
	}

	private _setLoading(productId: string, featureId: string, operation: string, loading: boolean) {
		this._panel.webview.postMessage({ command: loading ? 'setButtonLoading' : 'clearButtonLoading', productId, featureId, operation });
	}

	private async _createJiraIssues(productId: string, featureId: string) {
		const feature = this._productManager.getFeature(productId, featureId);
		if (!feature) { throw new Error('Feature not found'); }

		// Prompt for Jira project key — pre-fill if already saved on the feature
		const projectKey = await vscode.window.showInputBox({
			title: 'Jira Project Key (Step 1/2)',
			prompt: 'Enter the Jira project key where issues will be created (e.g. SEC, SECURITY)',
			value: feature.jiraProjectKey ?? '',
			placeHolder: 'SEC',
			validateInput: v => v.trim() ? null : 'Project key is required',
			ignoreFocusOut: true
		});
		if (!projectKey) { return; }

		// Prompt for issue type — pre-fill if already saved
		const issueType = await vscode.window.showInputBox({
			title: 'Jira Issue Type (Step 2/2)',
			prompt: 'Enter the Jira issue type (must match exactly what exists in your project)',
			value: feature.jiraIssueType ?? 'Task',
			placeHolder: 'Task',
			validateInput: v => v.trim() ? null : 'Issue type is required',
			ignoreFocusOut: true
		});
		if (!issueType) { return; }

		// Save both for next time
		const updates: any = {};
		if (projectKey !== feature.jiraProjectKey) { updates.jiraProjectKey = projectKey.trim().toUpperCase(); }
		if (issueType !== feature.jiraIssueType) { updates.jiraIssueType = issueType.trim(); }
		if (Object.keys(updates).length > 0) {
			await this._productManager.updateFeature(productId, featureId, updates);
		}

		this._setLoading(productId, featureId, 'jira', true);
		try {
			const result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Creating Jira issues for ${feature.name}...`,
				cancellable: false
			}, async (progress) => {
				progress.report({ message: 'Parsing Critical/High threats...' });
				const res = await this._threatAnalyzer.createJiraIssues(feature, projectKey.trim().toUpperCase(), issueType.trim());
				progress.report({ message: `Created ${res.created} tickets` });
				return res;
			});

			const ticketList = result.tickets.map(t => `${t.key}: ${t.threatName}`).join('\n');
			const failureNote = result.failures?.length > 0
				? ` (${result.failures.length} failed — see Output channel)`
				: '';

			let msg: string;
			if (result.created > 0) {
				msg = `✅ Created ${result.created} Jira issue${result.created !== 1 ? 's' : ''}${result.skipped > 0 ? ` (${result.skipped} already existed)` : ''}${failureNote}:\n${ticketList}`;
			} else if (result.skipped > 0) {
				msg = `ℹ️ No new issues created — ${result.skipped} Critical/High ticket${result.skipped !== 1 ? 's' : ''} already exist in Jira.`;
			} else {
				msg = `⚠️ No tickets created${failureNote}. Check the "AI Threat Modeling" output channel for errors.`;
			}

			vscode.window.showInformationMessage(msg, 'Show Output', 'Open Folder').then(sel => {
				if (sel === 'Show Output') {
					vscode.commands.executeCommand('workbench.action.output.toggleOutput');
				} else if (sel === 'Open Folder' && feature.folderPath) {
					vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(feature.folderPath));
				}
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to create Jira issues: ${msg}`);
		} finally {
			this._setLoading(productId, featureId, 'jira', false);
		}
	}

    private async _analyze(productId: string, featureId: string) {
        this._setLoading(productId, featureId, 'analyze', true);
        sendEvent('analyzeStarted', { productId, featureId });
        try {
            const feature = this._productManager.getFeature(productId, featureId);
            if (!feature) {
                throw new Error('Feature not found');
            }

            if (!feature.folderPath) {
                throw new Error('Feature folder path is not defined');
            }

            // Check which URLs are provided and analyze accordingly
            const hasConfluence = feature.confluenceUrls && feature.confluenceUrls.length > 0;
            const hasRepo = feature.repositoryUrls && feature.repositoryUrls.length > 0;
            if (hasRepo && hasConfluence) {
                // Both URLs provided - full analysis
                await this._threatAnalyzer.analyzeRepository(feature);
            } else if (hasConfluence) {
                // Only Confluence URLs - documentation analysis
                await this._threatAnalyzer.analyzeDocumentation(feature);
            } else if (hasRepo) {
                // Only repository URLs - repository analysis
                await this._threatAnalyzer.analyzeRepository(feature);
            } else {
                throw new Error('Please provide at least one URL (Confluence or Repository)');
            }
            
            // Don't update status immediately - let the user refresh after Copilot saves files
            sendEvent('analyzeCompleted', { productId, featureId });
            this._sendProducts();
            
            const repoPath = path.join(feature.folderPath, 'repo', 'threat-analysis.md');
            const designPath = path.join(feature.folderPath, 'design', 'threat-analysis.md');
			
            vscode.window.showInformationMessage(
                `Copilot Chat opened for threat analysis of ${feature.name}.\n\nIMPORTANT: After Copilot generates the analysis, save the files to:\n- ${repoPath}\n- ${designPath}\n\nThen click 'Check Status' to enable report generation.`,
                'Check Status', 'Open Folder'
            ).then(selection => {
                if (selection === 'Check Status') {
                    this._checkAndUpdateAnalysisStatus();
                    this._sendProducts();
                } else if (selection === 'Open Folder' && feature.folderPath) {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(feature.folderPath));
                }
            });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			sendError('analyzeFailed', { productId, featureId, error: errorMessage });
			vscode.window.showErrorMessage(`Failed to analyze: ${errorMessage}`);
		} finally {
			this._setLoading(productId, featureId, 'analyze', false);
		}
	}

	private async _generateReport(productId: string, featureId: string) {
		this._setLoading(productId, featureId, 'report', true);
		sendEvent('reportStarted', { productId, featureId });
		try {
			const feature = this._productManager.getFeature(productId, featureId);
			if (!feature) {
				throw new Error('Feature not found');
			}
			
			// Get product name
			const products = this._productManager.getProducts();
			const product = products.find(p => p.id === productId);
			const productName = product ? product.name : undefined;

			// Check if analysis files exist (don't rely solely on flags)
			if (feature.folderPath) {
				const repoAnalysisPath = path.join(feature.folderPath, 'repo', 'threat-analysis.md');
				const designAnalysisPath = path.join(feature.folderPath, 'design', 'threat-analysis.md');
				
				const hasRepoFile = fs.existsSync(repoAnalysisPath);
				const hasDesignFile = fs.existsSync(designAnalysisPath);
				
				if (!hasRepoFile && !hasDesignFile) {
					vscode.window.showWarningMessage(
						'No threat analysis files found. Please run "Analyze Threats" first and save the generated files.',
						'Check Status'
					).then(selection => {
						if (selection === 'Check Status') {
							this._checkAndUpdateAnalysisStatus();
							this._sendProducts();
						}
					});
					return;
				}
				
				// Update flags if they don't match
				if (hasRepoFile !== feature.hasRepoAnalysis || hasDesignFile !== feature.hasDocAnalysis) {
					this._productManager.updateFeatureAnalysisStatus(productId, feature.id, 'repo', hasRepoFile);
					this._productManager.updateFeatureAnalysisStatus(productId, feature.id, 'doc', hasDesignFile);
					this._sendProducts();
				}
			}

			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Generating threat report for ${feature.name}...`,
				cancellable: false
			}, async (progress) => {
				const reports = await this._reportGenerator.generateCombinedReport(feature, productName);
				sendEvent('reportCompleted', { productId, featureId });
				vscode.window.showInformationMessage(
					`Threat reports generated successfully!\nHTML: ${reports.htmlPath}\nCSV: ${reports.csvPath}`,
					'Open HTML', 'Open CSV', 'Open Folder'
				).then(selection => {
					if (selection === 'Open HTML') {
						vscode.env.openExternal(vscode.Uri.file(reports.htmlPath));
					} else if (selection === 'Open CSV') {
						vscode.env.openExternal(vscode.Uri.file(reports.csvPath));
					} else if (selection === 'Open Folder') {
						vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(feature.folderPath!));
					}
				});
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			sendError('reportFailed', { productId, featureId, error: errorMessage });
			vscode.window.showErrorMessage(`Failed to generate report: ${errorMessage}`);
		} finally {
			this._setLoading(productId, featureId, 'report', false);
		}
	}

	private async _publishToConfluence(productId: string, featureId: string) {
		this._setLoading(productId, featureId, 'publish', true);
		sendEvent('publishStarted', { productId, featureId });
		try {
			const feature = this._productManager.getFeature(productId, featureId);
			if (!feature) {
				throw new Error('Feature not found');
			}

			if (!feature.confluenceWritebackUrl) {
				const edit = await vscode.window.showWarningMessage(
					`No Confluence writeback page configured for "${feature.name}". Edit the feature to add a parent page URL.`,
					'Edit Feature'
				);
				if (edit === 'Edit Feature') {
					this._panel.webview.postMessage({ command: 'openEditFeature', productId, featureId });
				}
				return;
			}

			const products = this._productManager.getProducts();
			const product = products.find(p => p.id === productId);
			const productName = product ? product.name : undefined;

			let publishedUrl = feature.confluenceWritebackUrl;
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Publishing "${feature.name}" threat model to Confluence...`,
				cancellable: false
			}, async () => {
				publishedUrl = await this._threatAnalyzer.publishToConfluence(feature, productName);
			});

			sendEvent('publishCompleted', { productId, featureId });
			vscode.window.showInformationMessage(
				`Threat model published to Confluence for "${feature.name}".`,
				'Open in Confluence'
			).then(selection => {
				if (selection === 'Open in Confluence') {
					vscode.env.openExternal(vscode.Uri.parse(publishedUrl));
				}
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			sendError('publishFailed', { productId, featureId, error: errorMessage });
			vscode.window.showErrorMessage(`Failed to publish to Confluence: ${errorMessage}`);
		} finally {
			this._setLoading(productId, featureId, 'publish', false);
		}
	}

	/**
	 * Trigger PR analysis from the PR watcher.
	 * Temporarily overrides the feature's scope to 'pr' and triggers analysis.
	 */
	public async triggerPRAnalysis(productId: string, featureId: string, prUrl: string): Promise<void> {
		const feature = this._productManager.getFeature(productId, featureId);
		if (!feature) {
			vscode.window.showErrorMessage('Feature not found for PR analysis');
			return;
		}

		// Temporarily set PR scope for this analysis
		const originalScope = feature.repositoryScope;
		const originalPrUrl = feature.prUrl;

		await this._productManager.updateFeature(productId, featureId, {
			repositoryScope: 'pr',
			prUrl: prUrl
		});

		try {
			await this._analyze(productId, featureId);
		} finally {
			// Restore original scope
			await this._productManager.updateFeature(productId, featureId, {
				repositoryScope: originalScope || 'full',
				prUrl: originalPrUrl || ''
			});
		}
	}

	/**
	 * Trigger delta re-analysis when a Confluence page has changed.
	 * Called by the ConfluenceWatcher when it detects a page version update.
	 */
	public async triggerConfluenceDeltaAnalysis(productId: string, featureId: string): Promise<void> {
		const feature = this._productManager.getFeature(productId, featureId);
		if (!feature) {
			vscode.window.showErrorMessage('Feature not found for Confluence re-analysis');
			return;
		}

		this._setLoading(productId, featureId, 'analyze', true);
		try {
			await this._threatAnalyzer.reanalyzeWithContext(feature);
			this._sendProducts();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			vscode.window.showErrorMessage(`Delta re-analysis failed: ${errorMessage}`);
		} finally {
			this._setLoading(productId, featureId, 'analyze', false);
		}
	}

	private async _checkAndUpdateAnalysisStatus() {
		const products = this._productManager.getProducts();
		let updated = false;
		for (const product of products) {
			for (const feature of product.features) {
				if (feature.folderPath) {
					const repoAnalysisPath = path.join(feature.folderPath, 'repo', 'threat-analysis.md');
					const designAnalysisPath = path.join(feature.folderPath, 'design', 'threat-analysis.md');
					
					const hasRepoAnalysis = fs.existsSync(repoAnalysisPath);
					const hasDocAnalysis = fs.existsSync(designAnalysisPath);
					
					console.log(`Checking ${feature.name}: repo=${hasRepoAnalysis} (${repoAnalysisPath}), design=${hasDocAnalysis} (${designAnalysisPath})`);
					
					if (hasRepoAnalysis !== feature.hasRepoAnalysis || hasDocAnalysis !== feature.hasDocAnalysis) {
						await this._productManager.updateFeatureAnalysisStatus(product.id, feature.id, 'repo', hasRepoAnalysis);
						await this._productManager.updateFeatureAnalysisStatus(product.id, feature.id, 'doc', hasDocAnalysis);
						updated = true;
						console.log(`Updated status for ${feature.name}: repo=${hasRepoAnalysis}, design=${hasDocAnalysis}`);
					}
				}
			}
		}
		if (updated) {
			vscode.window.showInformationMessage('Analysis status updated! You can now generate reports.');
		} else {
			vscode.window.showWarningMessage('No threat-analysis.md files found yet. Make sure Copilot has saved the analysis files.');
		}
	}

	private _sendProducts() {
		const products = this._productManager.getProducts();
		this._panel.webview.postMessage({ command: 'productsUpdated', products });
	}

	/** Refresh product list (called externally after scanWorkspace command). */
	public refreshProducts() {
		this._productManager.reload();
		this._sendProducts();
	}

	private _update() {
		this._panel.webview.html = this._getHtmlForWebview();
	}

	private _getHtmlForWebview(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Threat Modeling Dashboard</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700;800;900&display=swap');

        :root {
            --bg-primary: #0a0e17;
            --bg-secondary: #111827;
            --bg-card: rgba(17, 24, 39, 0.8);
            --bg-elevated: rgba(30, 41, 59, 0.6);
            --neon-cyan: #00f0ff;
            --neon-green: #00ff9d;
            --neon-purple: #a855f7;
            --neon-pink: #f43f5e;
            --neon-amber: #fbbf24;
            --border-dim: rgba(0, 240, 255, 0.08);
            --border-glow: rgba(0, 240, 255, 0.25);
            --text-primary: #e2e8f0;
            --text-secondary: rgba(226, 232, 240, 0.6);
            --text-muted: rgba(226, 232, 240, 0.35);
            --radius: 12px;
            --transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
        }

        /* ── Animated grid background ── */
        body::before {
            content: '';
            position: fixed;
            inset: 0;
            background:
                linear-gradient(rgba(0, 240, 255, 0.03) 1px, transparent 1px),
                linear-gradient(90deg, rgba(0, 240, 255, 0.03) 1px, transparent 1px);
            background-size: 60px 60px;
            pointer-events: none;
            z-index: 0;
        }

        body::after {
            content: '';
            position: fixed;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(ellipse at 30% 20%, rgba(0, 240, 255, 0.06) 0%, transparent 50%),
                        radial-gradient(ellipse at 70% 80%, rgba(168, 85, 247, 0.04) 0%, transparent 50%);
            pointer-events: none;
            z-index: 0;
            animation: auroraShift 20s ease-in-out infinite alternate;
        }

        @keyframes auroraShift {
            0% { transform: translate(0, 0) scale(1); }
            100% { transform: translate(-5%, 5%) scale(1.1); }
        }

        /* ── Scanline overlay ── */
        .scanline-overlay {
            position: fixed;
            inset: 0;
            background: repeating-linear-gradient(
                0deg,
                transparent,
                transparent 2px,
                rgba(0, 240, 255, 0.008) 2px,
                rgba(0, 240, 255, 0.008) 4px
            );
            pointer-events: none;
            z-index: 9999;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            position: relative;
            z-index: 1;
        }

        /* ── Header + Tabs Block ── */
        .top-nav {
            display: flex;
            flex-direction: column;
            background: rgba(0, 0, 0, 0.4);
            border-bottom: 1px solid var(--border-dim);
            flex-shrink: 0;
            position: relative;
        }

        .top-nav::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(0, 240, 255, 0.15), transparent);
        }

        .nav-brand {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 16px;
            padding: 36px 24px 24px;
        }

        .nav-brand .brand-icon {
            font-size: 48px;
            filter: drop-shadow(0 0 20px rgba(0, 240, 255, 0.4));
            animation: iconPulse 3s ease-in-out infinite;
        }

        .nav-brand .brand-text {
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
            font-size: 40px;
            font-weight: 800;
            background: linear-gradient(135deg, var(--neon-cyan) 0%, #60a5fa 40%, var(--neon-purple) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: -1px;
        }

        .nav-tabs {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0;
            border-top: 1px solid var(--border-dim);
        }

        .tab-button {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            flex: 1;
            padding: 10px 18px;
            background: transparent;
            color: var(--text-muted);
            border: none;
            border-bottom: 2px solid transparent;
            cursor: pointer;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            transition: var(--transition);
            position: relative;
            white-space: nowrap;
        }

        .tab-button .tab-icon {
            font-size: 14px;
        }

        .tab-button:hover {
            color: var(--text-primary);
            background: rgba(0, 240, 255, 0.04);
        }

        .tab-button.active {
            color: var(--neon-cyan);
            border-bottom-color: var(--neon-cyan);
            background: rgba(0, 240, 255, 0.06);
        }

        .nav-status {
            position: absolute;
            top: 16px;
            right: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--neon-green);
            box-shadow: 0 0 6px var(--neon-green);
            animation: dotPulse 2s ease-in-out infinite;
        }

        .status-dot.warning { background: var(--neon-amber); box-shadow: 0 0 6px var(--neon-amber); }
        .status-dot.offline { background: var(--neon-pink); box-shadow: 0 0 6px var(--neon-pink); }

        /* ── Main content ── */
        .main-content {
            flex: 1;
            padding: 24px;
            overflow-y: auto;
        }

        .header {
            display: none;
        }

        @keyframes iconPulse {
            0%, 100% { transform: translateY(0) scale(1); filter: drop-shadow(0 0 20px rgba(0, 240, 255, 0.4)); }
            50% { transform: translateY(-6px) scale(1.05); filter: drop-shadow(0 0 30px rgba(0, 240, 255, 0.6)); }
        }

        h1 {
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
            font-size: 40px;
            font-weight: 800;
            margin-bottom: 8px;
            background: linear-gradient(135deg, var(--neon-cyan) 0%, #60a5fa 40%, var(--neon-purple) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: -1px;
        }

        .subtitle {
            display: none;
        }

        /* ── Status bar (moved to sidebar) ── */
        .status-bar {
            display: none;
        }

        @keyframes dotPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        /* ── Tabs (now vertical — see .sidebar-nav .tab-button above) ── */

        .tabs { display: none; }

        .tab-content { display: none; }
        .tab-content.active {
            display: block;
            animation: tabFadeIn 0.35s ease;
        }

        @keyframes tabFadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* ── CVSS Risk Dashboard ── */
        .risk-overview {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 28px;
        }
        .risk-stat-card {
            background: var(--bg-elevated);
            border: 1px solid var(--border-dim);
            border-radius: var(--radius);
            padding: 20px 24px;
            text-align: center;
            transition: border-color var(--transition);
        }
        .risk-stat-card:hover { border-color: var(--border-glow); }
        .risk-stat-value { font-size: 2.4rem; font-weight: 800; line-height: 1; }
        .risk-stat-label { font-size: 11px; color: var(--text-secondary); margin-top: 6px; text-transform: uppercase; letter-spacing: .06em; }
        .risk-product-block {
            background: var(--bg-elevated);
            border: 1px solid var(--border-dim);
            border-radius: var(--radius);
            margin-bottom: 18px;
            overflow: hidden;
        }
        .risk-product-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 14px 20px;
            border-bottom: 1px solid var(--border-dim);
            cursor: pointer;
            user-select: none;
        }
        .risk-product-header:hover { background: rgba(0,240,255,0.04); }
        .risk-product-title { font-size: 14px; font-weight: 700; color: var(--text-primary); }
        .risk-product-score { display: flex; align-items: center; gap: 10px; }
        .risk-score-pill {
            font-size: 11px; font-weight: 700;
            padding: 3px 10px; border-radius: 999px;
            letter-spacing: .04em;
        }
        .risk-feature-rows { padding: 12px 20px 16px; display: flex; flex-direction: column; gap: 12px; }
        .risk-feature-row { display: flex; align-items: center; gap: 12px; }
        .risk-feature-label { min-width: 160px; max-width: 200px; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .risk-feature-version { font-size: 10px; color: var(--text-muted); min-width: 40px; }
        .stacked-bar-wrap { flex: 1; display: flex; flex-direction: column; gap: 3px; }
        .stacked-bar {
            height: 14px; border-radius: 7px; overflow: hidden;
            background: rgba(255,255,255,0.06);
            display: flex;
        }
        .bar-seg { height: 100%; transition: width 0.6s cubic-bezier(0.4,0,0.2,1); }
        .bar-seg-critical { background: #f43f5e; }
        .bar-seg-high     { background: #f97316; }
        .bar-seg-medium   { background: #fbbf24; }
        .bar-seg-low      { background: #00ff9d; }
        .stacked-bar-legend { display: flex; gap: 10px; font-size: 10px; color: var(--text-muted); }
        .legend-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
        .risk-no-analysis { font-size: 12px; color: var(--text-muted); font-style: italic; }
        .gauge-svg { filter: drop-shadow(0 0 8px currentColor); }

        /* ── Section headers ── */
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .section-header h2 {
            font-family: 'JetBrains Mono', monospace;
            font-size: 22px;
            font-weight: 700;
            color: var(--text-primary);
            margin: 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .section-header h2::before {
            color: var(--neon-cyan);
            opacity: 0.4;
            font-weight: 400;
        }

        /* ── Buttons ── */
        .button {
            padding: 12px 24px;
            background: rgba(0, 240, 255, 0.08);
            color: var(--neon-cyan);
            border: 1px solid rgba(0, 240, 255, 0.2);
            border-radius: var(--radius);
            cursor: pointer;
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.5px;
            transition: var(--transition);
            text-transform: uppercase;
            position: relative;
            overflow: hidden;
        }

        .button::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(0, 240, 255, 0.1), transparent);
            transition: left 0.5s;
        }

        .button:hover::before { left: 100%; }

        .button:hover {
            background: rgba(0, 240, 255, 0.15);
            border-color: rgba(0, 240, 255, 0.4);
            box-shadow: 0 0 20px rgba(0, 240, 255, 0.15), 0 0 40px rgba(0, 240, 255, 0.05);
            transform: translateY(-1px);
        }

        .button:active { transform: translateY(0); }

        .button-secondary {
            color: var(--neon-purple);
            border-color: rgba(168, 85, 247, 0.2);
            background: rgba(168, 85, 247, 0.08);
        }
        .button-secondary:hover {
            background: rgba(168, 85, 247, 0.15);
            border-color: rgba(168, 85, 247, 0.4);
            box-shadow: 0 0 20px rgba(168, 85, 247, 0.15);
        }

        .button-danger {
            color: var(--neon-pink);
            border-color: rgba(244, 63, 94, 0.2);
            background: rgba(244, 63, 94, 0.08);
        }
        .button-danger:hover {
            background: rgba(244, 63, 94, 0.15);
            border-color: rgba(244, 63, 94, 0.4);
            box-shadow: 0 0 20px rgba(244, 63, 94, 0.15);
        }

        /* ── Cards grid ── */
        .products-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin-top: 16px;
        }

        .product-card {
            background: var(--bg-card);
            border: 1px solid var(--border-dim);
            border-radius: 16px;
            padding: 24px;
            transition: var(--transition);
            position: relative;
            overflow: hidden;
            backdrop-filter: blur(12px);
        }

        .product-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--neon-cyan), transparent);
            opacity: 0;
            transition: opacity 0.3s;
        }

        .product-card::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 2px;
            height: 0;
            background: linear-gradient(180deg, var(--neon-cyan), transparent);
            transition: height 0.4s;
        }

        .product-card:hover::before { opacity: 1; }
        .product-card:hover::after { height: 60px; }

        .product-card:hover {
            border-color: var(--border-glow);
            transform: translateY(-4px);
            box-shadow: 0 8px 40px rgba(0, 240, 255, 0.08),
                        0 0 60px rgba(0, 240, 255, 0.03);
        }

        .product-header {
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border-dim);
        }

        .product-name {
            font-family: 'JetBrains Mono', monospace;
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 4px;
            color: var(--neon-cyan);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .product-name::before {
            color: var(--neon-green);
            font-weight: 400;
            opacity: 0.6;
            animation: blink 1.2s step-end infinite;
        }

        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
        }

        .product-info {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 16px;
        }

        .info-row {
            display: flex;
            align-items: flex-start;
            font-size: 13px;
            padding: 10px 14px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
            border-left: 2px solid rgba(0, 240, 255, 0.15);
            transition: var(--transition);
            font-family: 'JetBrains Mono', monospace;
        }

        .info-row:hover {
            background: rgba(0, 240, 255, 0.03);
            border-left-color: var(--neon-cyan);
        }

        .info-label {
            font-weight: 600;
            min-width: 90px;
            color: var(--neon-cyan);
            font-size: 10px;
            letter-spacing: 1px;
            text-transform: uppercase;
        }

        .info-value {
            color: var(--text-secondary);
            word-break: break-word;
            flex: 1;
            font-size: 12px;
        }

        .product-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        .product-actions .button {
            flex: 1;
            min-width: 110px;
            font-size: 11px;
            padding: 8px 14px;
        }

        /* ── Feature items inside product cards ── */
        .features-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 20px;
        }

        .feature-item {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 14px 16px;
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 10px;
            transition: var(--transition);
        }

        .feature-item:hover {
            background: rgba(0, 240, 255, 0.03);
            border-color: rgba(0, 240, 255, 0.1);
        }

        .feature-item-row {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .feature-item-info {
            flex: 1;
            min-width: 0;
            display: flex;
            align-items: baseline;
            gap: 8px;
        }

        .feature-item-name {
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .feature-item-version {
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px;
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .feature-item-tags {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            flex: 1;
        }

        .feature-tag {
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            font-weight: 600;
            padding: 3px 8px;
            border-radius: 4px;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }

        .tag-confluence {
            background: rgba(0, 240, 255, 0.08);
            color: var(--neon-cyan);
            border: 1px solid rgba(0, 240, 255, 0.15);
        }

        .tag-repo {
            background: rgba(168, 85, 247, 0.08);
            color: var(--neon-purple);
            border: 1px solid rgba(168, 85, 247, 0.15);
        }

        .tag-writeback {
            background: rgba(0, 255, 157, 0.08);
            color: var(--neon-green);
            border: 1px solid rgba(0, 255, 157, 0.15);
        }

        .feature-item-actions {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
        }

        .feature-item:hover .feature-item-actions {
            opacity: 1;
        }

        .no-features-msg {
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            color: var(--text-muted);
            text-align: center;
            padding: 20px;
            border: 1px dashed rgba(0, 240, 255, 0.08);
            border-radius: 10px;
        }

        /* ── Icon buttons ── */
        .icon-btn {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 240, 255, 0.05);
            border: 1px solid rgba(0, 240, 255, 0.1);
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            transition: var(--transition);
            padding: 0;
            flex-shrink: 0;
        }

        .icon-btn:hover {
            background: rgba(0, 240, 255, 0.12);
            border-color: rgba(0, 240, 255, 0.3);
            transform: scale(1.1);
        }

        .icon-btn-danger {
            border-color: rgba(244, 63, 94, 0.1);
            background: rgba(244, 63, 94, 0.05);
        }

        .icon-btn-danger:hover {
            background: rgba(244, 63, 94, 0.12);
            border-color: rgba(244, 63, 94, 0.3);
        }

        /* ── Analysis status grid (Threats tab) ── */
        .analysis-status-grid {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 12px;
            margin-bottom: 20px;
        }

        .analysis-status-item {
            padding: 12px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.03);
            text-align: center;
        }

        .analysis-status-label {
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 6px;
        }

        .status-badge-sm {
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 600;
            padding: 3px 10px;
            border-radius: 4px;
        }

        .status-badge-sm.status-complete {
            background: rgba(0, 255, 157, 0.1);
            color: var(--neon-green);
        }

        .status-badge-sm.status-pending {
            background: rgba(251, 191, 36, 0.1);
            color: var(--neon-amber);
        }

        .status-badge-sm.status-na {
            background: rgba(255, 255, 255, 0.03);
            color: var(--text-muted);
        }

        .analysis-date {
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            color: var(--text-secondary);
        }

        .card-analyzing {
            border-color: rgba(251, 191, 36, 0.3) !important;
            box-shadow: 0 0 30px rgba(251, 191, 36, 0.06);
        }

        .card-analyzing::before {
            opacity: 1 !important;
            background: linear-gradient(90deg, transparent, var(--neon-amber), transparent) !important;
            animation: scanLine 2s linear infinite !important;
        }

        @keyframes scanLine {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }

        /* ── Report type info ── */
        .report-type-info {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 20px;
        }

        /* ── Status badges ── */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 5px 12px;
            border-radius: 6px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 600;
            margin-top: 10px;
            letter-spacing: 0.5px;
            animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-8px); }
            to { opacity: 1; transform: translateX(0); }
        }

        .status-analyzing {
            background: rgba(251, 191, 36, 0.1);
            color: var(--neon-amber);
            border: 1px solid rgba(251, 191, 36, 0.2);
        }

        .status-complete {
            background: rgba(0, 255, 157, 0.08);
            color: var(--neon-green);
            border: 1px solid rgba(0, 255, 157, 0.2);
        }

        /* ── Tables ── */
        .table-container {
            background: var(--bg-card);
            border: 1px solid var(--border-dim);
            border-radius: 16px;
            overflow: hidden;
            backdrop-filter: blur(12px);
        }

        .data-table {
            width: 100%;
            border-collapse: collapse;
        }

        .data-table thead {
            background: rgba(0, 0, 0, 0.3);
        }

        .data-table th {
            padding: 16px 20px;
            text-align: left;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 600;
            color: var(--neon-cyan);
            text-transform: uppercase;
            letter-spacing: 1.5px;
            border-bottom: 1px solid var(--border-dim);
        }

        .data-table td {
            padding: 16px 20px;
            color: var(--text-secondary);
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
            font-size: 13px;
        }

        .data-table tbody tr {
            transition: var(--transition);
        }

        .data-table tbody tr:hover:not(.empty-row) {
            background: rgba(0, 240, 255, 0.03);
        }

        .table-actions {
            display: flex;
            gap: 8px;
        }

        .table-actions .button {
            padding: 7px 14px;
            font-size: 11px;
            min-width: auto;
        }

        /* ── Empty states ── */
        .empty-state {
            text-align: center;
            padding: 80px 20px;
            color: var(--text-muted);
            border-radius: 16px;
            border: 1px dashed rgba(0, 240, 255, 0.1);
        }

        .empty-state-icon {
            font-size: 64px;
            margin-bottom: 20px;
            opacity: 0.5;
            animation: iconPulse 3s ease-in-out infinite;
        }

        .empty-state h3 {
            font-family: 'JetBrains Mono', monospace;
            font-size: 22px;
            margin-bottom: 8px;
            color: var(--text-secondary);
        }

        .empty-state p {
            font-size: 14px;
            color: var(--text-muted);
        }

        /* ── Forms ── */
        .form-title {
            font-family: 'JetBrains Mono', monospace;
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 20px;
            color: var(--neon-cyan);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .form-title::before {
            content: '$';
            color: var(--neon-green);
            opacity: 0.5;
        }

        .form-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 16px;
            margin-bottom: 16px;
        }

        .form-group {
            display: flex;
            flex-direction: column;
        }

        label {
            display: block;
            margin-bottom: 6px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 600;
            color: var(--neon-cyan);
            text-transform: uppercase;
            letter-spacing: 1px;
            opacity: 0.7;
        }

        input, textarea, select {
            width: 100%;
            padding: 12px 16px;
            background: rgba(0, 0, 0, 0.3);
            color: var(--text-primary);
            border: 1px solid var(--border-dim);
            border-radius: 10px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            transition: var(--transition);
        }

        input:focus, textarea:focus, select:focus {
            outline: none;
            border-color: var(--neon-cyan);
            background: rgba(0, 240, 255, 0.03);
            box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.08), 0 0 20px rgba(0, 240, 255, 0.05);
        }

        input::placeholder { color: var(--text-muted); }

        select {
            cursor: pointer;
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2300f0ff' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 12px center;
            padding-right: 36px;
        }

        select option {
            background: var(--bg-secondary);
            color: var(--text-primary);
        }

        /* ── Spinner ── */
        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(0, 240, 255, 0.2);
            border-radius: 50%;
            border-top-color: var(--neon-cyan);
            animation: spin 0.7s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Modals ── */
        .modal {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(8px);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .modal.active {
            display: flex;
            animation: tabFadeIn 0.25s ease;
        }

        .modal-content {
            background: var(--bg-secondary);
            border: 1px solid var(--border-dim);
            border-radius: 20px;
            padding: 32px;
            max-width: 600px;
            width: 90%;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 0 80px rgba(0, 240, 255, 0.08), 0 20px 60px rgba(0, 0, 0, 0.5);
            position: relative;
        }

        .modal-content::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--neon-cyan), var(--neon-purple), transparent);
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
        }

        .modal-header h2 {
            font-family: 'JetBrains Mono', monospace;
            font-size: 20px;
            font-weight: 700;
            color: var(--neon-cyan);
            margin: 0;
        }

        .close-btn {
            background: none;
            border: 1px solid rgba(244, 63, 94, 0.2);
            color: var(--neon-pink);
            font-size: 20px;
            cursor: pointer;
            width: 32px;
            height: 32px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: var(--transition);
            padding: 0;
            line-height: 1;
        }

        .close-btn:hover {
            background: rgba(244, 63, 94, 0.1);
            border-color: rgba(244, 63, 94, 0.4);
            box-shadow: 0 0 15px rgba(244, 63, 94, 0.15);
        }

        .modal-actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
            justify-content: flex-end;
        }

        .modal-actions .button { min-width: 120px; }

        .add-product-section {
            background: var(--bg-card);
            border: 1px solid var(--border-dim);
            border-radius: 16px;
            padding: 28px;
            margin-bottom: 28px;
            backdrop-filter: blur(12px);
            transition: var(--transition);
        }

        .add-product-section:hover {
            border-color: var(--border-glow);
            box-shadow: 0 0 30px rgba(0, 240, 255, 0.05);
        }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb {
            background: rgba(0, 240, 255, 0.15);
            border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover { background: rgba(0, 240, 255, 0.25); }

        @media (max-width: 768px) {
            .nav-brand .brand-text { display: none; }
            .tab-button .tab-label { display: none; }
            .main-content { padding: 12px; }
            .products-grid { grid-template-columns: 1fr; }
            .form-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="scanline-overlay"></div>
    <div class="container">
        <!-- ── Top Navigation Bar ── -->
        <nav class="top-nav">
            <div class="nav-brand">
                <span class="brand-icon">🛡️</span>
                <span class="brand-text">AI Threat Modeling</span>
            </div>
            <div class="nav-tabs">
                <button class="tab-button active" onclick="switchTab('products', this)">
                    <span class="tab-icon">📦</span>
                    <span class="tab-label">Products</span>
                </button>
                <button class="tab-button" onclick="switchTab('threats', this)">
                    <span class="tab-icon">⚠️</span>
                    <span class="tab-label">Threats</span>
                </button>
                <button class="tab-button" onclick="switchTab('reports', this)">
                    <span class="tab-icon">📊</span>
                    <span class="tab-label">Reports</span>
                </button>
                <button class="tab-button" onclick="switchTab('risk', this)">
                    <span class="tab-icon">📈</span>
                    <span class="tab-label">CVSS Risk</span>
                </button>
            </div>
        </nav>

        <!-- ── Main Content Area ── -->
        <div class="main-content">

        <div id="products-tab" class="tab-content active">
            <div class="section-header">
                <h2>Products</h2>
                <div style="display:flex;gap:8px;">
                    <button class="button button-secondary" onclick="scanWorkspace()" title="Import products/features created by @threat-modeler agent or /full-threat-pipeline skill">⟳ Scan Workspace</button>
                    <button class="button" onclick="showAddProductModal()">+ Add Product</button>
                </div>
            </div>
            <div class="products-grid" id="productsContainer">
                <div class="empty-state">
                    <div class="empty-state-icon">📋</div>
                    <h3>No products yet</h3>
                    <p>Click "+ Add Product" to get started, or "Scan Workspace" to import products created by the @threat-modeler agent.</p>
                </div>
            </div>
        </div>

        <div id="threats-tab" class="tab-content">
            <div class="section-header">
                <h2>Threat Analysis</h2>
            </div>
            <div class="products-grid" id="threatsContainer">
                <div class="empty-state">
                    <div class="empty-state-icon">⚠️</div>
                    <h3>No features to analyze</h3>
                    <p>Add a product and features first, then come here to run threat analysis.</p>
                </div>
            </div>
        </div>

        <div id="reports-tab" class="tab-content">
            <div class="section-header">
                <h2>Reports</h2>
            </div>
            <div class="products-grid" id="reportsContainer">
                <div class="empty-state">
                    <div class="empty-state-icon">📊</div>
                    <h3>No reports yet</h3>
                    <p>Generate reports after running threat analysis on your features.</p>
                </div>
            </div>
        </div>

        <div id="risk-tab" class="tab-content">
            <div class="section-header">
                <h2>CVSS Risk Dashboard</h2>
                <button class="button button-secondary" onclick="refreshRiskMetrics()" style="padding:6px 16px;font-size:12px;">↻ Refresh</button>
            </div>
            <div id="riskOverview" class="risk-overview"></div>
            <div id="riskContainer"></div>
        </div>

        <!-- Add Product Modal -->
        <div id="addProductModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Add Product</h2>
                    <button class="close-btn" onclick="closeAddProductModal()">&times;</button>
                </div>
                <form id="addProductForm">
                    <div class="form-group">
                        <label for="productName">Product Name</label>
                        <input type="text" id="productName" required placeholder="e.g., Payment Service">
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="button button-secondary" onclick="closeAddProductModal()">Cancel</button>
                        <button type="submit" class="button">Add Product</button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Add Feature Modal -->
        <div id="addFeatureModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Add Feature</h2>
                    <button class="close-btn" onclick="closeAddFeatureModal()">&times;</button>
                </div>
                <form id="addFeatureForm">
                    <input type="hidden" id="featureProductId">
                    <div class="form-group">
                        <label for="featureName">Feature Name</label>
                        <input type="text" id="featureName" required placeholder="e.g., OAuth2 Integration">
                    </div>
                    <div class="form-group">
                        <label for="featureVersion">Version</label>
                        <input type="text" id="featureVersion" required placeholder="e.g., v3.1">
                    </div>
                    <div class="form-group">
                        <label>Confluence Page URLs</label>
                        <div id="confluenceUrlList">
                            <div class="url-entry" style="display:flex;gap:8px;margin-bottom:6px;">
                                <input type="text" class="confluence-url-input" placeholder="https://your-confluence.atlassian.net/wiki/pages/123456" style="flex:1;">
                                <button type="button" class="button button-danger" onclick="removeConfluenceUrl(this)" title="Remove">✕</button>
                            </div>
                        </div>
                        <button type="button" class="button button-secondary" onclick="addConfluenceUrlField()" style="margin-top:6px;">+ Add Another Page</button>
                    </div>
                    <div class="form-group">
                        <label>Repository URLs</label>
                        <div id="repositoryUrlList">
                            <div class="url-entry" style="display:flex;gap:8px;margin-bottom:6px;">
                                <input type="text" class="repository-url-input" placeholder="https://bitbucket.example.com/projects/PROJ/repos/my-repo" style="flex:1;">
                                <button type="button" class="button button-danger" onclick="removeRepositoryUrl(this)" title="Remove">✕</button>
                            </div>
                        </div>
                        <button type="button" class="button button-secondary" onclick="addRepositoryUrlField()" style="margin-top:6px;">+ Add Another Repository</button>
                        <small style="color: rgba(255, 255, 255, 0.5); display: block; margin-top: 4px;">
                            Examples:<br>
                            • https://bitbucket.example.com/projects/PROJ/repos/my-repo<br>
                            • https://github.com/user/repository<br>
                            • https://gitlab.com/user/repository
                        </small>
                    </div>
                    <div class="form-group" id="repositoryScopeGroup">
                        <label for="featureRepositoryScope">Repository Analysis Scope</label>
                        <select id="featureRepositoryScope" onchange="toggleScopeFields('add')">
                            <option value="full">Full Repository</option>
                            <option value="pr">Pull Request</option>
                            <option value="subdirectory">Subdirectory</option>
                        </select>
                    </div>
                    <!-- Conditional fields for PR scope -->
                    <div class="form-group" id="prUrlGroup" style="display:none;">
                        <label for="featurePrUrl">Pull Request URL (Optional if already entered above)</label>
                        <input type="text" id="featurePrUrl" placeholder="Leave empty if PR URL is already in Repository URL field">
                        <small style="color: rgba(255, 255, 255, 0.5); display: block; margin-top: 4px;">
                            If you entered the PR URL in the Repository URL field above, you can leave this blank.
                        </small>
                    </div>
                    <!-- Conditional fields for Subdirectory scope -->
                    <div class="form-group" id="subdirectoryGroup" style="display:none;">
                        <label>Subdirectory Paths</label>
                        <div id="subdirectoryPathList">
                            <div class="url-entry" style="display:flex;gap:8px;margin-bottom:6px;">
                                <input type="text" class="subdirectory-path-input" placeholder="/src/auth" style="flex:1;">
                                <button type="button" class="button button-danger" onclick="removeSubdirectoryPath(this)" title="Remove">✕</button>
                            </div>
                        </div>
                        <button type="button" class="button button-secondary" onclick="addSubdirectoryPathField()" style="margin-top:6px;">+ Add Another Path</button>
                    </div>
                    <div class="form-group">
                        <label for="featureWritebackUrl">Confluence Writeback Page (Optional)</label>
                        <input type="text" id="featureWritebackUrl" placeholder="https://confluence.example.com/pages/123456">
                        <small style="color: rgba(255, 255, 255, 0.5); display: block; margin-top: 4px;">
                            Parent page where the threat analysis report will be published as a child page after analysis.
                        </small>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="button button-secondary" onclick="closeAddFeatureModal()">Cancel</button>
                        <button type="submit" class="button">Add Feature</button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Edit Feature Modal -->
        <div id="editFeatureModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Edit Feature</h2>
                    <button class="close-btn" onclick="closeEditFeatureModal()">&times;</button>
                </div>
                <form id="editFeatureForm">
                    <input type="hidden" id="editFeatureProductId">
                    <input type="hidden" id="editFeatureId">
                    <div class="form-group">
                        <label for="editFeatureName">Feature Name</label>
                        <input type="text" id="editFeatureName" required placeholder="e.g., OAuth2 Integration">
                    </div>
                    <div class="form-group">
                        <label for="editFeatureVersion">Version</label>
                        <input type="text" id="editFeatureVersion" required placeholder="e.g., v3.1">
                    </div>
                    <div class="form-group">
                        <label>Confluence Page URLs</label>
                        <div id="editConfluenceUrlList"></div>
                        <button type="button" class="button button-secondary" onclick="addEditConfluenceUrlField('')" style="margin-top:6px;">+ Add Another Page</button>
                    </div>
                    <div class="form-group">
                        <label>Repository URLs</label>
                        <div id="editRepositoryUrlList"></div>
                        <button type="button" class="button button-secondary" onclick="addEditRepositoryUrlField('')" style="margin-top:6px;">+ Add Another Repository</button>
                        <small style="color: rgba(255, 255, 255, 0.5); display: block; margin-top: 4px;">
                            Examples:<br>
                            • https://bitbucket.example.com/projects/PROJ/repos/my-repo<br>
                            • https://github.com/user/repository<br>
                            • https://gitlab.com/user/repository
                        </small>
                    </div>
                    <div class="form-group" id="editRepositoryScopeGroup" style="display:none;">
                        <label for="editFeatureRepositoryScope">Repository Analysis Scope</label>
                        <select id="editFeatureRepositoryScope" onchange="toggleScopeFields('edit')">
                            <option value="full">Full Repository</option>
                            <option value="pr">Pull Request</option>
                            <option value="subdirectory">Subdirectory</option>
                        </select>
                    </div>
                    <!-- Conditional fields for PR scope -->
                    <div class="form-group" id="editPrUrlGroup" style="display:none;">
                        <label for="editFeaturePrUrl">Pull Request URL (Optional if already entered above)</label>
                        <input type="text" id="editFeaturePrUrl" placeholder="Leave empty if PR URL is already in Repository URL field">
                        <small style="color: rgba(255, 255, 255, 0.5); display: block; margin-top: 4px;">
                            If you entered the PR URL in the Repository URL field above, you can leave this blank.
                        </small>
                    </div>
                    <!-- Conditional fields for Subdirectory scope -->
                    <div class="form-group" id="editSubdirectoryGroup" style="display:none;">
                        <label>Subdirectory Paths</label>
                        <div id="editSubdirectoryPathList"></div>
                        <button type="button" class="button button-secondary" onclick="addEditSubdirectoryPathField('')" style="margin-top:6px;">+ Add Another Path</button>
                    </div>
                    <div class="form-group">
                        <label for="editFeatureWritebackUrl">Confluence Writeback Page (Optional)</label>
                        <input type="text" id="editFeatureWritebackUrl" placeholder="https://confluence.example.com/pages/123456">
                        <small style="color: rgba(255, 255, 255, 0.5); display: block; margin-top: 4px;">
                            Parent page where the threat analysis report will be published as a child page after analysis.
                        </small>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="button button-secondary" onclick="closeEditFeatureModal()">Cancel</button>
                        <button type="submit" class="button">Update Feature</button>
                    </div>
                </form>
            </div>
        </div>
        </div><!-- /main-content -->
    </div><!-- /container -->

    <script>
        const vscode = acquireVsCodeApi();
        let products = [];
        const _loadingOps = new Set();

        vscode.postMessage({ command: 'getProducts' });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'setButtonLoading') {
                _loadingOps.add(message.productId + '|' + message.featureId + '|' + message.operation);
                renderProducts();
                renderReports();
                return;
            }
            if (message.command === 'clearButtonLoading') {
                _loadingOps.delete(message.productId + '|' + message.featureId + '|' + message.operation);
                renderProducts();
                renderReports();
                return;
            }
            switch (message.command) {
                case 'productsUpdated':
                    products = message.products;
                    renderProducts();
                    renderThreats();
                    renderReports();
                    break;
                case 'riskMetricsUpdated':
                    renderRiskDashboard(message.metrics);
                    break;
                case 'openEditFeature':
                    editFeature(message.productId, message.featureId);
                    break;
            }
        });

        // Tab switching
        window.switchTab = function(tabName, clickedButton) {
            document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            if (clickedButton) {
                clickedButton.classList.add('active');
            }
            const targetTab = document.getElementById(tabName + '-tab');
            if (targetTab) {
                targetTab.classList.add('active');
            }
            if (tabName === 'risk') {
                vscode.postMessage({ command: 'getRiskMetrics' });
            }
        };

        // Modal functions
        window.showAddProductModal = function() {
            document.getElementById('addProductModal').classList.add('active');
        };

        window.scanWorkspace = function() {
            vscode.postMessage({ command: 'scanWorkspace' });
        };

        window.closeAddProductModal = function() {
            document.getElementById('addProductModal').classList.remove('active');
            document.getElementById('addProductForm').reset();
        };

        // Form submission for Product
        document.getElementById('addProductForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const productName = document.getElementById('productName').value;
            vscode.postMessage({ command: 'addProduct', productName });
            closeAddProductModal();
        });

        // Form submission for Feature
        document.getElementById('addFeatureForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const confluenceUrls = Array.from(document.querySelectorAll('#confluenceUrlList .confluence-url-input'))
                .map(input => input.value.trim())
                .filter(url => url.length > 0);
            const repositoryUrls = Array.from(document.querySelectorAll('#repositoryUrlList .repository-url-input'))
                .map(input => input.value.trim())
                .filter(url => url.length > 0);
            
            if (confluenceUrls.length === 0 && repositoryUrls.length === 0) {
                vscode.postMessage({ command: 'showError', message: 'Please provide at least one Confluence URL or Repository URL' });
                return;
            }
            
            const feature = {
                name: document.getElementById('featureName').value,
                version: document.getElementById('featureVersion').value,
                confluenceUrls,
                repositoryUrls,
                confluenceWritebackUrl: document.getElementById('featureWritebackUrl').value.trim() || undefined
            };
            
            // Add repository scope fields if repository URLs provided
            if (repositoryUrls.length > 0) {
                const scope = document.getElementById('featureRepositoryScope').value;
                feature.repositoryScope = scope;
                
                if (scope === 'pr') {
                    // Use prUrl field if filled, otherwise check if first repositoryUrl looks like a PR
                    let prUrlValue = document.getElementById('featurePrUrl').value.trim();
                    if (!prUrlValue && repositoryUrls.length > 0) {
                        // Check if first repositoryUrl is actually a PR URL
                        const firstRepoUrl = repositoryUrls[0];
                        if (firstRepoUrl.includes('/pull-requests/') || firstRepoUrl.includes('/pull/')) {
                            prUrlValue = firstRepoUrl;
                        }
                    }
                    if (!prUrlValue) {
                        vscode.postMessage({ command: 'showError', message: 'Please provide a Pull Request URL' });
                        return;
                    }
                    feature.prUrl = prUrlValue;
                } else if (scope === 'subdirectory') {
                    const subdirectoryPaths = Array.from(document.querySelectorAll('#subdirectoryPathList .subdirectory-path-input'))
                        .map(input => input.value.trim())
                        .filter(path => path.length > 0);
                    if (subdirectoryPaths.length === 0) {
                        vscode.postMessage({ command: 'showError', message: 'Please provide at least one Subdirectory Path' });
                        return;
                    }
                    feature.subdirectoryPaths = subdirectoryPaths;
                }
            }
            
            const productId = document.getElementById('featureProductId').value;
            vscode.postMessage({ command: 'addFeature', productId, feature });
            closeAddFeatureModal();
        });

        // Form submission for Edit Feature
        document.getElementById('editFeatureForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const confluenceUrls = Array.from(document.querySelectorAll('#editConfluenceUrlList .confluence-url-input'))
                .map(input => input.value.trim())
                .filter(url => url.length > 0);
            const repositoryUrls = Array.from(document.querySelectorAll('#editRepositoryUrlList .repository-url-input'))
                .map(input => input.value.trim())
                .filter(url => url.length > 0);
            
            if (confluenceUrls.length === 0 && repositoryUrls.length === 0) {
                vscode.postMessage({ command: 'showError', message: 'Please provide at least one Confluence URL or Repository URL' });
                return;
            }
            
            const feature = {
                name: document.getElementById('editFeatureName').value,
                version: document.getElementById('editFeatureVersion').value,
                confluenceUrls,
                repositoryUrls,
                confluenceWritebackUrl: document.getElementById('editFeatureWritebackUrl').value.trim() || undefined
            };
            
            // Add repository scope fields if repository URLs provided
            if (repositoryUrls.length > 0) {
                const scope = document.getElementById('editFeatureRepositoryScope').value;
                feature.repositoryScope = scope;
                
                if (scope === 'pr') {
                    // Use prUrl field if filled, otherwise check if first repositoryUrl looks like a PR
                    let prUrlValue = document.getElementById('editFeaturePrUrl').value.trim();
                    if (!prUrlValue && repositoryUrls.length > 0) {
                        // Check if first repositoryUrl is actually a PR URL
                        const firstRepoUrl = repositoryUrls[0];
                        if (firstRepoUrl.includes('/pull-requests/') || firstRepoUrl.includes('/pull/')) {
                            prUrlValue = firstRepoUrl;
                        }
                    }
                    if (!prUrlValue) {
                        vscode.postMessage({ command: 'showError', message: 'Please provide a Pull Request URL' });
                        return;
                    }
                    feature.prUrl = prUrlValue;
                } else if (scope === 'subdirectory') {
                    const subdirectoryPaths = Array.from(document.querySelectorAll('#editSubdirectoryPathList .subdirectory-path-input'))
                        .map(input => input.value.trim())
                        .filter(path => path.length > 0);
                    if (subdirectoryPaths.length === 0) {
                        vscode.postMessage({ command: 'showError', message: 'Please provide at least one Subdirectory Path' });
                        return;
                    }
                    feature.subdirectoryPaths = subdirectoryPaths;
                }
            }
            
            const productId = document.getElementById('editFeatureProductId').value;
            const featureId = document.getElementById('editFeatureId').value;
            vscode.postMessage({ command: 'editFeature', productId, featureId, feature });
            closeEditFeatureModal();
        });

        // Event delegation for repository URL inputs in Add Feature modal
        const repoListAdd = document.getElementById('repositoryUrlList');
        if (repoListAdd) {
            repoListAdd.addEventListener('input', (e) => {
                if (e.target && e.target.classList && e.target.classList.contains('repository-url-input')) {
                    updateRepositoryScopeVisibility('add');
                }
            });
        }

        // Render Products Table
        function renderProducts() {
            const container = document.getElementById('productsContainer');
            if (products.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state" style="grid-column: 1 / -1;">
                        <div class="empty-state-icon">📋</div>
                        <h3>No products yet</h3>
                        <p>Click "+ Add Product" to get started with threat modeling.</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = products.map(product => {
                const featureCount = product.features ? product.features.length : 0;
                
                const featuresHtml = product.features && product.features.length > 0
                    ? product.features.map(f => {
                        const tags = [];
                        if (f.confluencePageUrls && f.confluencePageUrls.length > 0) tags.push('<span class="feature-tag tag-confluence">Confluence</span>');
                        if (f.repositoryUrls && f.repositoryUrls.length > 0) tags.push('<span class="feature-tag tag-repo">Repository</span>');
                        if (f.confluenceWritebackUrl) tags.push('<span class="feature-tag tag-writeback">Writeback</span>');
                        
                        return \`
                        <div class="feature-item">
                            <div class="feature-item-row">
                                <div class="feature-item-info">
                                    <div class="feature-item-name">\${f.name}</div>
                                    <div class="feature-item-version">v\${f.version}</div>
                                </div>
                                <button class="icon-btn" onclick="editFeature('\${product.id}', '\${f.id}')" title="Edit feature">✏️</button>
                                <button class="icon-btn icon-btn-danger" onclick="deleteFeature('\${product.id}', '\${f.id}')" title="Delete feature">🗑️</button>
                            </div>
                            <div class="feature-item-row">
                                <div class="feature-item-tags">\${tags.join('')}</div>
                            </div>
                        </div>
                    \`;
                    }).join('')
                    : '<div class="no-features-msg">No features added yet</div>';
                
                return \`
                <div class="product-card">
                    <div class="product-header">
                        <div class="product-name">\${product.name}</div>
                        <div class="product-meta">\${featureCount} feature\${featureCount !== 1 ? 's' : ''}</div>
                    </div>
                    <div class="features-list">
                        \${featuresHtml}
                    </div>
                    <div class="product-actions">
                        <button class="button" onclick="showAddFeatureModal('\${product.id}')">+ Add Feature</button>
                        <button class="icon-btn icon-btn-danger" onclick="deleteProduct('\${product.id}')" title="Delete product">🗑️</button>
                    </div>
                </div>
            \`;
            }).join('');
        }

        // Render Threats Table
        function renderThreats() {
            const container = document.getElementById('threatsContainer');
            const productsWithFeatures = products.filter(p => p.features && p.features.length > 0);
            
            if (productsWithFeatures.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state" style="grid-column: 1 / -1;">
                        <div class="empty-state-icon">⚠️</div>
                        <h3>No features to analyze</h3>
                        <p>Add a product and features first, then come here to run threat analysis.</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = productsWithFeatures.map(product => {
                const featuresHtml = product.features.map(feature => {
                    const isAnalyzing = _loadingOps.has(product.id + '|' + feature.id + '|analyze');
                    const repoHasUrls = feature.repositoryUrls && feature.repositoryUrls.length > 0;
                    const repoStatus = feature.hasRepoAnalysis ? 'complete' : (repoHasUrls ? 'pending' : 'na');
                    const docStatus = feature.hasDocAnalysis ? 'complete' : 'pending';
                    const repoLabel = repoStatus === 'complete' ? 'Done' : (repoStatus === 'pending' ? 'Pending' : 'N/A');
                    const docLabel = docStatus === 'complete' ? 'Done' : 'Pending';
                    const prWatchOn = !!feature.prWatchEnabled;
                    const prWatchTitle = prWatchOn
                        ? 'PR watching enabled — polling for new PRs'
                        : 'Enable PR watching to auto-detect new pull requests';
                    const hasConfluenceUrls = feature.confluenceUrls && feature.confluenceUrls.length > 0;
                    const confWatchOn = !!feature.confluenceWatchEnabled;
                    const confWatchTitle = confWatchOn
                        ? 'Confluence watching enabled — polling for spec changes'
                        : 'Enable Confluence watching to auto-detect spec updates';

                    return \`
                        <div class="feature-item \${isAnalyzing ? 'feature-analyzing' : ''}">
                            <div class="feature-item-row">
                                <div class="feature-item-info">
                                    <div class="feature-item-name">\${feature.name}</div>
                                    <div class="feature-item-version">\${feature.version}</div>
                                </div>
                                <button class="icon-btn icon-btn-danger" onclick="deleteFeature('\${product.id}', '\${feature.id}')" title="Delete feature">🗑️</button>
                            </div>
                            <div class="feature-item-row">
                                <div class="feature-item-tags">
                                    <span class="feature-tag \${repoStatus === 'complete' ? 'tag-writeback' : (repoStatus === 'pending' ? 'tag-repo' : '')}" style="\${repoStatus === 'na' ? 'opacity:0.3;' : ''}">Repo: \${repoLabel}</span>
                                    <span class="feature-tag \${docStatus === 'complete' ? 'tag-writeback' : 'tag-confluence'}">Doc: \${docLabel}</span>
                                </div>
                                <div style="display:flex;align-items:center;gap:6px;">
                                    \${repoHasUrls ? \`<label class="pr-watch-toggle" title="\${prWatchTitle}" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:\${prWatchOn ? 'var(--accent)' : 'rgba(255,255,255,0.4)'};">
                                        <input type="checkbox" \${prWatchOn ? 'checked' : ''} onchange="togglePRWatch('\${product.id}', '\${feature.id}', '\${feature.name}', this.checked)" style="accent-color:var(--accent);cursor:pointer;">
                                        🔄 PR Watch
                                    </label>\` : ''}
                                    \${hasConfluenceUrls ? \`<label class="conf-watch-toggle" title="\${confWatchTitle}" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:\${confWatchOn ? 'var(--accent)' : 'rgba(255,255,255,0.4)'};">
                                        <input type="checkbox" \${confWatchOn ? 'checked' : ''} onchange="toggleConfluenceWatch('\${product.id}', '\${feature.id}', '\${feature.name}', this.checked)" style="accent-color:var(--accent);cursor:pointer;">
                                        📄 Doc Watch
                                    </label>\` : ''}
                                    <button class="button" style="padding:6px 14px;font-size:10px;" onclick="analyze('\${product.id}', '\${feature.id}')" \${isAnalyzing ? 'disabled style="opacity:0.5;cursor:not-allowed;padding:6px 14px;font-size:10px;"' : ''}>
                                        \${isAnalyzing ? '<span class="spinner"></span> Analyzing...' : '🔍 Analyze'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    \`;
                }).join('');

                return \`
                <div class="product-card">
                    <div class="product-header">
                        <div class="product-name">\${product.name}</div>
                        <div class="product-meta">\${product.features.length} feature\${product.features.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div class="features-list">
                        \${featuresHtml}
                    </div>
                </div>
                \`;
            }).join('');
        }

        // Render Reports Table
        function renderReports() {
            const container = document.getElementById('reportsContainer');
            const productsWithFeatures = products.filter(p => p.features && p.features.length > 0);
            
            if (productsWithFeatures.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state" style="grid-column: 1 / -1;">
                        <div class="empty-state-icon">📊</div>
                        <h3>No reports yet</h3>
                        <p>Generate reports after running threat analysis on your features.</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = productsWithFeatures.map(product => {
                const featuresHtml = product.features.map(feature => {
                    const isGenerating = _loadingOps.has(product.id + '|' + feature.id + '|report');
                    const isPublishing = _loadingOps.has(product.id + '|' + feature.id + '|publish');
                    const isCreatingJira = _loadingOps.has(product.id + '|' + feature.id + '|jira');
                    const hasWriteback = !!feature.confluenceWritebackUrl;

                    return \`
                        <div class="feature-item">
                            <div class="feature-item-row">
                                <div class="feature-item-info">
                                    <div class="feature-item-name">\${feature.name}</div>
                                    <div class="feature-item-version">\${feature.version}</div>
                                </div>
                            </div>
                            <div class="feature-item-row">
                                <div class="feature-item-actions">
                                    <button class="button" style="padding:6px 14px;font-size:10px;" onclick="generateReport('\${product.id}', '\${feature.id}')" \${isGenerating ? 'disabled style="opacity:0.5;cursor:not-allowed;padding:6px 14px;font-size:10px;"' : ''}>
                                        \${isGenerating ? '<span class="spinner"></span> Generating...' : '📊 Report'}
                                    </button>
                                    <button class="button button-secondary" style="padding:6px 14px;font-size:10px;"
                                        onclick="publishToConfluence('\${product.id}', '\${feature.id}')"
                                        title="\${hasWriteback ? 'Publish to: ' + feature.confluenceWritebackUrl : 'Edit feature to set writeback page'}"
                                        \${!hasWriteback || isPublishing ? 'disabled' : ''}
                                        \${!hasWriteback ? 'style="opacity:0.4;cursor:not-allowed;padding:6px 14px;font-size:10px;"' : (isPublishing ? 'style="opacity:0.5;cursor:not-allowed;padding:6px 14px;font-size:10px;"' : 'style="padding:6px 14px;font-size:10px;"')}>
                                        \${isPublishing ? '<span class="spinner"></span> Publishing...' : '📤 Publish'}
                                    </button>
                                    <button class="button button-secondary" style="padding:6px 14px;font-size:10px;"
                                        onclick="createJiraIssues('\${product.id}', '\${feature.id}')"
                                        title="Create Jira tickets for Critical/High threats"
                                        \${isCreatingJira ? 'disabled style="opacity:0.5;cursor:not-allowed;padding:6px 14px;font-size:10px;"' : ''}>
                                        \${isCreatingJira ? '<span class="spinner"></span> Creating...' : '🎫 Jira'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    \`;
                }).join('');

                return \`
                <div class="product-card">
                    <div class="product-header">
                        <div class="product-name">\${product.name}</div>
                        <div class="product-meta">\${product.features.length} feature\${product.features.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div class="features-list">
                        \${featuresHtml}
                    </div>
                </div>
                \`;
            }).join('');
        }

        // ── CVSS v3.1 Risk Score helpers ──────────────────────────────────────
        // Score is 0–10 (higher = more risk). Colors follow CVSS qualitative ratings.
        function scoreColor(s) {
            if (s < 0)   return 'rgba(255,255,255,0.3)'; // N/A
            if (s === 0)  return '#00ff9d';               // None
            if (s <= 3.9) return '#22d3ee';               // Low
            if (s <= 6.9) return '#fbbf24';               // Medium
            if (s <= 8.9) return '#f97316';               // High
            return '#f43f5e';                             // Critical
        }

        function scoreLabel(s) {
            if (s < 0)   return 'N/A';
            if (s === 0)  return 'None';
            if (s <= 3.9) return 'Low';
            if (s <= 6.9) return 'Medium';
            if (s <= 8.9) return 'High';
            return 'Critical';
        }

        function buildGauge(score) {
            var r = 50, circ = 2 * Math.PI * r;
            var col = scoreColor(score);
            var lbl = scoreLabel(score);
            if (score < 0) {
                return '<svg viewBox="0 0 120 120" width="120" height="120">' +
                    '<circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="10"/>' +
                    '<text x="60" y="64" text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.3)">No data</text>' +
                    '</svg>';
            }
            // Gauge fills proportionally on 0–10 scale
            var offset = (circ * (1 - score / 10)).toFixed(1);
            return '<svg viewBox="0 0 120 120" width="120" height="120">' +
                '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="10"/>' +
                '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="10"' +
                ' stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + offset + '"' +
                ' stroke-linecap="round" transform="rotate(-90 60 60)"' +
                ' style="filter:drop-shadow(0 0 6px ' + col + ');transition:stroke-dashoffset 0.8s ease;"/>' +
                '<text x="60" y="54" text-anchor="middle" font-size="24" font-weight="800" fill="' + col + '">' + score + '</text>' +
                '<text x="60" y="68" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.45)">' + lbl + '</text>' +
                '</svg>';
        }
        function buildStackedBar(c, h, m, l, total) {
            if (total === 0) { return '<div class="risk-no-analysis">No threats found</div>'; }
            function pct(n) { return ((n / total) * 100).toFixed(1) + '%'; }
            var bar = '<div class="stacked-bar" title="Critical:' + c + '  High:' + h + '  Medium:' + m + '  Low:' + l + '">';
            if (c > 0) bar += '<div class="bar-seg bar-seg-critical" style="width:' + pct(c) + '"></div>';
            if (h > 0) bar += '<div class="bar-seg bar-seg-high" style="width:' + pct(h) + '"></div>';
            if (m > 0) bar += '<div class="bar-seg bar-seg-medium" style="width:' + pct(m) + '"></div>';
            if (l > 0) bar += '<div class="bar-seg bar-seg-low" style="width:' + pct(l) + '"></div>';
            bar += '</div>';
            var legend = '<div class="stacked-bar-legend">';
            if (c > 0) legend += '<span><span class="legend-dot" style="background:#f43f5e"></span>' + c + ' Critical</span>';
            if (h > 0) legend += '<span><span class="legend-dot" style="background:#f97316"></span>' + h + ' High</span>';
            if (m > 0) legend += '<span><span class="legend-dot" style="background:#fbbf24"></span>' + m + ' Medium</span>';
            if (l > 0) legend += '<span><span class="legend-dot" style="background:#00ff9d"></span>' + l + ' Low</span>';
            legend += '<span style="margin-left:auto;color:var(--text-muted)">' + total + ' total</span></div>';
            return bar + legend;
        }
        window.refreshRiskMetrics = function() { vscode.postMessage({ command: 'getRiskMetrics' }); };

        function renderRiskDashboard(metrics) {
            if (!metrics || metrics.length === 0) {
                document.getElementById('riskOverview').innerHTML = '';
                document.getElementById('riskContainer').innerHTML =
                    '<div class="empty-state"><div class="empty-state-icon">&#128200;</div>' +
                    '<h3>No data yet</h3><p>Add features and run threat analysis to see risk scores.</p></div>';
                return;
            }
            var analyzed  = metrics.filter(function(m) { return m.hasAnalysis; });
            var totalCrit = metrics.reduce(function(s,m){ return s + m.critical; }, 0);
            var totalHigh = metrics.reduce(function(s,m){ return s + m.high;     }, 0);
            var totalMed  = metrics.reduce(function(s,m){ return s + m.medium;   }, 0);
            var totalLow  = metrics.reduce(function(s,m){ return s + m.low;      }, 0);
            var validScores = metrics.filter(function(m){ return m.score >= 0; }).map(function(m){ return m.score; });
            var avgScore = validScores.length > 0
                ? Math.round(validScores.reduce(function(a,b){ return a+b; }, 0) / validScores.length * 10) / 10 : -1;
            var avgCol = scoreColor(avgScore);
            document.getElementById('riskOverview').innerHTML =
                '<div class="risk-stat-card"><div class="risk-stat-value" style="color:' + avgCol + '">' +
                    (avgScore >= 0 ? avgScore : 'N/A') + '</div><div class="risk-stat-label">Avg CVSS Score</div></div>' +
                '<div class="risk-stat-card"><div class="risk-stat-value" style="color:#f43f5e">' + totalCrit + '</div><div class="risk-stat-label">Critical Threats</div></div>' +
                '<div class="risk-stat-card"><div class="risk-stat-value" style="color:#f97316">' + totalHigh + '</div><div class="risk-stat-label">High Threats</div></div>' +
                '<div class="risk-stat-card"><div class="risk-stat-value" style="color:#fbbf24">' + totalMed  + '</div><div class="risk-stat-label">Medium Threats</div></div>' +
                '<div class="risk-stat-card"><div class="risk-stat-value" style="color:#00ff9d">' + totalLow  + '</div><div class="risk-stat-label">Low Threats</div></div>' +
                '<div class="risk-stat-card"><div class="risk-stat-value" style="color:var(--neon-cyan)">' +
                    analyzed.length + '/' + metrics.length + '</div><div class="risk-stat-label">Features Analyzed</div></div>';
            var byProduct = {};
            metrics.forEach(function(m) {
                if (!byProduct[m.productId]) { byProduct[m.productId] = { name: m.productName, features: [] }; }
                byProduct[m.productId].features.push(m);
            });
            var html = '';
            Object.values(byProduct).forEach(function(prod) {
                var pScores = prod.features.filter(function(f){ return f.score >= 0; }).map(function(f){ return f.score; });
                var pAvg = pScores.length > 0 ? Math.round(pScores.reduce(function(a,b){return a+b;},0) / pScores.length * 10) / 10 : -1;
                var pCol = scoreColor(pAvg);
                var featureRows = '';
                prod.features.forEach(function(f) {
                    featureRows +=
                        '<div class="risk-feature-row">' +
                          '<div class="risk-gauge-cell">' +
                            buildGauge(f.score) +
                            '<div class="risk-gauge-name" title="' + f.featureName + '">' + f.featureName + '</div>' +
                            '<div class="risk-gauge-ver">v' + f.version + '</div>' +
                          '</div>' +
                          '<div class="stacked-bar-wrap">' +
                            (f.hasAnalysis ? buildStackedBar(f.critical, f.high, f.medium, f.low, f.total)
                                           : '<div class="risk-no-analysis">Analysis not run yet</div>') +
                          '</div>' +
                        '</div>';
                });
                html +=
                    '<div class="risk-product-block">' +
                      '<div class="risk-product-header" onclick="var s=this.nextElementSibling.style;s.display=s.display===&quot;none&quot;?&quot;&quot;:&quot;none&quot;">' +
                        '<span class="risk-product-title">&#128230; ' + prod.name + '</span>' +
                        '<div class="risk-product-score">' +
                          '<span style="font-size:12px;color:var(--text-muted)">' + prod.features.length + ' feature' + (prod.features.length !== 1 ? 's' : '') + '</span>' +
                          '<span class="risk-score-pill" style="background:' + pCol + '22;color:' + pCol + ';border:1px solid ' + pCol + '66;">' +
                            'CVSS: ' + (pAvg >= 0 ? pAvg : 'N/A') +
                          '</span>' +
                        '</div>' +
                      '</div>' +
                      '<div class="risk-feature-rows">' + featureRows + '</div>' +
                    '</div>';
            });
            document.getElementById('riskContainer').innerHTML = html;
        }
        window.showAddFeatureModal = function(productId) {
            document.getElementById('featureProductId').value = productId;
            // Reset Confluence URL list to a single empty entry
            document.getElementById('confluenceUrlList').innerHTML = \`
                <div class="url-entry" style="display:flex;gap:8px;margin-bottom:6px;">
                    <input type="text" class="confluence-url-input" placeholder="https://your-confluence.atlassian.net/wiki/pages/123456" style="flex:1;">
                    <button type="button" class="button button-danger" onclick="removeConfluenceUrl(this)" title="Remove">✕</button>
                </div>\`;
            // Reset Repository URL list to a single empty entry
            document.getElementById('repositoryUrlList').innerHTML = \`
                <div class="url-entry" style="display:flex;gap:8px;margin-bottom:6px;">
                    <input type="text" class="repository-url-input" placeholder="https://bitbucket.example.com/projects/PROJ/repos/my-repo" style="flex:1;">
                    <button type="button" class="button button-danger" onclick="removeRepositoryUrl(this)" title="Remove">✕</button>
                </div>\`;
            // Hide scope dropdown initially
            document.getElementById('repositoryScopeGroup').style.display = '';
            document.getElementById('addFeatureModal').classList.add('active');
        }

        window.closeAddFeatureModal = function() {
            document.getElementById('addFeatureModal').classList.remove('active');
            document.getElementById('addFeatureForm').reset();
        };

        window.addConfluenceUrlField = function() {
            const list = document.getElementById('confluenceUrlList');
            const entry = document.createElement('div');
            entry.className = 'url-entry';
            entry.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';
            entry.innerHTML = \`
                <input type="text" class="confluence-url-input" placeholder="https://your-confluence.atlassian.net/wiki/pages/123456" style="flex:1;">
                <button type="button" class="button button-danger" onclick="removeConfluenceUrl(this)" title="Remove">✕</button>\`;
            list.appendChild(entry);
        };

        window.removeConfluenceUrl = function(btn) {
            const list = document.getElementById('confluenceUrlList');
            if (list.querySelectorAll('.url-entry').length > 1) {
                btn.parentElement.remove();
            } else {
                btn.previousElementSibling.value = '';
            }
        };

        window.addEditConfluenceUrlField = function(value) {
            const list = document.getElementById('editConfluenceUrlList');
            const entry = document.createElement('div');
            entry.className = 'url-entry';
            entry.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';
            entry.innerHTML = \`
                <input type="text" class="confluence-url-input" placeholder="https://your-confluence.atlassian.net/wiki/pages/123456" style="flex:1;" value="\${value || ''}">
                <button type="button" class="button button-danger" onclick="removeEditConfluenceUrl(this)" title="Remove">✕</button>\`;
            list.appendChild(entry);
        };

        window.removeEditConfluenceUrl = function(btn) {
            const list = document.getElementById('editConfluenceUrlList');
            if (list.querySelectorAll('.url-entry').length > 1) {
                btn.parentElement.remove();
            } else {
                btn.previousElementSibling.value = '';
            }
        };

        // Repository URL management for Add Feature
        window.addRepositoryUrlField = function() {
            const list = document.getElementById('repositoryUrlList');
            const entry = document.createElement('div');
            entry.className = 'url-entry';
            entry.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';
            entry.innerHTML = \`
                <input type="text" class="repository-url-input" placeholder="https://bitbucket.example.com/projects/PROJ/repos/my-repo" style="flex:1;">
                <button type="button" class="button button-danger" onclick="removeRepositoryUrl(this)" title="Remove">✕</button>\`;
            list.appendChild(entry);
            updateRepositoryScopeVisibility('add');
        };

        window.removeRepositoryUrl = function(btn) {
            const list = document.getElementById('repositoryUrlList');
            if (list.querySelectorAll('.url-entry').length > 1) {
                btn.parentElement.remove();
            } else {
                btn.previousElementSibling.value = '';
            }
            updateRepositoryScopeVisibility('add');
        };

        // Repository URL management for Edit Feature
        window.addEditRepositoryUrlField = function(value) {
            const list = document.getElementById('editRepositoryUrlList');
            const entry = document.createElement('div');
            entry.className = 'url-entry';
            entry.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';
            entry.innerHTML = \`
                <input type="text" class="repository-url-input" placeholder="https://bitbucket.example.com/projects/PROJ/repos/my-repo" style="flex:1;" value="\${value || ''}">
                <button type="button" class="button button-danger" onclick="removeEditRepositoryUrl(this)" title="Remove">✕</button>\`;
            list.appendChild(entry);
            updateRepositoryScopeVisibility('edit');
        }

        window.removeEditRepositoryUrl = function(btn) {
            const list = document.getElementById('editRepositoryUrlList');
            if (list.querySelectorAll('.url-entry').length > 1) {
                btn.parentElement.remove();
            } else {
                btn.previousElementSibling.value = '';
            }
            updateRepositoryScopeVisibility('edit');
        }

        // Update scope dropdown visibility based on repository URLs
        function updateRepositoryScopeVisibility(mode) {
            const prefix = mode === 'edit' ? 'edit' : '';
            const listId = prefix ? 'editRepositoryUrlList' : 'repositoryUrlList';
            const scopeGroupId = prefix ? 'editRepositoryScopeGroup' : 'repositoryScopeGroup';
            
            const inputs = document.querySelectorAll('#' + listId + ' .repository-url-input');
            const repoUrls = [];
            inputs.forEach(input => {
                const val = input.value.trim();
                if (val.length > 0) repoUrls.push(val);
            });
            
            const scopeGroup = document.getElementById(scopeGroupId);
            if (scopeGroup) {
                scopeGroup.style.display = repoUrls.length > 0 ? 'block' : 'none';
            }
        }

        window.toggleScopeFields = function(mode) {
            const prefix = mode === 'edit' ? 'edit' : '';
            const scope = document.getElementById(prefix + 'FeatureRepositoryScope').value;
            
            // Hide all conditional fields first
            const prGroup = document.getElementById(prefix + 'PrUrlGroup');
            const subGroup = document.getElementById(prefix + 'SubdirectoryGroup');
            
            if (prGroup) prGroup.style.display = 'none';
            if (subGroup) subGroup.style.display = 'none';
            
            // Show relevant fields based on scope
            if (scope === 'pr' && prGroup) {
                prGroup.style.display = 'block';
            } else if (scope === 'subdirectory' && subGroup) {
                subGroup.style.display = 'block';
            }
        }

        // Subdirectory path management for Add Feature
        window.addSubdirectoryPathField = function() {
            const list = document.getElementById('subdirectoryPathList');
            const entry = document.createElement('div');
            entry.className = 'url-entry';
            entry.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';
            entry.innerHTML = \`
                <input type="text" class="subdirectory-path-input" placeholder="/src/auth" style="flex:1;">
                <button type="button" class="button button-danger" onclick="removeSubdirectoryPath(this)" title="Remove">✕</button>\`;
            list.appendChild(entry);
        }

        window.removeSubdirectoryPath = function(btn) {
            const list = document.getElementById('subdirectoryPathList');
            if (list.querySelectorAll('.url-entry').length > 1) {
                btn.parentElement.remove();
            } else {
                btn.previousElementSibling.value = '';
            }
        }

        // Subdirectory path management for Edit Feature
        window.addEditSubdirectoryPathField = function(value) {
            const list = document.getElementById('editSubdirectoryPathList');
            const entry = document.createElement('div');
            entry.className = 'url-entry';
            entry.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';
            entry.innerHTML = \`
                <input type="text" class="subdirectory-path-input" placeholder="/src/auth" style="flex:1;" value="\${value || ''}">
                <button type="button" class="button button-danger" onclick="removeEditSubdirectoryPath(this)" title="Remove">✕</button>\`;
            list.appendChild(entry);
        }

        window.removeEditSubdirectoryPath = function(btn) {
            const list = document.getElementById('editSubdirectoryPathList');
            if (list.querySelectorAll('.url-entry').length > 1) {
                btn.parentElement.remove();
            } else {
                btn.previousElementSibling.value = '';
            }
        }

        window.editFeature = function(productId, featureId) {
            const product = products.find(p => p.id === productId);
            if (!product) return;
            
            const feature = product.features.find(f => f.id === featureId);
            if (!feature) return;

            document.getElementById('editFeatureProductId').value = productId;
            document.getElementById('editFeatureId').value = featureId;
            document.getElementById('editFeatureName').value = feature.name;
            document.getElementById('editFeatureVersion').value = feature.version;

            // Populate Confluence URL list
            const editConfList = document.getElementById('editConfluenceUrlList');
            editConfList.innerHTML = '';
            const urls = (feature.confluenceUrls && feature.confluenceUrls.length > 0)
                ? feature.confluenceUrls
                : [''];
            urls.forEach(url => addEditConfluenceUrlField(url));

            // Populate Repository URL list
            const editRepoList = document.getElementById('editRepositoryUrlList');
            editRepoList.innerHTML = '';
            const repoUrls = (feature.repositoryUrls && feature.repositoryUrls.length > 0)
                ? feature.repositoryUrls
                : [''];
            repoUrls.forEach(url => addEditRepositoryUrlField(url));

            // Add event listener for repository URL changes in edit modal
            const existingListener = editRepoList.getAttribute('data-listener');
            if (!existingListener) {
                editRepoList.addEventListener('input', (e) => {
                    if (e.target && e.target.classList && e.target.classList.contains('repository-url-input')) {
                        updateRepositoryScopeVisibility('edit');
                    }
                });
                editRepoList.setAttribute('data-listener', 'true');
            }

            // Populate repository scope fields
            const hasRepoUrls = feature.repositoryUrls && feature.repositoryUrls.length > 0;
            const scopeGroup = document.getElementById('editRepositoryScopeGroup');
            if (hasRepoUrls) {
                scopeGroup.style.display = 'block';
                const scope = feature.repositoryScope || 'full';
                document.getElementById('editFeatureRepositoryScope').value = scope;
                
                // Populate scope-specific fields
                if (scope === 'pr') {
                    document.getElementById('editFeaturePrUrl').value = feature.prUrl || '';
                } else if (scope === 'diff') {
                    document.getElementById('editFeatureBaseBranch').value = feature.baseBranch || 'main';
                    document.getElementById('editFeatureCompareBranch').value = feature.compareBranch || '';
                } else if (scope === 'subdirectory') {
                    const editSubList = document.getElementById('editSubdirectoryPathList');
                    editSubList.innerHTML = '';
                    const paths = (feature.subdirectoryPaths && feature.subdirectoryPaths.length > 0)
                        ? feature.subdirectoryPaths
                        : [''];
                    paths.forEach(path => addEditSubdirectoryPathField(path));
                }
                
                toggleScopeFields('edit');
            } else {
                scopeGroup.style.display = 'none';
            }

            document.getElementById('editFeatureWritebackUrl').value = feature.confluenceWritebackUrl || '';

            document.getElementById('editFeatureModal').classList.add('active');
        }

        window.closeEditFeatureModal = function() {
            document.getElementById('editFeatureModal').classList.remove('active');
            document.getElementById('editFeatureForm').reset();
        }

        window.analyze = function(productId, featureId) {
            vscode.postMessage({ command: 'analyze', productId, featureId });
        }

        window.generateReport = function(productId, featureId) {
            vscode.postMessage({ command: 'generateReport', productId, featureId });
        }

        window.deleteProduct = function(productId) {
            vscode.postMessage({ command: 'confirmDeleteProduct', productId });
        }

        window.deleteFeature = function(productId, featureId) {
            vscode.postMessage({ command: 'confirmDeleteFeature', productId, featureId });
        }

        window.publishToConfluence = function(productId, featureId) {
            vscode.postMessage({ command: 'publishToConfluence', productId, featureId });
        }

        window.togglePRWatch = function(productId, featureId, featureName, enabled) {
            vscode.postMessage({ command: 'togglePRWatch', productId, featureId, featureName, enabled });
        }

        window.toggleConfluenceWatch = function(productId, featureId, featureName, enabled) {
            vscode.postMessage({ command: 'toggleConfluenceWatch', productId, featureId, featureName, enabled });
        }

        window.createJiraIssues = function(productId, featureId) {
            vscode.postMessage({ command: 'createJiraIssues', productId, featureId });
        }
    </script>
</body>
</html>`;
	}

	private async _sendRiskMetrics(): Promise<void> {
		const products = this._productManager.getProducts();
		const rg = new ReportGenerator();
		const metrics: any[] = [];

		for (const product of products) {
			for (const feature of (product.features || [])) {
				if (!feature.folderPath) { continue; }
				let critical = 0, high = 0, medium = 0, low = 0;
				const files = [
					path.join(feature.folderPath, 'design', 'threat-analysis.md'),
					path.join(feature.folderPath, 'repo',   'threat-analysis.md')
				];
				for (const filePath of files) {
					if (fs.existsSync(filePath)) {
						try {
							const md = fs.readFileSync(filePath, 'utf-8');
							const threats = rg.parseThreatsFromMarkdown(md);
							critical += threats.filter((t) => t.severity?.toLowerCase() === 'critical').length;
							high     += threats.filter((t) => t.severity?.toLowerCase() === 'high').length;
							medium   += threats.filter((t) => t.severity?.toLowerCase() === 'medium').length;
							low      += threats.filter((t) => t.severity?.toLowerCase() === 'low').length;
						} catch { /* skip unreadable file */ }
					}
				}
				const total = critical + high + medium + low;
				// CVSS v3.1 base score mapping per severity
				const cvssWeightedSum = critical * 9.5 + high * 7.5 + medium * 5.0 + low * 2.5;
				// Aggregate CVSS = weighted average (0–10 scale, higher = more risk)
				const score = total === 0
					? (feature.hasDocAnalysis || feature.hasRepoAnalysis ? 0 : -1)
					: Math.round((cvssWeightedSum / total) * 10) / 10;
				metrics.push({
					productId: product.id,   productName: product.name,
					featureId: feature.id,   featureName: feature.name,
					version: feature.version,
					critical, high, medium, low, total, score,
					hasAnalysis: !!(feature.hasDocAnalysis || feature.hasRepoAnalysis)
				});
			}
		}
		this._panel.webview.postMessage({ command: 'riskMetricsUpdated', metrics });
	}

	public dispose() {
		DashboardPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}
}
