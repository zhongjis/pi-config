/**
 * ask — Class-based state machine.
 *
 * Holds cursor / selection / multi-set / custom-input / visited state and
 * exposes a `dispatch(KeyEvent, callbacks)` entrypoint that index.ts wires to
 * the pi-tui keyboard input. KeyEvent is a tui-agnostic abstract type — this
 * module MUST NOT import from `@earendil-works/pi-tui`.
 *
 * Imports `./types` only.
 */

import type {
	Answer,
	IncomingQuestion,
	NormalizedQuestion,
	AskDetails,
} from "./types.js";

export type KeyEvent =
	| { kind: "tab" }
	| { kind: "shiftTab" }
	| { kind: "left" }
	| { kind: "right" }
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "enter" }
	| { kind: "space" }
	| { kind: "escape" };

export interface DispatchCallbacks {
	onOpenEditor: (questionId: string) => void;
	onFinalize: (cancelled: boolean) => void;
}

export class AskState {
	readonly questions: NormalizedQuestion[];
	readonly autoFinalize: boolean;
	readonly hasTabBar: boolean;
	readonly totalTabs: number;

	currentTab = 0;
	optionIndex = 0;
	inputMode = false;
	inputQuestionId: string | null = null;
	dirty = false;

	private readonly singleAnswers = new Map<string, number>();
	private readonly multiSets = new Map<string, Set<number>>();
	private readonly customInputs = new Map<string, string>();
	private readonly lastCursor = new Map<string, number>();
	private readonly visited = new Set<string>();

	constructor(questions: NormalizedQuestion[]) {
		this.questions = questions;
		this.autoFinalize = questions.length === 1 && !questions[0].multi;
		this.hasTabBar = !this.autoFinalize;
		this.totalTabs = this.autoFinalize ? 1 : questions.length + 1;
		// Enter tab 0 immediately so the recommended cursor / visited bookkeeping
		// matches the original implementation's `enterTab(0)` call at startup.
		this.enterTab(0);
		// `enterTab` set dirty=true; constructor users can ignore that flag.
	}

	// ── Queries ────────────────────────────────────────────────────────────

	isAnswered(q: NormalizedQuestion): boolean {
		if (this.customInputs.has(q.id)) return true;
		if (q.multi) {
			const s = this.multiSets.get(q.id);
			return !!s && s.size > 0;
		}
		return this.singleAnswers.has(q.id);
	}

	allAnswered(): boolean {
		return this.questions.every((q) => this.isAnswered(q));
	}

	totalRows(q: NormalizedQuestion): number {
		return q.options.length + (q.allowOther ? 1 : 0);
	}

	isOtherRow(q: NormalizedQuestion, idx: number): boolean {
		return q.allowOther && idx === q.options.length;
	}

	isOptionToggled(qId: string, optIdx: number): boolean {
		return this.multiSets.get(qId)?.has(optIdx) ?? false;
	}

	getSingleAnswer(qId: string): number | undefined {
		return this.singleAnswers.get(qId);
	}

	getCustomInput(qId: string): string | undefined {
		return this.customInputs.get(qId);
	}

	getCurrentQuestion(): NormalizedQuestion | undefined {
		if (this.currentTab < 0 || this.currentTab >= this.questions.length) {
			return undefined;
		}
		return this.questions[this.currentTab];
	}

	buildAnswer(q: NormalizedQuestion): Answer | undefined {
		if (this.customInputs.has(q.id)) {
			return {
				id: q.id,
				multi: q.multi,
				wasCustom: true,
				values: [],
				labels: [],
				customInput: this.customInputs.get(q.id),
			};
		}
		if (q.multi) {
			const s = this.multiSets.get(q.id);
			if (!s || s.size === 0) return undefined;
			const sorted = Array.from(s).sort((a, b) => a - b);
			return {
				id: q.id,
				multi: true,
				wasCustom: false,
				values: sorted.map((i) => q.options[i].value),
				labels: sorted.map((i) => q.options[i].label),
				indices: sorted.map((i) => i + 1),
			};
		}
		const idx = this.singleAnswers.get(q.id);
		if (idx === undefined) return undefined;
		return {
			id: q.id,
			multi: false,
			wasCustom: false,
			values: [q.options[idx].value],
			labels: [q.options[idx].label],
			indices: [idx + 1],
		};
	}

	buildDetails(input: IncomingQuestion[], cancelled: boolean): AskDetails {
		const answers = this.questions
			.map((q) => this.buildAnswer(q))
			.filter((a): a is Answer => a !== undefined);
		return { questions: input, answers, cancelled };
	}

	// ── Mutations ──────────────────────────────────────────────────────────

	enterTab(idx: number): void {
		this.currentTab = idx;
		if (idx < this.questions.length) {
			const q = this.questions[idx];
			if (this.visited.has(q.id)) {
				this.optionIndex = this.lastCursor.get(q.id) ?? 0;
			} else {
				this.visited.add(q.id);
				this.optionIndex = q.recommended ?? 0;
			}
		} else {
			this.optionIndex = 0; // Submit tab
		}
		this.dirty = true;
	}

	rememberCursor(): void {
		if (this.currentTab >= 0 && this.currentTab < this.questions.length) {
			this.lastCursor.set(this.questions[this.currentTab].id, this.optionIndex);
		}
	}

	moveOption(delta: -1 | 1): void {
		const q = this.getCurrentQuestion();
		if (!q) return;
		const rows = this.totalRows(q);
		if (rows <= 0) return;
		this.optionIndex = (this.optionIndex + delta + rows) % rows;
		this.dirty = true;
	}

	toggleMulti(): void {
		const q = this.getCurrentQuestion();
		if (!q || !q.multi) return;
		// Multi toggle clears any prior custom input for this question.
		this.customInputs.delete(q.id);
		let s = this.multiSets.get(q.id);
		if (!s) {
			s = new Set();
			this.multiSets.set(q.id, s);
		}
		if (s.has(this.optionIndex)) s.delete(this.optionIndex);
		else s.add(this.optionIndex);
		this.dirty = true;
	}

	selectSingle(): void {
		const q = this.getCurrentQuestion();
		if (!q || q.multi) return;
		// Single-select clears any prior custom input for this question.
		this.customInputs.delete(q.id);
		this.singleAnswers.set(q.id, this.optionIndex);
		this.dirty = true;
	}

	setCustom(qId: string, text: string): void {
		// Other ↔ option mutual exclusion: clear prior toggles / single pick.
		this.multiSets.delete(qId);
		this.singleAnswers.delete(qId);
		this.customInputs.set(qId, text);
		this.dirty = true;
	}

	advanceAfterAnswer(cb: DispatchCallbacks): void {
		const isLastQuestion = this.currentTab === this.questions.length - 1;
		if (!isLastQuestion) {
			this.rememberCursor();
			this.enterTab(this.currentTab + 1);
			return;
		}
		// Last question.
		if (this.autoFinalize) {
			cb.onFinalize(false);
			return;
		}
		this.rememberCursor();
		this.enterTab(this.questions.length); // Submit tab
	}

	// ── Dispatch ───────────────────────────────────────────────────────────

	dispatch(key: KeyEvent, cb: DispatchCallbacks): void {
		if (key.kind === "escape") {
			cb.onFinalize(true);
			return;
		}

		// Submit tab handling (only present when hasTabBar).
		if (this.hasTabBar && this.currentTab === this.questions.length) {
			switch (key.kind) {
				case "tab":
				case "right":
					this.enterTab(0);
					return;
				case "shiftTab":
				case "left":
					this.enterTab(this.questions.length - 1);
					return;
				case "enter":
					if (this.allAnswered()) cb.onFinalize(false);
					return;
				default:
					return;
			}
		}

		// Question tab handling.
		const q = this.getCurrentQuestion();
		if (!q) return;

		// Tab navigation only when there is a tab bar.
		if (this.hasTabBar) {
			if (key.kind === "tab" || key.kind === "right") {
				this.rememberCursor();
				this.enterTab((this.currentTab + 1) % this.totalTabs);
				return;
			}
			if (key.kind === "shiftTab" || key.kind === "left") {
				this.rememberCursor();
				this.enterTab((this.currentTab - 1 + this.totalTabs) % this.totalTabs);
				return;
			}
		}

		switch (key.kind) {
			case "up":
				this.moveOption(-1);
				return;
			case "down":
				this.moveOption(1);
				return;
			case "enter": {
				if (this.isOtherRow(q, this.optionIndex)) {
					cb.onOpenEditor(q.id);
					return;
				}
				if (q.multi) {
					this.advanceAfterAnswer(cb);
					return;
				}
				this.selectSingle();
				this.advanceAfterAnswer(cb);
				return;
			}
			case "space": {
				if (q.multi && !this.isOtherRow(q, this.optionIndex)) {
					this.toggleMulti();
				}
				return;
			}
			default:
				return;
		}
	}
}
