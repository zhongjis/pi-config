import { describe, expect, it, vi } from "vitest";
import { derivePlanTitleFromMarkdown } from "../src/plan-storage.js";

// config-loader.test.ts — tests config parsing edge cases via plan-storage's derivePlanTitleFromMarkdown
// (config-loader itself requires filesystem access; we test the pure parsing functions here)

describe("derivePlanTitleFromMarkdown", () => {
	it("extracts H1 title from markdown", () => {
		expect(derivePlanTitleFromMarkdown("# My Plan\n\n- item 1")).toBe("My Plan");
	});

	it("returns undefined for no heading", () => {
		expect(derivePlanTitleFromMarkdown("No heading here\n\nJust text")).toBeUndefined();
	});

	it("handles heading with trailing hashes", () => {
		expect(derivePlanTitleFromMarkdown("# Title ##\n\nBody")).toBe("Title");
	});

	it("ignores H2 and deeper headings for title", () => {
		expect(derivePlanTitleFromMarkdown("## Subtitle\n\n- items")).toBeUndefined();
	});

	it("handles leading whitespace before heading", () => {
		expect(derivePlanTitleFromMarkdown("   # Indented Title\n\nBody")).toBe("Indented Title");
	});

	it("returns undefined for empty string", () => {
		expect(derivePlanTitleFromMarkdown("")).toBeUndefined();
	});
});
