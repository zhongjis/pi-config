import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createFastSession } from "../../../test/integration/helpers/fast-session.js";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { getSessionFast, sessionFastPolicies } from "../src/session-fast.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { AgentWidget, type UICtx } from "../src/ui/agent-widget.js";

const beta = "fast-mode-2026-02-01";
function config(name: string, model: string): AgentConfig {
	return { name, description: name, model, extensions: false, discoverSkills: false, preloadSkills: [], builtinToolNames: [], systemPrompt: "test", promptMode: "replace" };
}

it("isolated concurrent children enforce opposite fixed policies with shared registry; direct model cannot bypass frontmatter; resume retains policy", async () => {
	const t = await createFastSession([], { "Anthropic-Beta": beta, "ANTHROPIC-BETA": "other" });
	const children: AgentSession[] = [];
	vi.spyOn(t.ctx.modelRegistry, "find").mockImplementation((provider, id) => provider === t.model.provider && id === t.model.id ? t.model : t.runtime.getModel(provider, id));
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	registerAgents(new Map([
		["fast-on", config("fast-on", "missing,anthropic/claude-opus-4-8:fast")],
		["fast-off", config("fast-off", "missing:fast,anthropic/claude-opus-4-8")],
	]));
	try {
		const results = await Promise.all(["fast-on", "fast-off"].map((name) => runAgent(t.ctx, name, name, { pi: t.pi, isolated: true, model: t.model, onSessionCreated: (session) => { children.push(session); } })));
		expect(t.requests).toHaveLength(2);
		expect(results.map(result => getSessionFast(result.session))).toEqual([true, false]);
		expect(getSessionFast(t.session)).toBeUndefined();
		expect(t.requests.map((request) => request.payload.speed).sort()).toEqual(["fast", undefined].sort());
		for (const request of t.requests) {
			const tokens = request.headers.get("anthropic-beta") ?? "";
			expect(tokens.includes(beta)).toBe(request.payload.speed === "fast");
			expect(tokens).toContain("other");
		}
		expect(t.model.headers).toEqual({ "Anthropic-Beta": beta, "ANTHROPIC-BETA": "other" });
		registerAgents(new Map([["fast-on", config("fast-on", "anthropic/claude-opus-4-8")]]));
		const resumed = await resumeAgent(results[0].session, "again", {});
		expect(resumed.text).toBe("ok");
		expect(t.requests.at(-1)?.payload.speed).toBe("fast");
		expect(getSessionFast(results[0].session)).toBe(true);
	} finally { for (const child of children) child.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it("unsupported selected fast fails before child creation rather than choosing fallback", async () => {
	const t = await createFastSession();
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	registerAgents(new Map([["unsupported", config("unsupported", "anthropic/claude-sonnet-4-6:fast,anthropic/claude-opus-4-8:fast")]]));
	const children: AgentSession[] = [];
	const created = vi.fn((session: AgentSession) => { children.push(session); });
	try {
		await expect(runAgent(t.ctx, "unsupported", "go", { pi: t.pi, model: t.model, onSessionCreated: created })).rejects.toThrow("Explicit :fast is unsupported");
		expect(created).not.toHaveBeenCalled();
		expect(t.requests).toHaveLength(0);
	} finally { for (const child of children) child.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it("discovered interactive fast copies cannot override the always-retained fixed child policy", async () => {
	const t = await createFastSession([], { "anthropic-beta": beta });
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	const ext = join(t.cwd, "fast", "index.ts");
	mkdirSync(join(t.cwd, "fast"));
	writeFileSync(ext, `export { default } from ${JSON.stringify(resolve("extensions/fast/index.ts"))};`);
	registerAgents(new Map([["fixed-off", { ...config("fixed-off", "anthropic/claude-opus-4-8"), extensions: [ext] }]]));
	const children: AgentSession[] = [];
	try {
		await runAgent(t.ctx, "fixed-off", "go", {
			pi: t.pi,
			onSessionCreated: (session) => {
				children.push(session);
				session.sessionManager.appendCustomEntry("fast-policy", { version: 1, mode: "kuafu", source: "user", enabled: true });
			},
		});
		expect(t.requests[0].payload.speed).toBeUndefined();
		expect(t.requests[0].headers.get("anthropic-beta") ?? "").not.toContain(beta);
	} finally { for (const child of children) child.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it.each([false, true])("manager captures effective Fast at creation, completion and resume (fast=%s)", async fast => {
	const t = await createFastSession();
	const manager = new AgentManager();
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	registerAgents(new Map([["capture", config("capture", `anthropic/claude-opus-4-8${fast ? ":fast" : ""}`)]]));
	try {
		const { id, record } = await manager.spawnAndWait(t.pi, t.ctx, "capture", "go", {
			description: "capture", isolated: true,
			onSessionCreated: () => expect(manager.listAgents()[0].invocation?.fast).toBe(fast),
		});
		expect(record.invocation).toMatchObject({ modelName: "anthropic/claude-opus-4-8", fast });
		registerAgents(new Map([["capture", config("capture", `anthropic/claude-opus-4-8${fast ? "" : ":fast"}`)]]));
		await manager.resume(id, "again");
		expect(record.invocation?.fast).toBe(fast);
	} finally { manager.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it("widget reads real session thinking and retained Fast instead of stale invocation metadata", async () => {
	const t = await createFastSession();
	const manager = new AgentManager();
	const widget = new AgentWidget(manager, new Map());
	try {
		t.session.setThinkingLevel("off");
		const policy = { enabled: true, usingOAuth: false };
		sessionFastPolicies.set(t.session, policy);
		const record: AgentRecord = {
			id: "live", type: "general-purpose", description: "live", status: "running",
			toolUses: 0, startedAt: Date.now(), compactionCount: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, session: t.session,
			invocation: { modelName: "stale/model", thinking: "high", fast: false },
		};
		vi.spyOn(manager, "listAgents").mockReturnValue([record]);
		let factory: Exclude<Parameters<UICtx["setWidget"]>[1], undefined> | undefined;
		widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
		widget.update();
		if (!factory) throw new Error("Widget was not registered");
		const component = factory({ terminal: { columns: 240 } }, { fg: (_color, text) => text, bold: text => text });
		expect(component.render().join("\n")).toContain("anthropic/claude-opus-4-8:off:fast");
		policy.enabled = false;
		expect(component.render().join("\n")).toContain("anthropic/claude-opus-4-8:off");
		expect(component.render().join("\n")).not.toMatch(/:fast|stale\/model|thinking: high/);
	} finally { widget.dispose(); manager.dispose(); t.dispose(); }
});
