> **DEPRECATED (2026-05-11):** `extensions/offline/` has been merged into `extensions/profiles/`. The `local` profile now carries all offline guards (blocked tools/agents, system prompt, notify on session start). This plan is preserved for historical reference only.


# Offline Mode Session-Scoped Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `extensions/offline/` activation session-scoped while preserving local-model enforcement and subagent fallback behavior.

**Architecture:** Activation moves from config/env/flag to session custom entries plus an in-memory registry policy shared with child subagent sessions. Project policy may tune local providers, default model, blocked tools/agents, notification text, and status text, but no file can enable offline mode. Model filtering stays on `ctx.modelRegistry.getAvailable()`; subagent local fallback uses that filtered registry.

**Tech Stack:** TypeScript Pi extension, Vitest unit tests, Pi session custom entries via `pi.appendEntry()`, `ctx.sessionManager.getEntries()`, shared `WeakMap` registry policy.

---

## File Structure

- Modify: `extensions/offline/index.ts`
  - Remove global config/env/flag activation.
  - Remove `enabled`, `agentModels`, temporary parent-model switching, and `tool_result` restore logic.
  - Add session-entry activation helpers.
  - Add registry-level inherited offline policy helpers.
  - Keep model forcing, model availability filtering, tool blocking, agent blocking, and prompt injection.
- Modify: `extensions/offline/offline.test.ts`
  - Update harness for `pi.appendEntry()` and `ctx.sessionManager.getEntries()`.
  - Replace config/env/flag activation tests with session-state tests.
  - Add child-session inherited-policy tests.
- Modify: `extensions/offline/README.md`
  - Document `/offline on` as the only activation path.
  - Document project policy fields and explicitly state `enabled`/global config are ignored.
- Optional modify: `docs/superpowers/specs/2026-05-09-offline-mode-extension-design.md`
  - Only if implementation discovers spec mismatch; otherwise leave it.

---

### Task 1: Add failing tests for session-scoped activation

**Files:**
- Modify: `extensions/offline/offline.test.ts`

- [ ] **Step 2: Update the test harness to support session entries**

Replace `createHarness()` with a version that records appended entries:

```ts
function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const flags = new Map<string, unknown>();
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			appendedEntries.push({ customType, data });
		}),
		getFlag: vi.fn((name: string) => flags.get(name)),
		registerFlag: vi.fn((name: string, definition: unknown) => flags.set(name, definition)),
		registerCommand: vi.fn((name: string, definition: any) => commands.set(name, definition)),
		on: vi.fn((event: string, handler: Handler) => {
			const next = handlers.get(event) ?? [];
			next.push(handler);
			handlers.set(event, next);
		}),
		setModel: vi.fn(async () => true),
	};
	offlineExtension(pi as never);
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
```

Expected: tests still compile, existing tests may fail until implementation catches up.

- [ ] **Step 3: Update `createContext()` to expose session entries**

Replace the helper signature/body with:

```ts
function createContext(
	cwd: string,
	model: MockModel | undefined = cloudModel,
	entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
	registry = createMockRegistry([cloudModel, defaultLocalModel, coderLocalModel]),
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
```

Expected: existing tests that call `createContext(tempProject)` still work.

- [ ] **Step 4: Replace config/env activation tests with session-entry tests**

Replace the `describe("offline activation", ...)` block with:

```ts
describe("offline activation", () => {
	it("starts inactive when the session has no offline entry", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);

		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);

		expect(result).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("offline", undefined);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
	});

	it("restores active state from the latest session entry", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, cloudModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: false } },
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx) as [{ systemPrompt: string }];

		expect(result.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("offline", "offline: llama-swap");
		expect(harness.pi.setModel).toHaveBeenCalledWith(defaultLocalModel);
	});

	it("/offline on appends active session state and enables guards", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject);

		await harness.commands.get("offline")?.handler("on", ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx) as [{ systemPrompt: string }];

		expect(harness.appendedEntries).toEqual([{ customType: "panda:offline-mode", data: { active: true } }]);
		expect(result.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("offline", "offline: llama-swap");
	});

	it("/offline off appends inactive session state and disables own guards", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		await harness.commands.get("offline")?.handler("off", ctx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);

		expect(harness.appendedEntries).toEqual([{ customType: "panda:offline-mode", data: { active: false } }]);
		expect(result).toBeUndefined();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("offline", undefined);
	});
});
```

Expected: these tests fail before implementation because activation still reads env/flag/config and does not append session entries.

- [ ] **Step 5: Run focused tests and capture failing output**

Run:

```bash
pnpm vitest run --project unit extensions/offline/offline.test.ts
```

Expected: FAIL with assertions around `appendEntry`, session restore, and removed config/env activation.

- [ ] **Step 6: Do not commit red tests by default**

Keep failing tests unstaged or staged but uncommitted while implementing Task 2 and Task 3. Commit red tests only if the supervising session explicitly asks for red-test commits.

---

### Task 2: Remove activation from global config, env, and flag

**Files:**
- Modify: `extensions/offline/index.ts`
- Modify: `extensions/offline/offline.test.ts`

- [ ] **Step 1: Remove obsolete config shape**

In `extensions/offline/index.ts`, change the config interface and defaults to:

```ts
export interface OfflineConfig {
	localProviders: string[];
	defaultModel: string;
	blockedAgents: string[];
	blockedTools: string[];
	notifyOnSessionStart: boolean;
	statusText: string;
}
```

```ts
export const DEFAULT_OFFLINE_CONFIG: OfflineConfig = {
	localProviders: ["llama-swap"],
	defaultModel: "llama-swap/qwen2.5-coder:14b",
	blockedAgents: ["wenchang"],
	blockedTools: ["web_search", "code_search", "fetch_content", "get_search_content"],
	notifyOnSessionStart: true,
	statusText: "offline: llama-swap",
};
```

Remove `enabled` and `agentModels` everywhere in `OfflineConfig`, defaults, config merge, and command logic.

- [ ] **Step 2: Keep only project-local policy loading**

Replace `loadOfflineConfig()` with:

```ts
export function loadOfflineConfig(cwd: string, notify?: Notify): OfflineConfig {
	const projectPath = join(cwd, ".pi", "offline.json");
	return mergeConfig(DEFAULT_OFFLINE_CONFIG, readConfig(projectPath, notify));
}
```

Remove unused `homedir` import.

- [ ] **Step 3: Make config sanitization ignore activation and invalid fields precisely**

Replace `sanitizeConfig()` with a notify-aware sanitizer:

```ts
function sanitizeConfig(value: unknown, path: string, notify?: Notify): PartialOfflineConfig {
	if (!isRecord(value)) return {};
	const next: PartialOfflineConfig = {};

	if ("enabled" in value) {
		notify?.(`Offline mode: ignoring ${path}: enabled is no longer supported; use /offline on`, "warning");
	}
	if ("agentModels" in value) {
		notify?.(`Offline mode: ignoring ${path}: agentModels is no longer supported; use subagent model fallback`, "warning");
	}

	if (typeof value.defaultModel === "string") next.defaultModel = value.defaultModel;
	else if ("defaultModel" in value) notify?.(`Offline mode: ignoring invalid defaultModel in ${path}`, "warning");

	if (typeof value.notifyOnSessionStart === "boolean") next.notifyOnSessionStart = value.notifyOnSessionStart;
	else if ("notifyOnSessionStart" in value) notify?.(`Offline mode: ignoring invalid notifyOnSessionStart in ${path}`, "warning");

	if (typeof value.statusText === "string") next.statusText = value.statusText;
	else if ("statusText" in value) notify?.(`Offline mode: ignoring invalid statusText in ${path}`, "warning");

	const localProviders = stringArray(value.localProviders);
	if (localProviders) next.localProviders = localProviders;
	else if ("localProviders" in value) notify?.(`Offline mode: ignoring invalid localProviders in ${path}`, "warning");

	const blockedAgents = stringArray(value.blockedAgents);
	if (blockedAgents) next.blockedAgents = blockedAgents;
	else if ("blockedAgents" in value) notify?.(`Offline mode: ignoring invalid blockedAgents in ${path}`, "warning");

	const blockedTools = stringArray(value.blockedTools);
	if (blockedTools) next.blockedTools = blockedTools;
	else if ("blockedTools" in value) notify?.(`Offline mode: ignoring invalid blockedTools in ${path}`, "warning");

	return next;
}
```

Update `readConfig()` to call `sanitizeConfig(JSON.parse(...), path, notify)`.

- [ ] **Step 4: Remove flag/env activation**

Delete `isOfflineActive()` and the `pi.registerFlag("offline-mode", ...)` block.

Replace any checks of `pi.getFlag("offline-mode")`, `process.env.PI_AGENT_OFFLINE_MODE`, and `config.enabled` with session/effective state introduced in Task 3.

- [ ] **Step 5: Update config tests**

Replace `describe("offline config", ...)` with:

```ts
describe("offline config", () => {
	it("loads project policy without reading global config or activation", async () => {
		await mkdir(join(tempHome, ".pi", "agent"), { recursive: true });
		await mkdir(join(tempProject, ".pi"), { recursive: true });
		await writeFile(join(tempHome, ".pi", "agent", "offline.json"), JSON.stringify({
			localProviders: ["global-local"],
			blockedTools: ["global_tool"],
		}));
		await writeFile(join(tempProject, ".pi", "offline.json"), JSON.stringify({
			enabled: true,
			localProviders: ["project-local"],
			statusText: "offline: project",
			agentModels: { jintong: "project-jintong" },
		}));

		const config = loadOfflineConfig(tempProject);

		expect(config.localProviders).toEqual(["project-local"]);
		expect(config.blockedTools).toEqual(["web_search", "code_search", "fetch_content", "get_search_content"]);
		expect(config.statusText).toBe("offline: project");
		expect(config).not.toHaveProperty("enabled");
		expect(config).not.toHaveProperty("agentModels");
	});
});
```

Remove `originalOfflineEnv` setup/teardown from tests.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run --project unit extensions/offline/offline.test.ts
```

Expected: config tests pass; activation tests may still fail until Task 3.

---

### Task 3: Implement session activation and inherited registry policy

**Files:**
- Modify: `extensions/offline/index.ts`
- Modify: `extensions/offline/offline.test.ts`

- [ ] **Step 1: Add constants and types**

Near the top of `index.ts`, after `type Notify`, add:

```ts
export const OFFLINE_STATE_CUSTOM_TYPE = "panda:offline-mode";

type OfflineState = { active: boolean };
type SessionEntryLike = { type?: string; customType?: string; data?: unknown };
type RegistryPolicy = {
	activeConfigs: Map<symbol, OfflineConfig>;
	originalGetAvailable?: ModelRegistryLike["getAvailable"];
};
```

Replace `originalGetAvailableByRegistry` with:

```ts
const registryPolicies = new WeakMap<object, RegistryPolicy>();
```

- [ ] **Step 2: Add session state helpers**

Add after `mergeConfig()`:

```ts
function isOfflineState(value: unknown): value is OfflineState {
	return isRecord(value) && typeof value.active === "boolean";
}

function readSessionOfflineState(ctx: ExtensionContext): boolean | undefined {
	const entries = (ctx.sessionManager?.getEntries?.() ?? []) as SessionEntryLike[];
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== OFFLINE_STATE_CUSTOM_TYPE) continue;
		if (isOfflineState(entry.data)) return entry.data.active;
	}
	return undefined;
}

function writeSessionOfflineState(pi: ExtensionAPI, active: boolean): void {
	pi.appendEntry(OFFLINE_STATE_CUSTOM_TYPE, { active });
}
```

- [ ] **Step 3: Add registry policy helpers**

Replace `installModelRegistryFilter()` with helpers that install one wrapper per registry and track active owner configs:

```ts
function getRegistryPolicy(registry: ModelRegistryLike): RegistryPolicy | undefined {
	if (!registry || typeof registry !== "object") return undefined;
	let policy = registryPolicies.get(registry);
	if (!policy) {
		policy = { activeConfigs: new Map() };
		registryPolicies.set(registry, policy);
	}
	return policy;
}

function unionLocalProviders(configs: Iterable<OfflineConfig>): Set<string> {
	const providers = new Set<string>();
	for (const config of configs) {
		for (const provider of config.localProviders) providers.add(normalize(provider));
	}
	return providers;
}

function installModelRegistryFilter(registry: ModelRegistryLike): void {
	if (!registry || typeof registry !== "object" || typeof registry.getAvailable !== "function") return;
	const policy = getRegistryPolicy(registry);
	if (!policy || policy.originalGetAvailable) return;

	policy.originalGetAvailable = registry.getAvailable;
	registry.getAvailable = function getOfflineAvailable(this: ModelRegistryLike): ModelLike[] {
		const available = policy.originalGetAvailable?.call(this) ?? [];
		if (policy.activeConfigs.size === 0) return available;
		const localProviders = unionLocalProviders(policy.activeConfigs.values());
		return available.filter((model) => localProviders.has(normalize(model.provider)));
	};
}

function setRegistryOfflinePolicy(registry: ModelRegistryLike, owner: symbol, active: boolean, config: OfflineConfig): void {
	const policy = getRegistryPolicy(registry);
	if (!policy) return;
	installModelRegistryFilter(registry);
	if (active) policy.activeConfigs.set(owner, config);
	else policy.activeConfigs.delete(owner);
}

function hasInheritedRegistryOfflinePolicy(registry: ModelRegistryLike, owner: symbol): boolean {
	const policy = getRegistryPolicy(registry);
	if (!policy) return false;
	if (policy.activeConfigs.has(owner)) return false;
	return policy.activeConfigs.size > 0;
}
```

- [ ] **Step 4: Replace extension-local state**

Inside `offlineExtension()`, replace current activation variables:

```ts
let active = false;
let manualOverride: boolean | undefined;
const temporaryAgentModels = new Map<string, { previousModel: unknown; temporaryModel: unknown }>();
```

with:

```ts
const owner = Symbol("offline-mode-session");
let sessionActive = false;
let effectiveActive = false;
```

- [ ] **Step 5: Split session restore from policy refresh**

Session entries must be restored on `session_start` only. Command handlers update `sessionActive` in memory, then refresh config/effective state without re-reading stale `ctx.sessionManager.getEntries()` snapshots.

Replace `refreshState`, `updateStatus`, and `applyOffline` with:

```ts
function restoreSessionState(ctx: ExtensionContext): void {
	notifiedSessionStart = false;
	sessionActive = readSessionOfflineState(ctx) ?? false;
}

function refreshState(ctx: ExtensionContext): void {
	config = loadOfflineConfig(ctx.cwd, (message, type) => notifyOnce(ctx, `config:${message}`, message, type));
	setRegistryOfflinePolicy(ctx.modelRegistry, owner, sessionActive, config);
	effectiveActive = sessionActive || hasInheritedRegistryOfflinePolicy(ctx.modelRegistry, owner);
	installModelRegistryFilter(ctx.modelRegistry);
}

function updateStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("offline", effectiveActive ? config.statusText : undefined);
}

async function applyOffline(ctx: ExtensionContext, options: { restoreSession?: boolean } = {}): Promise<void> {
	if (options.restoreSession) restoreSessionState(ctx);
	refreshState(ctx);
	updateStatus(ctx);
	if (!effectiveActive) return;
	await forceLocalModel(pi, ctx, config, (message, type) => notifyOnce(ctx, `model:${message}`, message, type));
}
```

Update `session_start` to call `await applyOffline(ctx, { restoreSession: true })`. `/offline on`, `/offline off`, `before_agent_start`, and `tool_call` call `await applyOffline(ctx)` so command-updated in-memory state is preserved.

- [ ] **Step 6: Update `/offline` command**

Replace `on`/`off` branches with:

```ts
if (action === "on") {
	sessionActive = true;
	writeSessionOfflineState(pi, true);
	await applyOffline(ctx);
	ctx.ui.notify(`Offline mode ${offlineStatus(config, effectiveActive)}`, "info");
	return;
}
if (action === "off") {
	sessionActive = false;
	writeSessionOfflineState(pi, false);
	await applyOffline(ctx);
	ctx.ui.notify("Offline mode off", "info");
	return;
}
```

Update status branch to notify with `effectiveActive`:

```ts
ctx.ui.notify(`Offline mode ${offlineStatus(config, effectiveActive)}`, "info");
```

- [ ] **Step 7: Update guards to use effective active state**

Replace all `if (!active) return` checks with `if (!effectiveActive) return`.

In `session_start`, use:

```ts
if (effectiveActive && config.notifyOnSessionStart && !notifiedSessionStart) {
	ctx.ui.notify(NOTIFICATION_TEXT, "info");
	notifiedSessionStart = true;
}
```

Add a shutdown cleanup handler so registry policies do not leak into later sessions:

```ts
pi.on("session_shutdown", async (_event, ctx) => {
	setRegistryOfflinePolicy(ctx.modelRegistry, owner, false, config);
});
```

- [ ] **Step 8: Remove per-agent temporary model routing**

In `tool_call`, delete everything after blocked-agent handling that uses `config.agentModels`, `temporaryAgentModels`, `findConfigModel()`, or `setModel()` for Agent calls.

Delete the entire `pi.on("tool_result", ...)` handler.

After this task, allowed Agent calls should pass through unchanged.

- [ ] **Step 9: Remove now-unused code**

Delete `isSameModel()` if unused.

Keep `findConfigModel()` because `forceLocalModel()` uses it.

- [ ] **Step 10: Replace stale guard tests and add child/fallback tests**

Update the import at the top of `offline.test.ts`:

```ts
import { resolveFirstAvailable, resolveModel } from "../lib/model.js";
```

Replace `describe("offline guards", ...)` with:

```ts
describe("offline guards", () => {
	it("injects offline instructions only when active", async () => {
		const inactiveHarness = createHarness();
		const inactiveCtx = createContext(tempProject);
		const [inactiveResult] = await inactiveHarness.fire("before_agent_start", { systemPrompt: "Base" }, inactiveCtx);
		expect(inactiveResult).toBeUndefined();

		const activeHarness = createHarness();
		const activeCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await activeHarness.fire("session_start", {}, activeCtx);
		const [activeResult] = await activeHarness.fire("before_agent_start", { systemPrompt: "Base" }, activeCtx) as [{ systemPrompt: string }];

		expect(activeResult.systemPrompt).toContain("Base");
		expect(activeResult.systemPrompt).toContain(OFFLINE_SYSTEM_PROMPT);
	});

	it("blocks web tools and wenchang delegation only while active", async () => {
		const inactiveHarness = createHarness();
		const inactiveCtx = createContext(tempProject);
		const [inactiveWebResult] = await inactiveHarness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, inactiveCtx);
		expect(inactiveWebResult).toBeUndefined();

		const activeHarness = createHarness();
		const activeCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await activeHarness.fire("session_start", {}, activeCtx);
		const [webResult] = await activeHarness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, activeCtx);
		const [agentResult] = await activeHarness.fire("tool_call", { type: "tool_call", toolCallId: "agent", toolName: "Agent", input: { subagent_type: "wenchang" } }, activeCtx);

		expect(webResult).toMatchObject({ block: true, reason: expect.stringContaining("web_search") });
		expect(agentResult).toMatchObject({ block: true, reason: expect.stringContaining("wenchang") });
	});

	it("lets allowed Agent calls pass through without temporary parent model switching", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		const [result] = await harness.fire("tool_call", { type: "tool_call", toolCallId: "agent-1", toolName: "Agent", input: { subagent_type: "chengfeng" } }, ctx);

		expect(result).toBeUndefined();
		expect(harness.pi.setModel).not.toHaveBeenCalledWith(coderLocalModel);
	});

	it("disabling the active parent session restores the unfiltered registry", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		expect(ctx.modelRegistry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		await harness.commands.get("offline")?.handler("off", ctx);

		expect(ctx.modelRegistry.getAvailable()).toEqual([cloudModel, defaultLocalModel, coderLocalModel]);
	});

	it("starts a different no-entry session inactive in the same extension instance", async () => {
		const harness = createHarness();
		const activeCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, activeCtx);
		expect(activeCtx.modelRegistry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		const nextCtx = createContext(tempProject, defaultLocalModel);
		await harness.fire("session_start", {}, nextCtx);
		const [result] = await harness.fire("before_agent_start", { systemPrompt: "Base" }, nextCtx);

		expect(result).toBeUndefined();
		expect(nextCtx.ui.setStatus).toHaveBeenLastCalledWith("offline", undefined);
	});

	it("child sessions inherit offline tool guards from the shared registry policy", async () => {
		const registry = createMockRegistry([cloudModel, defaultLocalModel, coderLocalModel]);
		const parentHarness = createHarness();
		const parentCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		], registry);
		await parentHarness.fire("session_start", {}, parentCtx);

		const childHarness = createHarness();
		const childCtx = createContext(tempProject, defaultLocalModel, [], registry);
		await childHarness.fire("session_start", {}, childCtx);
		const [webResult] = await childHarness.fire("tool_call", { type: "tool_call", toolCallId: "web", toolName: "web_search", input: {} }, childCtx);

		expect(webResult).toMatchObject({ block: true, reason: expect.stringContaining("web_search") });
		expect(childHarness.appendedEntries).toEqual([]);
	});

	it("inactive child sessions do not disable a parent registry filter", async () => {
		const registry = createMockRegistry([cloudModel, defaultLocalModel, coderLocalModel]);
		const parentHarness = createHarness();
		const parentCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		], registry);
		await parentHarness.fire("session_start", {}, parentCtx);
		expect(registry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		const childHarness = createHarness();
		const childCtx = createContext(tempProject, defaultLocalModel, [], registry);
		await childHarness.fire("session_start", {}, childCtx);
		await childHarness.commands.get("offline")?.handler("off", childCtx);

		expect(registry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);
	});

	it("subagent fallback chain skips cloud candidates and selects local fallback", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, ctx);

		const resolved = resolveFirstAvailable([
			{ model: "anthropic/claude-sonnet" },
			{ model: "llama-swap/qwen2.5-coder:14b" },
		], ctx.modelRegistry as never);

		expect(typeof resolveModel("anthropic/claude-sonnet", ctx.modelRegistry as never)).toBe("string");
		expect(resolved?.model).toBe(defaultLocalModel);
	});

	it("session shutdown removes the owner registry policy", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, ctx);
		expect(ctx.modelRegistry.getAvailable()).toEqual([defaultLocalModel, coderLocalModel]);

		await harness.fire("session_shutdown", {}, ctx);

		expect(ctx.modelRegistry.getAvailable()).toEqual([cloudModel, defaultLocalModel, coderLocalModel]);
	});

	it("shows the session-start notification once and not on every turn", async () => {
		const harness = createHarness();
		const ctx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);

		await harness.fire("session_start", {}, ctx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Offline mode enabled: local models only; web tools and wenchang disabled.",
			"info",
		);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("offline", "offline: llama-swap");
	});

	it("resets session-start notification tracking for each session load", async () => {
		const harness = createHarness();
		const firstCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, firstCtx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, firstCtx);
		expect(firstCtx.ui.notify).toHaveBeenCalledTimes(1);

		const secondCtx = createContext(tempProject, defaultLocalModel, [
			{ type: "custom", customType: "panda:offline-mode", data: { active: true } },
		]);
		await harness.fire("session_start", {}, secondCtx);
		await harness.fire("before_agent_start", { systemPrompt: "Base" }, secondCtx);
		expect(secondCtx.ui.notify).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 11: Run focused tests**

Run:

```bash
pnpm vitest run --project unit extensions/offline/offline.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit implementation and tests**

```bash
git add extensions/offline/index.ts extensions/offline/offline.test.ts
git commit -m "feat(offline): make activation session-scoped"
```

---

### Task 4: Update README and remove stale behavior docs

**Files:**
- Modify: `extensions/offline/README.md`

- [ ] **Step 1: Replace feature list**

Replace lines under `## Features` with:

```md
- Enables offline mode only with `/offline on` in the current session.
- Persists activation through reloads of that same session via a session custom entry.
- Forces the parent session onto a configured local model when active.
- Filters `ctx.modelRegistry.getAvailable()` so only configured local providers are visible while active.
- Lets subagent frontmatter fallback choose local models from the filtered registry.
- Blocks web-dependent tools and delegation to `wenchang`.
- Injects an offline system instruction and shows a persistent `offline` status item.
```

- [ ] **Step 2: Replace command descriptions**

Use:

```md
- `/offline on` — Enable offline mode for the current session and persist it in this session log.
- `/offline off` — Disable offline mode for the current session and persist that state in this session log.
- `/offline status` — Show whether offline mode is active.
```

- [ ] **Step 3: Replace hooks list**

Use:

```md
- `session_start` — Loads project policy, restores session activation, installs model filtering, forces a local model, shows one notification, sets status.
- `before_agent_start` — Re-applies local model guard and appends offline instructions.
- `tool_call` — Blocks configured web tools and blocked agents.
```

Remove `tool_result` hook docs.

- [ ] **Step 4: Replace configuration section**

Use:

```md
## Policy

Activation is session-scoped. No config file can turn offline mode on.

Optional project policy lives at `<cwd>/.pi/offline.json`. The extension does not read `~/.pi/agent/offline.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `localProviders` | `string[]` | `["llama-swap"]` | Providers considered local. |
| `defaultModel` | `string` | `"llama-swap/qwen2.5-coder:14b"` | Parent model used when current model is not local. |
| `blockedAgents` | `string[]` | `["wenchang"]` | Subagents blocked while offline. |
| `blockedTools` | `string[]` | web/search/fetch tools | Tools blocked while offline. |
| `notifyOnSessionStart` | `boolean` | `true` | Show the session-start notification. |
| `statusText` | `string` | `"offline: llama-swap"` | Persistent footer/status text. |

Unsupported legacy keys are ignored:

- `enabled`
- `agentModels`

Example:

```json
{
  "defaultModel": "llama-swap/qwen2.5-coder:14b",
  "blockedAgents": ["wenchang"],
  "statusText": "offline: llama-swap"
}
```
```

- [ ] **Step 5: Commit docs**

Run:

```bash
git add extensions/offline/README.md
git commit -m "docs(offline): document session-scoped activation"
```

---

### Task 5: Full verification

**Files:**
- No intended edits unless verification finds a defect.

- [ ] **Step 1: Run focused extension tests**

```bash
pnpm vitest run --project unit extensions/offline/offline.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all extension unit tests**

```bash
pnpm test:extensions
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run lint/typecheck wrapper**

```bash
pnpm lint:typecheck
```

Expected: PASS.

- [ ] **Step 5: Final status check**

```bash
git status --short
git log --oneline -5
```

Expected: clean working tree except intentional commits; recent commits show offline implementation/docs.

---

## Self-Review

- Spec coverage: tasks cover session activation, no global config, no env/flag activation, project policy-only config, model filtering, child-session inherited enforcement, subagent fallback reliance, README updates, and verification.
- Placeholder scan: no unresolved placeholder markers. Each code-changing task names exact files and snippets.
- Type consistency: helpers use existing `ExtensionAPI`, `ExtensionContext`, `ModelRegistryLike`, `OfflineConfig`, `Notify`, and Vitest mock patterns.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-offline-mode-session-scoped-implementation-plan.md`.

Per user instruction, plan approval goes through `taishang` before execution.
