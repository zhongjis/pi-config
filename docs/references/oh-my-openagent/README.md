# Oh My OpenAgent references

`final-prompts/` contains 45 generated, final rendered prompts, including the upstream default and GPT ultrawork variants. Do not edit generated archive files by hand. The Pi-adapted active `ulw-plan` skill lives at `modes/fuxi/skills/ulw-plan/`; it records its own pinned upstream provenance.

[`model-family-prompt-variants.md`](./model-family-prompt-variants.md) explains why TasteSkill and Oh My OpenAgent maintain model-family prompt variants, separating vendor guidance from project-specific heuristics.

## Refresh

```bash
pnpm sync:oh-my-openagent-prompts
pnpm check:oh-my-openagent-prompts
```

Both commands fetch `https://github.com/code-yeongyu/oh-my-openagent` at commit `a17b91cdc210a24a86accf51c41e57b99e8aced7` (`5.0.0-beta.21`), install its locked dependencies with lifecycle scripts disabled, and run the pinned source's internal prompt builders. `sync` atomically replaces the final-prompt archive target. `check` regenerates in a temporary directory and compares without writing the archive.

Prompt generation freezes the date at `2026-01-01` and supplies empty available-agent, tool, skill, and category inputs. It disables the task system and supplies no prompt append, disabled tools, environment context, or directory context.

## Provenance and license

These prompts come from the pinned Oh My OpenAgent source. Upstream identifies the project as Sustainable Use License 1.0 (`LICENSE.md` at the pinned commit), with incorporated third-party components retaining their original licenses. Consult the pinned upstream license and `THIRD-PARTY-NOTICES.md` before reuse or redistribution.
