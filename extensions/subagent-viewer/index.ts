/**
 * Subagent Viewer Extension
 *
 * Companion to the subagent extension. Provides a full-screen viewer
 * (Ctrl+X) for inspecting subagent sessions in real-time.
 *
 * Architecture:
 *   - Registers a globalThis store that the subagent extension writes to
 *   - Persisted sessions are stored via pi.appendEntry("subagent-session", ...)
 *   - On session restore, persisted entries are loaded from the current branch
 *   - Running sessions stream in real-time via the globalThis bridge
 *   - Fork/rewind support: only sessions on the current branch are shown
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { type PersistedSessionData, SubagentSessionStore } from "./store.js";
import { SubagentViewerComponent } from "./viewer.js";

export default function (pi: ExtensionAPI) {
	const store = new SubagentSessionStore();
	store.registerGlobal();

	let latestCtx: ExtensionContext | undefined;
	let viewerOpen = false;
	// ── Status indicator ──

	function updateStatus(ctx: ExtensionContext): void {
		const running = store.runningCount();
		if (running > 0) {
			ctx.ui.setStatus(
				"subagent-viewer",
				ctx.ui.theme.fg("warning", `⏳ ${running} subagent${running > 1 ? "s" : ""} running`),
			);
		} else {
			const total = store.getAll().length;
			if (total > 0) {
				ctx.ui.setStatus(
					"subagent-viewer",
					ctx.ui.theme.fg("dim", `${total} subagent session${total > 1 ? "s" : ""} · Ctrl+X to view`),
				);
			} else {
				ctx.ui.setStatus("subagent-viewer", undefined);
			}
		}
	}

	// Subscribe to store changes for status updates (throttled)
	let statusPending = false;
	store.subscribe(() => {
		if (latestCtx && !statusPending && !viewerOpen) {
			statusPending = true;
			setTimeout(() => {
				statusPending = false;
				if (latestCtx && !viewerOpen) updateStatus(latestCtx);
			}, 500);
		}
	});

	// ── Session lifecycle ──

	function loadPersistedSessions(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type: string;
			customType?: string;
			data?: PersistedSessionData;
		}>;

		const persisted = new Map<string, PersistedSessionData>();
		for (const entry of entries) {
			if (
				entry.type === "custom" &&
				entry.customType === "subagent-session" &&
				entry.data?.id
			) {
				persisted.set(entry.data.id, entry.data);
			}
		}

		store.syncWithPersisted(persisted);
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		loadPersistedSessions(ctx);
		updateStatus(ctx);
	});

	// ── Ctrl+X shortcut ──

	pi.registerShortcut(Key.ctrl("x"), {
		description: "View subagent sessions",
		handler: async (ctx) => {
			latestCtx = ctx;

			// Refresh from persisted entries to handle rewinds
			loadPersistedSessions(ctx);

			const sessions = store.getAll();
			if (sessions.length === 0) {
				ctx.ui.notify("No subagent sessions in this branch.", "info");
				return;
			}

			viewerOpen = true;
			store.viewerOpen = true;
			try {
				await ctx.ui.custom(
					(tui, theme, _kb, done) => {
						return new SubagentViewerComponent(
							tui,
							theme,
							store,
							() => done(undefined),
						);
					},
				);
			} finally {
				viewerOpen = false;
				store.viewerOpen = false;
				if (latestCtx) updateStatus(latestCtx);
			}
		},
	});
}
