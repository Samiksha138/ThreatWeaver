import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Feature } from './productManager';
import { MCPManager } from './mcpManager';
import { ReportGenerator } from './reportGenerator';
import { KnowledgeManager } from './knowledgeManager';
import { ValidationGate } from './validationGate';

export interface ThreatAnalysisResult {
	threats: string;
	timestamp: string;
	confluencePageId: string;
}

export class ThreatAnalyzer {
	private context: vscode.ExtensionContext;
	private mcpManager: MCPManager;
	private outputChannel: vscode.OutputChannel;

	constructor(context: vscode.ExtensionContext, mcpManager: MCPManager) {
		this.context = context;
		this.mcpManager = mcpManager;
		this.outputChannel = vscode.window.createOutputChannel('AI Threat Modeling');
		context.subscriptions.push(this.outputChannel);
	}

	/**
	 * Get prior knowledge context from the product's knowledge base.
	 * Returns a formatted string to inject into analysis prompts, or empty string.
	 */
	private getKnowledgeContext(productFolderPath: string | undefined, featureName?: string): string {
		if (!productFolderPath || !fs.existsSync(productFolderPath)) { return ''; }
		const km = new KnowledgeManager(productFolderPath);
		const tags = featureName ? [featureName] : undefined;
		return km.getLessonsAsContext(undefined, tags);
	}

	/**
	 * Run validation gate on a feature's analysis files.
	 * Returns the validation result with errors and warnings.
	 */
	public validateAnalysis(feature: Feature): { design: import('./validationGate').ValidationResult; repo: import('./validationGate').ValidationResult } {
		if (!feature.folderPath || !fs.existsSync(feature.folderPath)) {
			throw new Error('Feature folder does not exist');
		}
		const gate = new ValidationGate();
		return gate.validateFeature(feature.folderPath);
	}

	public async analyzeRepository(feature: Feature): Promise<void> {
		if (!feature.folderPath || !fs.existsSync(feature.folderPath)) {
			throw new Error('Feature folder does not exist');
		}

		// Ensure knowledge folder exists at product level
		const productFolder = path.dirname(feature.folderPath);
		const knowledgeDir = path.join(productFolder, 'knowledge');
		if (!fs.existsSync(knowledgeDir)) {
			fs.mkdirSync(knowledgeDir, { recursive: true });
		}

		if (!feature.repositoryUrls || feature.repositoryUrls.length === 0) {
			throw new Error('No repository URLs provided for this feature');
		}

		// Fetch repository data based on scope — strictly gate scopeData by scope
		// so that Full Repository never accidentally uses PR data
		const scope = (feature.repositoryScope || 'full') as 'full' | 'pr' | 'subdirectory';
		let scopeData: {
			prUrl?: string;
			subdirectoryPaths?: string[];
		} = {};
		if (scope === 'pr') {
			scopeData = { prUrl: feature.prUrl };
		} else if (scope === 'subdirectory') {
			scopeData = { subdirectoryPaths: feature.subdirectoryPaths };
		}
		// scope === 'full': empty scopeData — uses full repo fetch
		
		// Fetch all repository URLs in parallel
		const repoResults = await Promise.all(
			feature.repositoryUrls.map((url, idx) =>
				this.mcpManager.fetchRepositoryWithScope(url, scope, scopeData)
					.then(instruction => instruction ? `### Repository ${idx + 1}: ${url}\n${instruction}` : '')
					.catch(() => '')
			)
		);
		const repositoryInstruction = repoResults.filter(r => r.length > 0).join('\n\n---\n\n');
		
		if (!repositoryInstruction) {
			throw new Error('Failed to fetch repository data from any of the provided URLs');
		}

		// Fetch Confluence page content via MCP if URLs are provided
		let confluenceInstruction = '';
		if (feature.confluenceUrls && feature.confluenceUrls.length > 0) {
			const results = await Promise.all(
				feature.confluenceUrls.map((url, idx) =>
					this.mcpManager.fetchConfluencePage(url)
						.then(content => content ? `### Confluence Page ${idx + 1}: ${url}\n${content}` : '')
						.catch(() => '')
				)
			);
			confluenceInstruction = results.filter(r => r.length > 0).join('\n\n---\n\n');
		}

		// Create the combined prompt for Copilot Chat
		const prompt = this.buildCombinedAnalysisPrompt(feature, repositoryInstruction, confluenceInstruction, scope);

		// Use Copilot Chat to analyze threats
		await this.invokeCopilotChat(prompt);
	}

	public async analyzeDocumentation(feature: Feature): Promise<void> {
		if (!feature.folderPath || !fs.existsSync(feature.folderPath)) {
			throw new Error('Feature folder does not exist');
		}

		// Ensure knowledge folder exists at product level
		const productFolder = path.dirname(feature.folderPath);
		const knowledgeDir = path.join(productFolder, 'knowledge');
		if (!fs.existsSync(knowledgeDir)) {
			fs.mkdirSync(knowledgeDir, { recursive: true });
		}

		// Fetch all Confluence pages content via MCP
		if (!feature.confluenceUrls || feature.confluenceUrls.length === 0) {
			throw new Error('No Confluence page URLs provided for this feature');
		}

		const results = await Promise.all(
			feature.confluenceUrls.map((url, idx) =>
				this.mcpManager.fetchConfluencePage(url)
					.then(content => content ? `### Confluence Page ${idx + 1}: ${url}\n${content}` : '')
					.catch(() => '')
			)
		);
		const confluenceInstruction = results.filter(r => r.length > 0).join('\n\n---\n\n');

		if (!confluenceInstruction) {
			throw new Error('Failed to fetch any Confluence page content');
		}

		// For documentation-only analysis, use empty repository instruction
		const repositoryInstruction = '';
		
		// Create the combined prompt for Copilot Chat
		const prompt = this.buildCombinedAnalysisPrompt(feature, repositoryInstruction, confluenceInstruction, 'full');

		// Use Copilot Chat to analyze threats
		await this.invokeCopilotChat(prompt);
	}

	/**
	 * Re-analyze threats when a Confluence page has changed.
	 * Reads existing threat-analysis.md and dataflow-diagram.drawio,
	 * fetches the updated Confluence content, and asks Copilot to perform
	 * an incremental/delta analysis that preserves existing findings.
	 */
	public async reanalyzeWithContext(feature: Feature): Promise<void> {
		if (!feature.folderPath || !fs.existsSync(feature.folderPath)) {
			throw new Error('Feature folder does not exist');
		}
		if (!feature.confluenceUrls || feature.confluenceUrls.length === 0) {
			throw new Error('No Confluence page URLs provided for this feature');
		}

		// 1. Read existing analysis outputs from disk
		const designThreatPath  = path.join(feature.folderPath, 'design', 'threat-analysis.md');
		const designDfdPath     = path.join(feature.folderPath, 'design', 'dataflow-diagram.drawio');
		const repoThreatPath    = path.join(feature.folderPath, 'repo',   'threat-analysis.md');
		const repoDfdPath       = path.join(feature.folderPath, 'repo',   'dataflow-diagram.drawio');

		const existingDesignThreats = fs.existsSync(designThreatPath) ? fs.readFileSync(designThreatPath, 'utf-8').trim() : '';
		const existingDesignDfd     = fs.existsSync(designDfdPath)    ? fs.readFileSync(designDfdPath,    'utf-8').trim() : '';
		const existingRepoThreats   = fs.existsSync(repoThreatPath)  ? fs.readFileSync(repoThreatPath,   'utf-8').trim() : '';
		const existingRepoDfd       = fs.existsSync(repoDfdPath)      ? fs.readFileSync(repoDfdPath,      'utf-8').trim() : '';

		// 2. Fetch latest Confluence page content via MCP
		const results = await Promise.all(
			feature.confluenceUrls.map((url, idx) =>
				this.mcpManager.fetchConfluencePage(url)
					.then(content => content ? `### Confluence Page ${idx + 1}: ${url}\n${content}` : '')
					.catch(() => '')
			)
		);
		const confluenceInstruction = results.filter(r => r.length > 0).join('\n\n---\n\n');
		if (!confluenceInstruction) {
			throw new Error('Failed to fetch updated Confluence page content');
		}

		// 3. Build delta analysis prompt
		const prompt = this._buildDeltaAnalysisPrompt(
			feature, confluenceInstruction,
			existingDesignThreats, existingDesignDfd,
			existingRepoThreats, existingRepoDfd
		);

		// 4. Invoke Copilot Chat
		await this.invokeCopilotChat(prompt);
	}

	private _buildDeltaAnalysisPrompt(
		feature: Feature,
		confluenceInstruction: string,
		existingDesignThreats: string,
		existingDesignDfd: string,
		existingRepoThreats: string,
		existingRepoDfd: string
	): string {
		const technology = feature.name;
		const designFolder   = path.join(feature.folderPath!, 'design');
		const designThreatPath  = path.join(designFolder, 'threat-analysis.md');
		const designDataflowPath = path.join(designFolder, 'dataflow-diagram.drawio');

		// Collect existing context sections
		const existingSections: string[] = [];
		if (existingDesignThreats) {
			existingSections.push(`### Existing Design Threat Analysis\n\`\`\`markdown\n${existingDesignThreats}\n\`\`\``);
		}
		if (existingRepoThreats) {
			existingSections.push(`### Existing Repository Threat Analysis\n\`\`\`markdown\n${existingRepoThreats}\n\`\`\``);
		}
		if (existingDesignDfd) {
			existingSections.push(`### Existing Design Data Flow Diagram\n\`\`\`xml\n${existingDesignDfd}\n\`\`\``);
		}
		if (existingRepoDfd) {
			existingSections.push(`### Existing Repository Data Flow Diagram\n\`\`\`xml\n${existingRepoDfd}\n\`\`\``);
		}

		const existingContext = existingSections.length > 0
			? `## Previous Threat Analysis & Data Flow Diagrams\nThe following are the EXISTING threat analysis outputs from the previous version of the specification. Use these as your baseline.\n\n${existingSections.join('\n\n')}`
			: '';

		return `${confluenceInstruction}

${existingContext}

You are a senior security architect performing an **incremental threat re-analysis** for ${technology}.

## Mission — Delta / Incremental Re-Analysis
The functional specification (Confluence pages above) has been **updated** since the last threat analysis.
Your job is to compare the updated specification against the **existing threat analysis and data flow diagrams** provided above, and produce an updated, consolidated output.

### What to do:
1. **Identify NEW threats** introduced by the specification changes that were not covered in the existing analysis.
2. **Identify REMOVED threats** — existing threats that are no longer relevant because the related functionality was removed or changed.
3. **Identify MODIFIED threats** — existing threats whose severity, component, description, or mitigation needs updating due to the specification changes.
4. **Preserve UNCHANGED threats** — keep all existing threats that are still valid as-is.
5. **Update the Data Flow Diagram** — reflect any new components, data flows, trust boundaries, or removed elements from the updated spec.

### Output Format
Produce the **complete, merged** threat analysis (not just the delta). The output should be a full replacement of the existing analysis file, incorporating all changes.

At the top of the output, include a **Change Summary** section:

## Change Summary
- **New threats added**: (count)
- **Threats removed**: (count)
- **Threats modified**: (count)
- **Threats unchanged**: (count)

Then list the full threat analysis below.

⚠️ CRITICAL: Use EXACTLY this format for each threat (parser requires strict adherence):

### Threat: {Descriptive Title}
**STRIDE Category**: Spoofing|Tampering|Repudiation|Information Disclosure|Denial of Service|Elevation of Privilege
**Severity**: Critical|High|Medium|Low
**Component**: {Architecture Component Name}
**Description**: {detailed vulnerability explanation}
**Impact**: {specific consequences and business impact}
**Mitigation**:
- First mitigation step
- Second mitigation step
- Third mitigation step
**Status**: New|Modified|Unchanged

---

**Format Rules:**
1. Always use ### (three hashes) for threat headings
2. Start heading with "Threat:" followed by descriptive title
3. Each field MUST be on its own line
4. STRIDE Category MUST be one of: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege
5. Severity MUST be one of: Critical, High, Medium, Low
6. Mitigation MUST be a bullet list with - (dash) prefix
7. Separate each threat with --- (three dashes)
8. **Status** field marks whether this threat is New, Modified, or Unchanged
9. Do NOT include removed threats in the final output — list them only in the Change Summary

## Part 2: Data Flow Diagrams

Update the data flow diagram using the draw.io VS Code extension, using Threat Modeling shapes. Reflect all changes from the updated specification.

## Output Locations
**Save updated design analysis**: ${designThreatPath}
**Save updated design dataflow (draw.io)**: ${designDataflowPath}

Disclaimer:
 - Only analyze based on the provided updated Confluence content and existing analysis context.
 - Do not make assumptions or use any other files from workspace beyond the given information.
 - Produce a COMPLETE merged output, not just the differences.`;
	}

	private extractPageId(confluenceUrl: string): string {
		// Try to extract page ID from URL
		const urlMatch = confluenceUrl.match(/pages[\/](\d+)/);
		if (urlMatch) {
			return urlMatch[1];
		}
		
		// If it's just a number, use it directly
		if (/^\d+$/.test(confluenceUrl)) {
			return confluenceUrl;
		}

		// Return as-is if we can't extract
		return confluenceUrl;
	}

	private buildCombinedAnalysisPrompt(
		feature: Feature,
		repositoryInstruction: string,
		confluenceInstruction: string,
		scope: 'full' | 'pr' | 'subdirectory' = 'full'
	): string {
		const technology = feature.name;
		const repoFolder = path.join(feature.folderPath!, 'repo');
		const designFolder = path.join(feature.folderPath!, 'design');
		const repoThreatPath = path.join(repoFolder, 'threat-analysis.md');
		const repoDataflowPath = path.join(repoFolder, 'dataflow-diagram.drawio');
		const designThreatPath = path.join(designFolder, 'threat-analysis.md');
		const designDataflowPath = path.join(designFolder, 'dataflow-diagram.drawio');
		
		const hasRepository = repositoryInstruction && repositoryInstruction.trim().length > 0;
		const hasConfluence = confluenceInstruction && confluenceInstruction.trim().length > 0;

		// Inject prior knowledge from the product's knowledge base
		const productFolder = path.dirname(path.dirname(feature.folderPath!)); // feature = product/feature/version
		const knowledgeContext = this.getKnowledgeContext(productFolder, feature.name);

		let contextSection = '';
		if (hasRepository && hasConfluence) {
			contextSection = `${repositoryInstruction}

${confluenceInstruction}`;
		} else if (hasRepository) {
			contextSection = repositoryInstruction;
		} else if (hasConfluence) {
			contextSection = confluenceInstruction;
		}

		let analysisScope = '';
		let outputLocations = '';

		// ── PR scope: dedicated focused prompt ──────────────────────────────────
		if (scope === 'pr' && hasRepository) {
			const prUrl = feature.prUrl || feature.repositoryUrls?.[0] || '';
			return `${contextSection}


You are a senior security architect performing a **pull request security review** for ${technology}.

## Mission
Review ONLY the code changes in this pull request. Identify security vulnerabilities introduced or exposed by these specific changes. Do NOT re-audit unchanged code.${prUrl ? `\n\nPull Request: ${prUrl}` : ''}

## Part 1: Threat Analysis

⚠️ CRITICAL: Use EXACTLY this format for each threat (parser requires strict adherence):

### Threat: {Descriptive Title}
**STRIDE Category**: Spoofing|Tampering|Repudiation|Information Disclosure|Denial of Service|Elevation of Privilege
**Severity**: Critical|High|Medium|Low
**Component**: {exact/file/path.ext:line-number}
**Description**: {detailed vulnerability explanation}
**Impact**: {specific consequences and business impact}
**Mitigation**:
- First mitigation step
- Second mitigation step
- Third mitigation step

---

**Format Rules:**
1. Always use ### (three hashes) for threat headings
2. Start heading with "Threat:" followed by descriptive title
3. Each field MUST be on its own line
4. STRIDE Category MUST be one of: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege
5. Severity MUST be one of: Critical, High, Medium, Low
6. Mitigation MUST be a bullet list with - (dash) prefix
7. Separate each threat with --- (three dashes)

Requirements:
- Analyze ONLY the changed/added code in the PR diff
- Every finding must reference exact file:line-number
- Focus on: injection, broken auth, secrets/credentials in code, missing input validation, insecure defaults, privilege escalation introduced by this change
- Do not generate generic findings — every threat must trace directly to a changed line

## Part 2: Data Flow Diagrams

Draw a data flow diagram using the draw.io VS Code extension, using Threat Modeling shapes.

## Output Locations
**Save PR analysis**: ${repoThreatPath}
**Save repo dataflow (draw.io)**: ${repoDataflowPath}

Disclaimer: Only analyze the PR diff provided. Do not make assumptions about unchanged files.
${feature.repositoryUrls?.[0] ? ` - Use mcp github to fetch the PR if needed` : ''}`;
		}

		// ── Full / diff / subdirectory scope ─────────────────────────────────────
		if (hasRepository && hasConfluence) {
			analysisScope = 'Generate threat analysis and data flow diagrams for both Confluence pages and Codebase.';
			outputLocations = `## Output Locations
**Save repository analysis**: ${repoThreatPath}
**Save design analysis**: ${designThreatPath}
**Save repo dataflow (draw.io)**: ${repoDataflowPath}
**Save design dataflow (draw.io)**: ${designDataflowPath}`;
		} else if (hasRepository) {
			analysisScope = 'Generate threat analysis and data flow diagrams for the Codebase only.';
			outputLocations = `## Output Locations
**Save repository analysis**: ${repoThreatPath}
**Save repo dataflow (draw.io)**: ${repoDataflowPath}

Note: Only analyze the provided repository code. Do not create design-level analysis.`;
		} else if (hasConfluence) {
			analysisScope = 'Generate threat analysis and data flow diagrams for the Confluence design document only.';
			outputLocations = `## Output Locations
**Save design analysis**: ${designThreatPath}
**Save design dataflow (draw.io)**: ${designDataflowPath}

Note: Only analyze the provided design document. Do not create code-level analysis.`;
		}
		
		return `${contextSection}

${knowledgeContext ? `${knowledgeContext}\n\n` : ''}
You are a senior security architect who has great experience in performing threat modeling for ${technology}. Perform context-specific threat analysis with precise code/architecture references.

## Mission
Find vulnerabilities with exact locations, attack paths, and actionable fixes. ${analysisScope}

## Part 1: Threat Analysis

⚠️ CRITICAL: Use EXACTLY this format for each threat (parser requires strict adherence):

### Threat: {Descriptive Title}
**STRIDE Category**: Spoofing|Tampering|Repudiation|Information Disclosure|Denial of Service|Elevation of Privilege
**Severity**: Critical|High|Medium|Low
**Component**: {exact/file/path.ext:line-number} OR {Architecture Component Name}
**Description**: {detailed vulnerability explanation}
**Impact**: {specific consequences and business impact}
**Mitigation**:
- First mitigation step
- Second mitigation step
- Third mitigation step

---

**Format Rules:**
1. Always use ### (three hashes) for threat headings
2. Start heading with "Threat:" followed by descriptive title
3. Each field (**STRIDE Category**, **Severity**, **Component**, etc.) MUST be on its own line
4. STRIDE Category MUST be one of: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege
5. Severity MUST be one of: Critical, High, Medium, Low
6. Mitigation MUST be a bullet list with - (dash) prefix
7. Separate each threat with --- (three dashes)
8. NO code blocks, NO numbered lists for mitigations
9. Keep each field concise (1-3 sentences max)
10. Always classify each threat using STRIDE methodology before listing severity

Requirements:
${hasRepository ? '- Focus on code-specific issues (auth, injection, secrets, validation and other in-depth) for code level threats. Add exact file location under component for code threats' : ''}
${hasConfluence ? '- Focus on architecture, data flow, and trust boundaries for design level threats using STRIDE methodology' : ''}
- Don't limit to OWASP Top 10, consider all threat types. No generic threats.

## Part 2: Data Flow Diagrams

Draw a data flow diagram using the draw.io VS Code extension, using Threat Modeling shapes.

Disclaimer:
 - Please ensure all analysis are identified from the provided ${hasRepository && hasConfluence ? 'Confluence content and codebase' : hasRepository ? 'codebase' : 'Confluence content'} only. 
 - Do not make assumptions/use any other files from workspace beyond the given information.
${hasRepository ? ' - For Github repositories, Use mcp github to analyze the code' : ''}

${outputLocations}

## Part 3: Knowledge Capture (Lessons Learned)

After completing the threat analysis and DFD, create 1-2 lesson files in: ${path.join(productFolder, 'knowledge')}

Each lesson captures a key insight from this analysis. Use this exact filename pattern: LESSON-001.md, LESSON-002.md, etc.

**File format:**
\`\`\`markdown
---
title: <short descriptive title>
domain: <one of: authentication, authorization, data-flow, networking, cryptography, input-validation, other>
tags: [${feature.name}, <additional relevant tags>]
product: ${path.basename(productFolder)}
feature: ${feature.name}
createdAt: ${new Date().toISOString().split('T')[0]}
---
<2-3 sentence insight about a key finding, pattern, or blind spot discovered during this analysis>
\`\`\`

**What to capture:** Surprising attack vectors, recurring patterns, architectural blind spots, or domain-specific risks worth remembering for future analyses of this product.`;
	}

	private async invokeCopilotChat(prompt: string): Promise<void> {
		try {
			// Send the prompt to Copilot Chat
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: prompt
			});

			// Show notification
			await vscode.window.showInformationMessage(
				'Copilot Chat opened with threat modeling prompt. Copilot will save the analysis automatically.'
			);
		} catch (error) {
			throw new Error(`Failed to invoke Copilot Chat: ${error}`);
		}
	}

	public async publishToConfluence(feature: Feature, productName?: string): Promise<string> {
		if (!feature.confluenceWritebackUrl) {
			throw new Error('No Confluence writeback page configured for this feature.');
		}

		// 1. Validate analysis files exist on disk
		const repoPath   = feature.folderPath ? path.join(feature.folderPath, 'repo',   'threat-analysis.md') : null;
		const designPath = feature.folderPath ? path.join(feature.folderPath, 'design', 'threat-analysis.md') : null;
		const hasRepo   = repoPath   && fs.existsSync(repoPath);
		const hasDesign = designPath && fs.existsSync(designPath);
		if (!hasRepo && !hasDesign) {
			throw new Error('No threat analysis files found. Please run "Analyze Threats" first.');
		}

		// 2. Parse cloudId and pageId from the writeback URL
		const { cloudId, pageId } = this.parseConfluenceUrl(feature.confluenceWritebackUrl);

		// 3. Atlassian credentials are mandatory for Confluence publish
		const email = await this.context.secrets.get('atlassian.email');
		const token = await this.context.secrets.get('atlassian.apiToken');
		if (!email || !token) {
			throw new Error(
				'Atlassian credentials are required to publish to Confluence.\n' +
				'Please configure them via: Threat Modeling sidebar \u2192 Configure Credentials \u2192 Atlassian Email & API Token'
			);
		}

		// 4. Read threat analysis files
		const repoMd   = hasRepo   ? fs.readFileSync(repoPath!,   'utf-8').trim() : '';
		const designMd = hasDesign ? fs.readFileSync(designPath!, 'utf-8').trim() : '';

		// 4. Read DFD files if present
		const repoDfdPath   = feature.folderPath ? path.join(feature.folderPath, 'repo',   'dataflow-diagram.drawio') : null;
		const designDfdPath = feature.folderPath ? path.join(feature.folderPath, 'design', 'dataflow-diagram.drawio') : null;
		const repoDfd   = repoDfdPath   && fs.existsSync(repoDfdPath)   ? fs.readFileSync(repoDfdPath,   'utf-8').trim() : '';
		const designDfd = designDfdPath && fs.existsSync(designDfdPath) ? fs.readFileSync(designDfdPath, 'utf-8').trim() : '';

		// 6. Build body in confirmed-working markdown format (storage/adf/wiki all produce empty pages)
		const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
		const featureLabel = `${productName ? productName + ' / ' : ''}${feature.name} v${feature.version}`;

		// Parse threats from both sources — inject source marker headings so the parser
		// can distinguish repo vs design threats even if the individual files lack them
		const reportGenerator = new ReportGenerator();
		const markedSections: string[] = [];
		if (repoMd) {
			markedSections.push(`## Repository Code Analysis\n\n${repoMd}`);
		}
		if (designMd) {
			markedSections.push(`## Design Documentation Analysis\n\n${designMd}`);
		}
		const combinedMd = markedSections.join('\n\n');
		const threats = reportGenerator.parseThreatsFromMarkdown(combinedMd);

		// Severity emoji helpers (markdown-compatible)
		const sevEmoji = (sev: string): string => {
			switch (sev?.toLowerCase()) {
				case 'critical': return '🔴 Critical';
				case 'high':     return '🟠 High';
				case 'medium':   return '🟡 Medium';
				case 'low':      return '🟢 Low';
				default:         return sev || '';
			}
		};
		const escMd = (s: string): string =>
			String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

		// Threat counts
		const critCount  = threats.filter(t => t.severity?.toLowerCase() === 'critical').length;
		const highCount  = threats.filter(t => t.severity?.toLowerCase() === 'high').length;
		const medCount   = threats.filter(t => t.severity?.toLowerCase() === 'medium').length;
		const lowCount   = threats.filter(t => t.severity?.toLowerCase() === 'low').length;
		const totalCount = threats.length;

		// Pre-scan drawio diagrams
		type DiagramCandidate = { label: string; folder: string; stem: string };
		const diagramCandidates: DiagramCandidate[] = [];
		const scanDiagramFolder = (folder: string, labelPrefix: string) => {
			if (!fs.existsSync(folder)) { return; }
			const entries = fs.readdirSync(folder);
			const drawioFiles = entries.filter((e: string) => e.toLowerCase().endsWith('.drawio'));
			for (const f of drawioFiles) {
				const stem = f.replace(/\.drawio$/i, '');
				diagramCandidates.push({
					label:  `${labelPrefix} — ${stem}`,
					folder,
					stem,
				});
			}
		};
		if (feature.folderPath) {
			scanDiagramFolder(path.join(feature.folderPath, 'repo'),   'Repository');
			scanDiagramFolder(path.join(feature.folderPath, 'design'), 'Design');
			scanDiagramFolder(feature.folderPath, 'Diagram');
		}

		// ── Executive Summary ────────────────────────────────────────────────────
		const execLines: string[] = [];
		execLines.push('## Executive Summary');
		execLines.push('');
		execLines.push(`This threat model was automatically generated by the **AI Threat Modeling Extension** on **${today}** for **${feature.name}** (version ${feature.version}).`);
		execLines.push('');
		execLines.push(`A total of **${totalCount} threat${totalCount !== 1 ? 's' : ''}** were identified using the STRIDE methodology:`);
		execLines.push('');
		execLines.push(`| Severity | Count |`);
		execLines.push(`| --- | --- |`);
		execLines.push(`| 🔴 Critical | ${critCount} |`);
		execLines.push(`| 🟠 High | ${highCount} |`);
		execLines.push(`| 🟡 Medium | ${medCount} |`);
		execLines.push(`| 🟢 Low | ${lowCount} |`);
		execLines.push(`| **Total** | **${totalCount}** |`);
		execLines.push('');
		if (critCount + highCount > 0) {
			execLines.push(`> ⚠️ **Immediate action required** for **${critCount + highCount}** Critical/High finding${critCount + highCount !== 1 ? 's' : ''}. See Section 4 for key risks and recommended controls.`);
		} else {
			execLines.push(`> ✅ No Critical or High severity threats identified. Continue monitoring for emerging risks.`);
		}
		execLines.push('');
		if (feature.confluenceUrls?.length || feature.repositoryUrls?.length) {
			execLines.push('**Analysis sources:**');
			feature.confluenceUrls?.forEach((u, i) => execLines.push(`- Design document ${i + 1}: ${u}`));
			feature.repositoryUrls?.forEach((u, i) => execLines.push(`- Repository ${i + 1}: ${u}`));
			execLines.push('');
		}
		execLines.push('---');
		execLines.push('');

		// ── Section 1: Context and Assumptions ──────────────────────────────────
		const ctxLines: string[] = [];
		ctxLines.push('## 1. Context and Assumptions');
		ctxLines.push('');
		ctxLines.push(`1. This threat model covers **${feature.name}** (version ${feature.version}).`);
		feature.confluenceUrls?.forEach((u, i) => ctxLines.push(`   - Source design document ${i + 1}: ${u}`));
		feature.repositoryUrls?.forEach((u, i) => ctxLines.push(`   - Source repository ${i + 1}: ${u}`));
		ctxLines.push(`1. Analysis generated by AI Threat Modeling Extension on ${today}.`);
		ctxLines.push('1. The STRIDE methodology is used to enumerate threats.');
		ctxLines.push('1. Threat level mapping: **Critical/High** = immediate action required; **Medium** = plan within sprint; **Low** = monitor.');
		ctxLines.push('');

		// ── Section 2: Data Flow Diagram ────────────────────────────────────────
		const dfdLines: string[] = [];
		dfdLines.push('## 2. Data flow diagram');
		dfdLines.push('');

		if (diagramCandidates.length > 0) {
			for (const d of diagramCandidates) {
				dfdLines.push(`### ${d.label}`);
				dfdLines.push('');
				const drawioLocalPath = path.join(d.folder, `${d.stem}.drawio`);
				const drawioFilename = `dfd-${d.label.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.drawio`;
				const { url: drawioUrl } = await this._tryPublishDiagramAsImage(
					cloudId, pageId, drawioLocalPath, drawioFilename, email, token
				);
				if (drawioUrl) {
					dfdLines.push(`{{drawio:${drawioFilename}:1200}}`);
				} else {
					const localFileUrl = 'file:///' + drawioLocalPath.replace(/\\/g, '/');
					dfdLines.push(`📊 **[${path.basename(drawioLocalPath)}](${localFileUrl})** _(Upload failed — see [AI Threat Modeling output](command:workbench.action.output.toggleOutput) for details)_`);
				}
				dfdLines.push('');
			}
		} else {
			dfdLines.push('_No .drawio diagram files found under `repo/`, `design/`, or the feature root folder._');
			dfdLines.push('');
		}

		// ── Section 3: STRIDE Threats table ─────────────────────────────────────
		// Load Jira tickets created for this feature (if any) to populate the ticket column
		const ticketsPath = feature.folderPath ? path.join(feature.folderPath, 'jira-tickets.json') : null;
		const jiraTicketMap = new Map<string, { key: string; url: string }>();
		if (ticketsPath && fs.existsSync(ticketsPath)) {
			try {
				const savedTickets: Array<{ threatName: string; key: string; url: string }> = JSON.parse(fs.readFileSync(ticketsPath, 'utf-8'));
				for (const t of savedTickets) {
					jiraTicketMap.set(t.threatName, { key: t.key, url: t.url });
				}
			} catch { /* ignore parse errors */ }
		}

		const tableLines: string[] = [];
		tableLines.push('## 3. STRIDE Threats & Mitigations');
		tableLines.push('');
		if (threats.length === 0) {
			tableLines.push('_Threat list could not be auto-parsed into a table. Full analysis:_');
			tableLines.push('');
			tableLines.push(combinedMd);
		} else {
			// Group threats by source (design vs repo), matching HTML report layout
			let currentSource = '';
			const tableHeader = [
				'| **Component / Trust Boundary** | **STRIDE Category** | **Threat Description** | **Threat Level** | **Mitigation** | **Mitigation Jira ticket** |',
				'| --- | --- | --- | --- | --- | --- |'
			];
			let lastComponent = '';
			for (const t of threats) {
				// Insert section heading when source changes
				if (t.source !== currentSource) {
					currentSource = t.source;
					const sectionTitle = currentSource === 'repo' ? '🔧 Repository Code Threats' : '📄 Design-level Threats';
					if (tableLines[tableLines.length - 1] !== '') {
						tableLines.push('');
					}
					tableLines.push(`### ${sectionTitle}`);
					tableLines.push('');
					tableLines.push(...tableHeader);
					lastComponent = '';
				}
				const comp = t.component || '';
				const displayComp = comp === lastComponent ? '' : comp;
				lastComponent = comp;
				const mitItems: string[] = [
					...(t.mitigation?.immediate ?? []),
					...(t.mitigation?.shortTerm ?? []),
					...(t.mitigation?.longTerm  ?? [])
				];
				const mitText = mitItems.map(m => `• ${escMd(m)}`).join('<br/>');
				const jiraEntry = jiraTicketMap.get(t.name);
				const jiraCell = jiraEntry ? `[${jiraEntry.key}](${jiraEntry.url})` : '';
				tableLines.push(`| ${escMd(displayComp)} | ${escMd(t.strideCategory)} | ${escMd(t.description)} | ${sevEmoji(t.severity)} | ${mitText} | ${jiraCell} |`);
			}
		}
		tableLines.push('');

		// ── Section 4: Summary of Key Risks & Controls ──────────────────────────
		const summaryLines: string[] = [];
		summaryLines.push('## 4. Summary of Key Risks & Controls');
		summaryLines.push('');
		const keyThreats = threats.filter(t => ['critical', 'high'].includes(t.severity?.toLowerCase() ?? ''));
		if (keyThreats.length === 0) {
			summaryLines.push(threats.length > 0
				? '_No Critical or High severity threats identified._'
				: '_See raw analysis in Section 3 above._');
		} else {
			for (const t of keyThreats) {
				const mitItems: string[] = [
					...(t.mitigation?.immediate ?? []),
					...(t.mitigation?.shortTerm ?? []),
					...(t.mitigation?.longTerm  ?? [])
				];
				const controlsText = mitItems.length > 0 ? mitItems.join('; ') : 'See threat table for details.';
				summaryLines.push(`**${t.name}**`);
				summaryLines.push('');
				summaryLines.push(`_**Risk**:_ ${t.description}`);
				summaryLines.push('');
				summaryLines.push(`_**Controls**:_ ${controlsText}`);
				summaryLines.push('');
			}
		}
		summaryLines.push('');
		summaryLines.push('---');
		summaryLines.push(`*AI-generated threat model for ${featureLabel}. Review and validate before acting on these findings.*`);

		// 6. UPDATE the Confluence page
		const body = [
			execLines.join('\n'),
			ctxLines.join('\n'),
			dfdLines.join('\n'),
			tableLines.join('\n'),
			summaryLines.join('\n'),
		].join('\n');

		const pageTitle = `Threat Model — ${featureLabel}`;

		// Always use REST API directly — supports drawio macros via storage format
		await this._updateConfluencePageViaRest(cloudId, pageId, pageTitle, body, email, token);
		this.outputChannel.appendLine('[Publish] ✅ Published via REST API (storage format).');

		return feature.confluenceWritebackUrl;
	}

	/**
	 * Direct REST API fallback for updating a Confluence page when MCP tool is unavailable (e.g., Cursor IDE).
	 */
	private async _updateConfluencePageViaRest(
		host: string, pageId: string, title: string, markdownBody: string,
		email: string, apiToken: string
	): Promise<void> {
		const https = require('https');

		const baseUrl = `https://${host}`;
		const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
		const apiPrefix = host.includes('.atlassian.net') || host.includes('.atlassian.com') ? '/wiki' : '';

		// 1. GET current page version
		const getPage = (): Promise<{ version: number; title: string }> => {
			return new Promise((resolve, reject) => {
				const url = new URL(`${apiPrefix}/rest/api/content/${pageId}?expand=version`, baseUrl);
				if (url.protocol !== 'https:') {
					reject(new Error('Only HTTPS URLs are supported for security. HTTP connections are not allowed.'));
					return;
				}
				const req = https.get(url.toString(), {
					headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
				}, (res: import('http').IncomingMessage) => {
					let data = '';
					res.on('data', (chunk: string) => { data += chunk; });
					res.on('end', () => {
						if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
							const parsed = JSON.parse(data);
							resolve({ version: parsed.version.number, title: parsed.title });
						} else {
							reject(new Error(`GET page failed (${res.statusCode}): ${data}`));
						}
					});
				});
				req.setTimeout(30_000, () => { req.destroy(new Error('GET page timed out after 30 seconds')); });
				req.on('error', reject);
			});
		};

		const pageInfo = await getPage();
		const newVersion = pageInfo.version + 1;

		// 2. Convert markdown to Confluence storage format (simple HTML conversion)
		const storageBody = this._markdownToConfluenceStorage(markdownBody);

		// 3. PUT updated page
		const putBody = JSON.stringify({
			version: { number: newVersion },
			title: title,
			type: 'page',
			body: {
				storage: {
					value: storageBody,
					representation: 'storage'
				}
			}
		});

		return new Promise((resolve, reject) => {
			const url = new URL(`${apiPrefix}/rest/api/content/${pageId}`, baseUrl);
			if (url.protocol !== 'https:') {
				reject(new Error('Only HTTPS URLs are supported for security. HTTP connections are not allowed.'));
				return;
			}
			const req = https.request(url.toString(), {
				method: 'PUT',
				headers: {
					'Authorization': `Basic ${auth}`,
					'Content-Type': 'application/json',
					'Accept': 'application/json',
					'Content-Length': Buffer.byteLength(putBody)
				}
			}, (res: import('http').IncomingMessage) => {
				let data = '';
				res.on('data', (chunk: string) => { data += chunk; });
				res.on('end', () => {
					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						resolve();
					} else {
						reject(new Error(`PUT page failed (${res.statusCode}): ${data}`));
					}
				});
			});
			req.setTimeout(30_000, () => { req.destroy(new Error('PUT page timed out after 30 seconds')); });
			req.on('error', reject);
			req.write(putBody);
			req.end();
		});
	}

	/**
	 * Basic markdown → Confluence storage format (XHTML) converter.
	 */
	private _markdownToConfluenceStorage(md: string): string {
		let html = md;
		// Draw.io macros: {{drawio:filename:width}} → Confluence drawio structured macro
		html = html.replace(/\{\{drawio:([^:}]+):(\d+)\}\}/g, (_m, diagramName: string, width: string) => {
			return `<ac:structured-macro ac:name="drawio" ac:schema-version="1"><ac:parameter ac:name="diagramName">${diagramName}</ac:parameter><ac:parameter ac:name="width">${width}</ac:parameter></ac:structured-macro>`;
		});
		// Tables: convert markdown tables to HTML tables
		html = html.replace(/^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)*)/gm, (_match, header: string, _sep: string, bodyBlock: string) => {
			const headers = header.split('|').filter((c: string) => c.trim()).map((c: string) => `<th style="word-wrap:break-word;overflow-wrap:break-word;white-space:normal;">${c.trim()}</th>`).join('');
			const rows = bodyBlock.trim().split('\n').map((row: string) => {
				const cells = row.split('|').filter((c: string) => c.trim()).map((c: string) => `<td style="word-wrap:break-word;overflow-wrap:break-word;white-space:normal;">${c.trim()}</td>`).join('');
				return `<tr>${cells}</tr>`;
			}).join('');
			return `<table data-layout="full-width" style="table-layout:fixed;width:100%;"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>\n`;
		});
		// Images: ![alt](url) → Confluence attachment or external image macro
		html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
			// Extract filename from URL (last path segment)
			const filename = url.split('/').pop() || alt;
			if (url.includes('/download/attachments/') || url.includes('/wiki/download/')) {
				// Confluence attachment — use ac:image with ri:attachment
				return `<ac:image ac:alt="${alt}" ac:title="${alt}"><ri:attachment ri:filename="${filename}"/></ac:image>`;
			}
			// External image
			return `<ac:image ac:alt="${alt}" ac:title="${alt}"><ri:url ri:value="${url}"/></ac:image>`;
		});
		// Links: [text](url) → <a href="url">text</a>
		html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
		// Headers
		html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
		html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
		html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
		html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
		// Bold and italic
		html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
		html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/_\*\*(.+?)\*\*:_/g, '<em><strong>$1</strong>:</em>');
		html = html.replace(/_(.+?)_/g, '<em>$1</em>');
		// Horizontal rules
		html = html.replace(/^---$/gm, '<hr/>');
		// Line breaks — convert double newlines to paragraphs
		const blocks = html.split(/\n{2,}/);
		html = blocks.map(block => {
			block = block.trim();
			if (!block) { return ''; }
			if (block.startsWith('<h') || block.startsWith('<table') || block.startsWith('<hr') || block.startsWith('<ac:')) {
				return block;
			}
			return `<p>${block.replace(/\n/g, '<br/>')}</p>`;
		}).filter(Boolean).join('\n');
		return html;
	}


	private async _tryPublishDiagramAsImage(
		cloudId: string, pageId: string, imagePath: string, filename: string,
		email: string, token: string
	): Promise<{ url: string | null; reason: 'ok' | 'upload-failed' }> {
		try {
			const fileBuffer = fs.readFileSync(imagePath);
			const contentType = 'application/xml';
			this.outputChannel.appendLine(`[DFD Upload] Uploading ${filename} to ${cloudId} page ${pageId} as ${email}`);
			const result = await this._uploadConfluenceAttachment(cloudId, pageId, filename, fileBuffer, contentType, email, token);
			if (result.url) {
				this.outputChannel.appendLine(`[DFD Upload] ✅ Success: ${result.url}`);
				return { url: result.url, reason: 'ok' };
			} else {
				this.outputChannel.appendLine(`[DFD Upload] ❌ Upload failed — HTTP ${result.status ?? 'error'}: ${result.body ?? ''}`);
				vscode.window.showWarningMessage(`DFD image upload failed (HTTP ${result.status ?? 'error'}). Check the "AI Threat Modeling" Output channel for details.`);
				return { url: null, reason: 'upload-failed' };
			}
		} catch (e) {
			this.outputChannel.appendLine(`[DFD Upload] ❌ Exception: ${e}`);
			return { url: null, reason: 'upload-failed' };
		}
	}

	private _httpsRequest(
		options: import('https').RequestOptions, body: Buffer, timeoutMs: number = 30_000
	): Promise<{ statusCode: number; body: string }> {
		return new Promise((resolve, reject) => {
			const https = require('https') as typeof import('https');
			const req = https.request(options, (res: import('http').IncomingMessage) => {
				let data = '';
				res.on('data', (chunk: Buffer) => data += chunk.toString());
				res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
			});
			req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)); });
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	private async _getExistingAttachmentId(
		cloudId: string, pageId: string, filename: string, auth: string
	): Promise<string | null> {
		return new Promise((resolve) => {
			const https = require('https') as typeof import('https');
			const req = https.request({
				hostname: cloudId,
				path: `/wiki/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(filename)}&limit=1`,
				method: 'GET',
				headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
			}, (res: import('http').IncomingMessage) => {
				let data = '';
				res.on('data', (chunk: Buffer) => data += chunk.toString());
				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						const id = json?.results?.[0]?.id ?? null;
						resolve(id);
					} catch { resolve(null); }
				});
			});
			req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
			req.on('error', () => resolve(null));
			req.end();
		});
	}

	private async _uploadConfluenceAttachment(
		cloudId: string, pageId: string, filename: string,
		fileBuffer: Buffer, contentType: string, email: string, apiToken: string
	): Promise<{ url: string | null; status?: number; body?: string }> {
		const boundary = `----ThreatModelBoundary${Date.now()}`;
		const bodyBuffer = Buffer.concat([
			Buffer.from(
				`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
				`Content-Type: ${contentType}\r\n\r\n`
			),
			fileBuffer,
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]);
		const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
		const successUrl = `https://${cloudId}/wiki/download/attachments/${pageId}/${encodeURIComponent(filename)}`;

		// Check whether the attachment already exists; if so, use the update endpoint
		const existingId = await this._getExistingAttachmentId(cloudId, pageId, filename, auth);
		const apiPath = existingId
			? `/wiki/rest/api/content/${pageId}/child/attachment/${existingId}/data`
			: `/wiki/rest/api/content/${pageId}/child/attachment`;

		try {
			const result = await this._httpsRequest({
				hostname: cloudId,
				path: apiPath,
				method: 'POST',
				headers: {
					'Authorization': `Basic ${auth}`,
					'X-Atlassian-Token': 'no-check',
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
					'Content-Length': bodyBuffer.length,
				},
			}, bodyBuffer);

			if (result.statusCode >= 200 && result.statusCode < 300) {
				return { url: successUrl };
			} else {
				return { url: null, status: result.statusCode, body: result.body.slice(0, 300) };
			}
		} catch (e: unknown) {
			return { url: null, body: String(e) };
		}
	}

	private parseConfluenceUrl(url: string): { cloudId: string; pageId: string } {
		let parsed: URL;
		try { parsed = new URL(url); } catch {
			throw new Error(`Invalid Confluence URL: ${url}`);
		}
		const cloudId = parsed.hostname;
		const pathMatch = parsed.pathname.match(/\/pages\/(\d+)/);
		if (pathMatch) { return { cloudId, pageId: pathMatch[1] }; }
		const queryId = parsed.searchParams.get('pageId');
		if (queryId) { return { cloudId, pageId: queryId }; }
		throw new Error(
			`Cannot extract page ID from URL: ${url}\nExpected format: .../pages/123456 or ...?pageId=123456`
		);
	}

	// ── Jira Integration ─────────────────────────────────────────────────────

	/**
	 * Creates Jira issues for all Critical and High severity threats found in
	 * the feature's threat analysis files. Tries MCP first, falls back to REST.
	 * Results are appended to {featureFolder}/jira-tickets.json.
	 */
	public async createJiraIssues(
		feature: Feature,
		jiraProjectKey: string,
		jiraIssueType: string = 'Task'
	): Promise<{ created: number; skipped: number; tickets: Array<{ key: string; url: string; threatName: string }>; failures: Array<{ threatName: string; error: string }> }> {
		// 1. Read threat analysis files
		const repoPath   = feature.folderPath ? path.join(feature.folderPath, 'repo',   'threat-analysis.md') : null;
		const designPath = feature.folderPath ? path.join(feature.folderPath, 'design', 'threat-analysis.md') : null;
		const repoMd   = repoPath   && fs.existsSync(repoPath)   ? fs.readFileSync(repoPath,   'utf-8') : '';
		const designMd = designPath && fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf-8') : '';
		const markedSections: string[] = [];
		if (repoMd) { markedSections.push(`## Repository Code Analysis\n\n${repoMd}`); }
		if (designMd) { markedSections.push(`## Design Documentation Analysis\n\n${designMd}`); }
		const combinedMd = markedSections.join('\n\n');

		if (!combinedMd) {
			throw new Error('No threat analysis files found. Run "Analyze Threats" first.');
		}

		// 2. Parse and filter Critical/High threats
		const reportGenerator = new ReportGenerator();
		const allThreats = reportGenerator.parseThreatsFromMarkdown(combinedMd);
		const targetThreats = allThreats.filter(t =>
			['critical', 'high'].includes((t.severity || '').toLowerCase())
		);

		if (targetThreats.length === 0) {
			throw new Error(`No Critical or High threats found. Total threats parsed: ${allThreats.length}.`);
		}

		// 3. Load existing tickets to skip duplicates
		const ticketsPath = feature.folderPath ? path.join(feature.folderPath, 'jira-tickets.json') : null;
		let existingTickets: Array<{ threatName: string; key: string; url: string; createdAt: string }> = [];
		if (ticketsPath && fs.existsSync(ticketsPath)) {
			try { existingTickets = JSON.parse(fs.readFileSync(ticketsPath, 'utf-8')); } catch { existingTickets = []; }
		}
		const existingThreatNames = new Set(existingTickets.map(t => t.threatName));

		// 4. Get on-prem Jira base URL from secrets
		const jiraBaseUrl = (await this.context.secrets.get('jira.baseUrl') ?? '').replace(/\/$/, '');
		if (!jiraBaseUrl) {
			throw new Error('Jira base URL not configured. Open sidebar → Configure Credentials → Jira Base URL.');
		}

		// 5. Create Jira issues for new threats only
		const created: Array<{ key: string; url: string; threatName: string }> = [];
		let skipped = 0;
		const failures: Array<{ threatName: string; error: string }> = [];

		this.outputChannel.show(false); // Reveal output so user can see progress
		this.outputChannel.appendLine(`[Jira] Creating tickets in project ${jiraProjectKey} (type: ${jiraIssueType}) on ${jiraBaseUrl}`);
		this.outputChannel.appendLine(`[Jira] Found ${targetThreats.length} Critical/High threat(s) to process...`);

		for (const threat of targetThreats) {
			if (existingThreatNames.has(threat.name)) {
				skipped++;
				this.outputChannel.appendLine(`[Jira] Skipping "${threat.name}" — ticket already exists.`);
				continue;
			}
			try {
				const ticket = await this._createSingleJiraIssue(jiraBaseUrl, jiraProjectKey, jiraIssueType, threat);
				created.push(ticket);
				this.outputChannel.appendLine(`[Jira] ✅ Created ${ticket.key}: ${ticket.threatName}`);
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				failures.push({ threatName: threat.name, error: errMsg });
				this.outputChannel.appendLine(`[Jira] ❌ Failed to create issue for "${threat.name}": ${errMsg}`);
			}
		}

		// 6. Persist created tickets
		if (ticketsPath && created.length > 0) {
			const timestamp = new Date().toISOString();
			const newEntries = created.map(t => ({ ...t, createdAt: timestamp }));
			fs.writeFileSync(ticketsPath, JSON.stringify([...existingTickets, ...newEntries], null, 2));
		}

		// 7. If everything failed, throw so the caller shows a real error
		if (created.length === 0 && skipped === 0 && failures.length > 0) {
			const firstErr = failures[0].error;
			throw new Error(
				`Failed to create Jira tickets (${failures.length} error${failures.length > 1 ? 's' : ''}).\n` +
				`First error: ${firstErr}\n\nCheck the "AI Threat Modeling" output channel for full details.`
			);
		}

		return { created: created.length, skipped, tickets: created, failures };
	}

	private async _createSingleJiraIssue(
		jiraBaseUrl: string,
		projectKey: string,
		issueType: string,
		threat: any
	): Promise<{ key: string; url: string; threatName: string }> {
		const summary = `[Threat Model] ${threat.name}`;
		const priority = (threat.severity || '').toLowerCase() === 'critical' ? 'Highest' : 'High';

		// Try MCP tool first (jira_oss on-prem MCP server)
		// Tool name pattern: mcp_jira_oss_jira_oss-jira_create_issue
		try {
			const result = await vscode.lm.invokeTool('mcp_jira_oss_jira_oss-jira_create_issue', {
				input: {
					project_key: projectKey,
					summary,
					description: this._buildJiraMarkdownDescription(threat),
					issue_type: issueType,
					priority
				},
				toolInvocationToken: undefined
			});

			// Extract issue key from MCP response
			let key = '';
			const contentParts = result?.content ?? [];
			this.outputChannel.appendLine(`[Jira] MCP response parts (${contentParts.length}): ${JSON.stringify(contentParts, null, 2).slice(0, 1000)}`);
			for (const rawPart of contentParts) {
				const part = rawPart as any;
				// LanguageModelTextPart can expose text as .value or .text depending on API version
				const text = (part && typeof part === 'object')
					? String(part.value ?? part.text ?? '')
					: String(part ?? '');
				if (!text) { continue; }
				const m = text.match(/([A-Z][A-Z0-9_]+-\d+)/);
				if (m) { key = m[1]; break; }
				try {
					const json = JSON.parse(text);
					if (json.key) { key = json.key; break; }
					if (json.issueKey) { key = json.issueKey; break; }
					if (json.id && json.self) {
						// Jira REST-style response via MCP — extract key from self URL
						const selfMatch = (json.self as string).match(/\/issue\/(\d+)/);
						if (selfMatch) { key = `${projectKey}-${selfMatch[1]}`; }
						if (json.key) { key = json.key; }
						break;
					}
				} catch { /* not JSON */ }
			}
			if (!key) { key = `${projectKey}-?`; }
			this.outputChannel.appendLine(`[Jira] Extracted key: ${key}`);

			// If MCP succeeded but we couldn't extract a real key, fall back to REST
			// to avoid saving phantom tickets with no real Jira issue
			if (key.endsWith('-?')) {
				this.outputChannel.appendLine(`[Jira] MCP returned no parseable key for "${threat.name}", falling back to REST API...`);
				return await this._createJiraIssueViaRest(jiraBaseUrl, projectKey, issueType, summary, threat, priority);
			}

			return { key, url: `${jiraBaseUrl}/browse/${key}`, threatName: threat.name };
		} catch (mcpError) {
			this.outputChannel.appendLine(`[Jira] MCP unavailable for "${threat.name}", trying REST: ${mcpError}`);
			return await this._createJiraIssueViaRest(jiraBaseUrl, projectKey, issueType, summary, threat, priority);
		}
	}

	private async _createJiraIssueViaRest(
		jiraBaseUrl: string,
		projectKey: string,
		issueType: string,
		summary: string,
		threat: any,
		priority: string
	): Promise<{ key: string; url: string; threatName: string }> {
		const jiraToken = await this.context.secrets.get('jira.token');
		if (!jiraToken) {
			throw new Error(
				'Jira credentials not configured.\n' +
				'Configure via: Threat Modeling sidebar → Configure Credentials → Jira (On-Prem)'
			);
		}

		// 0. Pre-flight: check CREATE_ISSUES permission before wasting API calls
		const permCheck = await this._checkCreatePermission(jiraBaseUrl, projectKey, jiraToken);
		if (permCheck.checked && !permCheck.hasPermission) {
			this.outputChannel.appendLine(`[Jira] ❌ Token lacks CREATE_ISSUES permission on project ${projectKey} (${jiraBaseUrl})`);
			throw new Error(
				`Jira permission denied: your token does not have CREATE_ISSUES permission on project ${projectKey} ` +
				`at ${jiraBaseUrl}.\n\n` +
				`Your token can browse the project but cannot create issues. This is the root cause — ` +
				`Jira misleadingly returns "field not on appropriate screen" when the user lacks create permission.\n\n` +
				`Fix: ask a Jira admin to grant CREATE_ISSUES permission for your account/token on project ${projectKey}, ` +
				`or use a different Jira instance where you have create access (e.g. your production Jira).`
			);
		}

		// 1. Try creating with the requested issue type
		const typesToTry = [issueType];
		let screenError = false;

		const result = await this._tryCreateWithType(jiraBaseUrl, projectKey, issueType, summary, threat, priority, jiraToken);
		if (result.success) {
			return result.ticket!;
		}
		screenError = result.screenError;

		// If it's a screen scheme issue, try alternative issue types
		if (screenError) {
			this.outputChannel.appendLine(`[Jira] ⚠️ "${issueType}" has broken screen scheme — trying alternative issue types...`);

			const altTypes = await this._getAllIssueTypes(jiraBaseUrl, projectKey, jiraToken);
			const skipTypes = new Set([issueType.toLowerCase(), 'sub-task', 'subtask']);
			const candidates = altTypes.filter(t => !skipTypes.has(t.name.toLowerCase()));

			this.outputChannel.appendLine(`[Jira] Alternative candidates: ${candidates.map(t => `${t.name}(id=${t.id})`).join(', ') || 'none'}`);

			for (const alt of candidates) {
				typesToTry.push(alt.name);
				this.outputChannel.appendLine(`[Jira] Trying alternative type: ${alt.name} (id=${alt.id})...`);
				const altResult = await this._tryCreateWithType(jiraBaseUrl, projectKey, alt.name, summary, threat, priority, jiraToken);
				if (altResult.success) {
					this.outputChannel.appendLine(`[Jira] ✅ Succeeded with alternative type "${alt.name}" (originally requested: "${issueType}")`);
					return altResult.ticket!;
				}
				if (!altResult.screenError) {
					break;
				}
			}

			// All types failed — run field probe for detailed diagnostics
			this.outputChannel.appendLine(`[Jira] All issue types failed with screen errors. Running field probe...`);
			const probeResult = await this._probeCreateFields(jiraBaseUrl, projectKey, jiraToken);

			if (probeResult.noPermission) {
				throw new Error(
					`Jira permission denied: your token does not have CREATE_ISSUES permission on project ${projectKey} ` +
					`at ${jiraBaseUrl}.\n\n` +
					`Jira misleadingly returns "field not on appropriate screen" when the user lacks create permission.\n\n` +
					`Fix: ask a Jira admin to grant CREATE_ISSUES permission for your account/token on project ${projectKey}, ` +
					`or use a different Jira instance where you have create access.`
				);
			}
		}

		// All failed — provide diagnostics
		let diagnostics = '';
		try {
			diagnostics = await this._fetchJiraCreateMeta(jiraBaseUrl, projectKey, jiraToken);
			this.outputChannel.appendLine(`[Jira] Diagnostics: ${diagnostics}`);
		} catch { /* ignore */ }
		throw new Error(
			`Jira REST API error: Could not create issue in project ${projectKey}.\n` +
			`Tried issue types: ${typesToTry.join(', ')}.\n` +
			`All failed with "field not on appropriate screen" — this Jira project's screen scheme ` +
			`does not allow setting standard fields via API.\n` +
			`Ask a Jira admin to check the Create Screen for project ${projectKey}.` +
			(diagnostics ? '\n\n' + diagnostics : '')
		);
	}

	/**
	 * Attempt to create a Jira issue with a specific issue type.
	 * Returns success/failure and whether the error is screen-related.
	 */
	private async _tryCreateWithType(
		jiraBaseUrl: string,
		projectKey: string,
		issueType: string,
		summary: string,
		threat: any,
		priority: string,
		token: string
	): Promise<{ success: boolean; ticket?: { key: string; url: string; threatName: string }; screenError: boolean }> {
		const { issueTypeId, allowedFields } = await this._discoverCreateFields(jiraBaseUrl, projectKey, issueType, token);
		const issueTypeField = issueTypeId ? { id: issueTypeId } : { name: issueType };
		const issueTypeFieldByName = { name: issueType };

		const payloads: Array<{ label: string; fields: Record<string, any>; apiPath: string }> = [];

		// Variant A: screen-aware with ID
		const screenAwareFields: Record<string, any> = {
			project: { key: projectKey },
			issuetype: issueTypeField,
		};
		if (allowedFields.size === 0 || allowedFields.has('summary'))     { screenAwareFields.summary     = summary; }
		if (allowedFields.size === 0 || allowedFields.has('description')) { screenAwareFields.description  = this._buildJiraMarkdownDescription(threat); }
		if (allowedFields.size === 0 || allowedFields.has('priority'))    { screenAwareFields.priority     = { name: priority }; }
		if (allowedFields.size === 0 || allowedFields.has('labels'))      { screenAwareFields.labels       = ['threat-model', 'security']; }
		payloads.push({ label: `${issueType}/screen-aware`, fields: screenAwareFields, apiPath: '/rest/api/2/issue' });

		// Variant B: minimal — project + issuetype(id) + summary only
		payloads.push({
			label: `${issueType}/minimal(id)`,
			apiPath: '/rest/api/2/issue',
			fields: { project: { key: projectKey }, issuetype: issueTypeField, summary }
		});

		// Variant C: minimal — project + issuetype(name) + summary only
		payloads.push({
			label: `${issueType}/minimal(name)`,
			apiPath: '/rest/api/2/issue',
			fields: { project: { key: projectKey }, issuetype: issueTypeFieldByName, summary }
		});

		let screenError = false;
		for (const { label, fields, apiPath } of payloads) {
			const body = JSON.stringify({ fields });
			this.outputChannel.appendLine(`[Jira] Trying "${label}": fields=[${Object.keys(fields).join(',')}] issuetype=${JSON.stringify(fields.issuetype)}`);
			try {
				const result = await this._jiraRestRequest(jiraBaseUrl, 'POST', apiPath, token, body);
				if (result.statusCode >= 200 && result.statusCode < 300) {
					const parsed = JSON.parse(result.body);
					const key = parsed.key as string;
					this.outputChannel.appendLine(`[Jira] ✅ REST success (${label}): ${key}`);
					return { success: true, ticket: { key, url: `${jiraBaseUrl}/browse/${key}`, threatName: threat.name }, screenError: false };
				}
				const isScreen = result.body.includes('not on the appropriate screen');
				if (isScreen) { screenError = true; }
				this.outputChannel.appendLine(`[Jira] "${label}" failed (${isScreen ? 'screen' : 'other'}): ${result.body.slice(0, 200)}`);
			} catch (e) {
				this.outputChannel.appendLine(`[Jira] "${label}" error: ${e instanceof Error ? e.message : e}`);
			}
		}

		return { success: false, screenError };
	}

	/**
	 * Get all issue types for a project (for trying alternatives).
	 */
	private async _getAllIssueTypes(
		jiraBaseUrl: string,
		projectKey: string,
		token: string
	): Promise<Array<{ id: string; name: string }>> {
		try {
			const result = await this._jiraRestRequest(jiraBaseUrl, 'GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}`, token);
			if (result.statusCode === 200) {
				const data = JSON.parse(result.body);
				return (data.issueTypes || []).map((t: any) => ({ id: String(t.id), name: String(t.name) }));
			}
		} catch { /* ignore */ }
		return [];
	}

	/**
	 * Diagnostic probe: POST with only project+issuetype (no summary) to discover
	 * what error message Jira returns — helps identify if it's permissions, screen config, etc.
	 */
	private async _probeCreateFields(
		jiraBaseUrl: string,
		projectKey: string,
		token: string
	): Promise<{ noPermission: boolean }> {
		this.outputChannel.appendLine(`[Jira] === DIAGNOSTIC PROBE ===`);
		let noPermission = false;

		// Probe 1: POST with only project+issuetype (empty fields probe)
		try {
			const body = JSON.stringify({ fields: { project: { key: projectKey }, issuetype: { name: 'Task' } } });
			const r = await this._jiraRestRequest(jiraBaseUrl, 'POST', '/rest/api/2/issue', token, body);
			this.outputChannel.appendLine(`[Jira] Probe (no summary): HTTP ${r.statusCode} → ${r.body.slice(0, 500)}`);
			if (r.statusCode === 403 || r.body.includes('do not have permission')) {
				noPermission = true;
			}
		} catch (e) { this.outputChannel.appendLine(`[Jira] Probe error: ${e}`); }

		// Probe 2: Check permissions
		const permResult = await this._checkCreatePermission(jiraBaseUrl, projectKey, token);
		if (permResult.checked && !permResult.hasPermission) {
			noPermission = true;
		}

		// Probe 3: Try GET on the project's screens
		try {
			const r = await this._jiraRestRequest(jiraBaseUrl, 'GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`, token);
			this.outputChannel.appendLine(`[Jira] Project statuses: HTTP ${r.statusCode} → ${r.body.slice(0, 300)}`);
		} catch (e) { this.outputChannel.appendLine(`[Jira] Statuses probe error: ${e}`); }

		this.outputChannel.appendLine(`[Jira] === END DIAGNOSTIC PROBE ===`);
		return { noPermission };
	}

	/**
	 * Check if the token has CREATE_ISSUES permission on the project.
	 * Returns { checked: true, hasPermission: bool } or { checked: false } if the endpoint is unavailable.
	 */
	private async _checkCreatePermission(
		jiraBaseUrl: string,
		projectKey: string,
		token: string
	): Promise<{ checked: boolean; hasPermission: boolean }> {
		try {
			const r = await this._jiraRestRequest(
				jiraBaseUrl, 'GET',
				`/rest/api/2/mypermissions?projectKey=${encodeURIComponent(projectKey)}&permissions=CREATE_ISSUES,BROWSE_PROJECTS`,
				token
			);
			if (r.statusCode === 200) {
				const perms = JSON.parse(r.body).permissions || {};
				const create = perms.CREATE_ISSUES || perms.CREATE_ISSUE;
				const browse = perms.BROWSE_PROJECTS || perms.BROWSE;
				const hasCreate = create?.havePermission === true;
				const hasBrowse = browse?.havePermission === true;
				this.outputChannel.appendLine(`[Jira] Permissions — CREATE_ISSUES: ${hasCreate}, BROWSE_PROJECTS: ${hasBrowse}`);
				return { checked: true, hasPermission: hasCreate };
			}
			this.outputChannel.appendLine(`[Jira] Permissions check: HTTP ${r.statusCode}`);
		} catch (e) {
			this.outputChannel.appendLine(`[Jira] Permissions check error: ${e}`);
		}
		return { checked: false, hasPermission: false };
	}

	/**
	 * Discover the issue type ID and allowed fields for the Create screen.
	 * Tries Jira 9+ createmeta/issuetypes/{id} endpoint, then falls back to
	 * the classic createmeta?expand=projects.issuetypes.fields endpoint.
	 */
	private async _discoverCreateFields(
		jiraBaseUrl: string,
		projectKey: string,
		issueTypeName: string,
		token: string
	): Promise<{ issueTypeId: string; allowedFields: Set<string> }> {
		const allowedFields = new Set<string>();
		let issueTypeId = '';

		// Strategy 1: Jira 9+ — get issue type list, then fields for that type
		try {
			const typesResult = await this._jiraRestRequest(
				jiraBaseUrl, 'GET',
				`/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
				token
			);
			this.outputChannel.appendLine(`[Jira] createmeta/issuetypes → HTTP ${typesResult.statusCode}`);
			if (typesResult.statusCode === 200) {
				const data = JSON.parse(typesResult.body);
				const types = data.values || data;
				const match = (Array.isArray(types) ? types : []).find(
					(t: any) => t.name?.toLowerCase() === issueTypeName.toLowerCase()
				);
				if (match?.id) {
					issueTypeId = String(match.id);
					// Now get allowed fields for this issue type
					const fieldsResult = await this._jiraRestRequest(
						jiraBaseUrl, 'GET',
						`/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${issueTypeId}`,
						token
					);
					this.outputChannel.appendLine(`[Jira] createmeta/issuetypes/${issueTypeId} fields → HTTP ${fieldsResult.statusCode}`);
					if (fieldsResult.statusCode === 200) {
						const fieldsData = JSON.parse(fieldsResult.body);
						const fieldValues = fieldsData.values || fieldsData.fields || fieldsData;
						if (Array.isArray(fieldValues)) {
							fieldValues.forEach((f: any) => { if (f.fieldId || f.key) { allowedFields.add(f.fieldId || f.key); } });
						} else if (typeof fieldValues === 'object') {
							Object.keys(fieldValues).forEach(k => allowedFields.add(k));
						}
					}
				}
			}
		} catch (e) { this.outputChannel.appendLine(`[Jira] Strategy 1 error: ${e}`); }

		if (issueTypeId && allowedFields.size > 0) {
			this.outputChannel.appendLine(`[Jira] Discovered issue type "${issueTypeName}" id=${issueTypeId}, ${allowedFields.size} allowed fields via strategy 1`);
			return { issueTypeId, allowedFields };
		}

		// Strategy 2: Classic createmeta with expand
		try {
			const result = await this._jiraRestRequest(
				jiraBaseUrl, 'GET',
				`/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&issuetypeNames=${encodeURIComponent(issueTypeName)}&expand=projects.issuetypes.fields`,
				token
			);
			this.outputChannel.appendLine(`[Jira] classic createmeta → HTTP ${result.statusCode}`);
			if (result.statusCode === 200) {
				const data = JSON.parse(result.body);
				const project = data.projects?.[0];
				const type = project?.issuetypes?.[0];
				if (type) {
					if (type.id) { issueTypeId = String(type.id); }
					if (type.fields && typeof type.fields === 'object') {
						Object.keys(type.fields).forEach(k => allowedFields.add(k));
					}
					this.outputChannel.appendLine(`[Jira] Classic createmeta found type id=${type.id}, fields: ${Object.keys(type.fields || {}).join(', ')}`);
				}
			}
		} catch (e) { this.outputChannel.appendLine(`[Jira] Strategy 2 error: ${e}`); }

		if (issueTypeId) {
			this.outputChannel.appendLine(`[Jira] Discovered issue type "${issueTypeName}" id=${issueTypeId}, ${allowedFields.size} allowed fields via strategy 2`);
			return { issueTypeId, allowedFields };
		}

		// Strategy 3: Get issue type ID from project endpoint (works when createmeta is unavailable)
		try {
			const result = await this._jiraRestRequest(
				jiraBaseUrl, 'GET',
				`/rest/api/2/project/${encodeURIComponent(projectKey)}`,
				token
			);
			this.outputChannel.appendLine(`[Jira] project endpoint → HTTP ${result.statusCode}`);
			if (result.statusCode === 200) {
				const data = JSON.parse(result.body);
				const types = data.issueTypes || [];
				const match = types.find(
					(t: any) => t.name?.toLowerCase() === issueTypeName.toLowerCase()
				);
				if (match?.id) {
					issueTypeId = String(match.id);
					this.outputChannel.appendLine(`[Jira] Found issue type "${issueTypeName}" id=${issueTypeId} via project endpoint (no field info available)`);
				}
			}
		} catch (e) { this.outputChannel.appendLine(`[Jira] Strategy 3 error: ${e}`); }

		// Strategy 4: Global issue types endpoint
		if (!issueTypeId) {
			try {
				const result = await this._jiraRestRequest(
					jiraBaseUrl, 'GET',
					'/rest/api/2/issuetype',
					token
				);
				this.outputChannel.appendLine(`[Jira] global issuetype endpoint → HTTP ${result.statusCode}`);
				if (result.statusCode === 200) {
					const types = JSON.parse(result.body);
					const match = (Array.isArray(types) ? types : []).find(
						(t: any) => t.name?.toLowerCase() === issueTypeName.toLowerCase()
					);
					if (match?.id) {
						issueTypeId = String(match.id);
						this.outputChannel.appendLine(`[Jira] Found issue type "${issueTypeName}" id=${issueTypeId} via global issuetype endpoint`);
					}
				}
			} catch (e) { this.outputChannel.appendLine(`[Jira] Strategy 4 error: ${e}`); }
		}

		if (issueTypeId) {
			this.outputChannel.appendLine(`[Jira] Resolved issue type "${issueTypeName}" → id=${issueTypeId}, ${allowedFields.size} allowed fields`);
		} else {
			this.outputChannel.appendLine(`[Jira] Could not discover issue type ID for "${issueTypeName}", using name-based lookup`);
		}
		return { issueTypeId, allowedFields };
	}

	/** Low-level HTTPS request to Jira REST API. */
	private _jiraRestRequest(
		jiraBaseUrl: string,
		method: string,
		apiPath: string,
		token: string,
		body?: string
	): Promise<{ statusCode: number; body: string }> {
		const https = require('https') as typeof import('https');
		const parsedUrl = new URL(jiraBaseUrl);
		const headers: Record<string, string | number> = {
			'Authorization': `Bearer ${token}`,
			'Content-Type':  'application/json',
			'Accept':        'application/json'
		};
		if (body) { headers['Content-Length'] = Buffer.byteLength(body); }

		return new Promise((resolve, reject) => {
			const req = https.request({
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || undefined,
				path: `${parsedUrl.pathname.replace(/\/$/, '')}${apiPath}`,
				method,
				headers
			}, (res: import('http').IncomingMessage) => {
				let data = '';
				res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
				res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
			});
			req.on('error', reject);
			if (body) { req.write(body); }
			req.end();
		});
	}

	/** Query Jira createmeta to discover valid issue types and fields for a project. */
	private async _fetchJiraCreateMeta(
		jiraBaseUrl: string,
		projectKey: string,
		token: string
	): Promise<string> {
		// Try multiple API versions — Jira 9+ deprecated the old createmeta endpoint
		const endpoints = [
			`/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,  // Jira 9+
			`/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`,  // Jira 7/8
			`/rest/api/2/project/${encodeURIComponent(projectKey)}`,  // Fallback: project info
		];

		for (const ep of endpoints) {
			try {
				const result = await this._jiraRestRequest(jiraBaseUrl, 'GET', ep, token);
				if (result.statusCode !== 200) { continue; }
				const data = JSON.parse(result.body);

				// Jira 9+ format: { values: [{ id, name, ... }] }
				if (data.values && Array.isArray(data.values)) {
					const issueTypes = data.values.map((it: any) => it.name).filter(Boolean);
					if (issueTypes.length > 0) {
						return `Available issue types for ${projectKey}: ${issueTypes.join(', ')}.\nPlease use one of these exact names when prompted for issue type.`;
					}
				}
				// Jira 7/8 format: { projects: [{ issuetypes: [{ name }] }] }
				if (data.projects?.[0]?.issuetypes) {
					const issueTypes = data.projects[0].issuetypes.map((it: any) => it.name);
					if (issueTypes.length > 0) {
						return `Available issue types for ${projectKey}: ${issueTypes.join(', ')}.\nPlease use one of these exact names when prompted for issue type.`;
					}
				}
				// Project endpoint: { issueTypes: [{ name }] }
				if (data.issueTypes && Array.isArray(data.issueTypes)) {
					const issueTypes = data.issueTypes.map((it: any) => it.name).filter(Boolean);
					if (issueTypes.length > 0) {
						return `Available issue types for ${projectKey}: ${issueTypes.join(', ')}.\nPlease use one of these exact names when prompted for issue type.`;
					}
				}
			} catch { /* try next */ }
		}
		return `Could not fetch valid issue types for project "${projectKey}". Check that the project key and Jira token are correct.`;
	}

	/** Plain markdown description for MCP tool (accepts markdown). */
	private _buildJiraMarkdownDescription(threat: any): string {
		const mitItems: string[] = [
			...(threat.mitigation?.immediate ?? []),
			...(threat.mitigation?.shortTerm ?? []),
			...(threat.mitigation?.longTerm  ?? [])
		];
		return [
			`**STRIDE Category:** ${threat.strideCategory || 'N/A'}`,
			`**Severity:** ${threat.severity || 'N/A'}`,
			`**Component:** ${threat.component || 'N/A'}`,
			'',
			'**Description**',
			threat.description || '',
			'',
			'**Impact**',
			threat.impact || '',
			...(mitItems.length > 0 ? ['', '**Mitigations**', ...mitItems.map(m => `- ${m}`)] : [])
		].join('\n');
	}

}
