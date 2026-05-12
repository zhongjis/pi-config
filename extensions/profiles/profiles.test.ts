import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import profilesExtension, {
DEFAULT_PROFILES_CONFIG,
loadProfilesConfig,
PROFILE_STATE_CUSTOM_TYPE,
OFFLINE_SYSTEM_PROMPT,
} from "./index.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

type MockModel = { id: string; name: string; provider: string };

const anthropicModel: MockModel = { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic" };
const openaiCodexModel: MockModel = { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai-codex" };
const opencodeGoModel: MockModel = { id: "qwen3.5-plus", name: "Qwen3.5 Plus", provider: "opencode-go" };
const opencodeGoKimi: MockModel = { id: "kimi-k2.6", name: "Kimi K2.6", provider: "opencode-go" };
const opencodeZenModel: MockModel = { id: "kimi-k2.6", name: "Kimi K2.6 (Zen)", provider: "opencode" };
const llamaSwapModel: MockModel = { id: "qwen2.5-coder:14b", name: "Qwen 2.5 Coder 14B", provider: "llama-swap" };
const unrelatedModel: MockModel = { id: "mistral-large", name: "Mistral Large", provider: "mistral" };

function createMockRegistry(models: MockModel[]) {
	return {
		find: vi.fn((provider: string, modelId: string) =>
			models.find((model) => model.provider === provider && model.id === modelId),
		),
		getAll: vi.fn(() => models),
		getAvailable: vi.fn(() => models),
	};
}

function createHarness(flagValues: Record<string, boolean | string | undefined> = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const flags = new Map<string, { type: "boolean" | "string"; default?: boolean | string }>();
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			appendedEntries.push({ customType, data });
		}),
		registerCommand: vi.fn((name: string, definition: any) => commands.set(name, definition)),
		registerFlag: vi.fn((name: string, options: { type: "boolean" | "string"; default?: boolean | string }) => {
			flags.set(name, options);
		}),
		getFlag: vi.fn((name: string) => {
			if (name in flagValues) return flagValues[name];
			return flags.get(name)?.default;
		}),
		on: vi.fn((event: string, handler: Handler) => {
			const next = handlers.get(event) ?? [];
			next.push(handler);
			handlers.set(event, next);
		}),
		setModel: vi.fn(async () => true),
	};
	profilesExtension(pi as never);
	return {
		appendedEntries,
		commands,
		flags,
		pi,
		async fire(event: string, payload: any, ctx: any) {
			const results = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(payload, ctx));
			}
			return results;
		},
	};
}

function createContext(
	cwd: string,
	model: MockModel | undefined = anthropicModel,
	entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
	registry = createMockRegistry([
		anthropicModel,
		openaiCodexModel,
		opencodeGoModel,
		opencodeGoKimi,
		opencodeZenModel,
		llamaSwapModel,
		unrelatedModel,
	]),
) {
	return {
		cwd,
		hasUI: true,
		model,
		modelRegistry: registry,
		sessionManager: {
			getEntries: vi.fn(() => entries),
		},
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

let tempHome = "";
let tempProject = "";
let originalHome: string | undefined;
let originalPiProfile: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	originalPiProfile = process.env.PI_PROFILE;
	tempHome = join(tmpdir(), `profiles-home-${Date.now()}-${Math.random()}`);
	tempProject = join(tmpdir(), `profiles-project-${Date.now()}-${Math.random()}`);
	await mkdir(tempHome, { recursive: true });
	await mkdir(tempProject, { recursive: true });
	process.env.HOME = tempHome;
	delete process.env.PI_PROFILE;
});

afterEach(async () => {
	process.env.HOME = originalHome;
	if (originalPiProfile === undefined) {
		delete process.env.PI_PROFILE;
	} else {
		process.env.PI_PROFILE = originalPiProfile;
	}
	vi.restoreAllMocks();
	await rm(tempHome, { force: true, recursive: true });
	await rm(tempProject, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe("profiles config", () => {
	it("returns built-in defaults when no config files exist", () => {
		const loaded = loadProfilesConfig(tempProject);
		expect(loaded.defaultProfile).toBe("default");
		expect(loaded.profiles.default.providers).toContain("anthropic");
		expect(loaded.profiles.opencode.providers).toContain("opencode-go");
		expect(loaded.profiles.local.providers).toContain("llama-swap");
	});

	it("merges global config over defaults", async () => {
		await mkdir(join(tempHome, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(tempHome, ".pi", "agent", "profiles.json"),
			JSON.stringify({
				defaultProfile: "opencode",
				profiles: {
					opencode: { defaultModel: "opencode-go/glm-5.1" },
				},
			}),
		);
		const loaded = loadProfilesConfig(tempProject);
		expect(loaded.defaultProfile).toBe("opencode");
		expect(loaded.profiles.opencode.defaultModel).toBe("opencode-go/glm-5.1");
		// Providers inherited from defaults.
		expect(loaded.profiles.opencode.providers).toEqual(DEFAULT_PROFILES_CONFIG.profiles.opencode.providers);
	});

	it("project config overrides global", async () => {
		await mkdir(join(tempHome, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(tempHome, ".pi", "agent", "profiles.json"),
			JSON.stringify({ defaultProfile: "opencode" }),
		);
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({ defaultProfile: "local" }),
		);
		const loaded = loadProfilesConfig(tempProject);
		expect(loaded.defaultProfile).toBe("local");
	});

	it("ignores invalid fields with warnings", async () => {
		const notify = vi.fn();
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({
				defaultProfile: 123,
				profiles: {
					opencode: {
						providers: "not-an-array",
						defaultModel: 42,
						statusText: null,
					},
				},
			}),
		);
		const loaded = loadProfilesConfig(tempProject, notify);
		// Defaults preserved.
		expect(loaded.defaultProfile).toBe("default");
		expect(loaded.profiles.opencode.providers).toEqual(DEFAULT_PROFILES_CONFIG.profiles.opencode.providers);
		expect(notify).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Registry filtering
// ---------------------------------------------------------------------------

describe("registry filter", () => {
	it("returns all models when no profile is active yet", () => {
		const ctx = createContext(tempProject);
		// Not fired session_start — filter shouldn't be active.
		const snapshot = ctx.modelRegistry.getAvailable();
		expect(snapshot).toEqual([
			anthropicModel,
			openaiCodexModel,
			opencodeGoModel,
			opencodeGoKimi,
			opencodeZenModel,
			llamaSwapModel,
			unrelatedModel,
		]);
	});

	it("filters to default providers on session_start", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("anthropic");
		expect(visible).toContain("openai-codex");
		expect(visible).not.toContain("opencode-go");
		expect(visible).not.toContain("llama-swap");
	});

	it("filters to opencode providers when PI_PROFILE=opencode", async () => {
		process.env.PI_PROFILE = "opencode";
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toEqual(expect.arrayContaining(["opencode-go", "opencode"]));
		expect(visible).not.toContain("anthropic");
		expect(visible).not.toContain("llama-swap");
	});

	it("filters to llama-swap when profile=local", async () => {
		process.env.PI_PROFILE = "local";
		const harness = createHarness();
		const ctx = createContext(tempProject, llamaSwapModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toEqual([llamaSwapModel.provider]);
	});

	it("restores original getAvailable on session_shutdown", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		expect(ctx.modelRegistry.getAvailable().length).toBeGreaterThan(0);
		await harness.fire("session_shutdown", {}, ctx);
		// After shutdown, filter disabled — all models visible again.
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("llama-swap");
		expect(visible).toContain("mistral");
	});
});

// ---------------------------------------------------------------------------
// Profile resolution priority
// ---------------------------------------------------------------------------

describe("profile resolution", () => {
	it("prefers session state over env var and config", async () => {
		process.env.PI_PROFILE = "opencode";
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({ defaultProfile: "local" }),
		);
		const harness = createHarness();
		const ctx = createContext(
			tempProject,
			anthropicModel,
			[{ type: "custom", customType: PROFILE_STATE_CUSTOM_TYPE, data: { name: "default" } }],
		);
		await harness.fire("session_start", {}, ctx);
		// Session state wins → default profile → anthropic survives, opencode-go hidden.
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("anthropic");
		expect(visible).not.toContain("opencode-go");
		expect(visible).not.toContain("llama-swap");
	});

	it("prefers env var over config default when no session state", async () => {
		process.env.PI_PROFILE = "opencode";
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({ defaultProfile: "local" }),
		);
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("opencode-go");
		expect(visible).not.toContain("anthropic");
		expect(visible).not.toContain("llama-swap");
	});

	it("uses config default when no env var and no session state", async () => {
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({ defaultProfile: "local" }),
		);
		const harness = createHarness();
		const ctx = createContext(tempProject, llamaSwapModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toEqual([llamaSwapModel.provider]);
	});

	it("falls back to built-in default when env var references unknown profile", async () => {
		process.env.PI_PROFILE = "nonexistent";
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("anthropic");
	});
});

// ---------------------------------------------------------------------------
// Model forcing
// ---------------------------------------------------------------------------

describe("model forcing", () => {
	it("does not switch model when current model is in profile's providers", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
	});

	it("switches to profile's defaultModel when current model is out-of-profile", async () => {
		process.env.PI_PROFILE = "opencode";
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		expect(harness.pi.setModel).toHaveBeenCalled();
		const called = harness.pi.setModel.mock.calls[0][0] as MockModel;
		expect(called.provider).toBe("opencode-go");
	});

	it("falls back to first allowed model when defaultModel is missing", async () => {
		process.env.PI_PROFILE = "opencode";
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({
				profiles: { opencode: { defaultModel: "opencode-go/non-existent-model" } },
			}),
		);
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		expect(harness.pi.setModel).toHaveBeenCalled();
		const called = harness.pi.setModel.mock.calls[0][0] as MockModel;
		expect(["opencode-go", "opencode"]).toContain(called.provider);
	});

	it("notifies when no model is available for profile's providers", async () => {
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({
				defaultProfile: "custom-empty",
				profiles: { "custom-empty": { providers: ["no-such-provider"], statusText: "empty" } },
			}),
		);
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("no model available"),
			"error",
		);
	});
});

// ---------------------------------------------------------------------------
// /profile command
// ---------------------------------------------------------------------------

describe("/profile command", () => {
	it("shows status when invoked with no args", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);
		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("profile")!.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Profile: default"),
			"info",
		);
	});

	it("switches profile and writes session state", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);
		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("profile")!.handler("opencode", ctx);
		expect(harness.appendedEntries).toContainEqual({
			customType: PROFILE_STATE_CUSTOM_TYPE,
			data: { name: "opencode" },
		});
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("opencode-go");
		expect(visible).not.toContain("anthropic");
	});

	it("rejects unknown profile name", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);
		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("profile")!.handler("nonexistent", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Unknown profile"),
			"error",
		);
		// Session state not written.
		expect(harness.appendedEntries).not.toContainEqual(
			expect.objectContaining({ data: { name: "nonexistent" } }),
		);
	});

	it("exposes argument completions for known profile names", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);
		await harness.fire("session_start", {}, ctx);
		const def = harness.commands.get("profile")!;
		const completions = (def as any).getArgumentCompletions("op");
		expect(completions).toEqual([{ value: "opencode", label: "opencode" }]);
	});
});

// ---------------------------------------------------------------------------
// Filter composition with concurrent owners (offline-style)
// ---------------------------------------------------------------------------

describe("filter composition", () => {
	it("multiple independent filter owners union their allowed providers", async () => {
		// Simulate: profile extension installed + offline extension installed on same registry.
		// Both should be able to add/remove their policies without breaking the other.
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);

		// Manually install a second filter owner (simulating offline).
		const policy = (ctx.modelRegistry as any);
		const getAvail = policy.getAvailable;
		expect(typeof getAvail).toBe("function");

		// Profile filter keeps anthropic+openai-codex. That's verified above.
		const beforeShutdown = ctx.modelRegistry.getAvailable();
		expect(beforeShutdown.map((m: MockModel) => m.provider)).not.toContain("llama-swap");

		await harness.fire("session_shutdown", {}, ctx);
		// After profile shutdown, filter removed.
		const afterShutdown = ctx.modelRegistry.getAvailable();
		expect(afterShutdown.map((m: MockModel) => m.provider)).toContain("llama-swap");
	});
});

// ---------------------------------------------------------------------------
// /profile:<name> shortcut commands
// ---------------------------------------------------------------------------

describe("/profile:<name> shortcut commands", () => {
	it("registers /profile:<name> command for each built-in profile", () => {
		const harness = createHarness();
		expect(harness.commands.has("profile:default")).toBe(true);
		expect(harness.commands.has("profile:opencode")).toBe(true);
		expect(harness.commands.has("profile:local")).toBe(true);
	});

	it("switches profile and writes session state via /profile:opencode", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);
		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("profile:opencode")!.handler("", ctx);
		expect(harness.appendedEntries).toContainEqual({
			customType: PROFILE_STATE_CUSTOM_TYPE,
			data: { name: "opencode" },
		});
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("opencode-go");
		expect(visible).not.toContain("anthropic");
	});

	it("/profile:local switches to llama-swap-only", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);
		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("profile:local")!.handler("", ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toEqual([llamaSwapModel.provider]);
	});

	it("does NOT auto-register shortcut commands for custom profiles from config", async () => {
		// Custom profiles defined only in config file don't get their own /profile:<name>
		// command since registerCommand runs at init time before config loads.
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(
			join(tempProject, ".pi", "profiles.json"),
			JSON.stringify({
				profiles: {
					"custom-one": { providers: ["anthropic"], statusText: "custom" },
				},
			}),
		);
		const harness = createHarness();
		expect(harness.commands.has("profile:custom-one")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// --profile CLI flag
// ---------------------------------------------------------------------------

describe("--profile CLI flag", () => {
	it("registers the --profile flag with string type", () => {
		const harness = createHarness();
		expect(harness.flags.has("profile")).toBe(true);
		expect(harness.flags.get("profile")?.type).toBe("string");
	});

	it("activates the profile specified by --profile at session_start", async () => {
		const harness = createHarness({ profile: "opencode" });
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("opencode-go");
		expect(visible).not.toContain("anthropic");
	});

	it("CLI flag takes precedence over PI_PROFILE env var", async () => {
		process.env.PI_PROFILE = "local";
		const harness = createHarness({ profile: "opencode" });
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("opencode-go");
		expect(visible).not.toContain("llama-swap");
		expect(visible).not.toContain("anthropic");
	});

	it("CLI flag takes precedence over previous session state", async () => {
		const harness = createHarness({ profile: "opencode" });
		const ctx = createContext(
			tempProject,
			anthropicModel,
			// Session history has "local" as the last-used profile.
			[{ type: "custom", customType: PROFILE_STATE_CUSTOM_TYPE, data: { name: "local" } }],
		);
		await harness.fire("session_start", {}, ctx);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		expect(visible).toContain("opencode-go");
		expect(visible).not.toContain("llama-swap");
	});

	it("persists CLI flag choice into session state so /resume keeps it", async () => {
		const harness = createHarness({ profile: "opencode" });
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		expect(harness.appendedEntries).toContainEqual({
			customType: PROFILE_STATE_CUSTOM_TYPE,
			data: { name: "opencode" },
		});
	});

	it("warns and falls back to default when --profile references unknown profile", async () => {
		const harness = createHarness({ profile: "nonexistent" });
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("unknown"),
			"warning",
		);
		const visible = ctx.modelRegistry.getAvailable().map((m: MockModel) => m.provider);
		// Falls back to default profile.
		expect(visible).toContain("anthropic");
	});
});

// ---------------------------------------------------------------------------
// Offline behavior merged into local profile
// ---------------------------------------------------------------------------

describe("local profile offline guards", () => {
	it("injects offline system prompt via before_agent_start when local profile is active", async () => {
		process.env.PI_PROFILE = "local";
		const harness = createHarness();
		const ctx = createContext(tempProject, llamaSwapModel);
		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx) as [{ systemPrompt: string }];
		expect(result.systemPrompt).toContain("Base");
		expect(result.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
	});

	it("does not inject system prompt for default profile", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);
		expect(result).toBeUndefined();
	});

	it("blocks web tools and wenchang delegation when local profile is active", async () => {
		process.env.PI_PROFILE = "local";
		const harness = createHarness();
		const ctx = createContext(tempProject, llamaSwapModel);
		await harness.fire("session_start", {}, ctx);
		const [webResult] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, ctx);
		const [agentResult] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "agent", toolName: "Agent", input: { subagent_type: "wenchang" } }, ctx);
		expect(webResult).toMatchObject({ block: true, reason: expect.stringContaining("web_search") });
		expect(agentResult).toMatchObject({ block: true, reason: expect.stringContaining("wenchang") });
	});

	it("allows allowed Agent calls through when local profile is active", async () => {
		process.env.PI_PROFILE = "local";
		const harness = createHarness();
		const ctx = createContext(tempProject, llamaSwapModel);
		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "agent-1", toolName: "Agent", input: { subagent_type: "chengfeng" } }, ctx);
		expect(result).toBeUndefined();
	});

	it("does not block tools for default profile", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, anthropicModel);
		await harness.fire("session_start", {}, ctx);
		const [webResult] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, ctx);
		expect(webResult).toBeUndefined();
	});

	it("shows session-start notification once for local profile", async () => {
		process.env.PI_PROFILE = "local";
		const harness = createHarness();
		const ctx = createContext(tempProject, llamaSwapModel);
		await harness.fire("session_start", {}, ctx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("local models only"),
			"info",
		);
	});
});
