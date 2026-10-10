import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ponytail: fixed scan bounds keep regex cost linear on adversarial output (1 MiB bash, large MCP
// results). URL credentials over 256 chars and PEM bodies over 16384 chars are not redacted;
// structuredContent over the depth or size cap is dropped. Raise a bound only with the timing test.
const MAX_STRUCTURED_DEPTH = 64;
const MAX_STRUCTURED_CHARS = 2 * 1024 * 1024;

/**
 * Filter or transform tool results before the LLM sees them.
 * Redacts sensitive data like API keys, tokens, passwords, etc.
 */
export default function (pi: ExtensionAPI) {
  const sensitivePatterns = [
    {
      pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g,
      replacement: "[OPENAI_KEY_REDACTED]",
    }, // sk-abc123...
    {
      pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
      replacement: "[GITHUB_TOKEN_REDACTED]",
    }, // ghp_xxxx...
    {
      pattern: /\b(gho_[a-zA-Z0-9]{36,})\b/g,
      replacement: "[GITHUB_OAUTH_REDACTED]",
    }, // gho_xxxx...
    {
      pattern: /\b(xox[baprs]-[a-zA-Z0-9-]{10,})\b/g,
      replacement: "[SLACK_TOKEN_REDACTED]",
    }, // xoxb-xxx, xoxp-xxx
    { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: "[AWS_KEY_REDACTED]" }, // AKIAIOSFODNN7EXAMPLE
    {
      pattern:
        /\b(api[_-]?key|apikey)\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
      replacement: "$1=[REDACTED]",
    }, // api_key=xxx, apiKey: "xxx"
    {
      pattern:
        /\b(secret|token|password|passwd|pwd)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
      replacement: "$1=[REDACTED]",
    }, // password=xxx, secret: "xxx"
    {
      pattern: /\b(bearer)\s+([a-zA-Z0-9._-]{20,})\b/gi,
      replacement: "Bearer [REDACTED]",
    }, // Bearer eyJhbGc...
    {
      pattern: /(mongodb(\+srv)?:\/\/[^:]{1,256}:)[^@]{1,256}(@)/gi,
      replacement: "$1[REDACTED]$3",
    }, // mongodb://user:pass@host
    {
      pattern: /(postgres(ql)?:\/\/[^:]{1,256}:)[^@]{1,256}(@)/gi,
      replacement: "$1[REDACTED]$3",
    }, // postgresql://user:pass@host
    { pattern: /(mysql:\/\/[^:]{1,256}:)[^@]{1,256}(@)/gi, replacement: "$1[REDACTED]$3" }, // mysql://user:pass@host
    { pattern: /(redis:\/\/[^:]{1,256}:)[^@]{1,256}(@)/gi, replacement: "$1[REDACTED]$3" }, // redis://user:pass@host
    {
      pattern:
        /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]{0,16384}?-----END \1PRIVATE KEY-----/g,
      replacement: "[PRIVATE_KEY_REDACTED]",
    }, // -----BEGIN RSA PRIVATE KEY-----...
  ];

  const sensitiveFiles = [
    /\.env$/, // .env
    /\.env\.(?!example$)[^/]+$/, // .env.local, .env.production (but not .env.example)
    /\.dev\.vars($|\.[^/]+$)/, // .dev.vars
    /secrets?\.(json|ya?ml|toml)$/i, // secrets.json, secret.yaml
    /(^|[/\\])credentials(\.(json|ya?ml|toml|ini))?$/i, // credential store basenames
  ];

  const redactText = (text: string): string => {
    let result = text;
    for (const { pattern, replacement } of sensitivePatterns) {
      result = result.replace(pattern, replacement);
    }
    return result;
  };

  /**
   * Redacts string leaves of structuredContent, keeping its shape. Never scan
   * JSON.stringify output: the api_key replacement consumes a closing quote.
   * Returns undefined (fail closed) for non-JSON values or values past the caps.
   */
  const redactStructured = (
    value: JsonValue,
  ): { value: JsonValue; redacted: boolean } | undefined => {
    let budget = MAX_STRUCTURED_CHARS;
    let redacted = false;
    const walk = (node: unknown, depth: number): JsonValue => {
      if (depth > MAX_STRUCTURED_DEPTH) throw new RangeError("too deep");
      if (node === null || typeof node === "number" || typeof node === "boolean") {
        return node;
      }
      if (typeof node === "string") {
        budget -= node.length;
        if (budget < 0) throw new RangeError("too large");
        const text = redactText(node);
        if (text !== node) redacted = true;
        return text;
      }
      if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
      if (
        typeof node === "object" &&
        [Object.prototype, null].includes(Object.getPrototypeOf(node))
      ) {
        return Object.fromEntries(
          Object.entries(node).map(([key, item]) => [key, walk(item, depth + 1)]),
        );
      }
      throw new TypeError("not plain JSON");
    };
    try {
      return { value: walk(value, 0), redacted };
    } catch {
      return undefined;
    }
  };

  pi.on("tool_result", async (event, ctx) => {
    // Nested calls (codemode scripts) stay quiet; only top-level results notify.
    const notify = (message: string) => {
      if (!event.parentToolCallId) ctx.ui.notify(message, "info");
    };

    if (event.toolName === "read" && !event.isError) {
      const filePath = event.input.path as string;
      if (/(^|\/)\.env\.example$/i.test(filePath)) {
        return undefined;
      }
      for (const pattern of sensitiveFiles) {
        if (pattern.test(filePath)) {
          notify(`🔒 Redacted contents of sensitive file: ${filePath}`);
          return {
            content: [
              {
                type: "text",
                text: `[Contents of ${filePath} redacted for security]`,
              },
            ],
          };
        }
      }
    }

    const original = event.content ?? [];
    const content = original.map((block) => {
      if (block.type !== "text") return block;
      const text = redactText(block.text);
      return text === block.text ? block : { ...block, text };
    });
    const structured =
      event.structuredContent === undefined
        ? undefined
        : redactStructured(event.structuredContent);
    const dropStructured = event.structuredContent !== undefined && !structured;
    const redacted =
      content.some((block, i) => block !== original[i]) || structured?.redacted === true;

    if (!redacted && !dropStructured) return undefined;
    if (redacted) notify("🔒 Sensitive data redacted from output");
    // Never return isError, usage, or details, so pi keeps them. Returning content without
    // structuredContent makes pi drop it (fail closed).
    return structured ? { content, structuredContent: structured.value } : { content };
  });
}
