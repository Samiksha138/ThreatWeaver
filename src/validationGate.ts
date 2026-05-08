import * as fs from 'fs';
import * as path from 'path';

export interface ValidationResult {
	passed: boolean;
	errors: string[];
	warnings: string[];
}

const STRIDE_CATEGORIES = ['Spoofing', 'Tampering', 'Repudiation', 'Information Disclosure', 'Denial of Service', 'Elevation of Privilege'];
const SEVERITY_LEVELS = ['Critical', 'High', 'Medium', 'Low'];

/**
 * Validates a threat analysis markdown file before publishing or creating tickets.
 */
export class ValidationGate {

	/**
	 * Run all validation checks on a threat analysis file.
	 */
	public validate(analysisPath: string): ValidationResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		if (!fs.existsSync(analysisPath)) {
			return { passed: false, errors: ['Threat analysis file does not exist: ' + analysisPath], warnings: [] };
		}

		const content = fs.readFileSync(analysisPath, 'utf-8');

		// Check: file is not empty/trivial
		if (content.trim().length < 100) {
			errors.push('Threat analysis appears empty or too short.');
			return { passed: false, errors, warnings };
		}

		// Check: STRIDE category coverage
		const coveredCategories = STRIDE_CATEGORIES.filter(cat =>
			content.toLowerCase().includes(cat.toLowerCase())
		);
		if (coveredCategories.length < 4) {
			errors.push(`Insufficient STRIDE coverage: only ${coveredCategories.length}/6 categories found (${coveredCategories.join(', ')}). Expected at least 4.`);
		} else if (coveredCategories.length < 6) {
			warnings.push(`Partial STRIDE coverage: ${coveredCategories.length}/6 categories found. Missing: ${STRIDE_CATEGORIES.filter(c => !coveredCategories.includes(c)).join(', ')}`);
		}

		// Check: severity distribution
		const severityCounts: Record<string, number> = {};
		for (const sev of SEVERITY_LEVELS) {
			const regex = new RegExp(`\\b${sev}\\b`, 'gi');
			const matches = content.match(regex);
			severityCounts[sev] = matches ? matches.length : 0;
		}
		const totalThreats = Object.values(severityCounts).reduce((a, b) => a + b, 0);

		if (totalThreats === 0) {
			errors.push('No threats with recognized severity levels found.');
		} else {
			// If >80% are Critical, likely hallucinated
			if (severityCounts['Critical'] / totalThreats > 0.8) {
				warnings.push(`Suspicious severity distribution: ${severityCounts['Critical']}/${totalThreats} threats are Critical. This may indicate hallucination.`);
			}
			// If all same severity
			const nonZero = Object.entries(severityCounts).filter(([, c]) => c > 0);
			if (nonZero.length === 1 && totalThreats > 3) {
				warnings.push(`All ${totalThreats} threats have the same severity (${nonZero[0][0]}). Consider if this is realistic.`);
			}
		}

		// Check: threats reference specific components (not all generic)
		const componentPattern = /\*\*Component\*\*|Component:|### .+/g;
		const componentMatches = content.match(componentPattern);
		if (!componentMatches || componentMatches.length < 2) {
			warnings.push('Few component-specific references found. Threats may be too generic.');
		}

		// Check: mitigations present
		const mitigationPattern = /mitigation|remediation|countermeasure|recommendation/gi;
		const mitigationMatches = content.match(mitigationPattern);
		if (!mitigationMatches || mitigationMatches.length < 2) {
			errors.push('Missing or insufficient mitigations. Each threat should have a mitigation.');
		}

		return {
			passed: errors.length === 0,
			errors,
			warnings
		};
	}

	/**
	 * Validate that DFD entries match the threats in the analysis.
	 */
	public validateDFDAlignment(analysisPath: string, dfdPath: string): ValidationResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		if (!fs.existsSync(dfdPath)) {
			warnings.push('DFD file not found — skipping alignment check.');
			return { passed: true, errors, warnings };
		}

		const analysisContent = fs.readFileSync(analysisPath, 'utf-8');
		const dfdContent = fs.readFileSync(dfdPath, 'utf-8');

		// Extract component names from analysis (look for ### headers or **Component** fields)
		const analysisComponents = new Set<string>();
		const headerPattern = /###\s+(.+)/g;
		let match;
		while ((match = headerPattern.exec(analysisContent)) !== null) {
			analysisComponents.add(match[1].trim().toLowerCase());
		}

		// Check that DFD references at least some components from the analysis
		let dfdReferencesAnalysis = 0;
		for (const comp of analysisComponents) {
			if (dfdContent.toLowerCase().includes(comp)) {
				dfdReferencesAnalysis++;
			}
		}

		if (analysisComponents.size > 0 && dfdReferencesAnalysis === 0) {
			warnings.push('DFD does not reference any components from the threat analysis. They may be misaligned.');
		}

		return { passed: errors.length === 0, errors, warnings };
	}

	/**
	 * Run full validation suite for a feature folder (analysis + DFD).
	 */
	public validateFeature(featureFolder: string): { design: ValidationResult; repo: ValidationResult } {
		const designAnalysis = path.join(featureFolder, 'design', 'threat-analysis.md');
		const designDfd = path.join(featureFolder, 'design', 'dataflow-diagram.drawio');
		const repoAnalysis = path.join(featureFolder, 'repo', 'threat-analysis.md');
		const repoDfd = path.join(featureFolder, 'repo', 'dataflow-diagram.drawio');

		const designResult = fs.existsSync(designAnalysis)
			? this.mergeResults(this.validate(designAnalysis), this.validateDFDAlignment(designAnalysis, designDfd))
			: { passed: true, errors: [], warnings: ['No design analysis found — skipped.'] };

		const repoResult = fs.existsSync(repoAnalysis)
			? this.mergeResults(this.validate(repoAnalysis), this.validateDFDAlignment(repoAnalysis, repoDfd))
			: { passed: true, errors: [], warnings: ['No repo analysis found — skipped.'] };

		return { design: designResult, repo: repoResult };
	}

	private mergeResults(a: ValidationResult, b: ValidationResult): ValidationResult {
		return {
			passed: a.passed && b.passed,
			errors: [...a.errors, ...b.errors],
			warnings: [...a.warnings, ...b.warnings]
		};
	}
}
