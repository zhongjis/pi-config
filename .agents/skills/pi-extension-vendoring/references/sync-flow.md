# Vendored Extension Sync Execution Manual

Use only for existing-sync mode. Gates, risk/dependency/README policy, validation, and reporting live in `../SKILL.md`.

## Snapshot

Before upstream source edits:

```bash
git status --short
git diff -- extensions/<name>
fd -t f . extensions/<name>
rg -n "registerTool|registerCommand|registerProvider|events\.emit|events\.on|\.on\(" extensions/<name>
```

Record dirty files, public registrations, config/env/storage paths, tests, package files, local-only files. Preserve pre-existing changes or ask.

## Upstream intent

```bash
git clone <upstream-url> /tmp/<extension>-upstream
git -C /tmp/<extension>-upstream fetch --tags
git -C /tmp/<extension>-upstream checkout <tag-or-commit>
git -C /tmp/<extension>-upstream rev-parse HEAD
```

Read changelog/release notes, host releases, package version/dependencies/gitHead, then commit history between local base and target. If release notes are absent, state fallback to commit history + package metadata. Pin immutable SHA.

Read local base from README `## Upstream`; compare optional package provenance and flag mismatch.

## Missing/stale manifest

Local `## Local Tweaks` is authoritative. Missing, empty despite drift, or stale means:

1. Stop source merge.
2. Reconstruct from target git history, README/CHANGELOG/tests, and documented upstream-base comparison.
3. Write/fix manifest first.
4. Present it; ask user to confirm before source edits.

Say: `manifest was missing/stale; reconstructed from git history and upstream comparison; confirm before I proceed.`

Until confirmed, outcome is blocked.

## Classify differences

| Class | Action |
|---|---|
| Upstream update | Apply unless blocked by SKILL gate |
| Local tweak | Preserve; keep manifest current |
| Local artifact | Preserve unless obsolete because of update |
| Conflict/unknown | Investigate history; ask if unresolved |
| Deleted upstream | Delete only when no local behavior depends on it |
| New dependency/toolchain | Stop for approval gate |

## Compare

```bash
git -C /tmp/<extension>-upstream diff --stat <old-ref>..<new-ref>
git -C /tmp/<extension>-upstream diff --name-only <old-ref>..<new-ref>
git -C /tmp/<extension>-upstream log --oneline <old-ref>..<new-ref>
```

```bash
python - <<'PY'
import pathlib, subprocess
up = pathlib.Path('/tmp/<extension>-upstream')
loc = pathlib.Path('extensions/<name>')
files = subprocess.check_output(['git', '-C', str(up), 'ls-files'], text=True).splitlines()
changed, missing = [], []
for rel in files:
    upf, lf = up / rel, loc / rel
    if not lf.exists(): missing.append(rel)
    elif upf.read_bytes() != lf.read_bytes(): changed.append(rel)
extra = [str(p.relative_to(loc)) for p in loc.rglob('*') if p.is_file() and not str(p.relative_to(loc)).startswith('node_modules/') and str(p.relative_to(loc)) not in files]
print('changed vs upstream:', changed)
print('missing upstream files locally:', missing)
print('extra local files:', extra)
PY
```

Targeted review: `git -C /tmp/<extension>-upstream diff <old-ref>..<new-ref> -- <path>` plus `git diff -- extensions/<name>/<path>`.

## Surgical merge

Edit/copy one file at a time. Immediately reapply manifest tweaks. Keep local public names, config/storage paths, event/RPC channels, tests, adapters, concise README style unless approved otherwise. Translate docs to local names. Scope tests to local runner. Update provenance after final target identity is known. Tier/dependency/shared-event changes return to approval gate.

Unknown base: infer from README/package version, changelog, git history, file comparison; merge only clearly attributable changes. Upstream deletion of locally modified file requires manifest/history check. Package metadata changes preserve author/license/repository/version and gate new dependency/toolchain names.
