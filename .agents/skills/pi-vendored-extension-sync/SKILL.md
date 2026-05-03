---
name: pi-vendored-extension-sync
description: |
  Update existing vendored Pi extensions in this repo from upstream while preserving local divergences. Use this skill whenever the user asks to update, sync, refresh, re-vendor, upgrade, merge upstream changes, read release notes, or bring a vendored extension under `extensions/` up to date from GitHub/GitLab/Forgejo/Bitbucket/npm/a local clone. Always read upstream changelog/release notes first, protect existing local custom changes, and update the extension README with last synced version/commit. This is the preferred skill for existing vendored extensions; use `pi-extension-vendoring` for first-time vendoring.
---

# Pi Vendored Extension Sync

Use this skill when an extension already exists under `extensions/<name>/` and the task is to bring it forward from upstream without losing local repo adaptations.

This is not a blind copy. Treat sync as a three-way maintenance task: understand upstream, understand local intentional drift, then apply the smallest safe merge.

## First reads

Read these before editing:

1. `AGENTS.md` — repo boundaries, commands, install gotchas.
2. `extensions/AGENTS.md` — extension layout and validation rules.
3. `extensions/CONVENTIONS.md` — event/RPC contract.
4. `.agents/skills/pi-extension-vendoring/SKILL.md` — base vendoring policy, dependency warnings, README standard.
5. `extensions/<name>/AGENTS.md` — extension-specific rules and `## Local Tweaks` manifest.
6. `extensions/<name>/README.md`, `package.json` if present, and the current entrypoint.

If `extensions/<name>/AGENTS.md` has no `## Local Tweaks`, reconstruct likely local divergences from docs, tests, and git history, then add the manifest during the sync.

## Intake

Identify:

- Local target: `extensions/<name>`.
- Upstream source URL/package and requested tag/branch/commit.
- Current documented upstream version/commit in README/package metadata.
- User-visible behavior that must remain stable: tool names, commands, config keys, storage paths, events, provider order, default workflow.
- Whether the user asked for a full update or only release-note review/planning.

Ask before editing if the target extension or upstream source is ambiguous.

## Workflow

### 1. Snapshot local state

Run from repo root:

```bash
git status --short
fd -t f . extensions/<name>
rg -n "registerTool|registerCommand|registerProvider|events\.emit|on\(" extensions/<name>
```

Record:

- Dirty files before your work.
- Registered tool names and commands.
- Config files/env vars.
- Tests and validation commands.
- Local-only files.

Do not overwrite pre-existing user changes. If the target extension is already dirty in files you need to touch, read the diff and preserve it or ask.

### 2. Read upstream changelog first, then fetch source

Start with release notes/changelog before code diff. The changelog tells you what upstream intended; use it to avoid blindly copying unrelated churn or missing migration notes.

Use git-native/package-native inspection, not raw HTTP downloads for repo transport.

Preferred for git upstream:

```bash
git clone <upstream-url> /tmp/<extension>-upstream
git -C /tmp/<extension>-upstream fetch --tags
git -C /tmp/<extension>-upstream checkout <tag-or-commit>
git -C /tmp/<extension>-upstream rev-parse HEAD
```

Pin the inspected source to an immutable commit SHA. Read `CHANGELOG.md`, GitHub/GitLab releases, npm release notes, or package metadata before deciding what to merge. If no changelog exists, say so explicitly and fall back to commit history plus package metadata. If upstream publishes npm metadata, compare package version, dependencies, and `gitHead` too.

### 3. Compare intentionally

Compare upstream to local by file, then classify each difference. Existing local custom changes are protected by default: never let upstream overwrite them unless the user explicitly agrees or the local manifest says the change is obsolete.

| Class | Meaning | Action |
|---|---|---|
| Upstream update | New release code/doc/test/dependency change | Apply unless blocked by repo policy |
| Local tweak | Intentional harness-specific behavior | Preserve and document in `AGENTS.md` |
| Local artifact | Tests/docs/adapters only used in this repo | Preserve unless stale because of this update |
| Conflict/unknown | Difference could be either local tweak or missed upstream | Investigate git history; ask if still unclear |

Useful commands:

```bash
git -C /tmp/<extension>-upstream diff --stat <old-ref>..<new-ref>
git -C /tmp/<extension>-upstream diff --name-only <old-ref>..<new-ref>
python - <<'PY'
# Compare tracked upstream files with local extension files.
# Replace paths before use.
import pathlib, subprocess
up = pathlib.Path('/tmp/<extension>-upstream')
loc = pathlib.Path('extensions/<name>')
files = subprocess.check_output(['git', '-C', str(up), 'ls-files'], text=True).splitlines()
changed, missing = [], []
for rel in files:
    upf, lf = up / rel, loc / rel
    if not lf.exists():
        missing.append(rel)
    elif upf.read_bytes() != lf.read_bytes():
        changed.append(rel)
extra = []
for p in loc.rglob('*'):
    if p.is_file():
        rel = str(p.relative_to(loc))
        if not rel.startswith('node_modules/') and rel not in files:
            extra.append(rel)
print('changed vs upstream:', changed)
print('missing upstream files locally:', missing)
print('extra local files:', extra)
PY
```

### 4. Prepare risk memo before editing

Use this exact shape:

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

Pause for user approval before any warning gate from `.agents/skills/pi-extension-vendoring/SKILL.md`, especially:

- New non-built-in dependency name.
- Shared event/RPC contract change.
- Root config/script/smoke-discovery change.
- Extension layout tier move when smaller layout still fits.
- New auth/secrets/background network/storage behavior not already in upstream/local behavior.
- Provider order, default workflow, config-key, or response-shape changes not explicitly requested.

### 5. Apply smallest safe merge

Prefer surgical edits over replacing the whole directory.

Preserve:

- Existing local custom changes by default, even when copying upstream files.
- Local tool names and command names unless user requested renaming.
- Local config key names and persistence paths.
- Local README style: concise, factual, no install instructions, no badges/marketing.
- Local tests and harness adapters.
- Local event conventions from `extensions/CONVENTIONS.md`.

Apply:

- Upstream bug fixes and feature code.
- Upstream dependency/version/lockfile changes, unless they add new dependency names requiring approval.
- New upstream tests when useful and compatible.
- Changelog/release-note updates if local extension tracks them.

When copying upstream files, immediately re-apply local tweaks and verify the names/config/events still match the manifest before moving to the next file.

### 6. Update docs and manifest

`extensions/<name>/README.md` must be updated at the end of every sync and should include:

- Upstream source URL.
- Last synced version/tag and immutable commit SHA.
- Sync date if useful for future maintainers.
- License.
- Brief local adaptation summary.
- Current tools/commands/settings that users need.

`extensions/<name>/AGENTS.md` must include or update:

```markdown
## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Preserved local tool name `...` | Existing prompts depend on it |
```

Document all intentional divergences: renamed tools, local-only tests, README replacement, package-script adaptations, event changes, config-path choices, local shims, deleted upstream files, or pinned dependency differences.

### 7. Verify behavior, not just types

Run focused checks first, then broader checks:

```bash
pnpm --dir extensions/<name> test   # if extension has local package tests
pnpm exec vitest run --project unit extensions/<name>/**/*.test.ts
pnpm test:extensions
pnpm lint:typecheck
```

Also perform runtime-like checks for the changed surface:

- Tool names still registered as expected.
- New/changed tool parameters appear in schemas.
- Fetch/search/code paths can execute against safe small inputs or mocks.
- Retrieval tools still work with stored `responseId` content.
- Browser-cookie or auth changes are opt-in if upstream intended that.

If `pnpm test:extensions` fails outside the target extension, report it as unrelated only after confirming no files in the failing area changed.

### 8. Final report

Report:

- Upstream source, tag/version, pinned commit.
- Last synced version/commit added to README.
- Files changed/added/deleted.
- Local tweaks preserved.
- Dependency changes.
- Risks found and how handled.
- Validation commands and exact pass/fail results.
- Any unrelated failures or follow-up needed.

## Common sync patterns

### Upstream README is noisy

Keep local README concise. Copy release/config facts, not badges, install commands, screenshots, marketing, or long quickstarts.

### Local tool name differs from upstream

Treat local name as public API. Preserve it in code, tests, README, and `AGENTS.md`. If upstream docs mention a different name, translate docs to local name.

### Upstream adds package tests

Add them if useful. If upstream `node --test` would accidentally run local TypeScript/Vitest tests, scope the package script to the upstream test glob and document that local adaptation.

### Unknown local base commit

Use package version, changelog, and file comparison to infer the likely range. If still unknown, compare current local to latest upstream and apply only changes clearly from release notes or obvious upstream bug fixes.

### New dependency name

Stop and ask. Include package name/version, why upstream added it, whether existing repo deps can avoid it, and exact proposed `package.json` change.
