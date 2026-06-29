# caveman

Pi-native caveman prompt injection extension. Preserves the local command/config behavior while vendoring prompt language from JuliusBrussee/caveman.

## Commands

```bash
pnpm exec vitest run --project unit extensions/caveman/test
pnpm lint:typecheck
```

## Always

- Keep `index.ts` as the flat directory entrypoint.
- Keep `upstream-caveman.SKILL.md` as upstream `skills/caveman/SKILL.md` body without YAML frontmatter.
- When syncing upstream prompt text, keep `prompt.ts` normalization aligned with local behavior that is intentionally not implemented.
- Do not advertise upstream stop/off or wenyan behavior in runtime injection unless the extension implements it.
- Keep tests under `extensions/caveman/test/`.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Local Pi extension entrypoint with `/caveman`, lifecycle hooks, status handling, and top-level persisted-session gate | Upstream is a cross-agent skill/hook package; this repo needs Pi-native registration and subagent exclusion |
| `config.ts` | Stores persistent config at `~/.pi/agent/caveman.json` and supports only `lite`, `full`, `ultra`, or default `off` | Matches existing personal harness config and avoids implementing upstream-only modes |
| `state.ts` | Stores per-session overrides as `caveman-level` custom entries | Lets Pi restore session state across reload/fork without upstream flag files |
| `prompt.ts` | Parses vendored SKILL body and removes upstream stop/off phrases from injected runtime prompt | Local command surface does not implement current-session off/normal-mode handling yet |
| `session-gate.ts` | Requires top-level persisted session signals before injecting | Keeps caveman out of subagents and transient sessions |
| `README.md` | Rewritten in repo-standard concise extension README format | Repo docs omit install/marketing sections and keep provenance local |
| `test/` | Local-only unit coverage for prompt, state, session gate, and Pi lifecycle injection | Upstream tests target other agent runtimes; local behavior needs Pi harness coverage |

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/caveman/`.
