import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Dev types must match the Pi that actually runs extensions. The runtime Pi comes
// from Nix (~/personal/nix-config, llm-agents input); the pnpm catalog is edited to follow it.
const ROOT = resolve(__dirname, "../..");
const PI_PACKAGES = ["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core"].map((name) => `@earendil-works/${name}`);

function readCatalog(): Record<string, string> {
	const lines = readFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "utf8").split("\n");
	const start = lines.findIndex((line) => /^catalog:\s*$/.test(line));
	const catalog: Record<string, string> = {};
	for (const line of lines.slice(start + 1)) {
		if (line.trim() && !/^\s/.test(line)) break;
		const match = /^\s+"?([^":\s]+)"?:\s*(\S+)\s*$/.exec(line);
		if (match) catalog[match[1]] = match[2];
	}
	return catalog;
}

function runtimePiVersion(): string | undefined {
	try {
		return execFileSync("pi", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

describe("pi dev dependency catalog", () => {
	const catalog = readCatalog();
	const piVersion = runtimePiVersion();

	it("pins every pi package to one version", () => {
		expect(new Set(PI_PACKAGES.map((name) => catalog[name])).size).toBe(1);
		expect(catalog["@earendil-works/pi-coding-agent"]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it.skipIf(!piVersion)("matches the runtime pi on PATH", () => {
		expect(catalog["@earendil-works/pi-coding-agent"]).toBe(piVersion);
	});

	it("pins typebox to the version pi-coding-agent ships", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(catalog.typebox).toBe(manifest.dependencies?.typebox);
	});
});
