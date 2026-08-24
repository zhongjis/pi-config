# Tool Smart Guard

Guards built-in `bash` tool calls while the latest valid persisted `agent-mode` entry is `fuxi`. Other modes, non-`bash` tools, and sessions without valid persisted mode state bypass the guard.

## Hooks

- `tool_call`: allows a narrow set of deterministic obvious-safe commands, blocks deterministic obvious-danger commands, and sends unknown commands to a separate classifier.
- Classifier model selection uses `tool-smart-guard.classifier` through shared tool-model config. Missing model or auth, provider errors, cancellation, and invalid verdicts block execution.
- Classifier input contains only mode, tool name, exact command, and resolved working directory.
- Registration is published after hook installation; the modes extension blocks Fu Xi `bash` when this capability is absent.

## Settings

`tool_models.json` may override role `guard.tool` or key `tool-smart-guard.classifier`. The built-in chain is `openai-codex/gpt-5.6-luna:low,opencode/claude-haiku-4-5`.

## Safety Boundary

This is a best-effort guard against accidental mutation during planning. Deterministic checks are intentionally narrow, not comprehensive shell parsing. Classifier approval is not a sandbox or proof that a command is harmless.
