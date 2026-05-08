import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Feature } from './productManager';

export interface ReportResult {
	htmlPath: string;
	csvPath: string;
}

export class ReportGenerator {
	public async generateCombinedReport(feature: Feature, productName?: string): Promise<ReportResult> {
		if (!feature.folderPath || !fs.existsSync(feature.folderPath)) {
			throw new Error('Feature folder does not exist');
		}

		const repoFolder = path.join(feature.folderPath, 'repo');
		const designFolder = path.join(feature.folderPath, 'design');
		const repoAnalysisPath = path.join(repoFolder, 'threat-analysis.md');
		const designAnalysisPath = path.join(designFolder, 'threat-analysis.md');
		
		// Check if analysis files exist
		const repoAnalysisExists = fs.existsSync(repoAnalysisPath);
		const designAnalysisExists = fs.existsSync(designAnalysisPath);
		
		// Read both analysis files
		let combinedContent = '';
		
		if (fs.existsSync(repoAnalysisPath)) {
			const repoContent = fs.readFileSync(repoAnalysisPath, 'utf-8');
			combinedContent += `# Repository Code Analysis\n\n${repoContent}\n\n`;
		}
		
		if (fs.existsSync(designAnalysisPath)) {
			const designContent = fs.readFileSync(designAnalysisPath, 'utf-8');
			combinedContent += `# Design Documentation Analysis\n\n${designContent}`;
		}
		
		if (!combinedContent) {
			throw new Error('No threat analysis found. Please run "Analyze Threats" first.');
		}

		const outputFolder = feature.folderPath;
		const htmlPath = await this.generateHTMLReport(
			feature, 
			combinedContent, 
			'Combined', 
			outputFolder, 
			productName,
			repoAnalysisExists ? repoAnalysisPath : undefined,
			designAnalysisExists ? designAnalysisPath : undefined
		);

		// Generate CSV report
		const csvPath = await this.generateCSVReport(feature, combinedContent, outputFolder, productName);

		return { htmlPath, csvPath };
	}

	public async generateRepositoryReport(feature: Feature): Promise<ReportResult> {
		if (!feature.folderPath || !fs.existsSync(feature.folderPath)) {
			throw new Error('Feature folder does not exist');
		}

		const repoFolder = path.join(feature.folderPath, 'repo');
		const analysisMarkdownPath = path.join(repoFolder, 'threat-analysis.md');
		
		if (!fs.existsSync(analysisMarkdownPath)) {
			throw new Error('Repository threat analysis not found. Please run "Analyze Repo" first.');
		}

		const analysisContent = fs.readFileSync(analysisMarkdownPath, 'utf-8');
		
		const htmlPath = await this.generateHTMLReport(feature, analysisContent, 'Repository', repoFolder);
		const csvPath = await this.generateCSVReport(feature, analysisContent, repoFolder);

		return { htmlPath, csvPath };
	}

	public async generateDesignReport(feature: Feature): Promise<ReportResult> {
		if (!feature.folderPath || !fs.existsSync(feature.folderPath)) {
			throw new Error('Feature folder does not exist');
		}

		const designFolder = path.join(feature.folderPath, 'design');
		const analysisMarkdownPath = path.join(designFolder, 'threat-analysis.md');
		
		if (!fs.existsSync(analysisMarkdownPath)) {
			throw new Error('Design threat analysis not found. Please run "Analyze Doc" first.');
		}

		const analysisContent = fs.readFileSync(analysisMarkdownPath, 'utf-8');
		
		const htmlPath = await this.generateHTMLReport(feature, analysisContent, 'Design', designFolder);
		const csvPath = await this.generateCSVReport(feature, analysisContent, designFolder);

		return { htmlPath, csvPath };
	}

	private async generateHTMLReport(feature: Feature, analysisContent: string, reportType: string, outputFolder: string, productName?: string, repoAnalysisPath?: string, designAnalysisPath?: string): Promise<string> {
		const htmlPath = path.join(outputFolder, `threat-report-${reportType.toLowerCase()}-${Date.now()}.html`);
		
		// Parse threats from markdown
		const threats = this.parseThreatsFromMarkdown(analysisContent);
		
		// Calculate stats
		const stats = {
			critical: threats.filter(t => t.severity.toLowerCase() === 'critical').length,
			high: threats.filter(t => t.severity.toLowerCase() === 'high').length,
			medium: threats.filter(t => t.severity.toLowerCase() === 'medium').length,
			low: threats.filter(t => t.severity.toLowerCase() === 'low').length,
			total: threats.length
		};
		
		const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${reportType} Threat Modeling Report - ${feature.name}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1800px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 36px;
            margin-bottom: 10px;
            font-weight: 800;
        }
        
        .header p {
            font-size: 18px;
            opacity: 0.9;
        }
        
        .stats-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
        }
        
        .stat-card {
            background: white;
            padding: 24px;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            text-align: center;
            transition: transform 0.3s;
        }
        
        .stat-card:hover {
            transform: translateY(-5px);
        }
        
        .stat-card .number {
            font-size: 48px;
            font-weight: 800;
            margin-bottom: 8px;
        }
        
        .stat-card.critical .number { color: #dc2626; }
        .stat-card.high .number { color: #ea580c; }
        .stat-card.medium .number { color: #f59e0b; }
        .stat-card.low .number { color: #10b981; }
        .stat-card.total .number { color: #667eea; }
        
        .stat-card .label {
            font-size: 14px;
            color: #6b7280;
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 1px;
        }
        
        .info-section {
            padding: 30px;
            background: white;
            border-bottom: 1px solid #e5e7eb;
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 16px;
        }
        
        .info-item {
            display: flex;
            gap: 12px;
            align-items: flex-start;
        }
        
        .info-label {
            font-weight: 700;
            color: #667eea;
            min-width: 120px;
            flex-shrink: 0;
        }
        
        .info-value {
            color: #374151;
            word-wrap: break-word;
            overflow-wrap: break-word;
            flex: 1;
            min-width: 0;
        }
        
        .controls {
            padding: 30px;
            background: white;
            border-bottom: 1px solid #e5e7eb;
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            align-items: center;
        }
        
        .search-box {
            flex: 1;
            min-width: 300px;
            position: relative;
        }
        
        .search-box input {
            width: 100%;
            padding: 12px 40px 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 14px;
            transition: all 0.3s;
        }
        
        .search-box input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .search-box::after {
            content: '🔍';
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 18px;
        }
        
        .filter-group {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        
        .filter-btn {
            padding: 10px 20px;
            border: 2px solid #e5e7eb;
            background: white;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            transition: all 0.3s;
        }
        
        .filter-btn:hover {
            border-color: #667eea;
            color: #667eea;
        }
        
        .filter-btn.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }
        
        .table-container {
            padding: 30px;
            overflow-x: auto;
        }
        
        .threat-table {
            width: 100%;
            min-width: 1400px;
            border-collapse: collapse;
            background: white;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: hidden;
            table-layout: auto;
        }
        
        .threat-table thead {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        
        .threat-table th {
            padding: 16px;
            text-align: left;
            font-weight: 700;
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }
        
        /* Let browser auto-distribute; only constrain compact columns */
        .threat-table th:nth-child(1),
        .threat-table td:nth-child(1) { white-space: nowrap; }   /* STRIDE badge */
        .threat-table th:nth-child(6),
        .threat-table td:nth-child(6) { white-space: nowrap; }   /* Severity badge */
        
        .threat-table th:hover {
            background: rgba(255, 255, 255, 0.1);
        }
        
        .threat-table th::after {
            content: ' ⇅';
            opacity: 0.5;
        }
        
        .threat-table td {
            padding: 12px 14px;
            border-bottom: 1px solid #e5e7eb;
            vertical-align: top;
            overflow-wrap: break-word;
            word-break: normal;
            white-space: normal;
        }
        
        .threat-table tbody tr {
            transition: background 0.2s;
        }
        
        .threat-table tbody tr:hover {
            background: #f9fafb;
        }
        
        .severity-badge {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .stride-badge {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 600;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .severity-critical {
            background: #dc2626;
            color: white;
        }
        
        .severity-high {
            background: #ea580c;
            color: white;
        }
        
        .severity-medium {
            background: #eab308;
            color: white;
        }
        
        .severity-low {
            background: #22c55e;
            color: white;
        }
        
        .mitigation-list {
            margin: 8px 0;
            overflow: hidden;
        }
        
        .mitigation-section {
            margin-bottom: 12px;
        }
        
        .mitigation-title {
            font-weight: 700;
            color: #667eea;
            margin-bottom: 4px;
            font-size: 13px;
        }
        
        .mitigation-list ul {
            margin-left: 16px;
            padding-left: 0;
            color: #374151;
            list-style-position: outside;
        }
        
        .mitigation-list li {
            margin-bottom: 4px;
            font-size: 13px;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }
        
        .status-select {
            padding: 8px 12px;
            border: 2px solid #e5e7eb;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            background: white;
            transition: all 0.3s;
            width: 100%;
            max-width: 100%;
            box-sizing: border-box;
        }
        
        .status-select:hover {
            border-color: #667eea;
        }
        
        .status-select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .status-open { color: #dc2626; font-weight: 700; }
        .status-triaged { color: #ea580c; font-weight: 700; }
        .status-mitigated { color: #f59e0b; font-weight: 700; }
        .status-remediated { color: #10b981; font-weight: 700; }
        .status-fp { color: #6b7280; font-weight: 700; }
        .status-wontfix { color: #9ca3af; font-weight: 700; }
        
        .comment-box {
            width: 100%;
            max-width: 100%;
            padding: 8px;
            border: 2px solid #e5e7eb;
            border-radius: 6px;
            font-size: 13px;
            font-family: inherit;
            resize: vertical;
            transition: all 0.3s;
            box-sizing: border-box;
        }
        
        .comment-box:hover {
            border-color: #667eea;
        }
        
        .comment-box:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .footer {
            text-align: center;
            padding: 30px;
            background: #f8f9fa;
            color: #6b7280;
            font-size: 13px;
        }
        
        .no-results {
            text-align: center;
            padding: 60px 20px;
            color: #6b7280;
            font-size: 18px;
        }
        
        @media print {
            body { background: white; padding: 0; }
            .controls { display: none; }
            .threat-table { box-shadow: none; min-width: 0; }
            .threat-table td {
                overflow-wrap: break-word;
                word-break: normal;
            }
            @page { margin: 1cm; }
        }
        
        @media (max-width: 768px) {
            .stats-container { grid-template-columns: repeat(2, 1fr); }
            .table-container { padding: 15px; overflow-x: auto; }
            .threat-table { font-size: 12px; }
            .threat-table th, .threat-table td { padding: 10px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛡️Threat Modeling Report</h1>
            <p>${productName ? `${productName} Security Analysis` : 'Security Analysis'}</p>
        </div>
        
        <div class="stats-container">
            <div class="stat-card critical">
                <div class="number" id="criticalCount">${stats.critical}</div>
                <div class="label">Critical</div>
            </div>
            <div class="stat-card high">
                <div class="number" id="highCount">${stats.high}</div>
                <div class="label">High</div>
            </div>
            <div class="stat-card medium">
                <div class="number" id="mediumCount">${stats.medium}</div>
                <div class="label">Medium</div>
            </div>
            <div class="stat-card low">
                <div class="number" id="lowCount">${stats.low}</div>
                <div class="label">Low</div>
            </div>
            <div class="stat-card total">
                <div class="number" id="totalCount">${stats.total}</div>
                <div class="label">Total Threats</div>
            </div>
        </div>
        
        <div class="info-section">
            <div class="info-grid">
                ${productName ? `<div class="info-item">
                    <span class="info-label">Product:</span>
                    <span class="info-value">${productName}</span>
                </div>` : ''}
                <div class="info-item">
                    <span class="info-label">Feature:</span>
                    <span class="info-value">${feature.name}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Version:</span>
                    <span class="info-value">${feature.version}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Analysis Date:</span>
                    <span class="info-value">${new Date().toLocaleString()}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Confluence Pages:</span>
                    <span class="info-value">
                        ${(feature.confluenceUrls && feature.confluenceUrls.length > 0)
                            ? feature.confluenceUrls.map((url, i) =>
                                `<a href="${encodeURI(url)}" target="_blank" style="color: var(--vscode-textLink-foreground); text-decoration: underline; display: block;">${i + 1}. ${this.escapeHtml(url)}</a>`
                              ).join('')
                            : 'N/A'}
                    </span>
                </div>
                ${(feature.repositoryUrls && feature.repositoryUrls.length > 0) ? `<div class="info-item">
                    <span class="info-label">Repositories:</span>
                    <span class="info-value">
                        ${feature.repositoryUrls.map((url, i) =>
                            `<a href="${encodeURI(url)}" target="_blank" style="color: var(--vscode-textLink-foreground); text-decoration: underline; display: block;">${i + 1}. ${this.escapeHtml(url)}</a>`
                          ).join('')}
                    </span>
                </div>` : ''}
                ${repoAnalysisPath ? `<div class="info-item">
                    <span class="info-label">Repository Analysis:</span>
                    <span class="info-value"><a href="file:///${repoAnalysisPath.replace(/\\/g, '/')}" target="_blank" style="color: var(--vscode-textLink-foreground); text-decoration: underline;">📄 threat-analysis.md</a></span>
                </div>` : ''}
                ${designAnalysisPath ? `<div class="info-item">
                    <span class="info-label">Design Analysis:</span>
                    <span class="info-value"><a href="file:///${designAnalysisPath.replace(/\\/g, '/')}" target="_blank" style="color: var(--vscode-textLink-foreground); text-decoration: underline;">📄 threat-analysis.md</a></span>
                </div>` : ''}
            </div>
        </div>
        
        <div class="controls">
            <div class="search-box">
                <input type="text" id="searchInput" placeholder="Search threats by name, description, or component...">
            </div>
            <div class="filter-group">
                <button class="filter-btn active" data-filter="all">All</button>
                <button class="filter-btn" data-filter="critical">Critical</button>
                <button class="filter-btn" data-filter="high">High</button>
                <button class="filter-btn" data-filter="medium">Medium</button>
                <button class="filter-btn" data-filter="low">Low</button>
            </div>
        </div>
        
        <div class="table-container">
            <table class="threat-table">
                <thead>
                    <tr>
                        <th onclick="sortTable(0)">STRIDE Category</th>
                        <th onclick="sortTable(1)">Threat Name</th>
                        <th onclick="sortTable(2)">Description & Exploitation</th>
                        <th onclick="sortTable(3)">Impact</th>
                        <th onclick="sortTable(4)">Affected Component</th>
                        <th onclick="sortTable(5)">Severity</th>
                        <th onclick="sortTable(6)">Mitigation Strategies</th>
                        <th onclick="sortTable(7)">Status</th>
                        <th>Comments</th>
                    </tr>
                </thead>
                <tbody id="threatTableBody">
                    ${this.generateThreatRows(threats)}
                </tbody>
            </table>
            <div id="noResults" class="no-results" style="display: none;">
                No threats found matching your search criteria.
            </div>
        </div>
        
        <div class="footer">
            <p><strong>Generated by ThreatWeaver</strong></p>
            <p>${new Date().toLocaleString()}</p>
        </div>
    </div>
    
    <script>
        const threats = ${JSON.stringify(threats)};
        let currentFilter = 'all';
        let currentSearchTerm = '';
        
        // Initialize stats
        function updateStats() {
            const stats = {
                critical: threats.filter(t => t.severity.toLowerCase() === 'critical').length,
                high: threats.filter(t => t.severity.toLowerCase() === 'high').length,
                medium: threats.filter(t => t.severity.toLowerCase() === 'medium').length,
                low: threats.filter(t => t.severity.toLowerCase() === 'low').length,
                total: threats.length
            };
            
            document.getElementById('criticalCount').textContent = stats.critical;
            document.getElementById('highCount').textContent = stats.high;
            document.getElementById('mediumCount').textContent = stats.medium;
            document.getElementById('lowCount').textContent = stats.low;
            document.getElementById('totalCount').textContent = stats.total;
        }
        
        function filterThreats() {
            const rows = document.querySelectorAll('#threatTableBody tr');
            let visibleCount = 0;
            
            rows.forEach((row) => {
                // Skip section header rows
                if (row.classList.contains('section-header')) {
                    row.style.display = '';
                    return;
                }
                
                const threatId = row.getAttribute('data-threat-id');
                if (!threatId) return;
                
                const threat = threats[parseInt(threatId)];
                if (!threat) return;
                
                const matchesFilter = currentFilter === 'all' || threat.severity.toLowerCase() === currentFilter;
                const matchesSearch = currentSearchTerm === '' || 
                    threat.name.toLowerCase().includes(currentSearchTerm) ||
                    threat.description.toLowerCase().includes(currentSearchTerm) ||
                    threat.component.toLowerCase().includes(currentSearchTerm);
                
                if (matchesFilter && matchesSearch) {
                    row.style.display = '';
                    visibleCount++;
                } else {
                    row.style.display = 'none';
                }
            });
            
            document.getElementById('noResults').style.display = visibleCount === 0 ? 'block' : 'none';
            document.querySelector('.threat-table').style.display = visibleCount === 0 ? 'none' : 'table';
        }
        
        // Sort table
        let sortDirection = {};
        function sortTable(columnIndex) {
            const table = document.querySelector('.threat-table tbody');
            const rows = Array.from(table.querySelectorAll('tr'));
            
            sortDirection[columnIndex] = !sortDirection[columnIndex];
            const direction = sortDirection[columnIndex] ? 1 : -1;
            
            rows.sort((a, b) => {
                const aText = a.cells[columnIndex].textContent.trim();
                const bText = b.cells[columnIndex].textContent.trim();
                return aText.localeCompare(bText) * direction;
            });
            
            rows.forEach(row => table.appendChild(row));
        }
        
        // Update status
        function updateStatus(selectElement, threatId) {
            const value = selectElement.value.toLowerCase().replace(/['\s]/g, '');
            
            // Remove all status classes
            selectElement.classList.remove('status-open', 'status-triaged', 'status-mitigated', 
                                         'status-remediated', 'status-fp', 'status-wontfix');
            
            // Add appropriate status class
            selectElement.classList.add('status-' + value);
            
            // Store status in localStorage
            const storageKey = 'threat-status-' + window.location.pathname.split('/').pop();
            const statuses = JSON.parse(localStorage.getItem(storageKey) || '{}');
            statuses[threatId] = selectElement.value;
            localStorage.setItem(storageKey, JSON.stringify(statuses));
        }
        
        // Update comment
        function updateComment(textElement, threatId) {
            const storageKey = 'threat-comments-' + window.location.pathname.split('/').pop();
            const comments = JSON.parse(localStorage.getItem(storageKey) || '{}');
            comments[threatId] = textElement.value;
            localStorage.setItem(storageKey, JSON.stringify(comments));
        }
        
        // Load saved statuses from localStorage
        function loadSavedStatuses() {
            const storageKey = 'threat-status-' + window.location.pathname.split('/').pop();
            const statuses = JSON.parse(localStorage.getItem(storageKey) || '{}');
            
            Object.keys(statuses).forEach(threatId => {
                const select = document.querySelector('[data-threat-id="' + threatId + '"] select');
                if (select) {
                    select.value = statuses[threatId];
                    updateStatus(select, threatId);
                }
            });
        }
        
        // Load saved comments from localStorage
        function loadSavedComments() {
            const storageKey = 'threat-comments-' + window.location.pathname.split('/').pop();
            const comments = JSON.parse(localStorage.getItem(storageKey) || '{}');
            
            Object.keys(comments).forEach(threatId => {
                const textarea = document.querySelector('[data-threat-id="' + threatId + '"] textarea');
                if (textarea) {
                    textarea.value = comments[threatId];
                }
            });
        }
        
        // Initialize on DOM ready
        document.addEventListener('DOMContentLoaded', function() {
            // Filter functionality
            document.querySelectorAll('.filter-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                    this.classList.add('active');
                    currentFilter = this.dataset.filter;
                    filterThreats();
                });
            });
            
            // Search functionality
            document.getElementById('searchInput').addEventListener('input', function(e) {
                currentSearchTerm = e.target.value.toLowerCase();
                filterThreats();
            });
            
            updateStats();
            loadSavedStatuses();
            loadSavedComments();
        });
    </script>
</body>
</html>`;

		fs.writeFileSync(htmlPath, htmlContent);
		return htmlPath;
	}

	private async generateCSVReport(feature: Feature, analysisContent: string, outputFolder: string, productName?: string): Promise<string> {
		const csvPath = path.join(outputFolder, `threat-report-combined-${Date.now()}.csv`);
		
		// Parse threats from markdown
		const threats = this.parseThreatsFromMarkdown(analysisContent);
		
		// CSV header
		const header = '"STRIDE Category","Threat Name","Description & Exploitation","Impact","Affected Component","Severity","Mitigation Strategies","Status","Comments"';
		
		// CSV rows
		const rows = threats.map(threat => {
			// Escape double quotes and wrap fields in quotes
			const escapeCsv = (value: any) => {
				// Convert to string and handle null/undefined
				const str = value !== null && value !== undefined ? String(value) : '';
				if (!str) { return '""'; }
				return `"${str.replace(/"/g, '""')}"`;
			};
			
			// Format mitigation object into readable string
			const formatMitigation = (mitigation: any) => {
				if (!mitigation || typeof mitigation !== 'object') {
					return String(mitigation || '');
				}
				
				const parts = [];
				if (mitigation.immediate && mitigation.immediate.length > 0) {
					parts.push('Immediate: ' + mitigation.immediate.join('; '));
				}
				if (mitigation.shortTerm && mitigation.shortTerm.length > 0) {
					parts.push('Short-term: ' + mitigation.shortTerm.join('; '));
				}
				if (mitigation.longTerm && mitigation.longTerm.length > 0) {
					parts.push('Long-term: ' + mitigation.longTerm.join('; '));
				}
				return parts.join(' | ');
			};
			
			return [
				escapeCsv(threat.strideCategory),
				escapeCsv(threat.name),
				escapeCsv(threat.description),
				escapeCsv(threat.impact),
				escapeCsv(threat.component),
				escapeCsv(threat.severity),
				escapeCsv(formatMitigation(threat.mitigation)),
				escapeCsv(''), // Status (empty by default)
				escapeCsv('') // Comments (empty by default)
			].join(',');
		}).join('\n');
		
		const csvContent = `${header}\n${rows}`;
		fs.writeFileSync(csvPath, csvContent, 'utf-8');
		
		return csvPath;
	}
	
	public parseThreatsFromMarkdown(markdown: string): any[] {
		// Try heading-based parsing first, fall back to --- block parsing
		const threats = this._parseByHeadings(markdown);
		if (threats.length > 0) {
			return threats;
		}
		console.log('Heading-based parse found 0 threats, trying --- block fallback');
		return this._parseByBlocks(markdown);
	}

	/** Parse threats from markdown split on ## / ### / #### headings */
	private _parseByHeadings(markdown: string): any[] {
		const threats: any[] = [];
		let currentSource = 'repo';

		// Accept heading levels 2–4 so Copilot output that uses ## or #### still works
		const sections = markdown.split(/(?=^#{2,4} )/gm).filter(s => s.trim().length > 0);

		console.log(`_parseByHeadings: ${sections.length} sections`);

		for (const section of sections) {
			if (section.includes('Repository Code Analysis')) { currentSource = 'repo'; continue; }
			if (section.includes('Design Documentation Analysis')) { currentSource = 'design'; continue; }
			if (section.trim().length < 50) { continue; }

			// Extract heading — accept any level 2-4
			const headingMatch = section.match(/^#{2,4}\s+(.+?)(?:\r?\n|$)/m);
			if (!headingMatch) { continue; }

			const rawHeading = headingMatch[1].trim().replace(/\*\*/g, '').replace(/\r/g, '');

			// Determine threat name: strip optional "Threat:" prefix
			let name: string;
			const prefixMatch = rawHeading.match(/^Threat:\s*(.+)$/i);
			if (prefixMatch) {
				name = prefixMatch[1].trim();
			} else {
				// For headings without "Threat:" prefix, only include sections
				// that contain a STRIDE category and severity indicator
				// Supports both line format (**Category**: value) and table format (| **Category** | value |)
				const hasStride   = /(?:STRIDE\s+)?Category\s*[\s:|\*]+\s*(?:Spoofing|Tampering|Repudiation|Information\s+Disclosure|Denial\s+of\s+Service|Elevation\s+of\s+Privilege)|(?:^|\|)\s*(?:Spoofing|Tampering|Repudiation|Information\s+Disclosure|Denial\s+of\s+Service|Elevation\s+of\s+Privilege)\s*(?:\||$)/im.test(section);
				const hasSeverity = /Severity\s*[\s:|\*]+\s*(?:Critical|High|Medium|Low)|(?:^|\|)\s*(?:Critical|High|Medium|Low)\s*(?:\||$)/im.test(section);
				if (!hasStride || !hasSeverity) { continue; }
				name = rawHeading;
			}

			threats.push(this._extractThreatFields(section, name, currentSource));
		}

		console.log(`_parseByHeadings: ${threats.length} threats`);
		return threats;
	}

	/** Fallback: parse threats from blocks separated by --- when no headings found */
	private _parseByBlocks(markdown: string): any[] {
		const threats: any[] = [];
		let currentSource = 'repo';

		const blocks = markdown.split(/\n---+\n/).map(b => b.trim()).filter(b => b.length > 40);

		for (const block of blocks) {
			if (block.includes('Repository Code Analysis')) { currentSource = 'repo'; continue; }
			if (block.includes('Design Documentation Analysis')) { currentSource = 'design'; continue; }

			const hasStride   = /(?:STRIDE\s+)?Category\s*[\s:|\*]+\s*(?:Spoofing|Tampering|Repudiation|Information\s+Disclosure|Denial\s+of\s+Service|Elevation\s+of\s+Privilege)|(?:^|\|)\s*(?:Spoofing|Tampering|Repudiation|Information\s+Disclosure|Denial\s+of\s+Service|Elevation\s+of\s+Privilege)\s*(?:\||$)/im.test(block);
			const hasSeverity = /Severity\s*[\s:|\*]+\s*(?:Critical|High|Medium|Low)|(?:^|\|)\s*(?:Critical|High|Medium|Low)\s*(?:\||$)/im.test(block);
			if (!hasStride && !hasSeverity) { continue; }

			// Try to get a name from first heading or first bold line
			const nameMatch = block.match(/^#{1,4}\s+(?:Threat:\s*)?(.+?)(?:\r?\n|$)/m)
				|| block.match(/^\*\*(.+?)\*\*/m);
			const name = nameMatch ? nameMatch[1].trim().replace(/\*\*/g, '') : 'Unknown Threat';

			threats.push(this._extractThreatFields(block, name, currentSource));
		}

		console.log(`_parseByBlocks: ${threats.length} threats`);
		return threats;
	}

	/** Extract STRIDE fields from a single threat block */
	private _extractThreatFields(section: string, name: string, source: string): any {
		const threat: any = {
			name,
			strideCategory: 'Not specified',
			description: '',
			impact: '',
			component: 'Not specified',
			severity: 'Medium',
			mitigation: { immediate: [], shortTerm: [], longTerm: [] },
			source
		};

		// Detect if this section uses markdown table format: | **Field** | Value |
		const tableRows = section.split(/\r?\n/).filter(l => {
			const t = l.trim();
			return t.startsWith('|') && t.endsWith('|') && t.split('|').length >= 4;
		});
		if (tableRows.length >= 3) {
			// Parse table for structured fields (STRIDE, Severity, Component)
			this._extractFromTable(section, threat);
			// Also parse line-based for Description/Impact/Mitigation which may be outside the table
			this._extractFromLines(section, threat);
		} else {
			// Pure line-based format
			this._extractFromLines(section, threat);
		}

		return threat;
	}

	/** Extract fields from markdown table rows: | **Field** | Value | */
	private _extractFromTable(section: string, threat: any): void {
		const STRIDE_VALUES_RE = /Spoofing|Tampering|Repudiation|Information\s+Disclosure|Denial\s+of\s+Service|Elevation\s+of\s+Privilege/i;

		// Process line-by-line for robustness (handles \r\n and \n)
		const lines = section.split(/\r?\n/);
		for (const line of lines) {
			const trimmed = line.trim();
			// Must be a table row: starts and ends with |
			if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) { continue; }

			// Split by | and take the cells (first and last elements are empty from split)
			const cells = trimmed.split('|').map(c => c.trim());
			// cells[0] = '' (before first |), cells[1] = field, cells[2] = value, cells[3+] = extra pipes in value
			if (cells.length < 3) { continue; }

			const rawField = cells[1].replace(/\*\*/g, '').trim();
			// Rejoin cells[2..n-1] in case value contained | characters
			const rawValue = cells.slice(2, -1).join('|').trim();

			const field = rawField.toLowerCase();

			// Skip header/separator rows
			if (field === 'field' || field === 'value' || field.match(/^-+$/) || rawValue.match(/^-+$/)) { continue; }

			if (field.includes('stride') || field === 'category') {
				const strideMatch = rawValue.match(STRIDE_VALUES_RE);
				if (strideMatch) {
					const val = strideMatch[0].trim();
					const canonical: Record<string, string> = {
						'information disclosure': 'Information Disclosure',
						'denial of service':      'Denial of Service',
						'elevation of privilege': 'Elevation of Privilege',
					};
					threat.strideCategory = canonical[val.toLowerCase()] ?? (val.charAt(0).toUpperCase() + val.slice(1));
				}
			} else if (field === 'severity') {
				const sevMatch = rawValue.match(/Critical|High|Medium|Low/i);
				if (sevMatch) {
					threat.severity = sevMatch[0].charAt(0).toUpperCase() + sevMatch[0].slice(1).toLowerCase();
				}
			} else if (field === 'component') {
				threat.component = rawValue.replace(/\*\*/g, '').replace(/`/g, '').trim() || 'Not specified';
			} else if (field.includes('description')) {
				threat.description = rawValue.replace(/\*\*/g, '').replace(/\r/g, '').trim();
			} else if (field === 'impact') {
				threat.impact = rawValue.replace(/\*\*/g, '').replace(/\r/g, '').trim();
			} else if (field.includes('mitigation')) {
				const items = this._extractMitigationItems(rawValue);
				this._distributeMitigations(items, threat);
			}
		}
	}

	/** Extract fields from line-based format: **Field**: Value */
	private _extractFromLines(section: string, threat: any): void {
		const STRIDE_RE = /Spoofing|Tampering|Repudiation|Information\s+Disclosure|Denial\s+of\s+Service|Elevation\s+of\s+Privilege/i;
		const SEVERITY_RE = /Critical|High|Medium|Low/i;
		const FIELD_RE = /^\*{2}([\w\s&/()]+)\*{2}\s*:?\s*(.*?)\s*$/;

		// State-machine: detect field headers and collect content lines that follow
		const lines = section.split(/\r?\n/);
		let currentField = '';
		let currentContent: string[] = [];
		const blocks: Record<string, string> = {};

		const flushBlock = () => {
			if (currentField && currentContent.length > 0) {
				blocks[currentField] = currentContent.join('\n').trim();
			}
			currentContent = [];
		};

		for (const line of lines) {
			// Skip table rows (handled by _extractFromTable)
			if (line.trim().startsWith('|') && line.trim().endsWith('|')) { continue; }

			const fieldMatch = line.match(FIELD_RE);
			if (fieldMatch) {
				flushBlock();
				const fieldName = fieldMatch[1].trim().toLowerCase();
				const inlineValue = fieldMatch[2]?.trim() || '';

				// Map field name to canonical key
				if (fieldName.includes('stride') || fieldName === 'category') {
					currentField = 'stride';
				} else if (fieldName === 'severity') {
					currentField = 'severity';
				} else if (fieldName === 'component' || fieldName === 'affected component') {
					currentField = 'component';
				} else if (fieldName.includes('description')) {
					currentField = 'description';
				} else if (fieldName === 'impact') {
					currentField = 'impact';
				} else if (fieldName.includes('mitigation')) {
					currentField = 'mitigation';
				} else {
					currentField = fieldName;
				}

				if (inlineValue) {
					currentContent.push(inlineValue);
				}
			} else if (currentField) {
				// Continuation of current field's content
				currentContent.push(line);
			}
		}
		flushBlock();

		// Apply parsed blocks to threat (only override if we actually found content)
		if (blocks['stride'] && threat.strideCategory === 'Not specified') {
			const m = blocks['stride'].match(STRIDE_RE);
			if (m) {
				const val = m[0];
				const canonical: Record<string, string> = {
					'information disclosure': 'Information Disclosure',
					'denial of service': 'Denial of Service',
					'elevation of privilege': 'Elevation of Privilege',
				};
				threat.strideCategory = canonical[val.toLowerCase()] ?? (val.charAt(0).toUpperCase() + val.slice(1));
			}
		}

		if (blocks['severity'] && threat.severity === 'Medium') {
			const m = blocks['severity'].match(SEVERITY_RE);
			if (m) {
				threat.severity = m[0].charAt(0).toUpperCase() + m[0].slice(1).toLowerCase();
			}
		}

		if (blocks['component'] && threat.component === 'Not specified') {
			threat.component = blocks['component'].replace(/\*\*/g, '').replace(/`/g, '').trim();
		}

		if (blocks['description'] && !threat.description) {
			threat.description = blocks['description'].replace(/\r/g, '').replace(/\n{2,}/g, '\n');
		}

		if (blocks['impact'] && !threat.impact) {
			threat.impact = blocks['impact'].replace(/\r/g, '').replace(/\n{2,}/g, '\n');
		}

		if (blocks['mitigation']) {
			const hasContent = threat.mitigation.immediate?.length > 0 ||
				threat.mitigation.shortTerm?.length > 0 ||
				threat.mitigation.longTerm?.length > 0;
			if (!hasContent) {
				const items = this.extractListItems(blocks['mitigation']);
				this._distributeMitigations(items, threat);
			}
		}
	}

	/** Extract mitigation items from a table cell value (numbered or bulleted) */
	private _extractMitigationItems(value: string): string[] {
		const items: string[] = [];
		// Split on numbered items (1. 2. 3.) or bullet points or <br> tags
		const parts = value.split(/(?:\d+\.\s+|<br\s*\/?>|\n\s*[-*•]\s*)/);
		for (const part of parts) {
			const cleaned = part.replace(/^\d+\.\s*/, '').replace(/^[-*•]\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
			if (cleaned.length > 5) {
				items.push(cleaned);
			}
		}
		// If splitting didn't work well, try extractListItems
		if (items.length === 0) {
			return this.extractListItems(value);
		}
		return items;
	}

	/** Distribute mitigation items into immediate/shortTerm/longTerm buckets */
	private _distributeMitigations(items: string[], threat: any): void {
		if (items.length > 0) {
			if (items.length <= 2) {
				threat.mitigation.immediate = items;
			} else if (items.length <= 4) {
				threat.mitigation.immediate = items.slice(0, 2);
				threat.mitigation.shortTerm = items.slice(2);
			} else {
				const third = Math.ceil(items.length / 3);
				threat.mitigation.immediate = items.slice(0, third);
				threat.mitigation.shortTerm = items.slice(third, third * 2);
				threat.mitigation.longTerm  = items.slice(third * 2);
			}
		}
	}
	
	private extractListItems(text: string): string[] {
		const items: string[] = [];
		const lines = text.split('\n');
		
		let currentItem = '';
		
		for (const line of lines) {
			const trimmed = line.trim();
			
			// Skip empty lines and section headers
			if (!trimmed || trimmed.match(/^\*\*(?:Immediate|Short|Long)/i)) {
				if (currentItem) {
					items.push(currentItem);
					currentItem = '';
				}
				continue;
			}
			
			// Check if this is a list item
			if (trimmed.match(/^[-*•\d+.]/)) {
				// Save previous item if exists
				if (currentItem) {
					items.push(currentItem);
				}
				// Start new item, removing list marker
				currentItem = trimmed.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').trim();
			} else if (currentItem) {
				// Continuation of previous item
				currentItem += ' ' + trimmed;
			} else {
				// Standalone text
				currentItem = trimmed;
			}
		}
		
		// Add last item
		if (currentItem) {
			items.push(currentItem);
		}
		
		// Clean up items
		return items
			.map(item => item.replace(/\*\*/g, '').replace(/`/g, '').trim())
			.filter(item => item.length > 5 && !item.match(/^(Immediate|Short|Long)[:\s]*$/i));
	}
	
	private generateThreatRows(threats: any[]): string {
		let rows = '';
		let currentSource = '';
		
		threats.forEach((threat, index) => {
			// Add section header if source changes
			if (threat.source !== currentSource) {
				currentSource = threat.source;
				const sectionTitle = currentSource === 'repo' ? 'Repository Threats' : 'Design-level Threats';
				rows += `
				<tr class="section-header section-header-row">
					<td colspan="9" style="background: #1e40af; color: white; font-weight: 700; font-size: 16px; padding: 16px; text-align: left; letter-spacing: 1px;">
						${sectionTitle}
					</td>
				</tr>
				`;
			}
			
			rows += `
			<tr data-threat-id="${index}">
				<td><span class="stride-badge">${this.escapeHtml(threat.strideCategory)}</span></td>
				<td><strong>${this.escapeHtml(threat.name)}</strong></td>
				<td>${this.escapeHtmlWithBreaks(threat.description)}</td>
				<td>${this.escapeHtmlWithBreaks(threat.impact)}</td>
				<td>${this.escapeHtml(threat.component)}</td>
				<td><span class="severity-badge severity-${threat.severity.toLowerCase()}">${threat.severity}</span></td>
				<td>
					<div class="mitigation-list">
						${threat.mitigation.immediate.length > 0 ? `
							<div class="mitigation-section">
								<div class="mitigation-title">🔥 Immediate:</div>
								<ul>
									${threat.mitigation.immediate.map((m: string) => `<li>${this.escapeHtml(m)}</li>`).join('')}
								</ul>
							</div>
						` : ''}
						${threat.mitigation.shortTerm.length > 0 ? `
							<div class="mitigation-section">
								<div class="mitigation-title">⚡ Short-term:</div>
								<ul>
									${threat.mitigation.shortTerm.map((m: string) => `<li>${this.escapeHtml(m)}</li>`).join('')}
								</ul>
							</div>
						` : ''}
						${threat.mitigation.longTerm.length > 0 ? `
							<div class="mitigation-section">
								<div class="mitigation-title">🎯 Long-term:</div>
								<ul>
									${threat.mitigation.longTerm.map((m: string) => `<li>${this.escapeHtml(m)}</li>`).join('')}
								</ul>
							</div>
						` : ''}
					</div>
				</td>
				<td>
					<select class="status-select status-open" onchange="updateStatus(this, ${index})">
						<option value="Open" selected>Open</option>
						<option value="Triaged">Triaged</option>
						<option value="Mitigated">Mitigated</option>
						<option value="Remediated">Remediated</option>
						<option value="FP">False Positive</option>
						<option value="Won't Fix">Won't Fix</option>
					</select>
				</td>
				<td>
					<textarea class="comment-box" placeholder="Add comments..." onchange="updateComment(this, ${index})" rows="2"></textarea>
				</td>
			</tr>
			`;
		});
		
		return rows;
	}
	
	private escapeHtml(text: string): string {
		if (!text) { return ''; }
		const map: { [key: string]: string } = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#039;'
		};
		return text.replace(/[&<>"']/g, m => map[m]);
	}

	private escapeHtmlWithBreaks(text: string): string {
		if (!text) { return ''; }
		return this.escapeHtml(text).replace(/\n/g, '<br>');
	}

	private convertMarkdownToHTML(markdown: string): string {
		// Simple markdown to HTML conversion
		let html = markdown;
		
		// Convert headers
		html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
		html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
		html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
		
		// Convert bold
		html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
		
		// Convert lists
		html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
		html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
		
		// Convert line breaks
		html = html.replace(/\n\n/g, '</p><p>');
		html = '<p>' + html + '</p>';
		
		return html;
	}
}
