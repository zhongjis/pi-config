const ANTHROPIC_TO_BEDROCK: Record<string, string> = {
  "claude-sonnet-4-6":         "us.anthropic.claude-sonnet-4-6",
  "claude-opus-4-6":           "us.anthropic.claude-opus-4-6-v1",
  "claude-haiku-4-5":          "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};

const BEDROCK_TO_ANTHROPIC: Record<string, string> = {};
for (const [anthropicId, bedrockId] of Object.entries(ANTHROPIC_TO_BEDROCK)) {
  BEDROCK_TO_ANTHROPIC[bedrockId] = anthropicId;

  const noRegion = bedrockId.replace(/^us\./, "");
  if (noRegion !== bedrockId) {
    BEDROCK_TO_ANTHROPIC[noRegion] = anthropicId;
  }
}

export function toBedrockModelId(anthropicId: string): string | null {
  return ANTHROPIC_TO_BEDROCK[anthropicId] ?? null;
}

export function normalizeModelId(id: string): string {
  return BEDROCK_TO_ANTHROPIC[id] ?? id;
}
