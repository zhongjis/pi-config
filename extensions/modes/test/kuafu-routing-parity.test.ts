import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// test dir → modes → extensions → repo root
const KUAFU_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../modes/kuafu");

function routingLadder(file: string): string[] {
	const body = readFileSync(resolve(KUAFU_DIR, file), "utf8");
	return [...body.matchAll(/^- (?:Routing ladder: )?([A-Z][a-z]+) = /gm)].map((match) => match[1]).sort();
}

describe("Kua Fu routing ladder", () => {
	it("lists the same agents in the default and GPT bodies", () => {
		expect(routingLadder("mode.md")).toEqual(routingLadder("gpt.md"));
	});
});
