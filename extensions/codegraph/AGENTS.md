# codegraph

Vendored `@vndv/pi-codegraph` extension. Preserve upstream behavior unless local tweaks below say otherwise.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Upstream `extensions/codegraph.ts` lives at directory entrypoint `extensions/codegraph/index.ts` | Repo requires extension directories with `index.ts`; no bare `extensions/*.ts` |
| `index.ts` | Tool `execute` injects `ctx.cwd` as `projectPath` only when params omit `projectPath`; explicit `projectPath` still wins. JSON-RPC stdout loop avoids assignment-in-expression. | Pi runtime cwd is correct project default in this harness; repo lint disallows assignment in expressions |
| `README.md` | Replaced upstream README with repo-standard concise docs and provenance | Repo docs omit install/development instructions and keep upstream metadata local |
| upstream `package.json` | Omitted; upstream metadata moved to `README.md` | No extension-local package/toolchain; no new deps |
| `LICENSE` | Copied upstream MIT license | Preserve vendored attribution/license text |

## Notes

- No new dependencies. Existing repo runtime provides `@earendil-works/pi-coding-agent` and `typebox`.
- `codegraph` CLI is assumed on `PATH`; tools spawn it per request.
