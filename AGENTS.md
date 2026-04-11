# pi-config

Personal configuration repo for [pi](https://github.com/mariozechner/pi-coding-agent). Contents are symlinked into `~/.pi/agent/` via `install.sh`.

## Commands

- `bash install.sh` — Symlink repo contents into `~/.pi/agent/`, skipping Nix-managed files
- Nix-managed files (AGENTS.md, settings.json, skills) are handled by Home Manager — **do not** create these manually in `~/.pi/agent/`

## Structure

| Directory            | Purpose                                                         |
| -------------------- | --------------------------------------------------------------- |
| `agents/`            | Custom agent definitions (Chinese mythology-named roles)        |
| `extensions/`        | Pi extensions (TypeScript) — UI widgets, tools, modes           |
| `scripts/`           | Helper scripts (e.g., `pi-package-npm.sh` for package installs) |
| `plans/`             | Planning and follow-up docs                                     |
| `self-improvements/` | Session mining / self-improvement design docs                   |
| `sessions/`          | Session data (gitignored)                                       |

## Agent Naming Convention

Agents use Chinese mythology names with specific roles:

- **Kua Fu 夸父** — Default build agent (senior engineer, orchestrates specialists)
- **Fu Xi 伏羲** — Strategic planner for plan mode
- **Hou Tu 后土** — Plan execution conductor (delegates, never writes code directly)
- **Jintong 金童** — Focused build worker for delegated tasks
- **Cheng Feng 乘风** — Fast read-only codebase reconnaissance (Haiku, low thinking)
- **Wen Chang 文昌** — External research agent (Haiku, low thinking)
- **Taishang 太上老君** — Architecture decisions and code review (read-only)
- **Nuwa 女娲** — UI/UX designer
- **Di Renjie 狄仁杰** — Gap reviewer for draft plans
- **Yan Luo 阎罗** — Plan reviewer for clarity and completeness

## Gotchas

- `install.sh` skips `AGENTS.md`, `settings.json`, and `skills` — these are Nix-managed via Home Manager symlinks. Editing them here has no effect on `~/.pi/agent/`.
- The `skills` symlink in the repo points to `/home/zshen/.omp/agent/skills` — it is not the active skills directory.
- Extensions are TypeScript files loaded directly by pi — no build step needed.
- `sessions/` and `auth.json` are gitignored. Do not commit them.
- Plannotator package requires a manual build after install/update — see `QUICKFIX.md`.
- Git packages with `package.json` get their deps installed automatically by `install.sh` (detects pnpm/bun/npm).

## Conventions

- Agent frontmatter uses `display_name`, `description`, `model`, and `thinking` fields.
- Disabled built-in agents use `enabled: false` in frontmatter (e.g., `general-purpose.md`, `Plan.md`, `Explore.md`).
- Extensions live in `extensions/` as `.ts` files or directories with `index.ts`.
- MCP servers are configured in `mcp.json` — currently context7 and nixos.

## Anti-pattern:

- do **not** recommend or use `pi install npm:...` for pi packages in this environment. Pi's npm package install path relies on global npm install behavior, which is not supported on this NixOS setup. Prefer `git:` packages, local paths, or repo-managed wiring instead.

## References

- Quick fixes for known issues: @QUICKFIX.md
- Self-improvement design: @self-improvements/design.md
