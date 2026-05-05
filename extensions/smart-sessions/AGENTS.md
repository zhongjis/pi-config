# smart-sessions

Vendored from `pasky/pi-session-summary` into the existing `smart-sessions` extension path.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Copied from upstream `index.ts`; local API compatibility tweak changes `ctx.ui.notify(..., "success")` to `"info"` | Replaces old `HazAT/pi-smart-sessions` behavior while keeping local path stable and compiling against current Pi notify levels |
| `README.md` | Rewritten to match repo README format and omit install/package instructions | Repo vendors/loads extensions locally |
| `AGENTS.md` | Local-only provenance and sync notes | Required for vendored extension local tweaks |
| `package.json` | Not vendored | Root repo already provides Pi runtime deps; this extension is loaded by directory entrypoint |
