import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface Feature {
	id: string;
	name: string;
	version: string;
	confluenceUrls: string[];
	repositoryUrls?: string[];   // Multiple repository URLs
	// Repository scope fields
	repositoryScope?: 'full' | 'pr' | 'diff' | 'subdirectory';
	prUrl?: string;              // For PR scope
	baseBranch?: string;         // For diff scope
	compareBranch?: string;      // For diff scope
	subdirectoryPaths?: string[]; // For subdirectory scope (multiple paths)
	// Confluence writeback
	confluenceWritebackUrl?: string; // Parent page URL where threat report is published as a child page
	// PR watch
	prWatchEnabled?: boolean;        // Auto-poll for new/updated PRs on this feature's repos
	// Confluence watch
	confluenceWatchEnabled?: boolean; // Auto-poll Confluence pages for version changes & re-analyze
	// Jira integration
	jiraProjectKey?: string;          // Jira project key for auto-creating tickets (e.g. "SEC")
	jiraIssueType?: string;           // Jira issue type (e.g. "Task", "Story", "Bug")
	createdAt: string;
	folderPath?: string;
	hasRepoAnalysis?: boolean;
	hasDocAnalysis?: boolean;
}

export interface Product {
	id: string;
	name: string;
	features: Feature[];
	createdAt: string;
	folderPath?: string;
}

export class ProductManager {
	private products: Product[] = [];
	private context: vscode.ExtensionContext;
	private readonly STORAGE_KEY = 'threatModeling.products';

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.loadProducts();
	}

	/** Reload product list from globalState (e.g. after another PM instance updated it). */
	public reload(): void {
		this.loadProducts();
	}

	private loadProducts(): void {
		const stored = this.context.globalState.get<any[]>(this.STORAGE_KEY, []);
		// Ensure all products have features array initialized and migrate old fields
		let needsMigration = false;
		this.products = stored.map(product => ({
			...product,
			features: (product.features || []).map((f: any) => {
				if (f.confluenceUrl || f.repositoryUrl || !f.repositoryScope) {
					needsMigration = true;
				}
				return {
					...f,
					// Migrate old single confluenceUrl to confluenceUrls array
					confluenceUrls: f.confluenceUrls
						? f.confluenceUrls
						: f.confluenceUrl
							? [f.confluenceUrl]
							: [],
					// Migrate old single repositoryUrl to repositoryUrls array
					repositoryUrls: f.repositoryUrls
						? f.repositoryUrls
						: f.repositoryUrl
							? [f.repositoryUrl]
							: [],
					// Set default repository scope if not present
					repositoryScope: f.repositoryScope || 'full',
					// Ensure subdirectoryPaths is array
					subdirectoryPaths: f.subdirectoryPaths || []
				};
			})
		}));
		// Persist migrated data so old fields are cleaned up
		if (needsMigration) {
			this.saveProducts();
		}
	}

	private async saveProducts(): Promise<void> {
		await this.context.globalState.update(this.STORAGE_KEY, this.products);
	}

	public getProducts(): Product[] {
		return this.products;
	}

	public async addProduct(productName: string): Promise<void> {
		// Create folder structure: product/
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
			throw new Error('No workspace folder open. Please open a folder first.');
		}

		const workspaceRoot = workspaceFolders[0].uri.fsPath;
		const sanitizeName = (name: string) => name.replace(/[^a-zA-Z0-9-_]/g, '_');
		
		const productFolder = path.join(workspaceRoot, sanitizeName(productName));

		// Create the folder structure
		try {
			if (!fs.existsSync(productFolder)) {
				fs.mkdirSync(productFolder, { recursive: true });
			}

			// Create knowledge folder for lessons learned
			const knowledgeFolder = path.join(productFolder, 'knowledge');
			if (!fs.existsSync(knowledgeFolder)) {
				fs.mkdirSync(knowledgeFolder, { recursive: true });
			}

			const product: Product = {
				id: Date.now().toString(),
				name: productName,
				features: [],
				createdAt: new Date().toISOString(),
				folderPath: productFolder
			};

			this.products.push(product);
			await this.saveProducts();

			// Create a metadata file
			const metadataPath = path.join(productFolder, 'product-info.json');
			fs.writeFileSync(metadataPath, JSON.stringify(product, null, 2));

			vscode.window.showInformationMessage(`Product "${productName}" added successfully!`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			vscode.window.showErrorMessage(`Failed to add product: ${errorMessage}`);
			throw error;
		}
	}

	public async addFeature(productId: string, feature: Omit<Feature, 'id' | 'createdAt' | 'folderPath'>): Promise<void> {
		const product = this.products.find(p => p.id === productId);
		if (!product) {
			throw new Error('Product not found');
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error('No workspace folder open');
		}

		const sanitizeName = (name: string) => name.replace(/[^a-zA-Z0-9-_]/g, '_');
		if (!product.folderPath) {
			throw new Error('Product folder path is not set. Please re-create the product.');
		}
		const featureFolder = path.join(
			product.folderPath,
			sanitizeName(feature.name),
			sanitizeName(feature.version)
		);

		// Create the folder structure
		try {
			if (!fs.existsSync(featureFolder)) {
				fs.mkdirSync(featureFolder, { recursive: true });
			}

			// Create design and repo subfolders
			const designFolder = path.join(featureFolder, 'design');
			const repoFolder = path.join(featureFolder, 'repo');
			if (!fs.existsSync(designFolder)) {
				fs.mkdirSync(designFolder, { recursive: true });
			}
			if (!fs.existsSync(repoFolder)) {
				fs.mkdirSync(repoFolder, { recursive: true });
			}

			// Ensure knowledge folder exists at product level
			const productFolder = path.dirname(featureFolder);
			const knowledgeFolder = path.join(productFolder, 'knowledge');
			if (!fs.existsSync(knowledgeFolder)) {
				fs.mkdirSync(knowledgeFolder, { recursive: true });
			}

			const newFeature: Feature = {
				id: Date.now().toString(),
				...feature,
				createdAt: new Date().toISOString(),
				folderPath: featureFolder,
				hasRepoAnalysis: false,
				hasDocAnalysis: false
			};

			product.features.push(newFeature);
			await this.saveProducts();

			// Create a metadata file
			const metadataPath = path.join(featureFolder, 'feature-info.json');
			fs.writeFileSync(metadataPath, JSON.stringify(newFeature, null, 2));

			vscode.window.showInformationMessage(`Feature "${feature.name}" added successfully!`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			vscode.window.showErrorMessage(`Failed to add feature: ${errorMessage}`);
			throw error;
		}
	}

	public async deleteProduct(productId: string): Promise<void> {
		const index = this.products.findIndex(p => p.id === productId);
		if (index !== -1) {
			const product = this.products[index];
			
			// Delete folder if it exists
			if (product.folderPath && fs.existsSync(product.folderPath)) {
				fs.rmSync(product.folderPath, { recursive: true, force: true });
			}

			this.products.splice(index, 1);
			await this.saveProducts();
			vscode.window.showInformationMessage(`Product "${product.name}" deleted successfully!`);
		}
	}

	public async deleteFeature(productId: string, featureId: string): Promise<void> {
		const product = this.products.find(p => p.id === productId);
		if (!product) {
			throw new Error('Product not found');
		}

		const featureIndex = product.features.findIndex(f => f.id === featureId);
		if (featureIndex !== -1) {
			const feature = product.features[featureIndex];
			
			// Delete folder if it exists
			if (feature.folderPath && fs.existsSync(feature.folderPath)) {
				fs.rmSync(feature.folderPath, { recursive: true, force: true });
			}

			product.features.splice(featureIndex, 1);
			await this.saveProducts();
			vscode.window.showInformationMessage(`Feature "${feature.name}" deleted successfully!`);
		}
	}

	public async editFeature(productId: string, featureId: string, updatedFeature: Partial<Omit<Feature, 'id' | 'createdAt' | 'folderPath'>>): Promise<void> {
		const product = this.products.find(p => p.id === productId);
		if (!product) {
			throw new Error('Product not found');
		}

		const featureIndex = product.features.findIndex(f => f.id === featureId);
		if (featureIndex === -1) {
			throw new Error('Feature not found');
		}

		const feature = product.features[featureIndex];
		
		// Update feature properties while keeping id, createdAt, and folderPath
		product.features[featureIndex] = {
			...feature,
			...updatedFeature,
			id: feature.id,
			createdAt: feature.createdAt,
			folderPath: feature.folderPath
		};

		await this.saveProducts();

		// Update metadata file if folder exists
		if (feature.folderPath && fs.existsSync(feature.folderPath)) {
			const metadataPath = path.join(feature.folderPath, 'feature-info.json');
			fs.writeFileSync(metadataPath, JSON.stringify(product.features[featureIndex], null, 2));
		}

		vscode.window.showInformationMessage(`Feature "${feature.name}" updated successfully!`);
	}

	public getProduct(productId: string): Product | undefined {
		return this.products.find(p => p.id === productId);
	}

	public getFeature(productId: string, featureId: string): Feature | undefined {
		const product = this.getProduct(productId);
		return product?.features.find(f => f.id === featureId);
	}

	public async updateFeature(productId: string, featureId: string, updatedFeature: Partial<Feature>): Promise<void> {
		const product = this.products.find(p => p.id === productId);
		if (!product) {
			throw new Error('Product not found');
		}

		const feature = product.features.find(f => f.id === featureId);
		if (!feature) {
			throw new Error('Feature not found');
		}

		// Update feature properties
		if (updatedFeature.name) { feature.name = updatedFeature.name; }
		if (updatedFeature.version) { feature.version = updatedFeature.version; }
		if (updatedFeature.confluenceUrls !== undefined) { feature.confluenceUrls = updatedFeature.confluenceUrls; }
		if (updatedFeature.repositoryUrls !== undefined) { feature.repositoryUrls = updatedFeature.repositoryUrls; }
		if (updatedFeature.repositoryScope !== undefined) { feature.repositoryScope = updatedFeature.repositoryScope; }
		if (updatedFeature.prUrl !== undefined) { feature.prUrl = updatedFeature.prUrl; }
		if (updatedFeature.baseBranch !== undefined) { feature.baseBranch = updatedFeature.baseBranch; }
		if (updatedFeature.compareBranch !== undefined) { feature.compareBranch = updatedFeature.compareBranch; }
		if (updatedFeature.subdirectoryPaths !== undefined) { feature.subdirectoryPaths = updatedFeature.subdirectoryPaths; }
		if (updatedFeature.confluenceWritebackUrl !== undefined) { feature.confluenceWritebackUrl = updatedFeature.confluenceWritebackUrl; }
		if (updatedFeature.prWatchEnabled !== undefined) { feature.prWatchEnabled = updatedFeature.prWatchEnabled; }
		if (updatedFeature.confluenceWatchEnabled !== undefined) { feature.confluenceWatchEnabled = updatedFeature.confluenceWatchEnabled; }
		if (updatedFeature.jiraProjectKey !== undefined) { feature.jiraProjectKey = updatedFeature.jiraProjectKey; }
		if (updatedFeature.jiraIssueType !== undefined) { feature.jiraIssueType = updatedFeature.jiraIssueType; }

		await this.saveProducts();
	}

	public async updateFeatureAnalysisStatus(productId: string, featureId: string, type: 'repo' | 'doc', status: boolean): Promise<void> {
		const product = this.getProduct(productId);
		if (!product) {
			throw new Error('Product not found');
		}

		const feature = product.features.find(f => f.id === featureId);
		if (!feature) {
			throw new Error('Feature not found');
		}

		if (type === 'repo') {
			feature.hasRepoAnalysis = status;
		} else {
			feature.hasDocAnalysis = status;
		}

		await this.saveProducts();
	}

	/**
	 * Scans the workspace for product/feature folders created by the
	 * @threat-modeler agent or /full-threat-pipeline skill that are not yet
	 * registered in the dashboard.  Folder convention:
	 *   {workspaceRoot}/{Product}/{Feature}/{Version}/design|repo/threat-analysis.md
	 */
	public async scanAndImport(): Promise<{ productsAdded: number; featuresAdded: number }> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error('No workspace folder open.');
		}

		const root = workspaceFolders[0].uri.fsPath;
		let productsAdded = 0;
		let featuresAdded = 0;

		// Build lookup of existing product folder paths for fast dedup
		const knownFolders = new Set(
			this.products.flatMap(p =>
				(p.features || []).map(f => f.folderPath?.toLowerCase())
			).filter(Boolean) as string[]
		);

		const entries = fs.readdirSync(root, { withFileTypes: true });
		for (const prodEntry of entries) {
			if (!prodEntry.isDirectory()) { continue; }
			// Skip hidden dirs, node_modules, dist, out, .git, .github, .vscode
			if (/^[._]|^node_modules$|^dist$|^out$/.test(prodEntry.name)) { continue; }

			const prodDir = path.join(root, prodEntry.name);
			const featureEntries = fs.readdirSync(prodDir, { withFileTypes: true }).filter(e => e.isDirectory());

			for (const featEntry of featureEntries) {
				const featDir = path.join(prodDir, featEntry.name);
				const versionEntries = fs.readdirSync(featDir, { withFileTypes: true }).filter(e => e.isDirectory());

				for (const verEntry of versionEntries) {
					const verDir = path.join(featDir, verEntry.name);
					const hasDesign = fs.existsSync(path.join(verDir, 'design', 'threat-analysis.md'));
					const hasRepo   = fs.existsSync(path.join(verDir, 'repo',   'threat-analysis.md'));
					const hasFeatureInfo = fs.existsSync(path.join(verDir, 'feature-info.json'));

					// Pick up folders that have analysis files OR a feature-info.json
					if (!hasDesign && !hasRepo && !hasFeatureInfo) { continue; }
					if (knownFolders.has(verDir.toLowerCase())) { continue; }

					// Find or create the product
					let product = this.products.find(
						p => p.folderPath?.toLowerCase() === prodDir.toLowerCase()
					);
					if (!product) {
						product = {
							id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 6),
							name: prodEntry.name.replace(/_/g, ' '),
							features: [],
							createdAt: new Date().toISOString(),
							folderPath: prodDir
						};
						this.products.push(product);
						productsAdded++;
					}

					// Add the feature
					const newFeature: Feature = {
						id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 6),
						name: featEntry.name.replace(/_/g, ' '),
						version: verEntry.name.replace(/^v/i, ''),
						confluenceUrls: [],
						repositoryUrls: [],
						repositoryScope: 'full',
						subdirectoryPaths: [],
						createdAt: new Date().toISOString(),
						folderPath: verDir,
						hasRepoAnalysis: hasRepo,
						hasDocAnalysis: hasDesign
					};

					// Try to load feature-info.json for extra metadata (Confluence URLs etc.)
					const infoPath = path.join(verDir, 'feature-info.json');
					if (fs.existsSync(infoPath)) {
						try {
							const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
							if (info.confluenceUrls) { newFeature.confluenceUrls = info.confluenceUrls; }
							if (info.repositoryUrls) { newFeature.repositoryUrls = info.repositoryUrls; }
							if (info.confluenceWritebackUrl) { newFeature.confluenceWritebackUrl = info.confluenceWritebackUrl; }
							if (info.jiraProjectKey) { newFeature.jiraProjectKey = info.jiraProjectKey; }
						} catch { /* ignore parse errors */ }
					}

					product.features.push(newFeature);
					knownFolders.add(verDir.toLowerCase());
					featuresAdded++;
				}
			}
		}

		if (productsAdded > 0 || featuresAdded > 0) {
			await this.saveProducts();
		}

		return { productsAdded, featuresAdded };
	}
}
