import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectOverlays, readPromptVariantDir, selectPromptBody } from "../prompt-variants.js";

describe("readPromptVariantDir", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prompt-variants-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("returns undefined when the default is missing", () => {
		writeFileSync(join(dir, "gpt.md"), "Variant");
		expect(readPromptVariantDir(dir)).toBeUndefined();
	});

	it("propagates read failures for an existing default", () => {
		mkdirSync(join(dir, "default.md"));
		expect(() => readPromptVariantDir(dir)).toThrow(/EISDIR/);
	});

	it("preserves raw default content and trims variant bodies", () => {
		const content = "---\nmodel: fixture/model\n---\n\nDefault body.\n";
		writeFileSync(join(dir, "default.md"), content);
		writeFileSync(join(dir, "gpt.md"), "  GPT body.\n");
		writeFileSync(join(dir, "gemini.md"), "\nGemini overlay.  ");
		expect(readPromptVariantDir(dir)).toEqual({
			defaultPath: join(dir, "default.md"),
			defaultContent: content,
			variants: { gpt: "GPT body.", gemini: "Gemini overlay." },
		});
	});

	it("omits missing variants", () => {
		writeFileSync(join(dir, "default.md"), "Default body.");
		expect(readPromptVariantDir(dir)?.variants).toEqual({});
	});

	it("omits empty variants", () => {
		writeFileSync(join(dir, "default.md"), "Default body.");
		writeFileSync(join(dir, "gpt.md"), " \n\t");
		writeFileSync(join(dir, "gemini.md"), " \n");
		expect(readPromptVariantDir(dir)?.variants).toEqual({});
	});
	it("propagates read failures for an existing variant", () => {
		writeFileSync(join(dir, "default.md"), "DEFAULT_BODY");
		mkdirSync(join(dir, "gemini.md"));
		expect(() => readPromptVariantDir(dir)).toThrow(/EISDIR/);
	});
});

describe("selectPromptBody", () => {
	const variants = { gpt: "Replacement", gemini: "Overlay" };

	it("replaces the body for GPT", () => {
		expect(selectPromptBody("Default", variants, "gpt")).toBe("Replacement");
	});

	it("injects the overlay for Gemini", () => {
		expect(selectPromptBody("Before\n<critical>After", variants, "gemini"))
			.toBe("Before\nOverlay\n\n<critical>After");
	});

	it("passes through the default body despite available variants", () => {
		expect(selectPromptBody("Default", variants, "default")).toBe("Default");
	});

	it.each(["gpt", "gemini"] as const)("keeps the default body when the %s variant is absent", (family) => {
		expect(selectPromptBody("Default", {}, family)).toBe("Default");
	});
});

describe("injectOverlays", () => {
	it("inserts before the first critical section, preferring it over role", () => {
		expect(injectOverlays("<role>Role</role>\n<critical>First</critical>\n<critical>Second", "Overlay"))
			.toBe("<role>Role</role>\nOverlay\n\n<critical>First</critical>\n<critical>Second");
	});

	it("inserts after role when there is no critical section", () => {
		expect(injectOverlays("<role>Role</role>\nBody", "Overlay"))
			.toBe("<role>Role</role>\n\nOverlay\nBody");
	});

	it("appends when neither anchor exists", () => {
		expect(injectOverlays("Plain body", "Overlay")).toBe("Plain body\n\nOverlay");
	});
});
