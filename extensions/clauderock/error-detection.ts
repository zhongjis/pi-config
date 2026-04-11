function getErrorText(err: unknown): string {
  if (!err || typeof err !== "object") return "";

  const parts = [
    "errorMessage" in err && typeof (err as any).errorMessage === "string" ? (err as any).errorMessage : "",
    "message" in err && typeof (err as any).message === "string" ? (err as any).message : "",
    "error" in err && (err as any).error && typeof (err as any).error === "object" && typeof (err as any).error.errorMessage === "string"
      ? (err as any).error.errorMessage
      : "",
    "error" in err && (err as any).error && typeof (err as any).error === "object" && typeof (err as any).error.message === "string"
      ? (err as any).error.message
      : "",
  ];

  return parts.join(" ").toLowerCase();
}

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const msg = getErrorText(err);
  if ("status" in err && (err as any).status === 402) return true;

  return msg.includes("billing") || msg.includes("credit")
      || msg.includes("spend limit") || msg.includes("quota");
}

export function isOauthRateLimitFallback(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const msg = getErrorText(err);
  return ("status" in err && (err as any).status === 429)
      || msg.includes("rate limit") || msg.includes("too many requests");
}
