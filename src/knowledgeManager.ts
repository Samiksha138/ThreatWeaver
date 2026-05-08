import * as fs from 'fs';
import * as path from 'path';

export interface Lesson {
	id: string;
	title: string;
	domain: string;
	component?: string;
	tags: string[];
	product: string;
	feature?: string;
	createdAt: string;
	body: string;
}

const KNOWLEDGE_FOLDER = 'knowledge';

export class KnowledgeManager {
	private productFolder: string;

	constructor(productFolder: string) {
		this.productFolder = productFolder;
	}

	private getKnowledgeDir(): string {
		return path.join(this.productFolder, KNOWLEDGE_FOLDER);
	}

	private ensureDir(): void {
		const dir = this.getKnowledgeDir();
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	/** Get the next lesson ID by scanning existing files. */
	private nextId(): string {
		const dir = this.getKnowledgeDir();
		if (!fs.existsSync(dir)) { return 'LESSON-001'; }
		const files = fs.readdirSync(dir).filter(f => f.startsWith('LESSON-') && f.endsWith('.md'));
		const nums = files.map(f => parseInt(f.replace('LESSON-', '').replace('.md', ''), 10)).filter(n => !isNaN(n));
		const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
		return `LESSON-${String(next).padStart(3, '0')}`;
	}

	/** Save a new lesson to the knowledge base. */
	public addLesson(lesson: Omit<Lesson, 'id' | 'createdAt'>): Lesson {
		this.ensureDir();
		const id = this.nextId();
		const full: Lesson = {
			...lesson,
			id,
			createdAt: new Date().toISOString()
		};

		const content = this.serializeLesson(full);
		const filePath = path.join(this.getKnowledgeDir(), `${id}.md`);
		fs.writeFileSync(filePath, content);
		return full;
	}

	/** Get all lessons for this product. */
	public getLessons(): Lesson[] {
		const dir = this.getKnowledgeDir();
		if (!fs.existsSync(dir)) { return []; }
		const files = fs.readdirSync(dir).filter(f => f.startsWith('LESSON-') && f.endsWith('.md'));
		return files.map(f => this.parseLesson(path.join(dir, f))).filter((l): l is Lesson => l !== null);
	}

	/** Get lessons relevant to a specific domain or set of tags. */
	public getRelevantLessons(domain?: string, tags?: string[]): Lesson[] {
		const all = this.getLessons();
		return all.filter(lesson => {
			if (domain && lesson.domain.toLowerCase() === domain.toLowerCase()) { return true; }
			if (tags && tags.some(t => lesson.tags.map(lt => lt.toLowerCase()).includes(t.toLowerCase()))) { return true; }
			return false;
		});
	}

	/** Format lessons as context string for injection into analysis prompts. */
	public getLessonsAsContext(domain?: string, tags?: string[]): string {
		const lessons = domain || tags ? this.getRelevantLessons(domain, tags) : this.getLessons();
		if (lessons.length === 0) { return ''; }

		const lines = ['## Prior Knowledge (Lessons Learned)', ''];
		for (const lesson of lessons) {
			lines.push(`- **${lesson.title}** [${lesson.domain}] — ${lesson.body.split('\n')[0]}`);
		}
		return lines.join('\n');
	}

	private serializeLesson(lesson: Lesson): string {
		const lines = [
			'---',
			`id: ${lesson.id}`,
			`title: "${lesson.title}"`,
			`domain: "${lesson.domain}"`,
			...(lesson.component ? [`component: "${lesson.component}"`] : []),
			`tags: [${lesson.tags.join(', ')}]`,
			`product: "${lesson.product}"`,
			...(lesson.feature ? [`feature: "${lesson.feature}"`] : []),
			`createdAt: ${lesson.createdAt}`,
			'---',
			'',
			lesson.body
		];
		return lines.join('\n');
	}

	private parseLesson(filePath: string): Lesson | null {
		try {
			const raw = fs.readFileSync(filePath, 'utf-8');
			const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			if (!fmMatch) { return null; }

			const fm = fmMatch[1];
			const body = fmMatch[2].trim();

			const get = (key: string): string => {
				const m = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, 'm'));
				return m ? m[1].trim() : '';
			};

			const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
			const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [];

			return {
				id: get('id'),
				title: get('title'),
				domain: get('domain'),
				component: get('component') || undefined,
				tags,
				product: get('product'),
				feature: get('feature') || undefined,
				createdAt: get('createdAt'),
				body
			};
		} catch {
			return null;
		}
	}
}
