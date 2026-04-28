---
name: pi-extension-vendoring
description: |
  Vendor online or third-party Pi extensions into this repo's `extensions/` directory. Use this skill whenever the user asks to vendor, import, copy, install, adapt, port, bring in, update, or fetch a Pi extension from GitHub/GitLab/Forgejo/Bitbucket/npm/a local clone into the current repo, especially when the target is `/extensions` or a Pi extension runtime. This skill is mandatory for preserving upstream attribution, warning about non-built-in dependencies, adapting package.json safely, assessing compatibility with the existing extension system, and writing README.md notes for future users/agents.
---

# Pi Extension Vendoring

Use this skill when bringing an external Pi extension into this repo. Vendoring is not a plain copy: you must preserve provenance, adapt to this harness, and warn before adding risk.

## First read

Read these files before touching code:

1. `AGENTS.md` — repo-wide boundaries, commands, install gotchas.
2. `extensions/AGENTS.md` — supported extension layouts and validation commands.
3. `extensions/CONVENTIONS.md` — event bus/RPC contracts.
4. `.agents/skills/pi-extensions/SKILL.md` — Pi extension architecture pointers.
5. Relevant child `extensions/<area>/AGENTS.md` if the vendored extension touches an existing subsystem.

Why: this repo has local rules that differ from generic Pi extension installs. In particular, do not recommend `pi install npm:...`; this repo vendors/extensions locally.

## Intake

Identify:

- Upstream source: git URL/package URL/local path, requested branch/tag/commit if any.
- Desired local extension name under `extensions/<name>` or `extensions/<name>.ts`.
- Whether this is a new vendored extension or an update to existing vendored code.
- User-visible feature goal: what command/tool/provider/UI should exist after vendoring.

If target name, source, or intended behavior is unclear, ask before editing.

## Vendor flow

1. **Fetch upstream safely**
   - For remote git hosts, use git-native commands: `git clone`, `git fetch`, `git checkout`.
   - Pin inspected source to an immutable commit SHA when possible.
   - Do not use raw HTTP downloads for repository transport.
   - For npm/package sources, inspect package metadata and tarball provenance; still preserve source repository and version.

2. **Inspect upstream before copying**
   - Entry point and exported default extension function.
   - Imports and runtime dependencies.
   - Commands/tools/providers registered.
   - UI usage and blocking prompts.
   - Event names, RPC channels, storage paths, auth/secrets, filesystem writes.
   - Existing README/license/package metadata.

3. **Choose the smallest local layout**
   - Single self-contained file → `extensions/<name>.ts`.
   - Multiple files, flat helpers → `extensions/<name>/index.ts` plus siblings.
   - Complex/tested extension → `extensions/<name>/index.ts` re-exporting `./src/index.js`, implementation in `src/`, tests in `test/`.
   - Never nest deeper than `extensions/<name>/src/` unless user explicitly accepts a repo rule change.

4. **Copy/adapt surgically**
   - Keep feature behavior recognizable.
   - Replace generic Pi install assumptions with this repo's local extension layout.
   - Follow existing TypeScript style and import patterns.
   - Keep event/RPC names compatible with `extensions/CONVENTIONS.md`.
   - Add/adjust tests only where there is a nearby pattern or high-risk behavior.

5. **Document local tweaks**
   - Every vendored extension with local modifications MUST have a `## Local Tweaks` section in its `AGENTS.md`.
   - This manifest is the source of truth for what to preserve on the next upstream sync.
   - Format: one entry per intentional divergence. Each entry names the file, describes the change, and states why.
   - Use this template:

   ```markdown
   ## Local Tweaks

   Intentional divergences from upstream. Preserve these on sync.

   | File | What | Why |
   |------|------|-----|
   | `src/types.ts` | Added `allowNesting` field to `AgentConfig` | delegation-policy.ts needs it |
   | `src/agent-runner.ts` | `allowNesting` gate on EXCLUDED_TOOL_NAMES filter | Allows nested Agent tool when frontmatter opts in |
   | `src/skill-loader.ts` | Entire file replaced with Pi-aware discovery | Supports SKILL.md, ancestor dirs, frontmatter names |
   | `src/background-supervision.ts` | Local-only file (not in upstream) | Auto-steer/abort idle background agents |
   ```

   - Entries should cover: added files, deleted upstream files, modified lines in shared files, changed interfaces/types, kept-but-divergent behavior.
   - When a file is entirely local-only, say so. When only a few lines differ, name the specific change.
   - On the next sync, the agent reads this manifest FIRST to know which local modifications to preserve.

6. **Validate**
   - Run `lsp_diagnostics` on changed files.
   - Run `pnpm test:extensions` for extension changes.
   - Run `pnpm lint:typecheck` when package.json, tsconfig, imports, or shared types changed.
   - Read changed files back and confirm README/provenance/dependency warnings are present.

## Adaptation risk analysis

Before editing, produce a short risk memo. Use this shape:

```markdown
## Vendoring risk analysis
- Source: <url/path>, <commit/tag/version>
- Local target: extensions/<name>
- Layout fit: bare file | flat dir | src package
- Compatibility risks:
  - Events/RPC: <none | details>
  - Blocking UI prompts: <none | emits user-prompted needed>
  - State/storage paths: <none | details>
  - Auth/secrets/network: <none | details>
  - Package/dependencies: <none | details>
  - Tests/smoke discovery: <none | details>
- Warnings requiring user approval: <none | list>
```

Warn and pause for user approval before any of these:

- Changing shared event names, RPC envelopes, or payload shapes consumed across extensions.
- Adding a new non-built-in dependency.
- Adding a nested package/toolchain inside an extension directory.
- Moving an existing extension between layout tiers when a smaller tier still fits.
- Introducing auth, secrets, background network calls, telemetry, or persistent storage not already present upstream.
- Changing root scripts, root TypeScript config, or smoke discovery outside the target extension.

If risk is low and no warning gate applies, proceed after presenting the memo.

## Dependency policy

Treat Pi/runtime built-ins and repo-present packages as low risk:

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-tui`
- `typebox` / `@sinclair/typebox` when already used by local patterns
- Node built-ins

Any new package not already in root `package.json` is an extra dependency. Warn before adding it. Include:

- Package name/version requested by upstream.
- Why upstream needs it.
- Whether it can be avoided with existing Pi/Node APIs.
- License/security/maintenance concern if visible.
- Exact `package.json` change proposed.

Do not silently add dependencies. Do not run global installs. Use this repo's package manager and Nix/project environment conventions.

## package.json adaptation

When package metadata changes:

- Preserve upstream author, license, repository, homepage, version/tag, and commit SHA in the vendored extension's local metadata or README.
- If keeping an extension-local `package.json`, do not delete original attribution fields. Add local notes in a custom field if useful:

```json
{
  "piVendor": {
    "upstream": "https://example.com/owner/repo",
    "commit": "<sha>",
    "localTarget": "extensions/<name>",
    "adaptedFor": "panda-harness extensions layout"
  }
}
```

- If dependencies must move to root `package.json`, make the smallest diff possible.
- Keep root scripts stable unless validation genuinely requires a new script.
- Never hide upstream attribution just because package metadata was flattened into this repo.

## README.md requirements

Create or adapt `extensions/<name>/README.md` for directory-style extensions. READMEs must be concise and factual — useful to future agents and humans, not marketing material.

### Format

```markdown
# <Extension Name>

One-paragraph summary: what it does, key capabilities.

## Upstream

(Vendored only) Source URL, version/commit, license, local changes summary.

## Tools

One subsection per registered tool. Parameters in a table or inline list.

## Commands

One line per command with brief description.

## Hooks

Which pi lifecycle hooks the extension uses and why.

## Settings / Configuration

Config file path, key fields, defaults. No full JSON blobs — list fields.

## Events

(If applicable) Lifecycle events emitted or consumed, RPC channels.

## Local Additions

(Vendored only) Features added on top of upstream, not present in the published package.
```

### Rules

- **Max ~120 lines.** If longer, cut.
- **No install instructions** — this repo vendors/loads extensions locally.
- **No badges, screenshots, videos, or marketing copy.**
- **No developer guides, audit tables, or test matrices** — those belong in AGENTS.md or test files.
- **No "How It Works" flow diagrams** unless the fallback chain is genuinely useful (e.g., provider selection order).
- **No "Quick Start" code examples** — the tool parameter tables are the reference.
- **No "Limitations" or "Future Work" sections.**
- **No file-listing tables** — put those in AGENTS.md if needed.
- **Upstream README is noisy?** Replace it entirely. Keep only usage/config substance.
- **Sections are optional.** Skip any section that doesn't apply (e.g., no Tools section for hook-only extensions).

## Event and UI adaptation checklist

- Blocking `registerTool` UI prompt? Emit `pi.events.emit("user-prompted", { tool: "<tool-name>" })` once before first blocking prompt.
- Persistent waiting state? Use `awaitingUserAction.suppressContinuationReminder === true` shape when applicable.
- RPC? Include `requestId`; replies go to `${channel}:reply:${requestId}` with `{ success: true, data? } | { success: false, error: string }`.
- Lifecycle/discovery events? Use `<namespace>:<event>`.
- Do not invent ad-hoc reply channels.

## Output to user

After vendoring, report:

- Files added/changed.
- Upstream source and pinned commit/version.
- Dependency changes and any warnings accepted.
- Adaptation risks found and how handled.
- Validation commands run and results.
- README/provenance location.
- Any follow-up needed before runtime use.
