/**
 * In-memory session store for subagent viewer.
 *
 * Provides real-time session tracking via globalThis bridge and
 * persistence integration via pi.appendEntry/getEntries.
 */

/** Aggregated token usage from a subagent run. */
export interface ViewerUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** A single subagent session visible in the viewer. */
export interface ViewerSession {
	id: string;
	agent: string;
	agentSource: string;
	task: string;
	delegationMode: string;
	status: "running" | "completed" | "error" | "aborted";
	startedAt: number;
	completedAt?: number;
	messages: any[];
	liveMessage?: any;
	usage: ViewerUsageStats;
	model?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
}

/** Data required to create a new session in the store. */
export interface SessionCreateData {
	id: string;
	agent: string;
	agentSource: string;
	task: string;
	delegationMode: string;
	startedAt: number;
}

/** Shape of the data persisted via pi.appendEntry. */
export interface PersistedSessionData {
	id: string;
	agent: string;
	agentSource: string;
	task: string;
	delegationMode: string;
	status: string;
	startedAt: number;
	completedAt?: number;
	messages: any[];
	usage: ViewerUsageStats;
	model?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
}

/** The API surface exposed on globalThis for the subagent extension. */
export interface ViewerStoreAPI {
	createSession(data: SessionCreateData): void;
	updateSession(id: string, result: {
		messages?: any[];
		liveMessage?: any;
		usage?: ViewerUsageStats;
		model?: string;
		exitCode?: number;
		stopReason?: string;
		errorMessage?: string;
		stderr?: string;
	}): void;
	completeSession(id: string, result: {
		messages?: any[];
		usage?: ViewerUsageStats;
		model?: string;
		exitCode?: number;
		stopReason?: string;
		errorMessage?: string;
		stderr?: string;
	}): void;
	isViewerOpen(): boolean;
}

const GLOBAL_KEY = "__piSubagentViewerStore";

function emptyUsage(): ViewerUsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export class SubagentSessionStore implements ViewerStoreAPI {
	private sessions = new Map<string, ViewerSession>();
	private ordering: string[] = [];
	private listeners = new Set<() => void>();
	private _version = 0;
	private _viewerOpen = false;

	get version(): number {
		return this._version;
	}

	set viewerOpen(value: boolean) {
		this._viewerOpen = value;
	}

	isViewerOpen(): boolean {
		return this._viewerOpen;
	}

	// ── Mutations (called by subagent extension via globalThis) ──

	createSession(data: SessionCreateData): void {
		if (this.sessions.has(data.id)) return;
		const session: ViewerSession = {
			id: data.id,
			agent: data.agent,
			agentSource: data.agentSource,
			task: data.task,
			delegationMode: data.delegationMode,
			status: "running",
			startedAt: data.startedAt,
			messages: [],
			usage: emptyUsage(),
			exitCode: -1,
			stderr: "",
		};
		this.sessions.set(data.id, session);
		this.ordering.push(data.id);
		this._version++;
		this.notify();
	}

	updateSession(id: string, result: {
		messages?: any[];
		liveMessage?: any;
		usage?: ViewerUsageStats;
		model?: string;
		exitCode?: number;
		stopReason?: string;
		errorMessage?: string;
		stderr?: string;
	}): void {
		const session = this.sessions.get(id);
		if (!session) return;
		if (result.messages !== undefined) session.messages = result.messages;
		if (result.liveMessage !== undefined) session.liveMessage = result.liveMessage;
		if (result.usage !== undefined) session.usage = result.usage;
		if (result.model !== undefined) session.model = result.model;
		if (result.exitCode !== undefined) session.exitCode = result.exitCode;
		if (result.stopReason !== undefined) session.stopReason = result.stopReason;
		if (result.errorMessage !== undefined) session.errorMessage = result.errorMessage;
		if (result.stderr !== undefined) session.stderr = result.stderr;
		this._version++;
		this.notify();
	}

	completeSession(id: string, result: {
		messages?: any[];
		usage?: ViewerUsageStats;
		model?: string;
		exitCode?: number;
		stopReason?: string;
		errorMessage?: string;
		stderr?: string;
	}): void {
		const session = this.sessions.get(id);
		if (!session) return;
		this.updateSession(id, result);
		session.completedAt = Date.now();
		session.liveMessage = undefined;
		const exitCode = result.exitCode ?? session.exitCode;
		const stopReason = result.stopReason ?? session.stopReason;
		session.status =
			exitCode === 0 ? "completed"
				: stopReason === "aborted" ? "aborted"
					: "error";
		this._version++;
		this.notify();
	}

	// ── Persistence integration ──

	loadPersisted(data: PersistedSessionData, silent = false): void {
		const session: ViewerSession = {
			id: data.id,
			agent: data.agent,
			agentSource: data.agentSource ?? "unknown",
			task: data.task,
			delegationMode: data.delegationMode ?? "spawn",
			status: (data.status as ViewerSession["status"]) ?? "completed",
			startedAt: data.startedAt ?? 0,
			completedAt: data.completedAt,
			messages: data.messages ?? [],
			usage: data.usage ?? emptyUsage(),
			model: data.model,
			exitCode: data.exitCode ?? 0,
			stopReason: data.stopReason,
			errorMessage: data.errorMessage,
			stderr: "",
		};
		this.sessions.set(data.id, session);
		if (!this.ordering.includes(data.id)) {
			this.ordering.push(data.id);
		}
		this._version++;
		if (!silent) this.notify();
	}

	/**
	 * Sync store with persisted entries from the current branch.
	 *
	 * - Adds/updates sessions found in persisted data
	 * - Removes completed sessions NOT in persisted data (rewound away)
	 * - Keeps running sessions (not yet persisted)
	 */
	syncWithPersisted(persisted: Map<string, PersistedSessionData>): void {
		for (const [_id, data] of persisted) {
			this.loadPersisted(data, true);
		}
		for (const [id, session] of this.sessions) {
			if (session.status !== "running" && !persisted.has(id)) {
				this.sessions.delete(id);
				this.ordering = this.ordering.filter((i) => i !== id);
			}
		}
		this._version++;
		this.notify();
	}

	clearAll(): void {
		this.sessions.clear();
		this.ordering = [];
		this._version++;
	}

	// ── Queries ──

	getAll(): ViewerSession[] {
		return this.ordering
			.filter((id) => this.sessions.has(id))
			.map((id) => this.sessions.get(id)!);
	}

	get(id: string): ViewerSession | undefined {
		return this.sessions.get(id);
	}

	hasRunning(): boolean {
		for (const session of this.sessions.values()) {
			if (session.status === "running") return true;
		}
		return false;
	}

	runningCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (session.status === "running") count++;
		}
		return count;
	}

	// ── Subscriptions ──

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {
				/* listener errors should not break the store */
			}
		}
	}

	// ── Global registration ──

	registerGlobal(): void {
		(globalThis as any)[GLOBAL_KEY] = this;
	}
}

/** Get the global viewer store (used by subagent extension). */
export function getGlobalViewerStore(): ViewerStoreAPI | undefined {
	return (globalThis as any)[GLOBAL_KEY];
}
