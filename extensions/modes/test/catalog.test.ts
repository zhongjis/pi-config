import { expect, it } from "vitest";
import { MODES, MODE_META, MODE_COLORS, SKILL_GATED_MODES } from "../src/constants.js";

it("catalog contains only the three retained modes", () => {
	expect(MODES).toEqual(["kuafu", "fuxi", "houtu"]);
	expect(Object.keys(MODE_META)).toEqual(MODES);
	expect(Object.keys(MODE_COLORS)).toEqual(MODES);
	expect([...SKILL_GATED_MODES]).toEqual(["fuxi"]);
});
