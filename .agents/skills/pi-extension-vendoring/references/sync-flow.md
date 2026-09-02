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

Base `<old-ref>` = last-synced provenance SHA (README `## Upstream`). Target `<new-ref>` = pinned upstream commit. The upstream delta `diff(<old-ref>..<new-ref>)` is the authority — never `diff(local..upstream)`, which would treat intentional local tweaks as changes to revert.

Scope the delta to the vendored subtree and preview it:

```bash
git -C /tmp/<extension>-upstream diff --stat        <old-ref>..<new-ref> -- <upstream-subtree>
git -C /tmp/<extension>-upstream diff --name-status <old-ref>..<new-ref> -- <upstream-subtree>
git -C /tmp/<extension>-upstream log  --oneline     <old-ref>..<new-ref> -- <upstream-subtree>
```

Establish two operator inputs before merging:

- **Path map** — upstream path → local path for every renamed/relocated file (e.g. `src/index.ts` → `index.ts`). Default identity when layout matches.
- **Drop list** — upstream paths intentionally not vendored (e.g. `package.json`, `tsconfig.json`, `.github/`). Delta hunks touching these are skipped, never silently re-added.

Apply the delta faithfully with a per-file 3-way merge (`git merge-file` merges `base→target` into the local file; clean hunks land verbatim, overlaps with local tweaks become `<<<<<<<` markers). A local tweak on a line immediately adjacent to an upstream hunk also conflicts even without true overlap (diff3 cannot interleave abutting changes) — resolve it like any other marker. Run on a committed/clean tree so `git diff` shows exactly what landed:

```bash
python - <<'PY'
import pathlib, subprocess, tempfile, os
UP='/tmp/<extension>-upstream'; BASE='<old-ref>'; TARGET='<new-ref>'
LOC=pathlib.Path('extensions/<name>')
PATHMAP={ 'src/index.ts':'index.ts' }        # upstream -> local; extend per rename
DROP={ 'package.json','tsconfig.json' }       # upstream paths not vendored

def blob(ref, path):
    r=subprocess.run(['git','-C',UP,'show',f'{ref}:{path}'],capture_output=True)
    return r.stdout if r.returncode==0 else None

status=subprocess.check_output(['git','-C',UP,'diff','--name-status',f'{BASE}..{TARGET}'],text=True).splitlines()
applied,conflict,added,deleted,skipped=[],[],[],[],[]
for line in status:
    parts=line.split('\t'); code=parts[0][0]; up_path=parts[-1]
    if up_path in DROP: skipped.append(up_path); continue
    local_rel=PATHMAP.get(up_path, up_path); lf=LOC/local_rel
    if code=='D': deleted.append((up_path,local_rel)); continue
    if code=='A':
        (added if not lf.exists() else conflict).append(local_rel); continue
    b=blob(BASE,up_path); u=blob(TARGET,up_path)
    if b is None or u is None or not lf.exists(): conflict.append(local_rel); continue
    tb=tempfile.NamedTemporaryFile(delete=False); tb.write(b); tb.close()
    tu=tempfile.NamedTemporaryFile(delete=False); tu.write(u); tu.close()
    rc=subprocess.run(['git','merge-file',str(lf),tb.name,tu.name]).returncode  # in place; !=0 => conflicts
    (conflict if rc!=0 else applied).append(local_rel)
    os.unlink(tb.name); os.unlink(tu.name)
print('clean upstream hunks applied:',applied)
print('CONFLICT (resolve at markers):',conflict)
print('new upstream files to adapt:',added)
print('upstream deletions to review:',deleted)
print('drop-listed, skipped:',skipped)
PY
```

Per-file upstream hunk for targeted review: `git -C /tmp/<extension>-upstream diff <old-ref>..<new-ref> -- <upstream-path>`.

## Surgical merge

The 3-way apply lands upstream hunks verbatim where no local tweak overlaps. Finish per class:

- **Clean-applied** — readback confirms only upstream-delta lines changed; no other edits.
- **Conflicted** (`<<<<<<<` markers) — resolve each marker: take upstream logic, keep local public names, config/storage paths, event/RPC channels, adapters, test runner, and concise README style. Remove every marker; refresh the matching `## Local Tweaks` row.
- **New upstream files** — create at the mapped local path, adapt names/paths, add a Local Tweaks row when divergent; skip if drop-listed.
- **Upstream deletions** — delete locally only when no local behavior depends on the file; else keep and record the reason in manifest/history.
- **Drop-listed** — intentionally not applied; name them in the report.

Verify no residue: `rg -n '^(<<<<<<<|=======|>>>>>>>)' extensions/<name>` returns nothing. Update the provenance SHA to `<new-ref>` after the merge. Tier/dependency/shared-event changes return to the approval gate.

Unknown base: if no reliable `<old-ref>` exists the faithful 3-way is impossible — fall back to per-file comparison, merge only clearly attributable upstream changes, and flag reduced fidelity in the report. Upstream deletion of a locally modified file requires a manifest/history check. Package metadata changes preserve author/license/repository/version and gate new dependency/toolchain names.
