/**
 * Full-screen subagent session viewer component.
 *
 * Two-level navigation:
 *   1. Session list — shows all subagent sessions in current branch
 *   2. Conversation detail — full message history for selected session
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { SubagentSessionStore, ViewerSession, ViewerUsageStats } from "./store.js";

type ThemeFg = (color: string, text: string) => string;

interface ViewerTheme {
	fg: ThemeFg;
	bold: (s: string) => string;
}

interface Tui {
	requestRender(): void;
}

// ---------------------------------------------------------------------------
// Formatting helpers (mirrors subagent render.ts for consistency)
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Partial<ViewerUsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join("  ");
}

function formatDuration(session: ViewerSession): string {
	const ms = (session.completedAt ?? Date.now()) - session.startedAt;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 0) return "0s";
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (minutes > 0) return `${minutes}:${String(secs).padStart(2, "0")}`;
	return `${secs}s`;
}

function statusIcon(session: ViewerSession, fg: ThemeFg): string {
	switch (session.status) {
		case "running":
			return fg("warning", "⏳");
		case "completed":
			return fg("success", "✓");
		case "error":
			return fg("error", "✗");
		case "aborted":
			return fg("warning", "⊘");
		default:
			return fg("muted", "?");
	}
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;
	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return fg("muted", "$ ") + fg("toolOutput", truncate(cmd, 60));
		}
		case "read": {
			let text = fg("accent", shortenPath(pathArg));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content || "") as string).split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(pathArg));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(pathArg));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		default:
			return fg("accent", toolName) + fg("dim", ` ${truncate(JSON.stringify(args), 50)}`);
	}
}

function getVisibleMessages(session: ViewerSession): any[] {
	if (!session.liveMessage) return session.messages;
	return [...session.messages, session.liveMessage];
}

// ---------------------------------------------------------------------------
// Viewer component
// ---------------------------------------------------------------------------

export class SubagentViewerComponent {
	focused = true;

	private mode: "list" | "detail" = "list";
	private selectedIndex = 0;
	private scrollOffset = 0;
	private sessions: ViewerSession[] = [];
	private createdAt = 0;

	private tui: Tui;
	private theme: ViewerTheme;
	private store: SubagentSessionStore;
	private onClose: () => void;
	private unsubscribe: () => void;
	private mdTheme: ReturnType<typeof getMarkdownTheme>;

	// Render cache
	private cachedLines?: string[];
	private cachedWidth?: number;
	private cachedVersion?: number;
	private cachedMode?: "list" | "detail";
	private cachedScroll?: number;
	private cachedSelected?: number;

	constructor(
		tui: Tui,
		theme: ViewerTheme,
		store: SubagentSessionStore,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.store = store;
		this.onClose = onClose;
		this.mdTheme = getMarkdownTheme();
		this.createdAt = Date.now();
		this.sessions = store.getAll();

		// Subscribe to store updates (throttled re-render)
		let renderPending = false;
		this.unsubscribe = store.subscribe(() => {
			this.sessions = store.getAll();
			this.cachedLines = undefined;
			if (!renderPending) {
				renderPending = true;
				setTimeout(() => {
					renderPending = false;
					tui.requestRender();
				}, 150);
			}
		});

		// Auto-scroll to bottom for running session in detail view
		if (this.sessions.length > 0) {
			// Select the most recent running session, or last session
			const runningIdx = this.sessions.findIndex((s) => s.status === "running");
			this.selectedIndex = runningIdx >= 0 ? runningIdx : this.sessions.length - 1;
		}
	}

	handleInput(data: string): void {
		if (this.mode === "list") {
			this.handleListInput(data);
		} else {
			this.handleDetailInput(data);
		}
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const version = this.store.version;
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedVersion === version &&
			this.cachedMode === this.mode &&
			this.cachedScroll === this.scrollOffset &&
			this.cachedSelected === this.selectedIndex
		) {
			return this.cachedLines;
		}

		// Refresh sessions from store
		this.sessions = this.store.getAll();

		const rawLines =
			this.mode === "list"
				? this.renderList(width)
				: this.renderDetail(width);

		// CRITICAL: every line must fit within terminal width
		const lines = rawLines.map((line) => truncateToWidth(line, width));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = version;
		this.cachedMode = this.mode;
		this.cachedScroll = this.scrollOffset;
		this.cachedSelected = this.selectedIndex;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.unsubscribe();
	}

	// ── Input handlers ──

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.sessions.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (this.sessions.length > 0) {
				this.mode = "detail";
				this.scrollOffset = 0;
				// Auto-scroll to end for running sessions
				const session = this.sessions[this.selectedIndex];
				if (session?.status === "running") {
					this.scrollOffset = Number.MAX_SAFE_INTEGER;
				}
			}
		} else if (matchesKey(data, Key.escape)) {
			this.dispose();
			this.onClose();
		} else if (matchesKey(data, Key.ctrl("x"))) {
			// Guard: ignore the Ctrl+X that opened the viewer (key leak from shortcut)
			if (Date.now() - this.createdAt > 300) {
				this.dispose();
				this.onClose();
			}
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset++;
		} else if (data === "G") {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
		} else if (data === "g") {
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			this.mode = "list";
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.ctrl("x"))) {
			if (Date.now() - this.createdAt > 300) {
				this.mode = "list";
				this.scrollOffset = 0;
			}
		}
	}

	// ── List view ──

	private renderList(width: number): string[] {
		const fg = this.theme.fg.bind(this.theme);
		const bold = this.theme.bold.bind(this.theme);
		const height = process.stdout.rows || 24;

		const headerLines = [
			fg("border", "─".repeat(width)),
			` ${fg("accent", bold(`Subagent Sessions (${this.sessions.length})`))}`,
			fg("border", "─".repeat(width)),
		];

		const footerLines = [
			fg("border", "─".repeat(width)),
			` ${fg("dim", "↑/↓ navigate  Enter view  Esc close")}`,
		];

		const contentHeight = Math.max(1, height - headerLines.length - footerLines.length);

		if (this.sessions.length === 0) {
			const content = ["", ` ${fg("muted", "No subagent sessions in this branch.")}`, ""];
			while (content.length < contentHeight) content.push("");
			return [...headerLines, ...content.slice(0, contentHeight), ...footerLines];
		}

		// Clamp selection
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.sessions.length - 1));

		// Build session rows
		const content: string[] = [""];
		const maxAgentLen = Math.min(16, Math.max(...this.sessions.map((s) => s.agent.length)));

		for (let i = 0; i < this.sessions.length; i++) {
			const s = this.sessions[i];
			const selected = i === this.selectedIndex;
			const icon = statusIcon(s, fg);
			const prefix = selected ? fg("accent", " ▸") : "  ";
			const agentName = s.agent.padEnd(maxAgentLen);
			const nameStyled = selected ? fg("accent", bold(agentName)) : fg("text", agentName);
			const taskPreview = truncate(s.task.replace(/\n/g, " ").trim(), Math.max(20, width - maxAgentLen - 30));
			const duration = formatDuration(s);
			const tokens = s.usage.input ? `↑${formatTokens(s.usage.input)}` : "";

			const line = `${prefix} ${icon} ${nameStyled}  ${fg("dim", taskPreview)}  ${fg("muted", duration)}  ${fg("dim", tokens)}`;
			content.push(truncateToWidth(line, width));
		}
		content.push("");

		// Scroll if list is too long
		const listScroll = Math.max(0, Math.min(
			this.selectedIndex - Math.floor(contentHeight / 2),
			Math.max(0, content.length - contentHeight),
		));
		const visible = content.slice(listScroll, listScroll + contentHeight);
		while (visible.length < contentHeight) visible.push("");

		return [...headerLines, ...visible, ...footerLines];
	}

	// ── Detail view ──

	private renderDetail(width: number): string[] {
		const session = this.sessions[this.selectedIndex];
		if (!session) {
			this.mode = "list";
			return this.renderList(width);
		}

		const fg = this.theme.fg.bind(this.theme);
		const bold = this.theme.bold.bind(this.theme);
		const height = process.stdout.rows || 24;

		// Fixed header
		const icon = statusIcon(session, fg);
		const headerLines = [
			fg("border", "─".repeat(width)),
			truncateToWidth(
				` ${icon} ${fg("toolTitle", bold(session.agent))}` +
				fg("muted", ` (${session.agentSource}, ${session.delegationMode})`) +
				(session.model ? fg("dim", ` · ${session.model}`) : "") +
				`  ${fg("muted", formatDuration(session))}`,
				width,
			),
			fg("border", "─".repeat(width)),
		];

		// Fixed footer
		const footerLines = [
			fg("border", "─".repeat(width)),
			truncateToWidth(
				` ${fg("dim", "↑/↓ scroll  ← back  Esc close")}`,
				width,
			),
		];

		// Build scrollable content
		const contentLines = this.buildConversationLines(session, width);
		const contentHeight = Math.max(1, height - headerLines.length - footerLines.length);

		// Clamp scroll offset
		const maxScroll = Math.max(0, contentLines.length - contentHeight);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		if (this.scrollOffset < 0) this.scrollOffset = 0;

		// Slice visible content
		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		while (visible.length < contentHeight) visible.push("");

		// Scroll indicator in footer
		if (contentLines.length > contentHeight) {
			const pos = `${this.scrollOffset + 1}–${Math.min(this.scrollOffset + contentHeight, contentLines.length)}/${contentLines.length}`;
			footerLines[1] = truncateToWidth(
				` ${fg("muted", pos)}  ${fg("dim", "↑/↓ scroll  ← back  Esc close")}`,
				width,
			);
		}

		return [...headerLines, ...visible, ...footerLines];
	}

	private buildConversationLines(session: ViewerSession, width: number): string[] {
		const fg = this.theme.fg.bind(this.theme);
		const lines: string[] = [];

		// ── Task section (matches render.ts renderSingleExpanded) ──
		lines.push("");
		lines.push(fg("muted", "─── Task ───"));
		for (const line of session.task.split("\n")) {
			lines.push(truncateToWidth(fg("dim", line), width));
		}

		// ── Output section ──
		lines.push("");
		lines.push(fg("muted", "─── Output ───"));

		// Collect all display items and final output from all messages
		const messages = getVisibleMessages(session);
		const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
		let finalOutput = "";

		for (const msg of messages) {
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const part of msg.content) {
				if (!part) continue;
				if (part.type === "toolCall" && part.name) {
					toolCalls.push({ name: part.name, args: part.arguments ?? {} });
				} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
					finalOutput = part.text;
				}
			}
		}

		if (toolCalls.length === 0 && !finalOutput.trim()) {
			lines.push(fg("muted", "(no output)"));
		} else {
			// All tool calls first
			for (const tc of toolCalls) {
				const callStr = formatToolCall(tc.name, tc.args, fg);
				lines.push(truncateToWidth(fg("muted", "→ ") + callStr, width));
			}

			// Then final markdown output
			if (finalOutput.trim()) {
				lines.push("");
				try {
					const md = new Markdown(finalOutput.trim(), 0, 0, this.mdTheme);
					const mdLines = md.render(width);
					for (const ml of mdLines) {
						lines.push(truncateToWidth(ml, width));
					}
				} catch {
					for (const textLine of finalOutput.trim().split("\n")) {
						lines.push(truncateToWidth(textLine, width));
					}
				}
			}
		}

		// Error info
		if (session.errorMessage) {
			lines.push("");
			lines.push(fg("error", `Error: ${session.errorMessage}`));
		}

		// Usage (matches render.ts footer)
		const usageStr = formatUsage(session.usage, session.model);
		if (usageStr) {
			lines.push("");
			lines.push(fg("dim", usageStr));
		}

		lines.push("");
		return lines;
	}
}
