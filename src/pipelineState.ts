import * as fs from 'fs';
import * as path from 'path';

/**
 * Pipeline phases for the full threat modeling workflow.
 * Each phase must complete (or be skipped) before advancing.
 */
export enum PipelinePhase {
	Preflight = 0,
	FetchSpec = 1,
	ThreatAnalysis = 2,
	ValidateAnalysis = 3,
	GenerateDFD = 4,
	GenerateReport = 5,
	PublishConfluence = 6,
	CreateJiraTickets = 7,
	Wrapup = 8
}

export type PhaseStatus = 'not-started' | 'in-progress' | 'completed' | 'skipped' | 'failed';

export interface PhaseEntry {
	phase: PipelinePhase;
	name: string;
	status: PhaseStatus;
	startedAt?: string;
	completedAt?: string;
	error?: string;
}

export interface PipelineState {
	featureId: string;
	productId: string;
	createdAt: string;
	updatedAt: string;
	currentPhase: PipelinePhase;
	phases: PhaseEntry[];
}

const PHASE_NAMES: Record<PipelinePhase, string> = {
	[PipelinePhase.Preflight]: 'Preflight',
	[PipelinePhase.FetchSpec]: 'Fetch Spec',
	[PipelinePhase.ThreatAnalysis]: 'Threat Analysis',
	[PipelinePhase.ValidateAnalysis]: 'Validate Analysis',
	[PipelinePhase.GenerateDFD]: 'Generate DFD',
	[PipelinePhase.GenerateReport]: 'Generate Report',
	[PipelinePhase.PublishConfluence]: 'Publish to Confluence',
	[PipelinePhase.CreateJiraTickets]: 'Create Jira Tickets',
	[PipelinePhase.Wrapup]: 'Wrapup'
};

const STATE_FILENAME = 'pipeline-state.json';

export class PipelineStateManager {
	private state: PipelineState;
	private filePath: string;

	constructor(featureFolder: string, productId: string, featureId: string) {
		this.filePath = path.join(featureFolder, STATE_FILENAME);
		this.state = this.load(productId, featureId);
	}

	private load(productId: string, featureId: string): PipelineState {
		if (fs.existsSync(this.filePath)) {
			const raw = fs.readFileSync(this.filePath, 'utf-8');
			return JSON.parse(raw) as PipelineState;
		}
		return this.createFresh(productId, featureId);
	}

	private createFresh(productId: string, featureId: string): PipelineState {
		const now = new Date().toISOString();
		const phases: PhaseEntry[] = Object.values(PipelinePhase)
			.filter(v => typeof v === 'number')
			.map(phase => ({
				phase: phase as PipelinePhase,
				name: PHASE_NAMES[phase as PipelinePhase],
				status: 'not-started' as PhaseStatus
			}));

		return {
			featureId,
			productId,
			createdAt: now,
			updatedAt: now,
			currentPhase: PipelinePhase.Preflight,
			phases
		};
	}

	public getState(): PipelineState {
		return this.state;
	}

	public getCurrentPhase(): PipelinePhase {
		return this.state.currentPhase;
	}

	public getPhaseStatus(phase: PipelinePhase): PhaseStatus {
		return this.state.phases[phase].status;
	}

	public isPhaseComplete(phase: PipelinePhase): boolean {
		const status = this.state.phases[phase].status;
		return status === 'completed' || status === 'skipped';
	}

	/** Get the next phase that needs to run (not completed/skipped). */
	public getResumePhase(): PipelinePhase {
		for (const entry of this.state.phases) {
			if (entry.status !== 'completed' && entry.status !== 'skipped') {
				return entry.phase;
			}
		}
		return PipelinePhase.Wrapup;
	}

	public startPhase(phase: PipelinePhase): void {
		this.state.phases[phase].status = 'in-progress';
		this.state.phases[phase].startedAt = new Date().toISOString();
		this.state.currentPhase = phase;
		this.save();
	}

	public completePhase(phase: PipelinePhase): void {
		this.state.phases[phase].status = 'completed';
		this.state.phases[phase].completedAt = new Date().toISOString();
		this.state.updatedAt = new Date().toISOString();
		this.save();
	}

	public skipPhase(phase: PipelinePhase): void {
		this.state.phases[phase].status = 'skipped';
		this.state.phases[phase].completedAt = new Date().toISOString();
		this.state.updatedAt = new Date().toISOString();
		this.save();
	}

	public failPhase(phase: PipelinePhase, error: string): void {
		this.state.phases[phase].status = 'failed';
		this.state.phases[phase].error = error;
		this.state.updatedAt = new Date().toISOString();
		this.save();
	}

	/** Reset a failed phase back to not-started so it can be retried. */
	public resetPhase(phase: PipelinePhase): void {
		this.state.phases[phase].status = 'not-started';
		this.state.phases[phase].error = undefined;
		this.state.phases[phase].startedAt = undefined;
		this.state.phases[phase].completedAt = undefined;
		this.save();
	}

	/** Reset the entire pipeline (e.g., for a full re-run). */
	public reset(): void {
		this.state = this.createFresh(this.state.productId, this.state.featureId);
		this.save();
	}

	/** Get a summary string suitable for display. */
	public getSummary(): string {
		const completed = this.state.phases.filter(p => p.status === 'completed' || p.status === 'skipped').length;
		const total = this.state.phases.length;
		const current = PHASE_NAMES[this.state.currentPhase];
		return `Phase ${completed}/${total} — ${current}`;
	}

	private save(): void {
		const dir = path.dirname(this.filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
	}
}
