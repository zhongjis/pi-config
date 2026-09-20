import type { ToolModelsFile } from "./tool-models.js";

export const BUILTIN_TOOL_MODELS_FILE = {
	version: 1,
	roles: {
		"summary.session": "gpt-5.4-mini,gemini-3-flash,claude-haiku-4-5,qwen3.5-plus,qwen2.5-coder:14b",
		commit: "claude-haiku-4-5,gpt-5.4-mini,opencode-go/qwen3.5-plus,llama-swap/qwen2.5-coder:7b",
		"guard.tool": "openai-codex/gpt-5.6-luna:low,anthropic/claude-haiku-4-5",
		"vision.inspect": "gpt-5.5:medium,mimo-v2.5,kimi-k2.6,glm-4.6v,gpt-5-nano",
	},
	tools: {
		"smart-sessions.summary": { role: "summary.session" },
		"recap.generate": { role: "summary.session" },
		"boomerang.commit": { role: "commit" },
		"smart-tool-guards.classifier": { role: "guard.tool" },
		"multimodal-look.inspect": { role: "vision.inspect" },
	},
} as const satisfies ToolModelsFile;
