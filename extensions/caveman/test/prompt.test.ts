import { describe, expect, it } from "vitest";
import { buildInjectedPrompt, loadRuntimePrompt } from "../prompt.js";

describe("caveman prompt", () => {
	it("loads current upstream rules into the normalized runtime prompt", () => {
		const prompt = loadRuntimePrompt();

		expect(prompt.source.raw).toContain("Last synced: 2026-06-29, commit 25d22f864ad68cc447a4cb93aefde918aa4aec9f");
		expect(prompt.source.sections.Rules).toContain("Preserve user's dominant language");
		expect(prompt.source.sections.Rules).toContain("No self-reference");
		expect(prompt.source.sections.Rules).toContain("No tool-call narration");
		expect(prompt.source.sections["Auto-Clarity"]).toContain("Compression itself creates technical ambiguity");
		expect(prompt.source.sections.Intensity).toContain("wenyan-full");
	});

	it("injects supported-level rules without advertising unimplemented stop commands", () => {
		const injected = buildInjectedPrompt("ultra");

		expect(injected).toContain("Active level: ultra.");
		expect(injected).toContain("never real code symbols/function names");
		expect(injected).toContain("Preserve user's dominant language");
		expect(injected).toContain("No self-reference");
		expect(injected).toContain("No tool-call narration");
		expect(injected).toContain("Compression itself creates technical ambiguity");
		expect(injected).not.toContain("stop caveman");
		expect(injected).not.toContain("normal mode");
	});
});
