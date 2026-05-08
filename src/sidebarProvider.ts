import * as vscode from 'vscode';

export class ThreatModelingSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'threatweaver.threatModelingDashboard';
	private _view?: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _context: vscode.ExtensionContext,
	) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getHtmlForWebview();

		webviewView.webview.onDidReceiveMessage(async data => {
			switch (data.command) {
				case 'configureCredentials':
					CredentialsPanel.show(this._context);
					break;
				case 'openDashboard':
					vscode.commands.executeCommand('ai-threat-modeling.openDashboard');
					break;
				case 'startMCP':
					vscode.commands.executeCommand('ai-threat-modeling.startMCP');
					break;
				case 'stopMCP':
					vscode.commands.executeCommand('ai-threat-modeling.stopMCP');
					break;
			}
		});
	}

	private _getHtmlForWebview() {
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<style>
				@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');

				:root {
					--bg-primary: #0a0e17;
					--bg-card: rgba(17, 24, 39, 0.8);
					--neon-cyan: #00f0ff;
					--neon-green: #00ff9d;
					--neon-purple: #a855f7;
					--neon-pink: #f43f5e;
					--border-dim: rgba(0, 240, 255, 0.08);
					--text-primary: #e2e8f0;
					--text-secondary: rgba(226, 232, 240, 0.6);
					--text-muted: rgba(226, 232, 240, 0.35);
					--transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
				}

				body {
					padding: 16px 12px;
					font-family: 'JetBrains Mono', monospace;
					color: var(--text-primary);
					background: var(--bg-primary);
					margin: 0;
				}

				/* Grid background */
				body::before {
					content: '';
					position: fixed;
					inset: 0;
					background:
						linear-gradient(rgba(0, 240, 255, 0.02) 1px, transparent 1px),
						linear-gradient(90deg, rgba(0, 240, 255, 0.02) 1px, transparent 1px);
					background-size: 40px 40px;
					pointer-events: none;
				}

				.sidebar-header {
					text-align: center;
					padding: 20px 8px 16px;
					margin-bottom: 16px;
					position: relative;
				}

				.sidebar-header::after {
					content: '';
					position: absolute;
					bottom: 0;
					left: 10%;
					right: 10%;
					height: 1px;
					background: linear-gradient(90deg, transparent, var(--neon-cyan), transparent);
					opacity: 0.3;
				}

				.sidebar-icon {
					font-size: 32px;
					display: block;
					margin-bottom: 8px;
					filter: drop-shadow(0 0 12px rgba(0, 240, 255, 0.4));
				}

				h3 {
					margin: 0;
					font-size: 13px;
					font-weight: 700;
					letter-spacing: 2px;
					text-transform: uppercase;
					background: linear-gradient(135deg, var(--neon-cyan), var(--neon-purple));
					-webkit-background-clip: text;
					-webkit-text-fill-color: transparent;
					background-clip: text;
				}

				.status-line {
					display: flex;
					align-items: center;
					justify-content: center;
					gap: 6px;
					margin-top: 8px;
					font-size: 10px;
					color: var(--text-muted);
					letter-spacing: 0.5px;
				}

				.status-dot {
					width: 6px;
					height: 6px;
					border-radius: 50%;
					background: var(--neon-green);
					box-shadow: 0 0 6px var(--neon-green);
					animation: dotPulse 2s ease-in-out infinite;
				}

				@keyframes dotPulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.4; }
				}

				.container {
					display: flex;
					flex-direction: column;
					gap: 6px;
					position: relative;
					z-index: 1;
				}

				.section-label {
					font-size: 9px;
					font-weight: 600;
					color: var(--neon-cyan);
					letter-spacing: 1.5px;
					text-transform: uppercase;
					margin: 12px 0 6px 4px;
					opacity: 0.5;
				}

				.section-label::before {
					margin-right: 4px;
					opacity: 0.4;
				}

				button {
					background: rgba(0, 240, 255, 0.04);
					color: var(--text-secondary);
					border: 1px solid var(--border-dim);
					padding: 10px 14px;
					cursor: pointer;
					width: 100%;
					border-radius: 8px;
					font-family: 'JetBrains Mono', monospace;
					font-size: 11px;
					font-weight: 500;
					text-align: left;
					transition: var(--transition);
					position: relative;
					overflow: hidden;
					letter-spacing: 0.3px;
				}

				button::before {
					content: '';
					position: absolute;
					top: 0;
					left: -100%;
					width: 100%;
					height: 100%;
					background: linear-gradient(90deg, transparent, rgba(0, 240, 255, 0.06), transparent);
					transition: left 0.5s;
				}

				button:hover::before { left: 100%; }

				button:hover {
					background: rgba(0, 240, 255, 0.08);
					border-color: rgba(0, 240, 255, 0.2);
					color: var(--neon-cyan);
					box-shadow: 0 0 15px rgba(0, 240, 255, 0.06);
					transform: translateX(2px);
				}

				button:active {
					transform: translateX(0);
				}

				button.primary {
					background: rgba(0, 240, 255, 0.08);
					border-color: rgba(0, 240, 255, 0.15);
					color: var(--neon-cyan);
				}

				button.primary:hover {
					background: rgba(0, 240, 255, 0.14);
					border-color: rgba(0, 240, 255, 0.3);
					box-shadow: 0 0 20px rgba(0, 240, 255, 0.1);
				}

				button.danger {
					color: var(--text-muted);
				}

				button.danger:hover {
					color: var(--neon-pink);
					border-color: rgba(244, 63, 94, 0.2);
					background: rgba(244, 63, 94, 0.06);
					box-shadow: 0 0 15px rgba(244, 63, 94, 0.06);
				}

				/* Scrollbar */
				::-webkit-scrollbar { width: 4px; }
				::-webkit-scrollbar-track { background: transparent; }
				::-webkit-scrollbar-thumb { background: rgba(0, 240, 255, 0.1); border-radius: 2px; }
			</style>
		</head>
		<body>
			<div class="sidebar-header">
				<h3>Threat Modeling Panel</h3>
			</div>
			<div class="container">
				<div class="section-label">Setup</div>
				<button onclick="configureCredentials()">🔑 Configure Credentials</button>

				<div class="section-label">Controls</div>
				<button class="primary" onclick="startMCP()">▶ Start MCP Servers</button>
				<button class="primary" onclick="openDashboard()">🛡️ Open Dashboard</button>
				<button class="danger" onclick="stopMCP()">⏹ Stop MCP Servers</button>
			</div>
			
			<script>
				const vscode = acquireVsCodeApi();
				
				function configureCredentials() {
					vscode.postMessage({ command: 'configureCredentials' });
				}
				
				function openDashboard() {
					vscode.postMessage({ command: 'openDashboard' });
				}
				
				function startMCP() {
					vscode.postMessage({ command: 'startMCP' });
				}
				
				function stopMCP() {
					vscode.postMessage({ command: 'stopMCP' });
				}
			</script>
		</body>
		</html>`;
	}
}


/**
 * Popup webview panel for credential configuration.
 */
export class CredentialsPanel {
	private static _panel?: vscode.WebviewPanel;

	public static show(context: vscode.ExtensionContext) {
		if (CredentialsPanel._panel) {
			CredentialsPanel._panel.reveal();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'threatModelCredentials',
			'🔑 Configure Credentials',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: false }
		);
		CredentialsPanel._panel = panel;

		panel.onDidDispose(() => { CredentialsPanel._panel = undefined; });

		panel.webview.html = CredentialsPanel._getHtml();

		panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.command === 'loadCredentials') {
				const secrets = context.secrets;
				panel.webview.postMessage({
					command: 'credentialsLoaded',
					bitbucketToken: await secrets.get('bitbucket.token') ?? '',
					githubToken: await secrets.get('github.token') ?? '',				jiraBaseUrl: await secrets.get('jira.baseUrl') ?? '',					jiraToken: await secrets.get('jira.token') ?? '',
					atlassianEmail: await secrets.get('atlassian.email') ?? '',
					atlassianApiToken: await secrets.get('atlassian.apiToken') ?? '',
				});
			}
			if (msg.command === 'saveCredentials') {
				const secrets = context.secrets;
				const fields: [string, string][] = [
					['github.token', msg.githubToken],
					['jira.baseUrl', msg.jiraBaseUrl],
					['jira.token', msg.jiraToken],
					['atlassian.email', msg.atlassianEmail],
					['atlassian.apiToken', msg.atlassianApiToken],
				];
				for (const [key, value] of fields) {
					if (value !== undefined && value.trim()) {
						await secrets.store(key, value.trim());
					}
				}
				panel.webview.postMessage({ command: 'credentialsSaved' });
				vscode.window.showInformationMessage('✅ Credentials saved securely.');
			}
		});
	}

	private static _getHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
	:root {
		--bg-primary: #0a0e17;
		--bg-card: rgba(17, 24, 39, 0.8);
		--neon-cyan: #00f0ff;
		--neon-green: #00ff9d;
		--neon-purple: #a855f7;
		--border-dim: rgba(0, 240, 255, 0.08);
		--text-primary: #e2e8f0;
		--text-secondary: rgba(226, 232, 240, 0.6);
		--text-muted: rgba(226, 232, 240, 0.35);
		--transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
	}
	body {
		margin: 0; padding: 0;
		font-family: 'JetBrains Mono', monospace;
		color: var(--text-primary);
		background: var(--bg-primary);
		display: flex; justify-content: center; align-items: flex-start;
		min-height: 100vh;
	}
	body::before {
		content: '';
		position: fixed; inset: 0;
		background:
			linear-gradient(rgba(0,240,255,0.02) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0,240,255,0.02) 1px, transparent 1px);
		background-size: 40px 40px;
		pointer-events: none;
	}
	.panel {
		width: 480px; max-width: 95vw;
		margin: 40px auto;
		position: relative; z-index: 1;
	}
	.panel-header {
		text-align: center;
		margin-bottom: 28px;
	}
	.panel-header h1 {
		margin: 0;
		font-size: 18px;
		font-weight: 700;
		letter-spacing: 2px;
		text-transform: uppercase;
		background: linear-gradient(135deg, var(--neon-cyan), var(--neon-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
	}
	.panel-header p {
		margin: 8px 0 0;
		font-size: 11px;
		color: var(--text-muted);
		letter-spacing: 0.5px;
	}
	.cred-group {
		margin-bottom: 20px;
		border: 1px solid var(--border-dim);
		border-radius: 10px;
		padding: 16px 20px;
		background: var(--bg-card);
	}
	.cred-group-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--neon-cyan);
		letter-spacing: 1.5px;
		text-transform: uppercase;
		margin-bottom: 12px;
		opacity: 0.8;
	}
	.field-row { margin-bottom: 12px; }
	.field-row:last-child { margin-bottom: 0; }
	.field-label {
		font-size: 11px;
		color: var(--text-secondary);
		margin-bottom: 4px;
		letter-spacing: 0.3px;
	}
	.field-input {
		width: 100%; box-sizing: border-box;
		background: rgba(0,0,0,0.3);
		border: 1px solid var(--border-dim);
		border-radius: 6px;
		padding: 9px 12px;
		font-family: 'JetBrains Mono', monospace;
		font-size: 12px;
		color: var(--text-primary);
		transition: var(--transition);
		outline: none;
	}
	.field-input::placeholder { color: var(--text-muted); }
	.field-input:focus {
		border-color: rgba(0,240,255,0.3);
		box-shadow: 0 0 10px rgba(0,240,255,0.08);
	}
	.field-input.has-value { border-color: rgba(0,255,157,0.2); }
	.input-wrap { position: relative; }
	.input-wrap .field-input { padding-right: 36px; }
	.toggle-vis {
		background: none; border: none;
		padding: 0; margin: 0;
		position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
		font-size: 14px; cursor: pointer;
		color: var(--text-muted); opacity: 0.5;
	}
	.toggle-vis:hover { opacity: 1; color: var(--neon-cyan); }
	.help-link {
		font-size: 10px; color: var(--text-muted);
		text-decoration: none; opacity: 0.6;
	}
	.help-link:hover { color: var(--neon-cyan); opacity: 1; }
	.btn-row {
		display: flex; gap: 10px;
		margin-top: 8px;
	}
	.btn {
		flex: 1;
		padding: 11px 16px;
		border-radius: 8px;
		font-family: 'JetBrains Mono', monospace;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 1px;
		text-align: center;
		cursor: pointer;
		transition: var(--transition);
		border: 1px solid;
	}
	.btn-save {
		background: rgba(0,255,157,0.08);
		border-color: rgba(0,255,157,0.2);
		color: var(--neon-green);
	}
	.btn-save:hover {
		background: rgba(0,255,157,0.14);
		border-color: rgba(0,255,157,0.35);
		box-shadow: 0 0 20px rgba(0,255,157,0.1);
	}
	.saved-indicator {
		text-align: center;
		font-size: 11px;
		color: var(--neon-green);
		opacity: 0;
		transition: opacity 0.3s;
		margin-top: 10px;
		letter-spacing: 0.5px;
	}
	.saved-indicator.show { opacity: 1; }
</style>
</head>
<body>
<div class="panel">
	<div class="panel-header">
		<h1>🔑 Configure Credentials</h1>
		<p>All credentials are stored securely in your VS Code secret storage</p>
	</div>

	<div class="cred-group">
		<div class="cred-group-title"> GitHub</div>
		<div class="field-row">
			<div class="field-label">Personal Access Token</div>
			<div class="input-wrap">
				<input class="field-input" type="password" id="githubToken" placeholder="ghp_..." spellcheck="false" />
				<button class="toggle-vis" onclick="toggleVis('githubToken')">👁</button>
			</div>
		</div>
	</div>

	<div class="cred-group">
		<div class="cred-group-title"> Atlassian / Confluence</div>
		<div class="field-row">
			<div class="field-label">Atlassian Email</div>
			<input class="field-input" type="text" id="atlassianEmail" placeholder="you@company.com" spellcheck="false" />
		</div>
		<div class="field-row">
			<div class="field-label">Atlassian API Token</div>
			<div class="input-wrap">
				<input class="field-input" type="password" id="atlassianApiToken" placeholder="••••••••" spellcheck="false" />
				<button class="toggle-vis" onclick="toggleVis('atlassianApiToken')">👁</button>
			</div>
		</div>
	</div>

	<div class="cred-group">
		<div class="cred-group-title">🎫 Jira (On-Prem)</div>
		<div class="field-row">
			<div class="field-label">Jira Base URL</div>
			<input class="field-input" type="text" id="jiraBaseUrl" placeholder="https://jira.your-company.com" spellcheck="false" />
		</div>
		<div class="field-row">
			<div class="field-label">Personal Access Token</div>
			<div class="input-wrap">
				<input class="field-input" type="password" id="jiraToken" placeholder="Jira PAT" spellcheck="false" />
				<button class="toggle-vis" onclick="toggleVis('jiraToken')">👁</button>
			</div>
		</div>
	</div>

	<div class="btn-row">
		<button class="btn btn-save" onclick="saveCredentials()">💾 SAVE CREDENTIALS</button>
	</div>
	<div class="saved-indicator" id="savedMsg">✓ Saved securely</div>
</div>

<script>
	const vscode = acquireVsCodeApi();

	function toggleVis(id) {
		const el = document.getElementById(id);
		el.type = el.type === 'password' ? 'text' : 'password';
	}

	function saveCredentials() {
		vscode.postMessage({
			command: 'saveCredentials',
			githubToken: document.getElementById('githubToken').value,
			jiraBaseUrl: document.getElementById('jiraBaseUrl').value,
			jiraToken: document.getElementById('jiraToken').value,
			atlassianEmail: document.getElementById('atlassianEmail').value,
			atlassianApiToken: document.getElementById('atlassianApiToken').value,
		});
	}

	function markFields() {
		document.querySelectorAll('.field-input').forEach(el => {
			el.classList.toggle('has-value', el.value.length > 0);
		});
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.command === 'credentialsLoaded') {
			document.getElementById('githubToken').value = msg.githubToken || '';
			document.getElementById('jiraBaseUrl').value = msg.jiraBaseUrl || '';
			document.getElementById('jiraToken').value = msg.jiraToken || '';
			document.getElementById('atlassianEmail').value = msg.atlassianEmail || '';
			document.getElementById('atlassianApiToken').value = msg.atlassianApiToken || '';
			markFields();
		}
		if (msg.command === 'credentialsSaved') {
			const el = document.getElementById('savedMsg');
			el.classList.add('show');
			markFields();
			setTimeout(() => el.classList.remove('show'), 2500);
		}
	});

	vscode.postMessage({ command: 'loadCredentials' });

	document.querySelectorAll('.field-input').forEach(el => {
		el.addEventListener('input', () => el.classList.toggle('has-value', el.value.length > 0));
	});
</script>
</body>
</html>`;
	}
}
