# Pi Web Access

Web search, content extraction, and video understanding for Pi. Supports Exa, Perplexity, Gemini API/Web, GitHub repo cloning, YouTube/local video analysis, and PDF extraction.

## Upstream

- **Source:** <https://github.com/nicobailon/pi-web-access>
- **Version:** `0.10.7` (`076bf0db5e739b200286ca37486e4edd8d19123c`)
- **License:** MIT
- **Adapted:** Vendored into this repo with stable local tool names, concise docs, and repo-root validation.

## Tools

### `web_search`

Search the web via Exa, Perplexity, or Gemini. Returns synthesized answers with citations. In `auto` mode, provider fallback is Exa → Perplexity → Gemini API → Gemini Web when browser-cookie access is enabled.

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | `auto` (default), `exa`, `perplexity`, or `gemini` |
| `includeContent` | Fetch full page content from sources in background |
| `workflow` | `summary-review` (default) opens curator; `none` skips curator |

### `code_search`

Search for code examples, docs, API refs, and implementation examples. Uses Exa MCP code context when available, with an Exa MCP web-search fallback.

| Parameter | Description |
|-----------|-------------|
| `query` | Programming question, API, library, or debugging topic |
| `maxTokens` | Max tokens to return (default: 5000, max: 50000) |

### `fetch_content`

Fetch URLs and extract readable content. Handles GitHub repos, YouTube, PDFs, local video files, and web pages.

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question about a YouTube or local video |
| `timestamp` | Frame extraction — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos exceeding the 350MB threshold |
| `model` | Override Gemini model for video or YouTube analysis |

### `get_search_content`

Retrieve stored content from previous searches or fetches. Content over 30k chars is truncated in tool responses but stored in full for retrieval here.

| Parameter | Description |
|-----------|-------------|
| `responseId` | ID from a previous search/fetch response |
| `urlIndex` | Index of the result to retrieve |
| `url` | URL of the result to retrieve |
| `query` | Original query to retrieve results for |
| `queryIndex` | Query index for multi-query search results |

## Commands

| Command | Description |
|---------|-------------|
| `/websearch` | Open search curator directly; optionally pre-fill with comma-separated queries |
| `/curator` | Toggle or configure curator workflow (`on`, `off`, `summary-review`) |
| `/search` | Browse stored search results from the current session |
| `/google-account` | Show active Google account used for Gemini Web |

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+W` | Activity monitor |
| `Ctrl+Shift+S` | Search curator |

Configurable via the `shortcuts` field in config.

## Configuration

Config file: `~/.pi/web-search.json`. All fields optional; env vars override config values.

| Field | Description |
|-------|-------------|
| `exaApiKey` | Exa API key (or `EXA_API_KEY` env var) |
| `perplexityApiKey` | Perplexity API key (or `PERPLEXITY_API_KEY` env var) |
| `geminiApiKey` | Gemini API key (or `GEMINI_API_KEY` env var) |
| `provider` | Default search provider: `exa`, `perplexity`, or `gemini` |
| `workflow` | Curator mode: `summary-review` (default) or `none` |
| `summaryModel` | Preferred model for curator summary drafts when available |
| `searchModel` | Override Gemini API model for `web_search` |
| `allowBrowserCookies` | Enable browser-cookie lookup for Gemini Web (`false` by default) |
| `chromeProfile` | Chromium profile directory for Gemini Web cookie lookup when enabled |
| `curatorTimeoutSeconds` | Initial curator idle timeout (default: 20, max: 600) |
| `shortcuts` | Key bindings for curator and activity monitor |

## Provider Fallback Chains

```
web_search(query)
  → Exa (direct API with key, MCP without) → Perplexity → Gemini API → Gemini Web (if browser cookies enabled)

fetch_content(url)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if enabled) → Gemini API → Perplexity
  → Video file?  Gemini API (Files API) → Gemini Web (if enabled)
  → PDF?         Extract text, save to ~/Downloads/
  → HTML?        Readability → RSC parser → Jina Reader → Gemini fallback
```

## Local Additions

- Local tool names are kept stable for this harness: `web_search`, `code_search`, `fetch_content`, `get_search_content`.
- Bundles a `librarian` skill for open-source library investigation using web search, GitHub cloning, and git evidence.
