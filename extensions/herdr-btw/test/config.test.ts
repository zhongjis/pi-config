import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	parseConfig,
	applyConfigCommand,
	formatConfig,
	CONFIG_COMMAND_USAGE,
} from "../src/config.ts";
import { createPayload, isBtwPayload, PAYLOAD_VERSION } from "../src/core.ts";

// S1: DEFAULT_CONFIG.closeOnExit and parseConfig
describe("parseConfig — closeOnExit", () => {
	it("DEFAULT_CONFIG.closeOnExit is false", () => {
		expect(DEFAULT_CONFIG.closeOnExit).toBe(false);
	});

	it("parseConfig({ autoSubmit: true, closeOnExit: true }) returns correct flags", () => {
		const config = parseConfig({ autoSubmit: true, closeOnExit: true });
		expect(config.autoSubmit).toBe(true);
		expect(config.closeOnExit).toBe(true);
	});

	it("parseConfig({}) yields closeOnExit === false", () => {
		const config = parseConfig({});
		expect(config.closeOnExit).toBe(false);
	});

	it('parseConfig({ closeOnExit: "yes" }) throws', () => {
		expect(() => parseConfig({ closeOnExit: "yes" })).toThrow("closeOnExit must be true or false");
	});
});

// S2: applyConfigCommand and formatConfig
describe("applyConfigCommand — close-on-exit", () => {
	it('"close-on-exit on" saves with closeOnExit: true', () => {
		const result = applyConfigCommand(DEFAULT_CONFIG, "close-on-exit on");
		expect(result.action).toBe("save");
		expect(result.config.closeOnExit).toBe(true);
	});

	it('"close-on-exit off" saves with closeOnExit: false', () => {
		const result = applyConfigCommand({ ...DEFAULT_CONFIG, closeOnExit: true }, "close-on-exit off");
		expect(result.action).toBe("save");
		expect(result.config.closeOnExit).toBe(false);
	});

	it('"close-on-exit bogus" throws CONFIG_COMMAND_USAGE', () => {
		expect(() => applyConfigCommand(DEFAULT_CONFIG, "close-on-exit bogus")).toThrow(CONFIG_COMMAND_USAGE);
	});

	it("formatConfig includes close-on-exit: on when true", () => {
		const str = formatConfig({ ...DEFAULT_CONFIG, closeOnExit: true });
		expect(str).toContain("close-on-exit: on");
	});

	it("formatConfig includes close-on-exit: off when false", () => {
		const str = formatConfig({ ...DEFAULT_CONFIG, closeOnExit: false });
		expect(str).toContain("close-on-exit: off");
	});
});

// S3: PAYLOAD_VERSION and isBtwPayload
const validConfig = {
	...DEFAULT_CONFIG,
	closeOnExit: false,
};

const validPayloadOptions = {
	createdAt: new Date().toISOString(),
	parentSessionId: "test-session-123",
	parentPaneId: null,
	metadata: {
		generatedAt: new Date().toISOString(),
		cwd: "/tmp",
		session: "test-session",
		model: "anthropic/claude-opus-4-5",
	},
	parentSystemPrompt: null,
	parentActiveTools: [],
	parentThinkingLevel: "medium",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	draftQuestion: "",
	config: validConfig,
};

describe("PAYLOAD_VERSION and isBtwPayload", () => {
	it("PAYLOAD_VERSION === 5", () => {
		expect(PAYLOAD_VERSION).toBe(5);
	});

	it("isBtwPayload returns true for valid payload with closeOnExit", () => {
		const payload = createPayload(validPayloadOptions);
		expect(isBtwPayload(payload)).toBe(true);
	});

	it("isBtwPayload returns false when closeOnExit is missing", () => {
		const payload = createPayload(validPayloadOptions);
		const mutated = { ...payload, config: { ...payload.config } };
		delete (mutated.config as Record<string, unknown>).closeOnExit;
		expect(isBtwPayload(mutated)).toBe(false);
	});

	it("isBtwPayload returns false when closeOnExit is non-boolean", () => {
		const payload = createPayload(validPayloadOptions);
		const mutated = { ...payload, config: { ...payload.config, closeOnExit: "yes" } };
		expect(isBtwPayload(mutated)).toBe(false);
	});
});

// S4: regression — existing keys still honored
describe("regression — existing config keys", () => {
	it("parseConfig still honors existing keys", () => {
		const config = parseConfig({ tools: "read-only", split: "down" });
		expect(config.tools).toBe("read-only");
		expect(config.split).toBe("down");
	});

	it("formatConfig(DEFAULT_CONFIG) contains all existing segments", () => {
		const str = formatConfig(DEFAULT_CONFIG);
		expect(str).toContain("auto-submit");
		expect(str).toContain("model");
		expect(str).toContain("thinking");
		expect(str).toContain("tools");
		expect(str).toContain("split");
	});
});
