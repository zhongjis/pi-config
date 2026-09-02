import { describe, expect, it } from "vitest";
import { beforeExampleBlock } from "../prompt.js";

describe("caveman prompt", () => {

	it("trims text before an Example block even when Example starts the section", () => {
		expect(beforeExampleBlock("Example: keep out\n\nUseful detail")).toBe("");
		expect(beforeExampleBlock("Keep this\n\nExample: keep out")).toBe("Keep this");
	});
});
