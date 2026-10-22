import { describe, expect, it } from "vitest";
import {
	getErrorText,
	isAccessDeniedError,
	isQuotaError,
	isQuotaOrRateLimitError,
	isRateLimitError,
} from "../provider-errors.js";

describe("getErrorText", () => {
	it("returns empty string for non-objects", () => {
		expect(getErrorText(null)).toBe("");
		expect(getErrorText(undefined)).toBe("");
		expect(getErrorText("a string")).toBe("");
		expect(getErrorText(42)).toBe("");
	});

	it("extracts and lowercases top-level message", () => {
		expect(getErrorText({ message: "Rate LIMIT hit" })).toContain("rate limit");
	});

	it("extracts errorMessage", () => {
		expect(getErrorText({ errorMessage: "QUOTA exhausted" })).toContain("quota");
	});

	it("walks nested error.errorMessage and error.message", () => {
		expect(getErrorText({ error: { errorMessage: "billing limit" } })).toContain("billing");
		expect(getErrorText({ error: { message: "too many requests" } })).toContain("too many requests");
	});

	it("walks cause.message", () => {
		expect(getErrorText({ cause: { message: "spend limit reached" } })).toContain("spend limit");
	});

	it("concatenates multiple sources", () => {
		const msg = getErrorText({ message: "outer", error: { errorMessage: "inner" } });
		expect(msg).toContain("outer");
		expect(msg).toContain("inner");
	});
});

describe("structured provider errors", () => {
	it.each([
		{ details: { errorCode: "usage_limit_reached" }, text: "Request failed", expected: [true, false, false] },
		{ details: { status: 429, errorCode: "usage_not_included" }, text: "Rate limit", expected: [true, false, false] },
		{ details: { status: 402, errorCode: "rate_limit_exceeded" }, text: "Quota exhausted", expected: [false, true, false] },
		{ details: { status: 429, errorCode: "unknown" }, text: "Request failed", expected: [false, true, false] },
		{ details: { status: 400, errorCode: "unknown" }, text: "Quota exhausted", expected: [true, false, false] },
		{ details: { status: 403 }, text: "Credit exhausted", expected: [false, false, true] },
		{ details: { errorType: "permission_error" }, text: "Request failed", expected: [false, false, true] },
	])("classifies $details before wording", ({ details, text, expected }) => {
		const error = {
			errorMessage: text,
			diagnostics: [{ type: "provider_response_failure", timestamp: 0, details }],
		};
		expect([isQuotaError(error), isRateLimitError(error), isAccessDeniedError(error)]).toEqual(expected);
	});

	it("ignores unrelated diagnostics", () => {
		expect(isQuotaOrRateLimitError({
			diagnostics: [{ type: "provider_transport_failure", details: { status: 429, errorCode: "usage_limit_reached" } }],
		})).toBe(false);
	});

	it("uses the last terminal failure diagnostic", () => {
		const error = {
			diagnostics: [
				{ type: "provider_response_failure", details: { errorCode: "usage_limit_reached" } },
				{ type: "provider_response_failure", details: { status: 403 } },
			],
		};
		expect([isQuotaError(error), isAccessDeniedError(error)]).toEqual([false, true]);
	});

	it.each([
		{ code: "usage_limit_reached", message: "Request failed" },
		{ error: { code: "usage_limit_reached" }, status: 429 },
	])("recognizes structured thrown errors: %j", (error) => {
		expect([isQuotaError(error), isRateLimitError(error)]).toEqual([true, false]);
	});
});

describe("isQuotaError", () => {
	it("detects HTTP 402", () => {
		expect(isQuotaError({ status: 402 })).toBe(true);
		expect(isQuotaError({ statusCode: 402 })).toBe(true);
		expect(isQuotaError({ error: { status: 402 } })).toBe(true);
	});

	it("detects billing/credit/quota/spend keywords", () => {
		expect(isQuotaError({ message: "Your billing has been exhausted" })).toBe(true);
		expect(isQuotaError({ message: "No credit left" })).toBe(true);
		expect(isQuotaError({ message: "Quota exceeded" })).toBe(true);
		expect(isQuotaError({ message: "Spend limit reached" })).toBe(true);
	});

	it("detects usage-limit errors without an HTTP status", () => {
		expect(isQuotaError({ errorMessage: "You have hit your ChatGPT usage limit." })).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isQuotaError({ message: "BILLING LIMIT" })).toBe(true);
	});

	it("walks nested event-stream shape", () => {
		expect(isQuotaError({ error: { errorMessage: "quota exhausted" } })).toBe(true);
	});

	it("returns false on unrelated errors", () => {
		expect(isQuotaError({ message: "Network error" })).toBe(false);
		expect(isQuotaError({ status: 500 })).toBe(false);
		expect(isQuotaError(null)).toBe(false);
	});
});

describe("isRateLimitError", () => {
	it("detects HTTP 429", () => {
		expect(isRateLimitError({ status: 429 })).toBe(true);
		expect(isRateLimitError({ statusCode: 429 })).toBe(true);
		expect(isRateLimitError({ error: { status: 429 } })).toBe(true);
	});

	it("detects rate-limit keyword variants", () => {
		expect(isRateLimitError({ message: "rate limit" })).toBe(true);
		expect(isRateLimitError({ message: "rate-limit" })).toBe(true);
		expect(isRateLimitError({ message: "rate_limit" })).toBe(true);
		expect(isRateLimitError({ message: "too many requests" })).toBe(true);
	});

	it("returns false on unrelated errors", () => {
		expect(isRateLimitError({ message: "Network error" })).toBe(false);
		expect(isRateLimitError({ status: 402 })).toBe(false);
	});
});

describe("isQuotaOrRateLimitError", () => {
	it("returns true for either", () => {
		expect(isQuotaOrRateLimitError({ status: 402 })).toBe(true);
		expect(isQuotaOrRateLimitError({ status: 429 })).toBe(true);
		expect(isQuotaOrRateLimitError({ message: "billing" })).toBe(true);
		expect(isQuotaOrRateLimitError({ message: "rate limit" })).toBe(true);
	});

	it("returns false for neither", () => {
		expect(isQuotaOrRateLimitError({ status: 500 })).toBe(false);
		expect(isQuotaOrRateLimitError({ message: "bad request" })).toBe(false);
	});
});

describe("isAccessDeniedError", () => {
	it("detects HTTP 403 status fields and provider message shapes", () => {
		expect(isAccessDeniedError({ status: 403 })).toBe(true);
		expect(isAccessDeniedError({ error: { status: 403 } })).toBe(true);
		expect(isAccessDeniedError({ errorMessage: "403 {\"type\":\"error\",\"error\":{\"type\":\"permission_error\",\"message\":\"Your role does not include access to this feature.\"}}" })).toBe(true);
		expect(isAccessDeniedError({ errorMessage: "403 status code (no body)" })).toBe(true);
		expect(isAccessDeniedError({ message: "PERMISSION_DENIED: model not enabled" })).toBe(true);
		expect(isAccessDeniedError({ message: "AccessDeniedException: not authorized" })).toBe(true);
	});

	it("returns false for other errors", () => {
		expect(isAccessDeniedError({ status: 401 })).toBe(false);
		expect(isAccessDeniedError({ errorMessage: "400 invalid API key" })).toBe(false);
		expect(isAccessDeniedError({ errorMessage: "prompt is too long: 214035 tokens" })).toBe(false);
		expect(isAccessDeniedError(null)).toBe(false);
	});
});
