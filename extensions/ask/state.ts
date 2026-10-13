/**
 * ask — Pure dialog state (no terminal/UI dependencies).
 *
 * dispatch/submitEditor/finalize return an effect, or undefined for a state-only
 * change. The dialog opens editors from {kind:"openEditor", target, initialText}
 * and calls done from {kind:"finalize", result}. finalize is one-shot, including
 * aborts. While editing, forward text to the editor; submitEditor/cancelEditor
 * close it. Read the public queries for rendering; dispatch(undefined) clears
 * the dismiss notice for unrecognized input too.
 */

import type { Answer, AskDetails, AskMode, AskNote, IncomingQuestion, NormalizedQuestion } from "./types.js";

export type KeyEvent =
	| { kind: "up" | "down" | "nextTab" | "prevTab" | "confirm" | "cancel" | "toggle" | "noteOption" | "noteQuestion" }
	| { kind: "digit"; n: number };

export type EditorTarget =
	| { kind: "custom"; questionId: string }
	| { kind: "note"; questionId: string; optionIndex?: number };

export type FinalizeResult = { cancelled: true } | { mode: AskMode };
export type AskEffect =
	| { kind: "openEditor"; target: EditorTarget; initialText: string }
	| { kind: "finalize"; result: FinalizeResult };

export class AskState {
	readonly questions: NormalizedQuestion[];
	readonly quickPick: boolean;
	readonly totalTabs: number;
	currentTab = 0;
	optionIndex = 0;
	reviewActionIndex = 0;
	dismissPending = false;
	editorTarget: EditorTarget | undefined;
	editorInitialText = "";
	private finalized = false;
	private readonly singleAnswers = new Map<string, number>();
	private readonly multiSets = new Map<string, Set<number>>();
	private readonly customInputs = new Map<string, string>();
	private readonly drafts = new Map<string, string>();
	private readonly notes = new Map<string, string>();
	private readonly lastCursor = new Map<string, number>();

	constructor(questions: NormalizedQuestion[]) {
		this.questions = questions;
		this.quickPick = questions.length === 1 && !questions[0].multi;
		this.totalTabs = questions.length + 1;
		this.optionIndex = questions[0]?.recommended ?? 0;
	}

	get hasTabBar(): boolean {
		return !this.quickPick || this.currentTab === this.questions.length;
	}

	get dirty(): boolean {
		return this.questions.some((q) => this.isAnswered(q)) || this.notes.size > 0 || this.drafts.size > 0;
	}

	get elaborateEnabled(): boolean {
		return this.notes.size > 0;
	}

	isAnswered(q: NormalizedQuestion): boolean {
		return this.customInputs.has(q.id) || (q.multi
			? (this.multiSets.get(q.id)?.size ?? 0) > 0
			: this.singleAnswers.has(q.id));
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

	private targetKey(target: EditorTarget): string {
		return JSON.stringify([target.kind, target.questionId, target.kind === "note" ? target.optionIndex : undefined]);
	}

	getDraft(target: EditorTarget): string | undefined {
		return this.drafts.get(this.targetKey(target));
	}

	getNote(qId: string, optionIndex?: number): string | undefined {
		return this.notes.get(this.targetKey({ kind: "note", questionId: qId, optionIndex }));
	}

	getNotes(): AskNote[] {
		const notes: AskNote[] = [];
		for (const q of this.questions) {
			const text = this.getNote(q.id);
			if (text) notes.push({ questionId: q.id, text });
			q.options.forEach((o, i) => {
				const optionText = this.getNote(q.id, i);
				if (optionText) notes.push({ questionId: q.id, optionValue: o.value, text: optionText });
			});
		}
		return notes;
	}

	getCurrentQuestion(): NormalizedQuestion | undefined {
		return this.questions[this.currentTab];
	}

	buildAnswer(q: NormalizedQuestion): Answer | undefined {
		if (!this.isAnswered(q)) return undefined;
		const single = this.singleAnswers.get(q.id);
		const selected = q.multi ? [...(this.multiSets.get(q.id) ?? [])].sort((a, b) => a - b)
			: single === undefined ? [] : [single];
		const customInput = this.customInputs.get(q.id);
		return {
			id: q.id,
			multi: q.multi,
			wasCustom: customInput !== undefined,
			values: selected.map((i) => q.options[i].value),
			labels: selected.map((i) => q.options[i].label),
			indices: selected.map((i) => i + 1),
			...(customInput === undefined ? {} : { customInput }),
		};
	}

	buildDetails(input: IncomingQuestion[], title: string | undefined, result: FinalizeResult): AskDetails {
		return {
			...(title === undefined ? {} : { title }),
			questions: input,
			answers: this.questions.map((q) => this.buildAnswer(q)).filter((a): a is Answer => a !== undefined),
			notes: this.getNotes(),
			cancelled: "cancelled" in result,
			mode: "mode" in result ? result.mode : "submit",
		};
	}

	enterTab(idx: number): void {
		this.rememberCursor();
		this.currentTab = idx;
		const q = this.getCurrentQuestion();
		this.optionIndex = q ? this.lastCursor.get(q.id) ?? q.recommended ?? 0 : 0;
	}

	rememberCursor(): void {
		const q = this.getCurrentQuestion();
		if (q) this.lastCursor.set(q.id, this.optionIndex);
	}

	moveOption(delta: -1 | 1): void {
		const q = this.getCurrentQuestion();
		if (q) this.optionIndex = (this.optionIndex + delta + this.totalRows(q)) % this.totalRows(q);
	}

	selectSingle(): void {
		const q = this.getCurrentQuestion();
		if (!q || q.multi || this.optionIndex >= q.options.length) return;
		this.deselectCustom(q.id);
		this.singleAnswers.set(q.id, this.optionIndex);
	}

	private deselectCustom(qId: string): void {
		const text = this.customInputs.get(qId);
		if (text !== undefined) this.drafts.set(this.targetKey({ kind: "custom", questionId: qId }), text);
		this.customInputs.delete(qId);
	}

	setCustom(qId: string, text: string): void {
		const q = this.questions.find((q) => q.id === qId);
		if (!q) return;
		const trimmed = text.trim();
		this.drafts.delete(this.targetKey({ kind: "custom", questionId: qId }));
		if (!trimmed) {
			this.customInputs.delete(qId);
			return;
		}
		if (!q.multi) this.singleAnswers.delete(qId);
		this.customInputs.set(qId, trimmed);
	}

	toggleMulti(): AskEffect | undefined {
		const q = this.getCurrentQuestion();
		if (!q?.multi) return;
		if (this.isOtherRow(q, this.optionIndex)) {
			if (this.customInputs.has(q.id)) this.deselectCustom(q.id);
			else {
				const target: EditorTarget = { kind: "custom", questionId: q.id };
				const draft = this.getDraft(target);
				if (draft !== undefined) this.setCustom(q.id, draft);
				else return this.openEditor(target);
			}
			return;
		}
		let selected = this.multiSets.get(q.id);
		if (!selected) {
			selected = new Set();
			this.multiSets.set(q.id, selected);
		}
		if (selected.has(this.optionIndex)) selected.delete(this.optionIndex);
		else selected.add(this.optionIndex);
	}

	private openEditor(target: EditorTarget): AskEffect {
		this.editorTarget = target;
		this.editorInitialText = this.getDraft(target) ?? (target.kind === "custom"
			? this.getCustomInput(target.questionId) : this.getNote(target.questionId, target.optionIndex)) ?? "";
		return { kind: "openEditor", target, initialText: this.editorInitialText };
	}

	submitEditor(text: string): AskEffect | undefined {
		const target = this.editorTarget;
		if (!target || this.finalized) return;
		this.editorTarget = undefined;
		if (target.kind === "custom") {
			this.setCustom(target.questionId, text);
			const q = this.questions.find((q) => q.id === target.questionId);
			if (text.trim() && !q?.multi) return this.advanceAfterAnswer();
		} else {
			const key = this.targetKey(target);
			const trimmed = text.trim();
			if (trimmed) this.notes.set(key, trimmed);
			else this.notes.delete(key);
			this.drafts.delete(key);
		}
	}

	cancelEditor(currentText: string): void {
		if (!this.editorTarget || this.finalized) return;
		const key = this.targetKey(this.editorTarget);
		if (currentText.trim()) this.drafts.set(key, currentText);
		else this.drafts.delete(key);
		this.editorTarget = undefined;
	}

	advanceAfterAnswer(): AskEffect | undefined {
		if (this.quickPick && !this.elaborateEnabled) return this.finalize({ mode: "submit" });
		this.enterTab(Math.min(this.currentTab + 1, this.questions.length));
	}

	finalize(result: FinalizeResult): AskEffect | undefined {
		if (this.finalized) return;
		this.finalized = true;
		return { kind: "finalize", result };
	}

	private runReviewAction(index: number): AskEffect | undefined {
		if (index === 0) return this.finalize({ mode: "submit" });
		if (index === 1 && this.elaborateEnabled) return this.finalize({ mode: "elaborate" });
		if (index === 2) return this.finalize({ cancelled: true });
	}

	dispatch(key: KeyEvent | undefined): AskEffect | undefined {
		if (this.finalized || this.editorTarget) return;
		if (key?.kind === "cancel") {
			if (!this.dirty || this.dismissPending) return this.finalize({ cancelled: true });
			this.dismissPending = true;
			return;
		}
		this.dismissPending = false;
		if (!key) return;
		if (key.kind === "nextTab" || key.kind === "prevTab") {
			this.enterTab((this.currentTab + (key.kind === "nextTab" ? 1 : -1) + this.totalTabs) % this.totalTabs);
			return;
		}
		const q = this.getCurrentQuestion();
		if (!q) {
			if (key.kind === "up" || key.kind === "down") this.reviewActionIndex = (this.reviewActionIndex + (key.kind === "up" ? 2 : 1)) % 3;
			if (key.kind === "confirm") return this.runReviewAction(this.reviewActionIndex);
			if (key.kind === "digit" && key.n >= 1 && key.n <= 3 && Number.isInteger(key.n)) return this.runReviewAction(key.n - 1);
			return;
		}
		if (key.kind === "up" || key.kind === "down") return void this.moveOption(key.kind === "up" ? -1 : 1);
		if (key.kind === "noteQuestion" || key.kind === "noteOption") {
			return this.openEditor({ kind: "note", questionId: q.id,
				...(key.kind === "noteOption" && !this.isOtherRow(q, this.optionIndex) ? { optionIndex: this.optionIndex } : {}),
			});
		}
		if (key.kind === "toggle") return this.toggleMulti();
		if (key.kind === "digit") {
			if (!Number.isInteger(key.n) || key.n < 1 || key.n > 9 || key.n > q.options.length) return;
			this.optionIndex = key.n - 1;
			if (q.multi) return this.toggleMulti();
		} else if (key.kind !== "confirm") return;
		if (this.isOtherRow(q, this.optionIndex)) return this.openEditor({ kind: "custom", questionId: q.id });
		if (!q.multi) this.selectSingle();
		return this.advanceAfterAnswer();
	}
}
