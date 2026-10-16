import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createFastSession } from "../../../test/integration/helpers/fast-session.js";
import { AgentManager } from "../src/agent-manager.js";
import { openSession } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { execute } from "../src/execution.js";
import { getSessionFast } from "../src/session-fast.js";
import type { AgentConfig } from "../src/types.js";

const beta = "fast-mode-2026-02-01";
function config(name: string, model: string): AgentConfig {
	return { name, description: name, model, extensionRules: [], toolRules: [], discoverSkills: false, preloadSkills: [], systemPrompt: "test", promptMode: "replace" };
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
		const results = await Promise.all(["fast-on", "fast-off"].map(async name => {
			const opened = await openSession(t.ctx, name, { pi: t.pi, isolated: true, model: t.model });
			children.push(opened.session);
			await execute(opened.session, (opened.promptPrefix ?? "") + name);
			return opened;
		}));
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
		const resumed = await execute(results[0].session, "again");
		expect(resumed.text).toBe("ok");
		expect(t.requests.at(-1)?.payload.speed).toBe("fast");
		expect(getSessionFast(results[0].session)).toBe(true);
	} finally { for (const child of children) child.dispose(); registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it("unsupported selected fast fails before child creation rather than choosing fallback", async () => {
	const t = await createFastSession();
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	registerAgents(new Map([["unsupported", config("unsupported", "anthropic/claude-sonnet-4-6:fast,anthropic/claude-opus-4-8:fast")]]));

	try {
		await expect(openSession(t.ctx, "unsupported", { pi: t.pi, model: t.model })).rejects.toThrow("Explicit :fast is unsupported");
		expect(t.requests).toHaveLength(0);
	} finally { registerAgents(new Map()); vi.unstubAllEnvs(); t.dispose(); }
});

it("discovered interactive fast copies cannot override the always-retained fixed child policy", async () => {
	const t = await createFastSession([], { "anthropic-beta": beta });
	vi.stubEnv("PI_CODING_AGENT_DIR", t.cwd);
	// A discovered global `fast` extension that the child's rules explicitly select.
	const ext = join(t.cwd, "extensions", "fast", "index.ts");
	mkdirSync(join(t.cwd, "extensions", "fast"), { recursive: true });
	writeFileSync(ext, `export { default } from ${JSON.stringify(resolve("extensions/fast/index.ts"))};`);
	registerAgents(new Map([["fixed-off", { ...config("fixed-off", "anthropic/claude-opus-4-8"), extensionRules: [{ sign: "+", selector: "fast" }] }]]));
	const children: AgentSession[] = [];
	try {
		const { session, promptPrefix } = await openSession(t.ctx, "fixed-off", { pi: t.pi });
		children.push(session);
		session.sessionManager.appendCustomEntry("fast-policy", { version: 1, mode: "kuafu", source: "user", enabled: true });
		await execute(session, (promptPrefix ?? "") + "go");
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
