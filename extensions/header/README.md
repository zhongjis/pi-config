# header

Neofetch-style startup header replacing the default pi header.

## What It Does

- Left column: π block-art mascot in accent color
- Right column: session info — pi version, model, working directory, git branch
- Resource counts: tools, skills, prompts, extensions (counts instead of verbose lists)
- Condensed keybinding hints: interrupt, exit, commands, bash, model, thinking
- Reinstalls on model change to keep the model line current

## Hooks

- `session_start` — Refresh info (git branch, resource counts) and install header
- `model_select` — Reinstall header with updated model

## Configuration

Requires `quietStartup: true` in `settings.json` to suppress the verbose default resource listings that would appear below the header.
