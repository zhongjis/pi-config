import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODE_COLORS, MODES, MODE_ALIASES, MODE_META, RESET } from "./constants.js";
import { resolveModelFromStr, type ModeStateManager } from "./mode-state.js";
import type { Mode } from "./types.js";

function colored(mode: Mode, text: string): string {
	return `${MODE_COLORS[mode]}${text}${RESET}`;
}

async function switchModeCommand(
	pi: ExtensionAPI,
	state: ModeStateManager,
	mode: Mode,
	ctx: ExtensionCommandContext,
	prompt?: string,
): Promise<void> {
	const requiresReload = await state.switchMode(mode, ctx);
	const followUpPrompt = prompt?.trim();
	if (requiresReload) {
		if (followUpPrompt) {
			ctx.ui.notify(`Mode changed to ${mode}. Please resubmit your prompt after reload.`, "info");
		}
		await ctx.reload();
		return;
	}

	if (followUpPrompt) {
		pi.sendUserMessage(followUpPrompt, { deliverAs: "followUp" });
	}
}

export function registerModeCommands(pi: ExtensionAPI, state: ModeStateManager): void {
	// CLI flag
	pi.registerFlag("mode", {
		description: "Agent mode: kuafu (build), fuxi (plan), houtu (execute), luban, shennong (pm), zhurong",
		type: "string",
		default: "kuafu",
	});

	// /mode command
	pi.registerCommand("mode", {
		description: "Switch agent mode (kuafu/fuxi/houtu/luban/shennong/zhurong)",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const filtered = MODES
				.filter((mode) => !query || mode.startsWith(query) || (MODE_META[mode].alias?.startsWith(query) ?? false))
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
				const selectedIndex = items.indexOf(choice);
				const selected = selectedIndex >= 0 ? MODES[selectedIndex] : undefined;
				if (selected) await switchModeCommand(pi, state, selected, ctx);
				return;
			}

			const name = args.trim().toLowerCase();
			const resolved = MODE_ALIASES[name] ?? (MODES.includes(name as Mode) ? (name as Mode) : null);
			if (!resolved) {
				ctx.ui.notify(`Unknown mode: "${name}". Available: ${MODES.join(", ")}`, "error");
				return;
			}
			await switchModeCommand(pi, state, resolved, ctx);
		},
	});

	// /mode-model command
	pi.registerCommand("mode-model", {
		description: "Override or show mode model",
		handler: async (args, ctx) => {
			const config = state.loadConfig(state.currentMode);

			if (!args?.trim()) {
				const current = ctx.model;
				const override = state.modelOverride;
				const chain = config.model ?? "(none)";
				const lines = [
					`Mode: ${state.currentMode}`,
					`Override: ${override ?? "(none)"}`,
					`Configured: ${chain}`,
					`Active: ${current ? `${current.provider}/${current.id}` : "(none)"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const arg = args.trim();
			if (arg === "--reset") {
				state.modelOverride = undefined;
				await state.applyMode(ctx);
				state.persistState();
				ctx.ui.notify("Model override cleared", "success" as never);
				return;
			}

			const resolved = resolveModelFromStr(arg, ctx.modelRegistry);
			if (!resolved) {
				ctx.ui.notify(`Model not available: "${arg}"`, "error");
				return;
			}

			state.modelOverride = arg;
			await state.applyMode(ctx);
			state.persistState();
			ctx.ui.notify(`Model override set: ${arg}`, "success" as never);
		},
	});

	// /mode:fuxi, /mode:houtu, /mode:kuafu (+ aliases)
	for (const mode of MODES) {
		pi.registerCommand(`mode:${mode}`, {
			description: `Switch to ${mode} mode`,
			handler: async (args, ctx) => {
				await switchModeCommand(pi, state, mode, ctx, args);
			},
		});
	}
	for (const [alias, target] of Object.entries(MODE_ALIASES)) {
		pi.registerCommand(`mode:${alias}`, {
			description: `Switch to ${target} mode`,
			handler: async (args, ctx) => {
				await switchModeCommand(pi, state, target, ctx, args);
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

}
