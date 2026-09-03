# caveman

Pi-native caveman prompt injection extension. Preserves the local command/config behavior while vendoring prompt language from JuliusBrussee/caveman.

## Commands

```bash
pnpm exec vitest run --project unit extensions/caveman/test
pnpm lint:typecheck
```

## Always

- Keep `index.ts` as the flat directory entrypoint.
- Prefer `~/.pi/agent/skills/caveman/SKILL.md`; use `upstream-caveman.SKILL.md` only when absent.
- Strip global SKILL YAML frontmatter before parsing or injection.
- Keep `upstream-caveman.SKILL.md` as upstream `skills/caveman/SKILL.md` body without YAML frontmatter.
- When syncing upstream prompt text, keep `prompt.ts` normalization aligned with local behavior that is intentionally not implemented.
- Do not advertise upstream stop/off or wenyan behavior in runtime injection unless the extension implements it.
- Keep tests under `extensions/caveman/test/`.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Local Pi extension entrypoint with `/caveman`, lifecycle hooks, status handling, and `before_agent_start` injection whenever a caveman level is configured (no session-type gate) | Upstream is a cross-agent skill/hook package; this repo needs Pi-native registration and wants caveman style to apply to every agent session, including spawned subagents |
| `config.ts` | Stores persistent config at `~/.pi/agent/caveman.json` and supports only `lite`, `full`, `ultra`, or default `off` | Matches existing personal harness config and avoids implementing upstream-only modes |
| `state.ts` | Stores per-session overrides as `caveman-level` custom entries | Lets Pi restore session state across reload/fork without upstream flag files |
| `prompt.ts` | Selects the global caveman SKILL before the bundled fallback, strips YAML frontmatter, parses prompt sections, and removes unsupported stop/off/wenyan advertising from runtime injection | Global skills stay user-updatable while the bundled body keeps the extension self-contained; local runtime supports only `lite`, `full`, and `ultra` |
| `README.md` | Rewritten in repo-standard concise extension README format | Repo docs omit install/marketing sections and keep provenance local |
| `test/` | Local-only unit coverage for prompt source routing/frontmatter, state, and Pi lifecycle injection | Upstream tests target other agent runtimes; local behavior needs Pi harness coverage |

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/caveman/`.
