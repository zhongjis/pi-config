/**
 * Direct integration with the plannotator package's browser review server.
 *
 * Instead of communicating via IPC events (which race with extension startup
 * and have a 5-second timeout), we import and call the plannotator browser
 * review functions directly.  The plannotator git package
 * (git:github.com/backnotprop/plannotator) must be installed for plan review
 * to work; when the import fails we degrade gracefully.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Types mirrored from plannotator-browser.ts ──────────────────────────────

export interface PlanReviewDecision {
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	agentSwitch?: string;
	permissionMode?: string;
}

export interface PlanReviewBrowserSession {
	reviewId: string;
	url: string;
	waitForDecision: () => Promise<PlanReviewDecision>;
	onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
	stop: () => void;
}

// ── Lazy-loaded plannotator functions ────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PLANNOTATOR_MODULE_CANDIDATES = [
	resolve(THIS_DIR, "../../../git/github.com/backnotprop/plannotator/apps/pi-extension/plannotator-browser.ts"),
	resolve(THIS_DIR, "../../../git/github.com/backnotprop/plannotator/apps/pi-extension/plannotator-browser.js"),
	join(homedir(), ".pi", "agent", "git", "github.com", "backnotprop", "plannotator", "apps", "pi-extension", "plannotator-browser.ts"),
	join(homedir(), ".pi", "agent", "git", "github.com", "backnotprop", "plannotator", "apps", "pi-extension", "plannotator-browser.js"),
];

function findPlannotatorModulePath(): string | undefined {
	for (const candidate of PLANNOTATOR_MODULE_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

let _resolved = false;
let _startSession: ((ctx: ExtensionContext, planContent: string) => Promise<PlanReviewBrowserSession>) | undefined;
let _hasPlanHtml: (() => boolean) | undefined;
let _loadError: string | undefined;

/**
 * Attempt to import plannotator-browser from installed git package.
 * Caches result — only tries once per process.
 */
async function resolvePlannotator(): Promise<void> {
	if (_resolved) return;
	_resolved = true;
	try {
		const modulePath = findPlannotatorModulePath();
		if (!modulePath) {
			_loadError = "plannotator-browser module not found under ~/.pi/agent/git/github.com/backnotprop/plannotator/apps/pi-extension.";
			return;
		}
		const mod = await import(pathToFileURL(modulePath).href);
		if (typeof mod.startPlanReviewBrowserSession === "function") {
			_startSession = mod.startPlanReviewBrowserSession;
		}
		if (typeof mod.hasPlanBrowserHtml === "function") {
			_hasPlanHtml = mod.hasPlanBrowserHtml;
		}
		if (!_startSession) {
			_loadError = "plannotator-browser module loaded but startPlanReviewBrowserSession not found.";
		}
	} catch (err) {
		_loadError = err instanceof Error ? err.message : String(err);
	}
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function isPlannotatorAvailable(): Promise<{ available: boolean; reason?: string }> {
	await resolvePlannotator();
	if (_loadError) {
		return { available: false, reason: `Plannotator package not loaded: ${_loadError}` };
	}
	if (!_startSession) {
		return { available: false, reason: "Plannotator startPlanReviewBrowserSession not available." };
	}
	// Check if HTML assets are built
	if (_hasPlanHtml && !_hasPlanHtml()) {
		return { available: false, reason: "Plannotator HTML assets not built. Run: cd git/github.com/backnotprop/plannotator && bun run build:pi" };
	}
	return { available: true };
}

export async function startDirectPlanReview(
	ctx: ExtensionContext,
	planContent: string,
): Promise<PlanReviewBrowserSession> {
	await resolvePlannotator();
	if (!_startSession) {
		throw new Error(_loadError ?? "Plannotator not available.");
	}
	return _startSession(ctx, planContent);
}

/**
 * Reset the cached import state so the next call re-probes.
 * Useful after session restarts or package updates.
 */
export function resetPlannotatorCache(): void {
	_resolved = false;
	_startSession = undefined;
	_hasPlanHtml = undefined;
	_loadError = undefined;
}
