import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalHome: string | undefined;
let tempHome = "";

async function importFreshState() {
	vi.resetModules();
	return import("../state.js");
}

describe("caveman state", () => {
	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await mkdtemp(join(tmpdir(), "caveman-state-home-"));
		process.env.HOME = tempHome;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		if (tempHome) {
			await rm(tempHome, { force: true, recursive: true });
		}
	});

	it("restores latest valid session level over config default", async () => {
		const state = await importFreshState();

		const restored = state.restoreCavemanState({
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "caveman-level", data: { level: "ultra" } },
					{ type: "custom", customType: "caveman-level", data: { level: "lite" } },
				],
			},
		});

		expect(restored.sessionLevel).toBe("lite");
		expect(state.getCavemanEffectiveLevel()).toBe("lite");
	});

	it("persists session override entries and reports unchanged repeats", async () => {
		const state = await importFreshState();
		state.restoreCavemanState({ sessionManager: { getBranch: () => [] } });
		const writer = { appendEntry: vi.fn() };

		expect(state.setCavemanSessionLevel(writer, "full")).toEqual({ changed: true, level: "full" });
		expect(writer.appendEntry).toHaveBeenCalledWith("caveman-level", { level: "full" });
		expect(state.setCavemanSessionLevel(writer, "full")).toEqual({ changed: false, level: "full" });
		expect(writer.appendEntry).toHaveBeenCalledTimes(1);
	});
});
