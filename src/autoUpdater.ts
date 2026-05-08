import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Parsed GitHub release info */
interface ReleaseInfo {
	tag: string;
	version: string;
	downloadUrl: string;
	releaseName: string;
	body: string;
}

/**
 * Check GitHub Releases for a newer VSIX and prompt the user to install it.
 *
 * Flow:
 * 1. GET /repos/{owner}/{repo}/releases/latest from the GitHub API
 * 2. Compare the release tag (e.g. v0.0.6) with the current extension version
 * 3. If newer, show a notification with "Update Now" / "Release Notes" / "Dismiss"
 * 4. "Update Now" downloads the first .vsix asset and installs it
 */
export async function checkForUpdates(context: vscode.ExtensionContext): Promise<void> {
	const config = vscode.workspace.getConfiguration('aiThreatModeling');
	if (config.get<boolean>('autoUpdateEnabled') === false) {
		return;
	}

	// Throttle: check at most once every 6 hours
	const lastCheck = context.globalState.get<number>('updateCheck.lastTimestamp', 0);
	const intervalMs = (config.get<number>('autoUpdateIntervalHours') ?? 6) * 3600_000;
	if (Date.now() - lastCheck < intervalMs) {
		return;
	}
	await context.globalState.update('updateCheck.lastTimestamp', Date.now());

	const repoSetting = config.get<string>('githubRepo') || '';
	const owner: string = repoSetting.split('/')[0] || 'Samiksha138';
	const repo: string  = repoSetting.split('/')[1] || 'ThreatWeaver';

	try {
		const release = await fetchLatestRelease(owner, repo, context);
		if (!release) { return; }

		const currentVersion = vscode.extensions.getExtension('ThreatWeaver.threatweaver')?.packageJSON?.version
			?? context.extension.packageJSON.version;

		if (!isNewer(release.version, currentVersion)) {
			console.log(`[AutoUpdate] Current ${currentVersion} is up-to-date (latest: ${release.version})`);
			return;
		}

		console.log(`[AutoUpdate] New version available: ${release.version} (current: ${currentVersion})`);

		const updateBtn   = 'Update Now';
		const notesBtn    = 'Release Notes';
		const dismissBtn  = 'Dismiss';

		const choice = await vscode.window.showInformationMessage(
			`🛡️ ThreatWeaver v${release.version} is available (you have v${currentVersion}).`,
			updateBtn, notesBtn, dismissBtn
		);

		if (choice === updateBtn) {
			await downloadAndInstall(release, context);
		} else if (choice === notesBtn) {
			// Show release notes, then offer update again
			const doc = await vscode.workspace.openTextDocument({
				content: `# ${release.releaseName}\n\n${release.body}`,
				language: 'markdown'
			});
			await vscode.window.showTextDocument(doc, { preview: true });

			const choice2 = await vscode.window.showInformationMessage(
				`Install ThreatWeaver v${release.version}?`,
				'Update Now', 'Later'
			);
			if (choice2 === 'Update Now') {
				await downloadAndInstall(release, context);
			}
		}
	} catch (err) {
		console.warn('[AutoUpdate] Check failed:', err);
		// Silently fail — don't bother the user with update-check errors
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch the latest release from GitHub Releases API */
async function fetchLatestRelease(owner: string, repo: string, context: vscode.ExtensionContext): Promise<ReleaseInfo | null> {
	const token = await context.secrets.get('github.token');
	const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;

	const json = await httpGetJson(apiUrl, token);
	if (!json || !json.tag_name) { return null; }

	// Find the first .vsix asset
	const vsixAsset = (json.assets || []).find(
		(a: any) => a.name?.endsWith('.vsix') && a.browser_download_url
	);
	if (!vsixAsset) {
		console.log('[AutoUpdate] Latest release has no .vsix asset');
		return null;
	}

	return {
		tag: json.tag_name,
		version: json.tag_name.replace(/^v/i, ''),
		downloadUrl: vsixAsset.browser_download_url,
		releaseName: json.name || json.tag_name,
		body: json.body || ''
	};
}

/** Compare semver strings, returns true if `remote` > `local` */
function isNewer(remote: string, local: string): boolean {
	const r = remote.split('.').map(Number);
	const l = local.split('.').map(Number);
	for (let i = 0; i < Math.max(r.length, l.length); i++) {
		const rv = r[i] ?? 0;
		const lv = l[i] ?? 0;
		if (rv > lv) { return true; }
		if (rv < lv) { return false; }
	}
	return false;
}

/** Download a file from `url` to a temp path, then install via VS Code CLI */
async function downloadAndInstall(release: ReleaseInfo, context: vscode.ExtensionContext): Promise<void> {
	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Updating ThreatWeaver to v${release.version}...`,
		cancellable: false
	}, async (progress) => {
		progress.report({ message: 'Downloading VSIX...' });

		const tmpDir = path.join(os.tmpdir(), 'ai-threat-modeling-update');
		if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }
		const vsixPath = path.join(tmpDir, `ai-threat-modeling-${release.version}.vsix`);

		const token = await context.secrets.get('github.token');
		await downloadFile(release.downloadUrl, vsixPath, token);

		progress.report({ message: 'Installing...' });
		await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));

		// Clean up
		try { fs.unlinkSync(vsixPath); } catch { /* ignore */ }

		const reload = await vscode.window.showInformationMessage(
			`✅ ThreatWeaver updated to v${release.version}. Reload to activate.`,
			'Reload Now', 'Later'
		);
		if (reload === 'Reload Now') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

/** Simple HTTPS GET returning parsed JSON, following up to 5 redirects */
function httpGetJson(url: string, token?: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const get = (u: string, redirects: number) => {
			if (redirects > 5) { return reject(new Error('Too many redirects')); }
			const headers: Record<string, string> = {
				'User-Agent': 'ThreatWeaver',
				'Accept': 'application/vnd.github+json'
			};
			if (token) { headers['Authorization'] = `token ${token}`; }

			const requester = u.startsWith('https') ? https : http;
			requester.get(u, { headers }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					return get(res.headers.location, redirects + 1);
				}
				if (res.statusCode !== 200) {
					res.resume();
					return resolve(null);
				}
				let data = '';
				res.on('data', (chunk: Buffer) => data += chunk);
				res.on('end', () => {
					try { resolve(JSON.parse(data)); } catch { resolve(null); }
				});
			}).on('error', reject);
		};
		get(url, 0);
	});
}

/** Download a file following redirects, with optional auth token */
function downloadFile(url: string, dest: string, token?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const get = (u: string, redirects: number) => {
			if (redirects > 5) { return reject(new Error('Too many redirects')); }
			const headers: Record<string, string> = {
				'User-Agent': 'ThreatWeaver',
				'Accept': 'application/octet-stream'
			};
			if (token) { headers['Authorization'] = `token ${token}`; }

			const requester = u.startsWith('https') ? https : http;
			requester.get(u, { headers }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					return get(res.headers.location, redirects + 1);
				}
				if (res.statusCode !== 200) {
					res.resume();
					return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
				}
				const file = fs.createWriteStream(dest);
				res.pipe(file);
				file.on('finish', () => file.close(() => resolve()));
				file.on('error', reject);
			}).on('error', reject);
		};
		get(url, 0);
	});
}
