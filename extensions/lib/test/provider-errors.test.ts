import { describe, expect, it } from "vitest";
import {
	getErrorText,
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
