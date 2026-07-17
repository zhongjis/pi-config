import { expect, it } from "vitest";
import { extractInlineEditorLines, stripAnsi } from "../src/editor-render.js";

it("removes the stock editor frame without disturbing its cursor", () => {
	const cursorMarker = "\x1b_pi:c\x07";
	const lines = [
		"\x1b[33m────────────\x1b[39m",
		`draft${cursorMarker}\x1b[7m \x1b[0m      `,
		"\x1b[33m────────────\x1b[39m",
	];

	const extracted = extractInlineEditorLines(lines);
	expect(extracted.length).toBe(1);
	expect(extracted[0]!).toMatch(/pi:c/);
	expect(stripAnsi(extracted[0]!).trim()).toBe("draft");
});

it("unwraps composed editor side borders and padding", () => {
	const lines = [
		"\x1b[33m╭──── model ─╮\x1b[39m",
		"\x1b[33m│\x1b[39m draft\x1b_pi:c\x07\x1b[7m \x1b[0m      \x1b[33m│\x1b[39m",
		"\x1b[33m╰──── 90% ───╯\x1b[39m",
	];

	const extracted = extractInlineEditorLines(lines, 1);
	expect(extracted.length).toBe(1);
	expect(stripAnsi(extracted[0]!).trim()).toBe("draft");
	expect(stripAnsi(extracted[0]!)).not.toMatch(/[│╭╮╰╯]/);
});

it("unwraps nested side frames even when a composer pads outside them", () => {
	const extracted = extractInlineEditorLines([
		"╭────────────╮",
		"  │ │ draft       │ │  ",
		"╰────────────╯",
	], 1);

	expect(stripAnsi(extracted[0]!).trim()).toBe("draft");
	expect(stripAnsi(extracted[0]!)).not.toMatch(/[│┃]/);
});

it("keeps autocomplete rows below the editor body", () => {
	const extracted = extractInlineEditorLines([
		"────────────",
		"@iss        ",
		"────────────",
		"#123 issue  ",
		"#456 issue  ",
	]);

	expect(extracted.map((line: string) => stripAnsi(line).trim())).toEqual(["@iss", "#123 issue", "#456 issue"]);
});

it("does not mistake short horizontal user text for the bottom frame", () => {
	const extracted = extractInlineEditorLines([
		"────────────",
		"---         ",
		"────────────",
	]);

	expect(stripAnsi(extracted[0]!).trim()).toBe("---");
});

it("leaves frameless custom editor output intact", () => {
	expect(extractInlineEditorLines(["custom editor"])).toEqual(["custom editor"]);
});
