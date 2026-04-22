import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeLineDiff } from "../../lib/utils.js";
import type { ModeStateManager } from "./mode-state.js";
import { LOCAL_PLAN_URI } from "./constants.js";
import { hydratePlanState, writeLocalPlanFile } from "./plan-storage.js";
import { checkPlannotatorAvailability, getPlannotatorUnavailableReason, startPlanReview, prepareApprovedPlanHandoff } from "./plannotator.js";

export function buildEditorRefinementMessage(diff: string): string {
	if (!diff) {
		return "User opened the editor but made no meaningful changes. Ask if they need help refining the plan.";
	}
	return [
		"User refined the plan in their editor. Here are the changes:",
		"",
		"```diff",
		diff,
		"```",
		"",
		'Review the changes. If they added comments or feedback (e.g., lines starting with "//" or "<!--"), interpret them as revision requests.',
		`Update ${LOCAL_PLAN_URI} to address the feedback, then call the \`plan_approve\` tool again.`,
	].join("\n");
}

/**
 * Open the plan file directly in $VISUAL / $EDITOR.
 * Uses ctx.ui.custom() to obtain the tui handle, suspends the TUI,
 * spawns the editor with stdio inherited, then resumes.
 */
async function refineInSystemEditor(
	state: ModeStateManager,
	ctx: ExtensionContext,
): Promise<"edited" | "cancelled" | "no-ui"> {
	if (!ctx.hasUI) return "no-ui";

	const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";

	const currentContent = state.planContent ?? "";
	const tmpFile = path.join(os.tmpdir(), `pi-plan-edit-${Date.now()}.md`);

	try {
		fs.writeFileSync(tmpFile, currentContent, "utf-8");

		// Use ctx.ui.custom() to get the tui handle for stop/start
		const editResult = await ctx.ui.custom<"edited" | "cancelled">((tui, _theme, _keybindings, done) => {
			// Synchronous: suspend TUI, launch editor, resume — no deferral
			let outcome: "edited" | "cancelled" = "cancelled";
			try {
				tui.stop();
				// Enter alternate screen so editor output doesn't pollute scrollback
				process.stdout.write("\x1b[?1049h");
				const [editor, ...editorArgs] = editorCmd.split(" ");
				const result = spawnSync(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});

				if (result.status === 0) {
					const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
					if (newContent.trim() !== currentContent.trim()) {
						outcome = "edited";
					}
				}
			} catch {
				// editor failed — treat as cancelled
			} finally {
				// Exit alternate screen — restores pre-editor terminal content
				process.stdout.write("\x1b[?1049l");
				tui.start();
				tui.requestRender(true);
			}
			// Resolve after TUI is fully restored — avoids "Working..." flash
			done(outcome);

			// Placeholder component (never visible — TUI is stopped synchronously)
			return { width: 0, height: 0, draw() {} } as any;
		});

		if (editResult === "edited") {
			const updated = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
			await writeLocalPlanFile(ctx as any, updated);
			await hydratePlanState(ctx as any, state);
			state.persistState();
			return "edited";
		}
		return "cancelled";
	} finally {
		try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
	}
	}


type ApprovalMenuVariant =
	| "post-gap-review"    // after gap review: Refine in Editor | Refine in Plannotator | High Accuracy Review | Approve
	| "post-high-accuracy"; // after yanluo: Refine in Editor | Refine in Plannotator | Approve

/**
 * Run the interactive plan approval flow.
 *
 * - "post-gap-review": shown after Di Renjie gap review finishes. Options:
 *     Refine in Editor | Refine in Plannotator | High Accuracy Review (Yan Luo) | Approve
 * - "post-high-accuracy": shown after Yan Luo returns OKAY. Options:
 *     Refine in Editor | Refine in Plannotator | Approve
 * Returns a string message for the agent describing what happened.
 */
export async function runPlanApprovalFlow(
	pi: ExtensionAPI,
	state: ModeStateManager,
	ctx: ExtensionContext,
	variant: ApprovalMenuVariant = "post-gap-review",
): Promise<string> {
	// Re-hydrate to ensure we have the latest plan content
	const snapshot = await hydratePlanState(ctx as any, state);
	if (!snapshot || !state.planTitle) {
		return `Error: No plan found in ${LOCAL_PLAN_URI}. Write or save the plan to ${LOCAL_PLAN_URI} first.`;
	}

	// Check plannotator availability (re-probe each time this menu is shown so
	// the option can be enabled if plannotator starts up between invocations)
	const plannotatorAvail = await checkPlannotatorAvailability(pi, state, /* forceProbe */ true);

	const plannotatorLabel = plannotatorAvail.available
		? "Refine in Plannotator"
		: `Refine in Plannotator (unavailable: ${getPlannotatorUnavailableReason(plannotatorAvail.reason)})`;

	const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
	const editorName = path.basename(editorCmd.split(" ")[0]);
	const editorLabel = `Refine in System Editor (${editorName})`;

	// Build option list
	const OPTIONS_POST_GAP = [
		editorLabel,
		plannotatorLabel,
		"High Accuracy Review (Yan Luo)",
		"Approve",
	] as const;

	const OPTIONS_POST_HIGH_ACCURACY = [
		editorLabel,
		plannotatorLabel,
		"Approve",
	] as const;

	const options = variant === "post-gap-review" ? OPTIONS_POST_GAP : OPTIONS_POST_HIGH_ACCURACY;

	if (!ctx.hasUI) {
		// Non-interactive: auto-approve
		state.planReviewApproved = true;
		const handoffResult = await prepareApprovedPlanHandoff(pi, state, ctx);
		return handoffResult.message;
	}

	pi.events.emit("user-prompted", { tool: "plan_approve" });
	const selected = await ctx.ui.select(
		`Plan: "${state.planTitle}" — How would you like to proceed?`,
		[...options],
	);

	if (!selected) {
		return "Plan approval cancelled by user.";
	}

	// ── Approve ──────────────────────────────────────────────────────────────
	if (selected === "Approve") {
		state.planReviewApproved = true;
		const handoffResult = await prepareApprovedPlanHandoff(pi, state, ctx);
		if (!handoffResult.success) {
			return handoffResult.message;
		}
		return handoffResult.message;
	}

	// ── High Accuracy Review ─────────────────────────────────────────────────
	if (selected === "High Accuracy Review (Yan Luo)") {
		return [
			`Plan approval: user selected High Accuracy Review.`,
			`Run yanluo as a subagent with the plan content from ${LOCAL_PLAN_URI}.`,
			`Loop until yanluo returns OKAY. Fix every issue raised. No maximum retry limit.`,
			`After yanluo returns OKAY, call the plan_approve tool with variant "post-high-accuracy" to show the post-review approval menu.`,
		].join("\n");
	}

	// ── Refine in System Editor ───────────────────────────────────────────────
	if (selected.startsWith("Refine in System Editor")) {
		const oldContent = state.planContent ?? "";
		const editorResult = await refineInSystemEditor(state, ctx);
		if (editorResult === "cancelled") {
			// Re-show the same menu after cancellation
			return runPlanApprovalFlow(pi, state, ctx, variant);
		}
		if (editorResult === "no-ui") {
			return "Cannot open editor in non-interactive mode.";
		}
		// Plan updated — send diff as agent feedback instead of recursing to menu
		const newContent = state.planContent ?? "";
		const diff = computeLineDiff(oldContent, newContent);
		pi.sendUserMessage(buildEditorRefinementMessage(diff), { deliverAs: "followUp" });
		return `Plan "${state.planTitle}" updated via editor. Refinement feedback sent.`;
	}

	// ── Refine in Plannotator ─────────────────────────────────────────────────
	if (selected.startsWith("Refine in Plannotator")) {
		if (!plannotatorAvail.available) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Plannotator is unavailable: ${plannotatorAvail.reason}`, "warning");
			}
			// Re-show menu
			return runPlanApprovalFlow(pi, state, ctx, variant);
		}
		const reviewResult = await startPlanReview(pi, state, ctx);
		return reviewResult;
	}

	return "Plan approval: unrecognised selection.";
}
