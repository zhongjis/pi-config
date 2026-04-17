import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { runPlanApprovalFlow } from "../mode-planning/plannotator.js";
import { MODES, MODE_ALIASES, MODE_META } from "./constants.js";
import type { ModeStateManager } from "./mode-state.js";
import { colored } from "./utils.js";
import type { Mode } from "./types.js";

export function registerModeCommands(pi: ExtensionAPI, state: ModeStateManager): void {
	// CLI flag
	pi.registerFlag("mode", {
		description: "Agent mode: kuafu (build), fuxi (plan), houtu (execute)",
		type: "string",
		default: "kuafu",
	});

	// /mode command
	pi.registerCommand("mode", {
		description: "Switch agent mode (kuafu/fuxi/houtu)",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const filtered = MODES
				.filter((mode) => !query || mode.startsWith(query) || MODE_META[mode].alias.startsWith(query))
				.map((mode) => ({ value: mode, label: MODE_META[mode].label }));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				// Show selector
				const items = MODES.map((m) => {
					const active = m === state.currentMode ? " (active)" : "";
					return `${colored(m, MODE_META[m].label)}${active}`;
				});
				const choice = await ctx.ui.select("Agent Mode", items);
				if (!choice) return;
				const selected = MODES.find((m) => choice.includes(m));
				if (selected) await state.switchMode(selected, ctx);
				return;
			}

			const name = args.trim().toLowerCase();
			const resolved = MODE_ALIASES[name] ?? (MODES.includes(name as Mode) ? (name as Mode) : null);
			if (!resolved) {
				ctx.ui.notify(`Unknown mode: "${name}". Available: ${MODES.join(", ")}`, "error");
				return;
			}
			await state.switchMode(resolved, ctx);
		},
	});

	// /mode:fuxi, /mode:houtu, /mode:kuafu (+ aliases)
	for (const mode of MODES) {
		pi.registerCommand(`mode:${mode}`, {
			description: `Switch to ${mode} mode`,
			handler: async (args, ctx) => {
				await state.switchMode(mode, ctx);
				const prompt = args?.trim();
				if (prompt) {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
			},
		});
	}
	for (const [alias, target] of Object.entries(MODE_ALIASES)) {
		pi.registerCommand(`mode:${alias}`, {
			description: `Switch to ${target} mode`,
			handler: async (args, ctx) => {
				await state.switchMode(target, ctx);
				const prompt = args?.trim();
				if (prompt) {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
			},
		});
	}

	// Bare word input: typing "fuxi" transforms to /mode:fuxi
	pi.on("input", async (event) => {
		const trimmed = event.text.trim().toLowerCase();
		const resolved = MODE_ALIASES[trimmed] ?? (MODES.includes(trimmed as Mode) ? (trimmed as Mode) : null);
		if (resolved) {
			return { action: "transform" as const, text: `/mode:${resolved}` };
		}
		return { action: "continue" as const };
	});

	// Ctrl+Shift+M always cycles regardless of editor state
	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle agent mode (Ctrl+Shift+M)",
		handler: async (ctx) => {
			await state.cycleMode(ctx);
		},
	});
	// /plan:approve — run by fuxi agent after planning is complete
	pi.registerCommand("plan:approve", {
		description: "Present the plan approval menu (Approve / High Accuracy Review / Refine in Editor / Refine in Plannotator)",
		handler: async (args: string, ctx: any) => {
			const rawVariant = args?.trim().replace(/^--variant\s+/u, "");
			const variant =
				rawVariant === "post-high-accuracy"
					? ("post-high-accuracy" as const)
					: ("post-gap-review" as const);
			const result = await runPlanApprovalFlow(pi, state, ctx, variant);
			pi.sendUserMessage(result, { deliverAs: "followUp" });
		},
	});
}
