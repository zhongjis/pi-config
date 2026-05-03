# pi-web-access

## Overview
Research/fetch extension: `web_search`, `code_search`, `fetch_content`, and `get_search_content` with provider fallbacks, curator UI, GitHub cloning, PDF extraction, and video handling.

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Tool schemas, config, `/websearch` + `/curator` commands | `index.ts` | Main entrypoint |
| URL routing / extraction fallback chain | `extract.ts` | GitHub, YouTube, video, HTML, PDF dispatch |
| Search providers | `exa.ts`, `perplexity.ts`, `gemini-search.ts`, `gemini-api.ts`, `gemini-web.ts` | Provider order matters |
| GitHub handling | `github-extract.ts`, `github-api.ts` | Clone-first, API fallback for large repos/commit SHAs |
| Curator flow | `curator-server.ts`, `curator-page.ts`, `summary-review.ts` | `workflow` behavior lives here |
| Video / YouTube | `video-extract.ts`, `youtube-extract.ts` | Prompt threading + frame extraction |
| Result persistence / activity | `storage.ts`, `activity.ts` | `responseId` retrieval + observability |

## Commands
Validate from repo root.

```bash
pnpm test:extensions
pnpm lint:typecheck
```

## Always
- Keep `web_search` fallback order intentional: Exa → Perplexity → Gemini API → Gemini Web in `auto` mode unless a deliberate product change says otherwise.
- Keep GitHub URLs clone-first; API fallback is for oversized repos and commit-SHA cases, not the default path.
- Thread the user-specific `prompt` through YouTube and local-video paths; generic extraction is a quality fallback, not the preferred flow.
- Treat `~/.pi/web-search.json` as the persisted config source; env vars override keys, per-call params override both.
- Preserve `responseId` storage/retrieval semantics; `get_search_content` is part of the public workflow, not an internal helper.

## Ask First
- Changing provider order, default `workflow`, or curator auto-open behavior.
- Changing config-key names or persistence location.
- Changing GitHub clone thresholds, session cache behavior, or response-shape contracts.

## Never
- Never silently ignore invalid `timestamp` / frame requests; fail explicitly on non-video targets or bad formats.
- Never assume API keys exist; zero-config paths are intentional.
- Never drop source citations from synthesized search answers.
- Never bypass the GitHub-specific extraction path for GitHub code URLs.

## Gotchas
- `index.ts` is the integration hub; provider modules are comparatively isolated.
- Package-local upstream Node tests live under `test/*.mjs`; repo-root Vitest still owns harness validation.
- YouTube/local frame extraction needs `ffmpeg`; YouTube frame extraction also needs `yt-dlp`. Content analysis can still work without them.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Preserve registered tool names `web_search`, `code_search`, `fetch_content`, `get_search_content` and command names `/websearch`, `/curator`, `/google-account`, `/search` | Existing local prompts/workflows depend on these names |
| `README.md` | Replaced upstream marketing/install README with concise repo-local documentation | This repo vendors extensions locally and forbids `pi install npm:...` guidance |
| `AGENTS.md` | Local maintenance guide and this tweak manifest | Required source of truth for future vendored syncs |
| `index.test.ts` | Local Vitest coverage for schema normalization and tool registration | Root `pnpm test:extensions` discovers `extensions/**/*.test.ts` |
| `package.json` | Version/dependencies synced to upstream; `test` script is scoped to upstream `test/*.test.mjs` | Avoids Node test runner trying local TypeScript/Vitest tests while preserving package-local upstream tests |
