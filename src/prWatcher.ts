import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Feature, Product } from './productManager';
import { sendEvent } from './telemetry';

/**
 * Represents a detected pull request from GitHub or Bitbucket.
 */
interface DetectedPR {
	repoUrl: string;
	prNumber: number;
	prUrl: string;
	title: string;
	author: string;
	updatedAt: string;
	state: string;
	platform: 'github' | 'bitbucket';
}

/**
 * Stored state per repository to track which PRs we've already seen.
 */
interface WatchState {
	/** ISO timestamp of last successful poll */
	lastChecked: string;
	/** Map of PR number → last-seen updatedAt timestamp */
	knownPRs: Record<number, string>;
}

/**
 * PRWatcher polls GitHub and Bitbucket repositories for new/updated pull requests
 * and notifies the user (with optional auto-trigger of threat analysis).
 */
export class PRWatcher implements vscode.Disposable {
	private static readonly STORAGE_KEY = 'threatModeling.prWatchState';
	private static readonly DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

	private _context: vscode.ExtensionContext;
	private _timer: ReturnType<typeof setInterval> | undefined;
	private _outputChannel: vscode.OutputChannel;
	private _isRunning = false;
	private _onPRDetected: vscode.EventEmitter<{ pr: DetectedPR; productId: string; featureId: string }>;
	public readonly onPRDetected: vscode.Event<{ pr: DetectedPR; productId: string; featureId: string }>;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		this._outputChannel = vscode.window.createOutputChannel('PR Watcher');
		context.subscriptions.push(this._outputChannel);

		this._onPRDetected = new vscode.EventEmitter();
		this.onPRDetected = this._onPRDetected.event;
	}

	/**
	 * Start polling for PRs across all watched features.
	 */
	public start(): void {
		if (this._isRunning) {
			this._outputChannel.appendLine('⚠️ PR Watcher is already running');
			return;
		}

		const intervalMs = vscode.workspace.getConfiguration('aiThreatModeling')
			.get<number>('prWatchInterval', 5) * 60 * 1000;

		this._isRunning = true;
		this._outputChannel.appendLine(`🔄 PR Watcher started (polling every ${intervalMs / 60000} minutes)`);
		sendEvent('prWatcherStarted');

		// Run first check immediately
		this._pollAll();

		// Then schedule recurring checks
		this._timer = setInterval(() => this._pollAll(), intervalMs || PRWatcher.DEFAULT_INTERVAL_MS);
	}

	/**
	 * Auto-start the watcher if any features have PR watching enabled.
	 * Called on extension activation — no manual command needed.
	 */
	public startIfWatched(): void {
		const products = this._context.globalState.get<Product[]>('threatModeling.products', []);
		const hasWatched = products.some(p =>
			p.features.some(f => f.prWatchEnabled && f.repositoryUrls && f.repositoryUrls.length > 0)
		);
		if (hasWatched) {
			this._outputChannel.appendLine('🔄 Features with PR Watch detected — auto-starting watcher');
			this.start();
		}
	}

	/**
	 * Stop polling.
	 */
	public stop(): void {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = undefined;
		}
		this._isRunning = false;
		this._outputChannel.appendLine('⏹️ PR Watcher stopped');
		sendEvent('prWatcherStopped');
	}

	public isRunning(): boolean {
		return this._isRunning;
	}

	/**
	 * Poll all watched features for new PRs.
	 */
	private async _pollAll(): Promise<void> {
		const products = this._context.globalState.get<Product[]>('threatModeling.products', []);
		const watchState = this._getWatchState();

		for (const product of products) {
			for (const feature of product.features) {
				if (!feature.prWatchEnabled) { continue; }
				if (!feature.repositoryUrls || feature.repositoryUrls.length === 0) { continue; }

				for (const repoUrl of feature.repositoryUrls) {
					try {
						await this._pollRepo(repoUrl, product, feature, watchState);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						this._outputChannel.appendLine(`❌ Error polling ${repoUrl}: ${msg}`);
					}
				}
			}
		}

		this._saveWatchState(watchState);
	}

	/**
	 * Poll a single repository for open PRs.
	 */
	private async _pollRepo(
		repoUrl: string,
		product: Product,
		feature: Feature,
		watchState: Record<string, WatchState>
	): Promise<void> {
		const platform = this._detectPlatform(repoUrl);
		if (platform === 'unknown') {
			return;
		}

		const prs = platform === 'github'
			? await this._fetchGitHubPRs(repoUrl)
			: await this._fetchBitbucketPRs(repoUrl);

		if (!prs || prs.length === 0) { return; }

		const stateKey = repoUrl;
		const repoState = watchState[stateKey] || { lastChecked: '', knownPRs: {} };

		for (const pr of prs) {
			const knownUpdatedAt = repoState.knownPRs[pr.prNumber];

			if (!knownUpdatedAt || knownUpdatedAt !== pr.updatedAt) {
				// New or updated PR
				const isNew = !knownUpdatedAt;
				this._outputChannel.appendLine(
					`${isNew ? '🆕' : '✏️'} ${isNew ? 'New' : 'Updated'} PR #${pr.prNumber}: "${pr.title}" by ${pr.author} in ${repoUrl}`
				);

				this._onPRDetected.fire({
					pr,
					productId: product.id,
					featureId: feature.id
				});

				this._autoAnalyzePR(pr, product, feature, isNew);
				repoState.knownPRs[pr.prNumber] = pr.updatedAt;
			}
		}

		// Clean up closed/merged PRs from state
		const openPRNumbers = new Set(prs.map(pr => pr.prNumber));
		for (const prNum of Object.keys(repoState.knownPRs)) {
			if (!openPRNumbers.has(Number(prNum))) {
				delete repoState.knownPRs[Number(prNum)];
			}
		}

		repoState.lastChecked = new Date().toISOString();
		watchState[stateKey] = repoState;
	}

	/**
	 * Auto-trigger threat analysis for a detected PR and notify the user.
	 */
	private async _autoAnalyzePR(
		pr: DetectedPR,
		product: Product,
		feature: Feature,
		isNew: boolean
	): Promise<void> {
		const label = isNew ? 'New PR' : 'Updated PR';

		// Auto-trigger analysis immediately
		sendEvent('prWatcherAutoAnalyze', {
			productId: product.id,
			featureId: feature.id,
			prNumber: String(pr.prNumber)
		});
		await vscode.commands.executeCommand('ai-threat-modeling.analyzePR', {
			productId: product.id,
			featureId: feature.id,
			prUrl: pr.prUrl
		});

		// Inform the user (non-blocking)
		const msg = `🛡️ ${label} #${pr.prNumber}: "${pr.title}" — auto-analyzing threats (${product.name}/${feature.name})`;
		vscode.window.showInformationMessage(msg, 'Open PR').then(selection => {
			if (selection === 'Open PR') {
				vscode.env.openExternal(vscode.Uri.parse(pr.prUrl));
			}
		});
	}

	// ── GitHub REST API ──────────────────────────────────────────────────────

	private async _fetchGitHubPRs(repoUrl: string): Promise<DetectedPR[]> {
		const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
		if (!match) { return []; }

		const owner = match[1];
		const repo = match[2];
		const token = await this._context.secrets.get('github.token');

		const headers: Record<string, string> = {
			'User-Agent': 'ThreatWeaver',
			'Accept': 'application/vnd.github+json'
		};
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		try {
			const data = await this._httpsGet(
				`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=20`,
				headers
			);

			const prs: any[] = JSON.parse(data);
			return prs.map(pr => ({
				repoUrl,
				prNumber: pr.number,
				prUrl: pr.html_url,
				title: pr.title,
				author: pr.user?.login || 'unknown',
				updatedAt: pr.updated_at,
				state: pr.state,
				platform: 'github' as const
			}));
		} catch (err) {
			this._outputChannel.appendLine(`❌ GitHub API error for ${owner}/${repo}: ${err}`);
			return [];
		}
	}

	// ── Bitbucket REST API ───────────────────────────────────────────────────

	private async _fetchBitbucketPRs(repoUrl: string): Promise<DetectedPR[]> {
		const match = repoUrl.match(/\/projects\/([^/]+)\/repos\/([^/]+)/);
		if (!match) { return []; }

		const project = match[1];
		const repo = match[2];
		const token = await this._context.secrets.get('bitbucket.token');
		if (!token) {
			this._outputChannel.appendLine('⚠️ Bitbucket token not configured — skipping PR poll');
			return [];
		}

		// Extract Bitbucket host from URL
		let bbHost: string;
		try {
			const u = new URL(repoUrl.startsWith('http') ? repoUrl : `https://${repoUrl}`);
			bbHost = u.host;
		} catch {
			this._outputChannel.appendLine(`⚠️ Cannot parse Bitbucket host from ${repoUrl}`);
			return [];
		}

		const headers: Record<string, string> = {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/json'
		};

		try {
			const data = await this._httpsGet(
				`https://${bbHost}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests?state=OPEN&limit=20&order=NEWEST`,
				headers
			);

			const response = JSON.parse(data);
			const prs: any[] = response.values || [];
			return prs.map(pr => ({
				repoUrl,
				prNumber: pr.id,
				prUrl: `https://${bbHost}/projects/${project}/repos/${repo}/pull-requests/${pr.id}`,
				title: pr.title,
				author: pr.author?.user?.displayName || pr.author?.user?.name || 'unknown',
				updatedAt: new Date(pr.updatedDate || pr.createdDate).toISOString(),
				state: (pr.state || 'OPEN').toLowerCase(),
				platform: 'bitbucket' as const
			}));
		} catch (err) {
			this._outputChannel.appendLine(`❌ Bitbucket API error for ${project}/${repo}: ${err}`);
			return [];
		}
	}

	// ── HTTP helpers ─────────────────────────────────────────────────────────

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

	// ── State persistence ────────────────────────────────────────────────────

	private _getWatchState(): Record<string, WatchState> {
		return this._context.globalState.get<Record<string, WatchState>>(PRWatcher.STORAGE_KEY, {});
	}

	private async _saveWatchState(state: Record<string, WatchState>): Promise<void> {
		await this._context.globalState.update(PRWatcher.STORAGE_KEY, state);
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private _detectPlatform(url: string): 'github' | 'bitbucket' | 'unknown' {
		if (url.includes('github.com')) { return 'github'; }
		if (url.includes('bitbucket')) { return 'bitbucket'; }
		return 'unknown';
	}

	public dispose(): void {
		this.stop();
		this._onPRDetected.dispose();
	}
}
