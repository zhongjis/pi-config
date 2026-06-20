# smart-sessions

Vendored from `pasky/pi-session-summary` into the existing `smart-sessions` extension path.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Copied from upstream `index.ts`; local API compatibility tweak changes `ctx.ui.notify(..., "success")` to `"info"`; auto-detect list fixes current Haiku id and local 14B qwen selection; generated settings leave `provider`/`model` blank | Replaces old `HazAT/pi-smart-sessions` behavior while keeping local path stable, compiling against current Pi notify levels, selecting valid local/profile models, and preserving auto-detect by default |
| `test/index.test.ts` | Local regression tests for model auto-detection and explicit-config behavior | Locks local model-id compatibility without depending on upstream test layout |
| `README.md` | Rewritten to match repo README format and omit install/package instructions | Repo vendors/loads extensions locally |
| `AGENTS.md` | Local-only provenance and sync notes | Required for vendored extension local tweaks |
| `package.json` | Not vendored | Root repo already provides Pi runtime deps; this extension is loaded by directory entrypoint |
