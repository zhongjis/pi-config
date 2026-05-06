# Superpowers Mode and Skills Extension Design

## Status

Implemented on 2026-05-06. Current runtime: `agents/superpowers.md`, `extensions/modes`, and `extensions/superpowers`.

## Decision

Add Superpowers as an opt-in Pi mode plus a vendored upstream skill package:

- `agents/superpowers.md` defines `/mode superpowers` behavior.
- `extensions/modes` registers the new mode.
- `extensions/superpowers` vendors the upstream Superpowers skills from `obra/superpowers`.

Do not copy Weiping's runtime design wholesale. Use Weiping's Pi mapping as reference only.

## Research Summary

### Upstream: `obra/superpowers`

Source inspected from `/tmp/obra-superpowers`:

- Repository: `https://github.com/obra/superpowers`
- Commit inspected: `f2cbfbef`
- Version inspected: `5.1.0`
- Shape: skills library plus hook-based bootstrap for Claude/Cursor-style agents.
- Skill set: 14 skills.

Upstream skills:

1. `brainstorming`
2. `dispatching-parallel-agents`
3. `executing-plans`
4. `finishing-a-development-branch`
5. `receiving-code-review`
6. `requesting-code-review`
7. `subagent-driven-development`
8. `systematic-debugging`
9. `test-driven-development`
10. `using-git-worktrees`
11. `using-superpowers`
12. `verification-before-completion`
13. `writing-plans`
14. `writing-skills`

Upstream `using-superpowers` is a guardrail skill. Its job is to force skill lookup and skill compliance before normal work. Upstream activates it through a `SessionStart` hook. In this repo, mode prompt injection is the right activation mechanism.

### Existing Pi port: `weiping/pi-superpowers`

Source inspected from `/tmp/weiping-pi-superpowers`:

- Repository: `https://github.com/weiping/pi-superpowers`
- Commit inspected: `ca3f8ed`
- Version inspected: `5.0.8`
- Shape: Pi package port of Superpowers.

Weiping adds beyond skills:

- `package.json` with `pi.extensions`, `pi.skills`, and `pi.prompts`.
- `extensions/bootstrap.ts`, which injects `using-superpowers` with `before_agent_start`.
- `extensions/subagent.ts`, which registers `dispatch_agent` and shells out to `pi --no-session --print`.
- `extensions/bootstrap-utils.ts` and `extensions/subagent-utils.ts`.
- Tests for bootstrap, subagent dispatch, prompts, and skills.
- Prompt templates and Chinese aliases.
- OpenClaw plugin files.

This repo already has better-native replacements for Weiping's runtime pieces:

- Mode prompt injection via `extensions/modes`.
- Supervised subagents via `Agent`, `get_subagent_result`, and `steer_subagent`.
- Task tracking via `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskExecute`.

Therefore, copy skills and ideas, not Weiping's bootstrap or subprocess subagent runtime.

### Local repo constraints

Relevant local facts:

- Extensions live under `extensions/<name>/` and must have `index.ts` plus `README.md`.
- Vendored extension READMEs must include upstream source, version or commit, license, and local additions.
- `install.sh` symlinks `extensions/*` into `~/.pi/agent/extensions`.
- Top-level `skills` is Nix-managed and skipped by `install.sh`, so the Superpowers skills should live under the extension package.
- Pi packages can declare `pi.skills: ["./skills"]` in `package.json`.
- Pi discovers `SKILL.md` recursively from package skill directories.
- Skill name collisions warn and keep the first discovered skill.
- The live user environment already has `brainstorming` under global user skill directories, so upstream `brainstorming` may be shadowed depending load order.
- Root extension smoke tests import every `extensions/*/index.ts` and expect each extension to register something.

## Goals

1. Let users opt into Superpowers with `/mode superpowers`.
2. Vendor upstream Superpowers skills with clear provenance.
3. Patch upstream skill text minimally for Pi-native tools.
4. Avoid duplicated runtime mechanisms that this repo already provides.
5. Keep future upstream sync easy.

## Non-Goals

- Do not add automatic `SessionStart` or `before_agent_start` bootstrap injection outside mode switching.
- Do not add a `dispatch_agent` tool.
- Do not shell out to `pi --no-session --print` for subagents.
- Do not recommend `pi install npm:...` in this repo.
- Do not import OpenClaw plugin code.
- Do not rename all upstream skills to a local prefix.

## Architecture

### Mode prompt

Create:

```text
agents/superpowers.md
```

This mode is a curated Pi-native adaptation of upstream `skills/using-superpowers/SKILL.md`.

Required frontmatter decisions:

- `name` or display name: Superpowers.
- `prompt_mode: replace`.
- Use migrated agent frontmatter: `builtin_tools` for built-ins, `extension_tools` for exact extension-tool allowlists, and `extensions` only for extension availability/source scope.
- Set delegation policy explicitly. It should allow existing specialist agents, not Weiping-style subprocess agents.

Use `prompt_mode: replace` because existing modes use replacement semantics. This avoids accumulating old mode bodies when switching modes. It still preserves global and repo AGENTS rules.

The prompt must be standalone. There is no implicit Kuafu inheritance in the mode loader. If Superpowers should have orchestration discipline, copy only the minimal needed local rules into `agents/superpowers.md`.

Core behavior:

1. Before responding, check whether a relevant skill is available.
2. If a relevant skill exists, read it before acting.
3. Announce skill use briefly.
4. Follow the skill workflow exactly unless repo or user constraints override it.
5. Use Pi-native tools when upstream skill text mentions Claude-only tools.
6. If no skill applies, proceed normally.

The mode prompt and vendored `using-superpowers` skill intentionally overlap. The mode prompt is the runtime bootstrap. The vendored skill is kept for upstream completeness and `/skill:using-superpowers` use. On upstream sync, compare both and update the mode prompt only when upstream guardrail behavior changes materially.

### Mode registration

Update `extensions/modes`:

- Add `superpowers` to `MODES`.
- Add `superpowers` to the `Mode` union.
- Add `MODE_META.superpowers` with a clear label.
- Add a color in `MODE_COLORS`.
- Add alias `sp` if we accept bare `sp` switching modes.
- Update command descriptions and README command examples.

Decision: add alias `sp`. It is short and useful. Document that bare `sp` will switch modes because current command handling supports bare mode aliases.

Mode cycling with Tab / Ctrl+Shift+M should include `superpowers` because cycling uses `MODES` order.

### Superpowers extension package

Create:

```text
extensions/superpowers/
  README.md
  package.json
  skills/
    brainstorming/
    dispatching-parallel-agents/
    executing-plans/
    finishing-a-development-branch/
    receiving-code-review/
    requesting-code-review/
    subagent-driven-development/
    systematic-debugging/
    test-driven-development/
    using-git-worktrees/
    using-superpowers/
    verification-before-completion/
    writing-plans/
    writing-skills/
```

`package.json` should declare:

```json
{
  "name": "superpowers",
  "private": true,
  "type": "module",
  "description": "Vendored Superpowers skills adapted for the local Pi harness.",
  "license": "MIT",
  "pi": {
    "skills": ["./skills"]
  },
  "piVendor": {
    "upstream": "https://github.com/obra/superpowers",
    "commit": "f2cbfbef",
    "version": "5.1.0",
    "localTarget": "extensions/superpowers",
    "adaptedFor": "panda-harness Pi mode and native Agent/Task tools"
  }
}
```

This package is skills-only. It declares `pi.skills` in `package.json` and ships no `index.ts`. The root extension smoke test discovers extensions by `index.ts`, so a skills-only package is correctly skipped by smoke and validated by the package manifest test instead.

No lifecycle hook should inject Superpowers instructions. Mode switching owns prompt injection.

### README

Create `extensions/superpowers/README.md` with these sections:

- Title and summary.
- Upstream:
  - source URL
  - inspected version and commit
  - license
  - adaptation summary
- What It Does:
  - ships upstream Superpowers skills
  - adds optional `/mode superpowers` support through `extensions/modes`
- Commands:
  - `/mode superpowers`
  - `/mode sp`
- Local Additions:
  - Pi-native tool mappings
  - no bootstrap injection
  - no `dispatch_agent`
- Collision note:
  - `brainstorming` may be shadowed by an existing global/user skill depending Pi skill load order.
- Files Worth Reading.

Keep README concise, under the local extension README standard.

## Skill Vendoring Policy

Vendor from `obra/superpowers`, not `weiping/pi-superpowers`, because upstream is newer and source-of-truth for skill semantics.

Keep upstream skill names and directory names exact. This preserves compatibility with upstream docs and minimizes patch size.

Known collision: `brainstorming` already exists in the live user skill directories. Do not rename it now. Prefixing all skills would avoid collisions but would require broad semantic edits and break upstream references. Document the collision and accept it for this local harness. If load-order problems become painful, solve them later with package filters or explicit skill loading, not ad hoc renames.

Each vendored `SKILL.md` should include attribution frontmatter. Use local pattern:

```yaml
adaptedFrom:
  - "https://github.com/obra/superpowers/tree/main/skills/<skill-name>"
```

Unknown frontmatter fields are allowed by Pi, so this is safe.

For non-`SKILL.md` files copied from upstream, preserve upstream comments and paths where practical. If a file is locally edited, prefer a short comment near the top or README entry rather than noisy inline annotations.

## Minimal Patch Policy

Patch only text that would mislead a Pi agent or point it to unavailable tool APIs.

### Tool mapping

| Upstream reference | Pi-native replacement |
|---|---|
| `Skill` tool | Read the matching `SKILL.md` through Pi skill discovery or `/skill:<name>`; in agent work, use `read` when exact path is known. |
| `Task` tool for subagents | `Agent` for direct subagent launch; `TaskExecute` for pi-task-backed delegated execution; `get_subagent_result` for results; `steer_subagent` for correction. |
| Multiple `Task` calls | Multiple `Agent` calls with `run_in_background: true` for independent workstreams. |
| `TodoWrite` | `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet`. |
| `Read` | `read`. |
| `Write` | `write`. |
| `Edit` | `edit`. |
| `Bash` | `bash` with repo rule: use `cwd`, never `cd dir && command`. |
| Claude Code `SessionStart` hook | Omit from skills; use `/mode superpowers` mode prompt injection instead. |
| Claude/Cursor/Codex/Gemini install docs | Remove or replace with local README guidance. |
| `dispatch_agent` | Do not mention as available. Use Pi `Agent`. |

### What not to patch

Do not rewrite upstream process logic, examples, guardrails, or sequencing unless required by tool mismatch. Keep upstream skill semantics intact.

Do not modernize wording, reorganize sections, or shorten upstream content merely for style. Smaller diff matters more than local prose polish inside vendored skills.

## Relationship to Existing Agents

`superpowers` mode is not a replacement for Kuafu, Fuxi, or Houtu. It is an opt-in discipline mode that prioritizes skill-driven workflows.

Because mode injection does not inherit another mode body, `agents/superpowers.md` must include any required orchestration rules directly. Keep these rules minimal:

- Use skills first.
- Use pi-tasks for non-trivial work when the loaded skill calls for task tracking.
- Use `Agent` for bounded delegated work.
- Verify before completion.
- Ask before broadening scope.

Do not copy the full Kuafu prompt unless implementation proves the mode needs it. Copying the full prompt would create maintenance drag and prompt conflicts.

## Relationship to Weiping Port

Use Weiping as a comparison source only.

Keep:

- Pi tool mapping ideas.
- Awareness of bootstrap and subagent gaps in generic Pi environments.
- Test ideas for skill validation.

Do not keep:

- `bootstrap.ts` prompt injection.
- `dispatch_agent` subprocess tool.
- npm install-oriented docs.
- OpenClaw plugin files.
- Broad Chinese prompt/alias layer unless requested later.

Reason: this repo already has first-class mode injection, subagent lifecycle tools, and task tracking.

## Validation Plan

Implementation should include these checks:

1. Mode registration tests:
   - `superpowers` is in `MODES`.
   - `Mode` union includes `superpowers`.
   - metadata and color exist.
   - alias `sp` resolves to `superpowers`.

2. Mode README/docs check:
   - `extensions/modes/README.md` lists `superpowers` and `sp`.
   - command descriptions mention new mode.

3. Package manifest check:
   - `extensions/superpowers/package.json` has `pi.skills: ["./skills"]`.
   - `piVendor` records upstream URL, version, commit, and local target.

4. Skill validation:
   - all 14 expected skill dirs exist.
   - each dir has `SKILL.md`.
   - frontmatter `name` matches directory name.
   - frontmatter `description` exists.
   - `adaptedFrom` or equivalent provenance exists.

5. Patch audit:
   - no vendored skill refers to `dispatch_agent` as an available tool.
   - no vendored skill instructs use of Claude `Task` without nearby Pi mapping.
   - no vendored skill requires `TodoWrite` without nearby Pi mapping.
   - no README recommends `pi install npm:...`.

6. Focused commands:
   - `pnpm test:extensions`
   - `pnpm lint:typecheck`

Run full `pnpm test` if focused tests reveal shared harness risk.

## Risks and Mitigations

### Skill collision risk

Risk: vendored `brainstorming` may be shadowed by global user `brainstorming`.

Mitigation: keep upstream name for minimal patching, document collision, and add explicit mode prompt wording that can still enforce Superpowers workflows even if one skill is shadowed.

### Prompt drift risk

Risk: `agents/superpowers.md` and vendored `skills/using-superpowers/SKILL.md` drift.

Mitigation: document that mode prompt is a curated adaptation of `using-superpowers`. On upstream sync, compare these files first.

### Tool mismatch risk

Risk: upstream skills contain Claude-specific tool names.

Mitigation: use the mapping table above and add a patch audit test/search.

### Overengineering risk

Risk: adding bootstrap hooks or subprocess subagents duplicates local infra.

Mitigation: keep extension package-tier only because it needs package skills and smoke registration. Runtime behavior stays in modes and existing Pi tools.

## Implementation Outline

1. Vendor upstream skills into `extensions/superpowers/skills`.
2. Apply minimal mechanical Pi tool-reference patches.
3. Add `extensions/superpowers/package.json` and `README.md` for the skills-only package.
4. Add `agents/superpowers.md` as standalone `prompt_mode: replace` mode prompt adapted from `using-superpowers`.
5. Register `superpowers` and `sp` in `extensions/modes` constants/types/docs.
6. Add tests for mode registration, package manifest, and skill validation.
7. Run focused verification.

## Acceptance Criteria

- `/mode superpowers` can be selected.
- `/mode sp` works if alias registration is included.
- Mode prompt tells the agent to use relevant skills before acting.
- Superpowers skills are vendored under `extensions/superpowers/skills` with provenance.
- Upstream skill names remain unchanged.
- Claude-only tool references are replaced or clearly mapped to Pi-native tools.
- No Weiping bootstrap or subprocess subagent runtime is copied.
- Extension smoke and focused tests pass.

## Consult Review

Taishang reviewed the design and conditionally approved it. Required tightenings were incorporated:

- explicit skill collision policy;
- skills-only package shape (no `index.ts`); root smoke discovers by `index.ts` and skips skills-only packages, with `manifest.test.ts` covering validation;
- `prompt_mode: replace` and standalone mode behavior;
- explicit sync rule between `agents/superpowers.md` and `skills/using-superpowers/SKILL.md`;
- exact Pi-native tool mapping;
- clear validation plan.
