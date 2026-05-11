/**
 * Provider error classification — quota (402 + billing keywords) and
 * rate-limit (429 + rate-limit keywords) detection across both thrown
 * errors and event-stream error events.
 *
 * Works with any provider: anthropic, openai, opencode, bedrock, etc.
 * Keyword lists cover the common phrasings each provider uses.
 */

/**
 * Walk a potentially deeply-nested error/event object and concatenate all
 * string message fields into one lowercased string for keyword matching.
 *
 * Covers shapes from:
 * - thrown errors: `{ message }`
 * - event-stream errors: `{ type: "error", error: { errorMessage, message } }`
 * - nested SDK errors: `{ error: { cause: { message } } }`
 */
export function getErrorText(err: unknown): string {
	if (!err || typeof err !== "object") return "";
	const e = err as Record<string, unknown>;
	const nested = (e.error && typeof e.error === "object" ? e.error : {}) as Record<string, unknown>;
	const cause = (e.cause && typeof e.cause === "object" ? e.cause : {}) as Record<string, unknown>;
	const parts = [
		typeof e.errorMessage === "string" ? e.errorMessage : "",
		typeof e.message === "string" ? e.message : "",
		typeof nested.errorMessage === "string" ? nested.errorMessage : "",
		typeof nested.message === "string" ? nested.message : "",
		typeof cause.message === "string" ? cause.message : "",
	];
	return parts.join(" ").toLowerCase();
}

/** HTTP status extracted from error shapes: err.status, err.statusCode, err.error.status. */
function getStatus(err: unknown): number | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	if (typeof e.status === "number") return e.status;
	if (typeof e.statusCode === "number") return e.statusCode;
	const nested = e.error as Record<string, unknown> | undefined;
	if (nested && typeof nested.status === "number") return nested.status;
	return undefined;
}

/** 402 Payment Required, or message containing billing/credit/quota/spend keywords. */
export function isQuotaError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	if (getStatus(err) === 402) return true;
	const msg = getErrorText(err);
	return msg.includes("billing")
		|| msg.includes("credit")
		|| msg.includes("spend limit")
		|| msg.includes("quota");
}

/** 429 Too Many Requests, or message containing rate-limit keywords. */
export function isRateLimitError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	if (getStatus(err) === 429) return true;
	const msg = getErrorText(err);
	return msg.includes("rate limit")
		|| msg.includes("rate-limit")
		|| msg.includes("rate_limit")
		|| msg.includes("too many requests");
}

/** Either quota or rate-limit — common "should I failover?" predicate. */
export function isQuotaOrRateLimitError(err: unknown): boolean {
	return isQuotaError(err) || isRateLimitError(err);
}
