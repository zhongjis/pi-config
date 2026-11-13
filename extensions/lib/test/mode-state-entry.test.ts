import { describe, expect, it } from "vitest";
import { findLatestModeStateEntry, type ModeStateEntryLike } from "../mode-state-entry.js";

const mode = (data?: unknown): ModeStateEntryLike => ({ type: "custom", customType: "agent-mode", data });

describe("findLatestModeStateEntry", () => {
	it("returns undefined without a persisted agent-mode custom entry", () => {
		expect(findLatestModeStateEntry([])).toBeUndefined();
		expect(
			findLatestModeStateEntry([
				{ type: "message" },
				{ type: "custom", customType: "fast-policy", data: { mode: "fuxi" } },
				{ type: "custom_message", customType: "agent-mode", data: { mode: "fuxi" } },
			]),
		).toBeUndefined();
	});

	it("returns the latest agent-mode entry unvalidated", () => {
		const older = mode({ mode: "fuxi" });
		const latest = mode({ mode: 42 });
		expect(
			findLatestModeStateEntry([
				older,
				{ type: "custom", customType: "fast-policy" },
				latest,
				{ type: "message" },
			]),
		).toBe(latest);

		const empty = mode();
		expect(findLatestModeStateEntry([older, empty])).toBe(empty);
	});

	it("selects the latest accepted agent-mode entry", () => {
		const older = mode({ mode: "fuxi" });
		const rejected = mode({ mode: "  " });
		expect(findLatestModeStateEntry([older, rejected], (entry) => entry !== rejected)).toBe(older);
	});

	it("throws on a nullish entry newer than the match unless accept rejects it", () => {
		const entries = [mode({ mode: "fuxi" }), null as never];
		expect(() => findLatestModeStateEntry(entries)).toThrow(TypeError);
		expect(findLatestModeStateEntry(entries, (entry) => entry != null)).toBe(entries[0]);
	});
});
