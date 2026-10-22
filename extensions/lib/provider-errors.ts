/**
 * Provider error classification — quota (402 + billing keywords),
 * rate-limit (429 + rate-limit keywords), and access-denied (403 +
 * permission keywords) detection across both thrown errors and event-stream
 * error events.
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

type ProviderErrorKind = "quota" | "rate-limit" | "access-denied";

/** Only terminal provider-response diagnostics carry authoritative failure metadata. */
function getFailureMetadata(err: object): object {
	if ("diagnostics" in err && Array.isArray(err.diagnostics)) {
		const diagnostics: readonly unknown[] = err.diagnostics;
		for (let index = diagnostics.length - 1; index >= 0; index--) {
			const diagnostic = diagnostics[index];
			if (diagnostic && typeof diagnostic === "object"
				&& "type" in diagnostic && diagnostic.type === "provider_response_failure"
				&& "details" in diagnostic && diagnostic.details && typeof diagnostic.details === "object") {
				return diagnostic.details;
			}
		}
	}
	return err;
}

/** Recognized provider codes outrank HTTP status; unknown metadata leaves text matching available. */
function getStructuredErrorKind(err: object): ProviderErrorKind | undefined {
	const metadata = getFailureMetadata(err);
	const nested = "error" in metadata ? metadata.error : undefined;
	for (const source of [metadata, nested]) {
		if (!source || typeof source !== "object") continue;
		const code = "errorCode" in source ? source.errorCode : "code" in source ? source.code : undefined;
		const type = "errorType" in source ? source.errorType : "type" in source ? source.type : undefined;
		for (const value of [code, type]) {
			switch (typeof value === "string" ? value.toLowerCase() : undefined) {
				case "usage_limit_reached":
				case "usage_not_included": return "quota";
				case "rate_limit_exceeded": return "rate-limit";
				case "permission_error":
				case "permission_denied":
				case "access_denied": return "access-denied";
				default: break;
			}
		}
	}
	switch (getStatus(metadata)) {
		case 402: return "quota";
		case 429: return "rate-limit";
		case 403: return "access-denied";
		default: return undefined;
	}
}

/** 402 Payment Required, or message containing billing/credit/quota/spend keywords. */
export function isQuotaError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const structured = getStructuredErrorKind(err);
	if (structured) return structured === "quota";
	const msg = getErrorText(err);
	return msg.includes("billing")
		|| msg.includes("credit")
		|| msg.includes("spend limit")
		|| msg.includes("usage limit")
		|| msg.includes("quota");
}

/** 429 Too Many Requests, or message containing rate-limit keywords. */
export function isRateLimitError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const structured = getStructuredErrorKind(err);
	if (structured) return structured === "rate-limit";
	const msg = getErrorText(err);
	return msg.includes("rate limit")
		|| msg.includes("rate-limit")
		|| msg.includes("rate_limit")
		|| msg.includes("too many requests");
}

/** 403 Forbidden, or message containing permission/access-denied keywords. */
export function isAccessDeniedError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const structured = getStructuredErrorKind(err);
	if (structured) return structured === "access-denied";
	return /\b403\b|forbidden|permission.?(?:error|denied)|access.?denied/.test(getErrorText(err));
}

/** Either quota or rate-limit — common "should I failover?" predicate. */
export function isQuotaOrRateLimitError(err: unknown): boolean {
	return isQuotaError(err) || isRateLimitError(err);
}
