# claude-fast

Vendored Claude Fast-mode extension.

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Runtime behavior | `index.ts` | Copied verbatim from upstream commit in README |
| User docs/provenance | `README.md` | Local repo README format |

## Commands

```bash
pnpm test:extensions
pnpm lint:typecheck
```

## Always

- Keep `index.ts` behavior aligned with upstream unless intentionally adapting.
- Preserve README `## Upstream` commit/version/license on sync.
- If runtime code changes locally, update `## Local Tweaks` below.

## Never

- Do not add upstream install instructions; this repo vendors extensions locally.
- Do not add an extension-local package/toolchain without user approval.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `README.md` | Rewritten in local extension README format with provenance and without install instructions | Repo requires concise vendored docs and forbids `pi install npm:...` guidance |
| `package.json` | Upstream file not copied | Repo loads extension directories directly; no nested package/toolchain needed |
| `claude-fast.example.json` | Upstream file not copied | README documents config fields instead |
| `.pi-fleet-tested-version` | Upstream file not copied | Fleet marker is upstream release metadata, not used by local harness |
