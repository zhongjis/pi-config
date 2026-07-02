# Vendored Extension Sync Reference

Use this reference when `extensions/<name>` already exists and the user asks to update, sync, refresh, re-vendor, upgrade, merge upstream changes, read release notes, or bring it up to date.

Sync is not a blind copy. Treat it as a three-way maintenance task:

1. Understand upstream intent.
2. Understand local intentional drift.
3. Apply the smallest safe merge.

## Manifest is authoritative

`extensions/<name>/AGENTS.md` `## Local Tweaks` is the current-state snapshot of local divergences and is the first thing to read.

If the manifest says a file diverges for reason X, preserve that divergence on sync, even if the diff looks harmless to overwrite.

Supporting evidence, used only to verify or bootstrap:

- `git log extensions/<name>/` — chronology for when local tweaks appeared.
- `extensions/<name>/README.md` `## Upstream` — upstream source URL, last synced version/commit, license.
- `extensions/<name>/CHANGELOG.md` if present — local release notes.

## Missing or stale manifest

If `extensions/<name>/AGENTS.md` has no `## Local Tweaks`, or the manifest predates visible local churn:

1. Reconstruct likely divergences from `git log extensions/<name>/`, `CHANGELOG.md`, and the existing README.
2. For each suspected divergence, confirm by diffing against upstream at the documented last-synced commit.
3. Write or update the manifest in `AGENTS.md` as the first edit of the sync, before touching source files.
4. Tell the user: `manifest was missing/stale; reconstructed from git history, confirm before I proceed.`

## Snapshot local state

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

## Read upstream changelog first

Start with release notes/changelog before code diff. The changelog tells you what upstream intended; use it to avoid blindly copying unrelated churn or missing migration notes.

Use git-native/package-native inspection, not raw HTTP downloads for repo transport.

Preferred for git upstream:

```bash
git clone <upstream-url> /tmp/<extension>-upstream
git -C /tmp/<extension>-upstream fetch --tags
git -C /tmp/<extension>-upstream checkout <tag-or-commit>
git -C /tmp/<extension>-upstream rev-parse HEAD
```

Pin inspected source to an immutable commit SHA. Read `CHANGELOG.md`, GitHub/GitLab releases, npm release notes, or package metadata before deciding what to merge. If no changelog exists, say so explicitly and fall back to commit history plus package metadata. If upstream publishes npm metadata, compare package version, dependencies, and `gitHead` too.

## Compare intentionally

Compare upstream to local by file, then classify each difference.

| Class | Meaning | Action |
|---|---|---|
| Upstream update | New release code/doc/test/dependency change | Apply unless blocked by repo policy |
| Local tweak | Intentional harness-specific behavior | Preserve and document in `AGENTS.md` |
| Local artifact | Tests/docs/adapters only used in this repo | Preserve unless stale because of this update |
| Conflict/unknown | Difference could be local tweak or missed upstream | Investigate git history; ask if still unclear |

Useful commands:

```bash
git -C /tmp/<extension>-upstream diff --stat <old-ref>..<new-ref>
git -C /tmp/<extension>-upstream diff --name-only <old-ref>..<new-ref>
```

Compare tracked upstream files with local extension files:

```bash
python - <<'PY'
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

## Apply smallest safe merge

Preserve:

- Existing local custom changes by default, even when copying upstream files.
- Local tool names and command names unless the user requested renaming.
- Local config key names and persistence paths.
- Local README style: concise, factual, no install instructions, no badges/marketing.
- Local tests and harness adapters.
- Local event conventions from `extensions/CONVENTIONS.md`.

Apply:

- Upstream bug fixes and feature code.
- Upstream dependency/version/lockfile changes, unless they add new dependency names requiring approval.
- New upstream tests when useful and compatible.
- Changelog/release-note updates if local extension tracks them.

When copying upstream files, immediately re-apply local tweaks and verify names/config/events still match the manifest before moving to the next file.

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
