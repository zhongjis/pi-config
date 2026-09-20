// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeRecap, resolveRecapModelCandidates } from "./model.js";

type TestModel = { provider: string; id: string; name: string };

function model(provider: string, id: string): TestModel {
	return { provider, id, name: id };
}

function writeConfig(agentDir: string, chain: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "tool_models.json"),
		JSON.stringify({ version: 1, roles: { "summary.session": chain } }),
	);
}

function makeContext(cwd: string, available: TestModel[], session?: TestModel) {
	return {
		cwd,
		model: session,
		modelRegistry: {
			find(provider: string, id: string) {
				return available.find((entry) => entry.provider === provider && entry.id === id);
			},
			getAll() {
				return available;
			},
			getAvailable() {
				return available;
			},
			hasConfiguredAuth(candidate: TestModel) {
				return available.some((entry) => entry.provider === candidate.provider && entry.id === candidate.id);
			},
			complete: vi.fn(),
		},
	};
}

describe("recap model selection", () => {
	let root = "";
	let agentDir = "";
	let cwd = "";
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "recap-model-test-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { force: true, recursive: true });
	});

	it("resolves every available configured candidate in chain order, then the session model", () => {
		writeConfig(agentDir, "fixture/first:low,fixture/missing,fixture/second:medium");
		const session = model("session", "current");
		const ctx = makeContext(cwd, [model("fixture", "first"), model("fixture", "second"), session], session);

		expect(resolveRecapModelCandidates(ctx)).toEqual([
			{ model: model("fixture", "first"), thinkingLevel: "low" },
			{ model: model("fixture", "second"), thinkingLevel: "medium" },
			{ model: session },
		]);
	});

	it("deduplicates configured and session candidates by provider and id", () => {
		writeConfig(agentDir, "fixture/first,fixture/first");
		const session = model("fixture", "first");
		const ctx = makeContext(cwd, [session], session);

		expect(resolveRecapModelCandidates(ctx)).toEqual([{ model: session }]);
	});

	it("falls through runtime failures and provider error responses", async () => {
		const first = model("fixture", "first");
		const second = model("fixture", "second");
		const complete = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider unavailable"))
			.mockResolvedValueOnce({ stopReason: "error", content: [] })
			.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "recap" }] });

		await expect(completeRecap(complete, [{ model: first }, { model: second }, { model: model("session", "current") }], {})).resolves.toMatchObject({ kind: "completed" });
		expect(complete.mock.calls.map(([candidate]) => candidate.model)).toEqual([first, second, model("session", "current")]);
	});

	it("uses the session candidate after configured candidates fail", async () => {
		const configured = model("fixture", "configured");
		const session = model("session", "current");
		const complete = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ stopReason: "stop", content: [] });

		await expect(completeRecap(complete, [{ model: configured }, { model: session }], {})).resolves.toMatchObject({ kind: "completed" });
		expect(complete.mock.calls.map(([candidate]) => candidate.model)).toEqual([configured, session]);
	});

	it("stops immediately when completion aborts", async () => {
		const first = model("fixture", "first");
		const second = model("fixture", "second");
		const complete = vi.fn().mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "AbortError" }));

		await expect(completeRecap(complete, [{ model: first }, { model: second }], {})).resolves.toEqual({ kind: "skipped", reason: "aborted" });
		expect(complete).toHaveBeenCalledTimes(1);
	});
	it("passes each candidate thinking level to the completion attempt", async () => {
		const first: { model: TestModel; thinkingLevel: "low" } = { model: model("fixture", "first"), thinkingLevel: "low" };
		const fallback: { model: TestModel; thinkingLevel: "medium" } = { model: model("fixture", "fallback"), thinkingLevel: "medium" };
		const complete = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ stopReason: "stop", content: [] });

		await completeRecap(complete, [first, fallback], {});

		expect(complete.mock.calls.map(([candidate]) => candidate.thinkingLevel)).toEqual(["low", "medium"]);
	});

	it("reports one aggregate warning after every candidate fails", async () => {
		const complete = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ stopReason: "error", content: [] });
		const warn = vi.fn();

		await expect(completeRecap(complete, [{ model: model("fixture", "first") }, { model: model("fixture", "second") }], {}, undefined, warn)).resolves.toEqual({ kind: "skipped", reason: "generation failed" });

		expect(warn).toHaveBeenCalledTimes(1);
	});

});
