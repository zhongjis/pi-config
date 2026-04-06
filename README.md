# Pi Agent Configuration

Personal configuration for [pi coding agent](https://github.com/badlogic/pi-mono).

## Setup

Symlink this repo to pi's config directory:

```bash
ln -sfn "$(pwd)" ~/.pi/agent
```

## Structure

| File | Purpose |
|------|---------|
| `settings.json` | Global settings (model, theme, packages) |
| `AGENTS.md` | Global coding conventions loaded in every session |
| `mcp.json` | MCP server configuration (used by pi-mcp-adapter) |

## Installed Packages

- **pi-mcp-adapter** — MCP server proxy (~200 tokens vs 10k+)
- **pi-web-access** — Web search, URL fetch, PDF, YouTube
- **taskplane** — Parallel multi-agent task orchestration
- **pi-subagents** — Subagent delegation with chains and parallel execution

## Defaults

- **Model:** claude-sonnet-4-6 @ high thinking
- **Provider:** Anthropic (subscription)
- **Theme:** dark
