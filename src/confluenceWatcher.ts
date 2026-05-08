import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Feature, Product } from './productManager';
import { sendEvent } from './telemetry';

/**
 * Tracks the version of a Confluence page to detect updates.
 */
interface PageVersionState {
	/** Confluence page version number last seen */
	version: number;
	/** ISO timestamp of last check */
	lastChecked: string;
}

/**
 * ConfluenceWatcher polls Confluence pages linked to features for version changes.
 * When a page is updated, it auto-triggers a delta re-analysis that considers
 * existing threat analysis and DFD outputs.
 */
export class ConfluenceWatcher implements vscode.Disposable {
	private static readonly STORAGE_KEY = 'threatModeling.confluenceWatchState';
	private static readonly DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

	private _context: vscode.ExtensionContext;
	private _timer: ReturnType<typeof setInterval> | undefined;
	private _outputChannel: vscode.OutputChannel;
	private _isRunning = false;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		this._outputChannel = vscode.window.createOutputChannel('Confluence Watcher');
		context.subscriptions.push(this._outputChannel);
	}

	/**
	 * Start polling Confluence pages.
	 */
	public start(): void {
		if (this._isRunning) {
			this._outputChannel.appendLine('⚠️ Confluence Watcher is already running');
			return;
		}

		const intervalMs = vscode.workspace.getConfiguration('aiThreatModeling')
			.get<number>('confluenceWatchInterval', 10) * 60 * 1000;

		this._isRunning = true;
		this._outputChannel.appendLine(`📄 Confluence Watcher started (polling every ${intervalMs / 60000} minutes)`);
		sendEvent('confluenceWatcherStarted');

		// First check immediately
		this._pollAll();

		// Recurring checks
		this._timer = setInterval(() => this._pollAll(), intervalMs || ConfluenceWatcher.DEFAULT_INTERVAL_MS);
	}

	/**
	 * Auto-start if any features have confluence watching enabled.
	 */
	public startIfWatched(): void {
		const products = this._context.globalState.get<Product[]>('threatModeling.products', []);
		const hasWatched = products.some(p =>
			p.features.some(f => f.confluenceWatchEnabled && f.confluenceUrls && f.confluenceUrls.length > 0)
		);
		if (hasWatched) {
			this._outputChannel.appendLine('📄 Features with Confluence Watch detected — auto-starting watcher');
			this.start();
		}
	}

	public stop(): void {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = undefined;
		}
		this._isRunning = false;
		this._outputChannel.appendLine('⏹️ Confluence Watcher stopped');
		sendEvent('confluenceWatcherStopped');
	}

	public isRunning(): boolean {
		return this._isRunning;
	}

	// ── Polling ──────────────────────────────────────────────────────────────

	private async _pollAll(): Promise<void> {
		const products = this._context.globalState.get<Product[]>('threatModeling.products', []);
		const watchState = this._getWatchState();

		for (const product of products) {
			for (const feature of product.features) {
				if (!feature.confluenceWatchEnabled) { continue; }
				if (!feature.confluenceUrls || feature.confluenceUrls.length === 0) { continue; }

				for (const pageUrl of feature.confluenceUrls) {
					try {
						await this._pollPage(pageUrl, product, feature, watchState);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						this._outputChannel.appendLine(`❌ Error polling ${pageUrl}: ${msg}`);
					}
				}
			}
		}

		this._saveWatchState(watchState);
	}

	private async _pollPage(
		pageUrl: string,
		product: Product,
		feature: Feature,
		watchState: Record<string, PageVersionState>
	): Promise<void> {
		const { host, pageId, apiPrefix } = this._parseConfluenceUrl(pageUrl);
		if (!pageId) {
			this._outputChannel.appendLine(`⚠️ Cannot extract page ID from: ${pageUrl}`);
			return;
		}

		const email = await this._context.secrets.get('atlassian.email');
		const token = await this._context.secrets.get('atlassian.apiToken');
		if (!email || !token) {
			this._outputChannel.appendLine('⚠️ Atlassian credentials not configured — skipping Confluence poll');
			return;
		}

		const currentVersion = await this._fetchPageVersion(host, pageId, apiPrefix, email, token);
		if (currentVersion === null) { return; }

		const stateKey = pageUrl;
		const known = watchState[stateKey];

		if (!known) {
			// First time seeing this page — record version, don't trigger
			this._outputChannel.appendLine(`📄 Tracking ${pageUrl} (v${currentVersion})`);
			watchState[stateKey] = { version: currentVersion, lastChecked: new Date().toISOString() };
			return;
		}

		if (currentVersion > known.version) {
			// Page was updated!
			this._outputChannel.appendLine(
				`✏️ Confluence page updated: ${pageUrl} (v${known.version} → v${currentVersion})`
			);

			// Auto-trigger delta re-analysis
			this._autoReanalyze(pageUrl, product, feature, known.version, currentVersion);

			watchState[stateKey] = { version: currentVersion, lastChecked: new Date().toISOString() };
		} else {
			watchState[stateKey].lastChecked = new Date().toISOString();
		}
	}

	// ── Auto re-analysis trigger ─────────────────────────────────────────────

	private _autoReanalyze(
		pageUrl: string,
		product: Product,
		feature: Feature,
		oldVersion: number,
		newVersion: number
	): void {
		sendEvent('confluenceWatcherAutoAnalyze', {
			productId: product.id,
			featureId: feature.id,
			pageUrl,
			oldVersion: String(oldVersion),
			newVersion: String(newVersion)
		});

		// Fire command for delta re-analysis
		vscode.commands.executeCommand('ai-threat-modeling.reanalyzeConfluence', {
			productId: product.id,
			featureId: feature.id,
			pageUrl,
			oldVersion,
			newVersion
		});

		// Notify user
		const msg = `📄 Confluence page updated (v${oldVersion}→v${newVersion}) — auto-re-analyzing threats for "${feature.name}" (${product.name})`;
		vscode.window.showInformationMessage(msg, 'Open Page').then(selection => {
			if (selection === 'Open Page') {
				vscode.env.openExternal(vscode.Uri.parse(pageUrl));
			}
		});
	}

	// ── Confluence REST API ──────────────────────────────────────────────────

	private async _fetchPageVersion(
		host: string,
		pageId: string,
		apiPrefix: string,
		email: string,
		apiToken: string
	): Promise<number | null> {
		const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
		const url = `https://${host}${apiPrefix}/rest/api/content/${pageId}?expand=version`;

		try {
			const data = await this._httpsGet(url, {
				'Authorization': `Basic ${auth}`,
				'Accept': 'application/json'
			});
			const parsed = JSON.parse(data);
			return parsed.version?.number ?? null;
		} catch (err) {
			this._outputChannel.appendLine(`❌ Confluence API error for page ${pageId}: ${err}`);
			return null;
		}
	}

	// ── HTTP helper ──────────────────────────────────────────────────────────

	private _httpsGet(url: string, headers: Record<string, string>): Promise<string> {
		return new Promise((resolve, reject) => {
			const parsedUrl = new URL(url);
			const options: https.RequestOptions = {
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || 443,
				path: parsedUrl.pathname + parsedUrl.search,
				method: 'GET',
				headers
			};

			const proto = parsedUrl.protocol === 'http:' ? http : https;
			const req = proto.request(options, (res) => {
				let body = '';
				res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
				res.on('end', () => {
					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						resolve(body);
					} else {
						reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
					}
				});
			});
			req.on('error', reject);
			req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
			req.end();
		});
	}

	// ── URL parsing ──────────────────────────────────────────────────────────

	private _parseConfluenceUrl(url: string): { host: string; pageId: string; apiPrefix: string } {
		let parsed: URL;
		try { parsed = new URL(url); } catch {
			return { host: '', pageId: '', apiPrefix: '' };
		}

		const host = parsed.hostname;
		const apiPrefix = host.includes('.atlassian.net') || host.includes('.atlassian.com') ? '/wiki' : '';

		// Try /pages/123456 pattern
		const pathMatch = parsed.pathname.match(/\/pages\/(\d+)/);
		if (pathMatch) {
			return { host, pageId: pathMatch[1], apiPrefix };
		}

		// Try ?pageId=123456 pattern
		const queryId = parsed.searchParams.get('pageId');
		if (queryId) {
			return { host, pageId: queryId, apiPrefix };
		}

		return { host, pageId: '', apiPrefix };
	}

	// ── State persistence ────────────────────────────────────────────────────

	private _getWatchState(): Record<string, PageVersionState> {
		return this._context.globalState.get<Record<string, PageVersionState>>(ConfluenceWatcher.STORAGE_KEY, {});
	}

	private async _saveWatchState(state: Record<string, PageVersionState>): Promise<void> {
		await this._context.globalState.update(ConfluenceWatcher.STORAGE_KEY, state);
	}

	public dispose(): void {
		this.stop();
	}
}
