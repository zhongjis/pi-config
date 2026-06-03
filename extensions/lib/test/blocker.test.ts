import { describe, expect, it } from "vitest";
import { filterBlockers, type BlockerStore } from "../blocker.js";

describe("filterBlockers", () => {
	it("groups completed blockers as satisfied", () => {
		const store = {
			get(id: string) {
				return id === "done" ? { status: "completed" } : undefined;
			},
		} satisfies BlockerStore;

		expect(filterBlockers(["done"], store)).toEqual({
			satisfied: ["done"],
			unsatisfied: [],
		});
	});

	it("groups pending blockers as unsatisfied", () => {
		const store = {
			get(id: string) {
				return id === "pending" ? { status: "pending" } : undefined;
			},
		} satisfies BlockerStore;

		expect(filterBlockers(["pending"], store)).toEqual({
			satisfied: [],
			unsatisfied: ["pending"],
		});
	});

	it("groups missing blockers as unsatisfied", () => {
		const store = {
			get() {
				return undefined;
			},
		} satisfies BlockerStore;

		expect(filterBlockers(["missing"], store)).toEqual({
			satisfied: [],
			unsatisfied: ["missing"],
		});
	});
});
