---
name: pi-extension-vendoring
description: |
  Vendor, import, adapt, update, sync, refresh, or re-vendor third-party Pi extensions into this repo's `extensions/` directory. Use this skill whenever the user asks to bring in a Pi extension from GitHub/GitLab/Forgejo/Bitbucket/npm/a local clone, or to update an existing vendored extension from upstream. This skill is mandatory for preserving upstream attribution, protecting local `## Local Tweaks`, reading changelogs before sync, warning about non-built-in dependencies, adapting package.json safely, assessing compatibility with this extension system, and keeping README/AGENTS notes useful for future maintainers.
---

# Pi Extension Vendoring

Use this skill when bringing an external Pi extension into this repo **or** bringing an already-vendored extension forward from upstream. Vendoring is not a plain copy: preserve provenance, adapt to this harness, protect intentional local drift, and warn before adding risk.

## Related skill docs

- `.agents/skills/pi-extensions/SKILL.md` — Pi extension architecture and local adaptation patterns; see `guides/08-vendored-adaptation.md`.
- `.agents/skills/pi-extensions/references/local-tweaks-format.md` — authoritative manifest format for `## Local Tweaks`.
- `.agents/skills/pi-extension-vendoring/references/sync-flow.md` — deeper sync workflow, stale-manifest recovery, compare script, and common sync patterns.

## Mode selection

Identify the target before editing:

- **First-time vendoring**: no existing `extensions/<name>` target. Follow `First-time vendor flow`.
- **Existing sync/update**: `extensions/<name>` already exists and the user asks to update, sync, refresh, re-vendor, upgrade, merge upstream changes, read release notes, or bring it up to date. Follow `Existing sync flow`.
- **Local-only adaptation**: upstream is not changing; user wants to adjust local vendored behavior. Read `.agents/skills/pi-extensions/SKILL.md` and its vendored-adaptation guide too.

Ask before editing if target extension, upstream source, or desired mode is ambiguous.

## First reads

Read these before touching code:

1. `AGENTS.md` — repo-wide boundaries, commands, install gotchas.
2. `extensions/AGENTS.md` — extension layout and validation rules.
3. `extensions/CONVENTIONS.md` — event bus/RPC contracts.
4. `.agents/skills/pi-extensions/SKILL.md` — Pi extension architecture pointers and adaptation guide.
5. Relevant child `extensions/<area>/AGENTS.md` if the vendored extension touches an existing subsystem.

For existing sync/update, also read these first, in this order:

1. `extensions/<name>/AGENTS.md` — extension-specific rules and `## Local Tweaks`. Read this before upstream code.
2. `extensions/<name>/README.md` `## Upstream` — documented upstream source, version, commit, license.
3. `extensions/<name>/package.json` if present, plus current entrypoint.

Why: this repo vendors extensions locally. Do not recommend `pi install npm:...`. Do not overwrite local harness adaptations just because upstream changed the same file.

## Intake

Identify:

- Upstream source: git URL/package URL/local path, requested branch/tag/commit if any.
- Local target: desired or existing `extensions/<name>` or `extensions/<name>.ts`.
- Mode: first-time vendoring, existing sync/update, or local-only adaptation.
- User-visible feature goal: tool/command/provider/UI behavior expected after work.
- Stable public surface: tool names, command names, config keys, storage paths, event/RPC names, provider order, default workflow, response shapes.
- Whether the user asked for implementation or only release-note review/planning.

## Common safeguards

### Fetch upstream safely

- For remote git hosts, use git-native commands: `git clone`, `git fetch`, `git checkout`.
- Pin inspected source to an immutable commit SHA when possible.
- Do not use raw HTTP downloads for repository transport.
- For npm/package sources, inspect package metadata and tarball provenance; preserve source repository and version.

### Inspect compatibility before copying

Check:

- Entry point and exported default extension function.
- Imports and runtime dependencies.
- Commands/tools/providers registered.
- UI usage and blocking prompts.
- Event names, RPC channels, storage paths, auth/secrets, filesystem writes.
- Existing README/license/package metadata.
- Tests and validation commands.

### Warning gates

Pause for user approval before any of these:

- Changing shared event names, RPC envelopes, or payload shapes consumed across extensions.
- Adding a new non-built-in dependency.
- Adding a nested package/toolchain inside an extension directory.
- Moving an existing extension between layout tiers when a smaller tier still fits.
- Introducing auth, secrets, background network calls, telemetry, or persistent storage not already present upstream/local behavior.
- Changing root scripts, root TypeScript config, smoke discovery, provider order, default workflow, config keys, or response shapes not explicitly requested.

If risk is low and no warning gate applies, proceed after presenting the risk memo.

## First-time vendor flow

1. **Choose the smallest local layout**
   - Single self-contained file → `extensions/<name>.ts`.
   - Multiple files, flat helpers → `extensions/<name>/index.ts` plus siblings.
   - Complex/tested extension → `extensions/<name>/index.ts` re-exporting `./src/index.js`, implementation in `src/`, tests in `test/`.
   - Never nest deeper than `extensions/<name>/src/` unless the user accepts a repo rule change.

2. **Prepare risk memo before editing**

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

3. **Copy/adapt surgically**
   - Keep feature behavior recognizable.
   - Replace generic Pi install assumptions with this repo's local extension layout.
   - Follow existing TypeScript style and import patterns.
   - Keep event/RPC names compatible with `extensions/CONVENTIONS.md`.
   - Add or adjust tests only where there is a nearby pattern or high-risk behavior.

4. **Document local tweaks**
   - Every vendored extension with local modifications needs `extensions/<name>/AGENTS.md` with `## Local Tweaks`.
   - The manifest is a **current-state snapshot**, not a history log. It answers: what diverges from upstream right now, and why?
   - Upstream metadata lives in `README.md` `## Upstream`, not in the manifest.
   - Format: one row per intentional divergence. Required columns: `File`, `What`, `Why`. Optional: commit SHA.
   - Full spec: `.agents/skills/pi-extensions/references/local-tweaks-format.md`.

   ```markdown
   ## Local Tweaks

   Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

   | File | What | Why |
   |------|------|-----|
   | `src/types.ts` | Added `allowNesting` field to `AgentConfig` | delegation-policy.ts needs it |
   | `src/background-supervision.ts` | Local-only file (not in upstream) | Auto-steer/abort idle background agents |
   ```

## Existing sync flow

Sync is a three-way maintenance task: understand upstream, understand local intentional drift, then apply the smallest safe merge. See `references/sync-flow.md` for detailed commands and edge cases.

1. **Treat `## Local Tweaks` as authoritative**
   - Read `extensions/<name>/AGENTS.md` first.
   - Preserve every listed divergence unless the user agrees it is obsolete or the manifest says it can be dropped.
   - If manifest is missing/stale, reconstruct likely divergences from git history, README, CHANGELOG, and comparison to the documented upstream base. Write/fix the manifest before source edits, then flag this to the user.

2. **Snapshot local state**
   - Record dirty files before work with `git status --short`.
   - List target files with `fd -t f . extensions/<name>`.
   - Inspect registered surfaces with `rg -n "registerTool|registerCommand|registerProvider|events\\.emit|on\\(" extensions/<name>`.
   - Do not overwrite pre-existing user changes. If needed files are dirty, read the diff and preserve or ask.

3. **Read changelog/release notes before code diff**
   - Read upstream `CHANGELOG.md`, GitHub/GitLab releases, npm release notes, or package metadata before choosing what to merge.
   - If no changelog exists, say so and fall back to commit history plus package metadata.
   - Pin the inspected upstream source to an immutable commit SHA.

4. **Compare intentionally**

   | Class | Meaning | Action |
   |---|---|---|
   | Upstream update | New release code/doc/test/dependency change | Apply unless blocked by repo policy |
   | Local tweak | Intentional harness-specific behavior | Preserve and document in `AGENTS.md` |
   | Local artifact | Tests/docs/adapters only used in this repo | Preserve unless stale because of this update |
   | Conflict/unknown | Difference could be local tweak or missed upstream | Investigate git history; ask if still unclear |

5. **Prepare sync risk memo before editing**

   ```markdown
   ## Vendored sync risk analysis
   - Source: <url>, <tag/version>, <commit>
   - Local target: extensions/<name>
   - Local version/base: <documented version/commit or unknown>
   - Upstream changes: <release-note summary>
   - Local tweaks to preserve:
     - <file>: <behavior>
   - Compatibility risks:
     - Events/RPC: <none | details>
     - Blocking UI prompts: <none | details>
     - State/storage/config: <none | details>
     - Auth/secrets/network: <none | details>
     - Package/dependencies: <none | details>
     - Tests/smoke discovery: <none | details>
   - Warning gates requiring user approval: <none | list>
   ```

6. **Apply smallest safe merge**
   - Prefer surgical edits over replacing the whole directory.
   - Preserve local tool names, command names, config keys, persistence paths, tests, harness adapters, README style, and event conventions.
   - Apply upstream bug fixes/features/dependency updates unless blocked by warning gates.
   - When copying upstream files, immediately re-apply local tweaks and verify names/config/events still match the manifest.

7. **Update docs and manifest**
   - Update `extensions/<name>/README.md` `## Upstream` with source URL, last synced tag/version, immutable commit SHA, license, and local adaptation summary.
   - Update `extensions/<name>/AGENTS.md` `## Local Tweaks` to reflect current intentional divergences, including renamed tools, local-only tests, README replacement, package-script adaptations, event changes, config-path choices, local shims, deleted upstream files, or pinned dependency differences.

## Dependency policy

Treat Pi/runtime built-ins and repo-present packages as low risk:

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-tui`
- `typebox` / `@sinclair/typebox` when already used by local patterns
- Node built-ins

Any new package not already in root `package.json` is an extra dependency. Warn before adding it. Include package name/version, why upstream needs it, whether existing APIs can avoid it, visible license/security/maintenance concern, and exact `package.json` change proposed.

Do not silently add dependencies. Do not run global installs. Use this repo's package manager and Nix/project environment conventions.

## package.json adaptation

When package metadata changes:

- Preserve upstream author, license, repository, homepage, version/tag, commit SHA, and last-synced version in local metadata or README.
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
- Never hide upstream attribution because package metadata was flattened into this repo.

## README.md requirements

Create or adapt `extensions/<name>/README.md` for directory-style extensions. READMEs must be concise and factual — useful to future agents and humans, not marketing material.

### Format

```markdown
# <Extension Name>

One-paragraph summary: what it does, key capabilities.

## Upstream

(Vendored only) Source URL, last synced version/tag, immutable commit SHA, license, local changes summary.

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

- Max ~120 lines. If longer, cut.
- No install instructions — this repo vendors/loads extensions locally.
- No badges, screenshots, videos, marketing copy, quick starts, future work, limitations, audit tables, test matrices, or file-listing tables.
- No developer guides; put them in `AGENTS.md`, references, or tests.
- Sections are optional; skip what does not apply.
- Always include last synced version/commit in `## Upstream`.
- Upstream README is noisy? Replace it entirely. Keep usage/config facts only.

## Event and UI adaptation checklist

- Blocking `registerTool` UI prompt? Emit `pi.events.emit("user-prompted", { tool: "<tool-name>" })` once before first blocking prompt.
- Persistent waiting state? Use `awaitingUserAction.suppressContinuationReminder === true` shape when applicable.
- RPC? Include `requestId`; replies go to `${channel}:reply:${requestId}` with `{ success: true, data? } | { success: false, error: string }`.
- Lifecycle/discovery events? Use `<namespace>:<event>`.
- Do not invent ad-hoc reply channels.

## Validation

Run focused checks first, then broader checks:

```bash
pnpm --dir extensions/<name> test   # if extension has local package tests
pnpm exec vitest run --project unit extensions/<name>/**/*.test.ts
pnpm test:extensions
pnpm lint:typecheck
```

Also perform runtime-like checks for changed surfaces:

- Tool names still registered as expected.
- New/changed tool parameters appear in schemas.
- Fetch/search/code paths execute against safe small inputs or mocks.
- Retrieval tools still work with stored `responseId` content.
- Browser-cookie or auth changes are opt-in if upstream intended that.

If `pnpm test:extensions` fails outside the target extension, report it as unrelated only after confirming no files in the failing area changed.

For instruction-only edits to this skill, re-read changed skill files, confirm referenced paths resolve, and run search for stale split-skill references.

## Skill evals

When creating or improving this skill, keep `.agents/skills/pi-extension-vendoring/evals/evals.json` current. Use `skill-creator` workflow: run with-skill and baseline test cases, grade outputs, aggregate benchmark, then run `eval-viewer/generate_review.py` so a human can review first-time vendoring and sync behavior before accepting major instruction changes.

## Output to user

After vendoring or syncing, report:

- Mode used: first-time vendoring or existing sync/update.
- Files added/changed/deleted.
- Upstream source and pinned commit/version.
- Last synced version/commit recorded in README.
- Local tweaks preserved or added.
- Dependency changes and warnings accepted.
- Adaptation risks found and how handled.
- Validation commands run and exact results.
- README/provenance location.
- Any follow-up needed before runtime use.
