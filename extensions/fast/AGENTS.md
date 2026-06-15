# fast

Vendored Fast-mode extension, merged from two upstream packages into one local extension.

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Runtime behavior | `index.ts` | Profile-registry engine; one profile per provider |
| User docs/provenance | `README.md` | Local repo README format, dual upstream provenance |

## Commands

```bash
pnpm test:extensions
pnpm lint:typecheck
```

## Always

- Keep per-profile behavior aligned with each upstream source unless intentionally adapting.
- Preserve README `## Upstream` commit/version/license entries for both sources on sync.
- If runtime code changes locally, update `## Local Tweaks` below.

## Never

- Do not add upstream install instructions; this repo vendors extensions locally.
- Do not add an extension-local package/toolchain without user approval.
- Do not reintroduce config files; state is intentionally session-only.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Merged `openai-fast` + `claude-fast` into one extension behind a `FastProfile` registry resolved by `ctx.model.provider` | One `/fast` command for both providers; two extensions cannot register the same command |
| `index.ts` | Dropped JSON config loading (`enabled`/`showStatus`, global + project files) | State is session-only per repo decision |
| `index.ts` | Single bare `/fast` toggle; dropped `/claude-fast` and `/openai-fast` command names | Unified UX |
| `README.md` | Local extension README format with dual provenance, no install instructions | Repo requires concise vendored docs and forbids `pi install npm:...` guidance |
| `package.json`, example configs, `.pi-fleet-tested-version` | Upstream files not copied | Repo loads extension directories directly; no nested package/toolchain or fleet marker used |

## Upstream Sync Note

Upstream ships these as two separate npm packages. To re-vendor, sync each profile independently against its upstream source (see `README.md`), then re-apply the merge: keep the shared engine, update only the affected `FastProfile` entry and provider-specific helpers (e.g. `syncAnthropicBetaHeader`).
