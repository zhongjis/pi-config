// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

import { describe, expect, it } from "vitest";
import {
	buildInputKey,
	cleanLine,
	cleanSingleLine,
	isWideChar,
	limitWords,
	positiveInt,
	similarity,
	unitRatio,
	wrapText,
} from "./content.js";

describe("recap content helpers", () => {
	it("cleans recap output", () => {
		expect(cleanLine("## 会话回顾")).toBe("会话回顾");
		expect(cleanLine("3 files changed and the build is green")).toBe("3 files changed and the build is green");
		expect(cleanLine("1.5x faster rendering landed")).toBe("1.5x faster rendering landed");
		expect(cleanLine("2024. roadmap is done")).toBe("2024. roadmap is done");
		expect(cleanLine("-3 items removed")).toBe("-3 items removed");
		expect(cleanLine("100. item")).toBe("item");
		expect(cleanLine("※ recap: 修复了标题问题")).toBe("修复了标题问题");
		expect(cleanLine("see [docs](https://example.com)")).toBe("see docs");
	});

	it("selects the first usable recap line", () => {
		expect(cleanSingleLine("Here is a recap of the session:\n用户正在测试 recap 生成")).toBe("用户正在测试 recap 生成");
		expect(cleanSingleLine("## 标题\n实际内容在这")).toBe("实际内容在这");
		expect(cleanSingleLine("修复了 bug。")).toBe("修复了 bug");
	});

	it("limits words and measures symmetric similarity", () => {
		expect(limitWords("a b c d", 2)).toBe("a b…");
		expect(similarity("a b c", "a b c")).toBe(1);
		expect(similarity("a b", "a b c")).toBe(2 / 3);
		expect(similarity("", "a b")).toBe(0);
	});

	it("validates numeric recap settings", () => {
		expect(positiveInt(2.9, 3)).toBe(2);
		expect(positiveInt(0, 3)).toBe(3);
		expect(unitRatio(0.5, 0.7)).toBe(0.5);
		expect(unitRatio(1.5, 0.7)).toBe(0.7);
	});

	it("creates stable input keys and terminal-width wrapping", () => {
		const rounds = [
			{ user: "first", assistant: "reply", tools: ["read"] },
			{ user: "second message", assistant: "another reply", tools: [] },
		];
		expect(buildInputKey("the goal", rounds)).toBe(buildInputKey("the goal", rounds));
		expect(wrapText("※abc", 3)).toEqual(["※a", "bc"]);
		expect(wrapText("中文", 2)).toEqual(["中", "文"]);
		expect(isWideChar("※")).toBe(true);
		expect(isWideChar("a")).toBe(false);
	});
});
