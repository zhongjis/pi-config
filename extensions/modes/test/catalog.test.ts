import { expect, it } from "vitest";
import { MODES, MODE_META, MODE_COLORS } from "../src/constants.js";

it("mode metadata and colors cover every mode", () => {
	expect(Object.keys(MODE_META)).toEqual(MODES);
	expect(Object.keys(MODE_COLORS)).toEqual(MODES);
});
