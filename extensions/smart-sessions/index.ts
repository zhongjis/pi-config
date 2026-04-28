import { complete, type Api, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Vendored from https://github.com/HazAT/pi-smart-sessions
// Adapted lightly for this config.

const skillPattern = /^\/skill:(\S+)\s*([\s\S]*)/;
const SUMMARY_PROMPT =
  "Summarize the user's request in 5-10 words max. Output ONLY the summary, nothing else. No quotes, no punctuation at the end.";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

type SummaryModelContext = {
  model: Model<Api> | null;
  modelRegistry: {
    find: (provider: string, id: string) => Model<Api> | undefined;
    getApiKeyAndHeaders: (
      model: Model<Api>,
    ) => Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
  };
};

async function pickCheapModel(
  ctx: SummaryModelContext,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string> } | null> {
  const haiku = ctx.modelRegistry.find("anthropic", HAIKU_MODEL_ID);
  if (haiku) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(haiku);
    if (auth.ok) return { model: haiku, apiKey: auth.apiKey, headers: auth.headers };
  }

  if (ctx.model) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (auth.ok) return { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers };
  }

  return null;
}

export default function smartSessionsExtension(pi: ExtensionAPI) {
  let named = false;

  pi.on("session_start", () => {
    named = !!pi.getSessionName();
  });

  pi.on("input", async (event, ctx) => {
    if (named) return;

    if (pi.getSessionName()?.trim()) {
      named = true;
      return;
    }

    const match = event.text.match(skillPattern);
    if (!match) return;

    const skillName = match[1];
    const userPrompt = match[2].trim();
    named = true;

    if (!userPrompt) {
      pi.setSessionName(`[${skillName}]`);
      return;
    }

    pi.setSessionName(`[${skillName}] ${userPrompt.slice(0, 60)}`);

    const cheap = await pickCheapModel({
      model: ctx.model ?? null,
      modelRegistry: ctx.modelRegistry,
    });
    if (!cheap) return;

    try {
      const response = await complete(
        cheap.model,
        {
          systemPrompt: SUMMARY_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: userPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: cheap.apiKey, headers: cheap.headers },
      );

      const summary = response.content
        .filter((content): content is { type: "text"; text: string } => content.type === "text")
        .map((content) => content.text)
        .join("")
        .trim();

      if (summary) {
        pi.setSessionName(`[${skillName}] ${summary}`);
      }
    } catch {
      // Keep the temporary truncated name.
    }
  });
}
