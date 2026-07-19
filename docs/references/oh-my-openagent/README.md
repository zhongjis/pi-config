# Oh My OpenAgent final prompts

`final-prompts/` contains 43 generated, final rendered prompts. Do not edit them by hand.

## Refresh

```bash
pnpm sync:oh-my-openagent-prompts
pnpm check:oh-my-openagent-prompts
```

Both commands fetch `https://github.com/code-yeongyu/oh-my-openagent` at commit `14083b89f1cbf4680be13493a6c4afd67c957e8a` (`4.19.0`), install its locked dependencies with lifecycle scripts disabled, and run the pinned source's internal prompt builders. `sync` atomically replaces the archive. `check` regenerates in a temporary directory and compares without writing the archive.

Generation freezes the date at `2026-01-01` and supplies empty available-agent, tool, skill, and category inputs. It disables the task system and supplies no prompt append, disabled tools, environment context, or directory context.

## Provenance and license

These prompts are generated from the pinned Oh My OpenAgent source. Upstream identifies the project as Sustainable Use License 1.0 (`LICENSE.md` at the pinned commit), with incorporated third-party components retaining their original licenses. Consult the pinned upstream license and `THIRD-PARTY-NOTICES.md` before reuse or redistribution.
