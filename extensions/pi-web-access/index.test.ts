import { describe, expect, it, beforeEach, vi } from "vitest";
import { createMockContext } from "../../test/fixtures/mock-context.js";
import { createMockPi } from "../../test/fixtures/mock-pi.js";
import initWebAccess, {
	normalizeCuratorTimeoutSeconds,
	normalizeProviderInput,
	normalizeQueryList,
	resolveWorkflow,
} from "./index.js";

const searchMock = vi.hoisted(() => vi.fn());

vi.mock("./gemini-search.js", () => ({
	search: searchMock,
}));

describe("pi-web-access config and schema normalization", () => {
	beforeEach(() => {
		searchMock.mockReset();
	});

	it("normalizes provider, workflow, query list, and curator timeout inputs", () => {
		expect(normalizeProviderInput(undefined)).toBeUndefined();
		expect(normalizeProviderInput(" ExA ")).toBe("exa");
		expect(normalizeProviderInput("unknown")).toBe("auto");
		expect(normalizeProviderInput(42)).toBe("auto");

		expect(resolveWorkflow("none", true)).toBe("none");
		expect(resolveWorkflow(" NONE ", true)).toBe("none");
		expect(resolveWorkflow("summary-review", true)).toBe("summary-review");
		expect(resolveWorkflow(undefined, false)).toBe("none");

		expect(normalizeQueryList(["  alpha  ", "", 1, "beta"])).toEqual(["alpha", "beta"]);
		expect(normalizeCuratorTimeoutSeconds(12.9)).toBe(12);
		expect(normalizeCuratorTimeoutSeconds(0)).toBeUndefined();
		expect(normalizeCuratorTimeoutSeconds(700)).toBe(600);
	});

	it("registers web_search provider and workflow schemas with Pi 0.70 TypeBox", () => {
		const mock = createMockPi();
		initWebAccess(mock.pi as never);

		const webSearch = mock.tools.get("web_search") as {
			parameters: { properties: Record<string, { enum?: string[]; type?: string; items?: { type?: string } }> };
		};

		expect(webSearch.parameters.properties.provider.enum).toEqual(["auto", "perplexity", "gemini", "exa"]);
		expect(webSearch.parameters.properties.workflow.enum).toEqual(["none", "summary-review"]);
		expect(webSearch.parameters.properties.queries).toMatchObject({
			type: "array",
			items: { type: "string" },
		});
	});

	it("parses workflow and provider options before executing non-curated searches", async () => {
		searchMock.mockResolvedValue({
			answer: "answer",
			results: [{ title: "Example", url: "https://example.com" }],
			provider: "exa",
		});
		const mock = createMockPi();
		initWebAccess(mock.pi as never);
		const webSearch = mock.tools.get("web_search") as {
			execute: (...args: unknown[]) => Promise<{ details: { queries: string[]; successfulQueries: number } }>;
		};

		const result = await webSearch.execute(
			"call-1",
			{ queries: ["  alpha  ", "beta"], provider: "unknown", workflow: " none " },
			undefined,
			undefined,
			createMockContext(),
		);

		expect(searchMock).toHaveBeenCalledTimes(2);
		expect(searchMock).toHaveBeenNthCalledWith(1, "alpha", expect.objectContaining({ provider: "auto" }));
		expect(searchMock).toHaveBeenNthCalledWith(2, "beta", expect.objectContaining({ provider: "auto" }));
		expect(result.details).toMatchObject({
			queries: ["alpha", "beta"],
			successfulQueries: 2,
		});
	});
});
