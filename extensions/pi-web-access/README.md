# Pi Web Access

Web search, content extraction, and video understanding for Pi. Supports Exa, Perplexity, Gemini (API and browser-based), GitHub repo cloning, YouTube/local video analysis, and PDF extraction.

## Upstream

Source: <https://github.com/nicobailon/pi-web-access> (MIT). Vendored.

## Tools

### web_search

Search the web via Exa, Perplexity, or Gemini.

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | `auto` (default), `exa`, `perplexity`, or `gemini` |
| `includeContent` | Fetch full page content from sources in background |
| `workflow` | `none` or `summary-review` (default) |

### code_search

Search for code examples and docs via Exa MCP. No API key required.

| Parameter | Description |
|-----------|-------------|
| `query` | Programming question, API, library, or debugging topic |
| `maxTokens` | Max tokens to return (default: 5000, max: 50000) |

### fetch_content

Fetch URLs and extract readable content. Handles GitHub repos, YouTube, PDFs, local video files, and web pages.

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question about a YouTube or local video |
| `timestamp` | Frame extraction — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos exceeding the 350MB threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Content over 30k chars is truncated in tool responses but stored in full for retrieval here.

| Parameter | Description |
|-----------|-------------|
| `responseId` | ID from a previous search/fetch response |
| `urlIndex` | Index of the result to retrieve |
| `url` | URL of the result to retrieve |
| `query` | Original query to retrieve results for |

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

Config file: `~/.pi/web-search.json`. All fields optional.

| Field | Description |
|-------|-------------|
| `exaApiKey` | Exa API key (or `EXA_API_KEY` env var) |
| `perplexityApiKey` | Perplexity API key (or `PERPLEXITY_API_KEY` env var) |
| `geminiApiKey` | Gemini API key (or `GEMINI_API_KEY` env var) |
| `provider` | Default search provider: `exa`, `perplexity`, or `gemini` |
| `workflow` | Curator mode: `summary-review` (default) or `none` |
| `chromeProfile` | Chromium profile directory for Gemini Web cookie lookup |
| `searchModel` | Override Gemini API model for `web_search` |
| `curatorTimeoutSeconds` | Initial curator idle timeout (default: 20, max: 600) |
| `shortcuts` | Key bindings for curator and activity monitor |

Env vars take precedence over config file values.

## Provider Fallback Chains

```
web_search(query)
  → Exa (direct API with key, MCP without) → Perplexity → Gemini API → Gemini Web

fetch_content(url)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web → Gemini API → Perplexity
  → Video file?  Gemini API (Files API) → Gemini Web
  → PDF?         Extract text, save to ~/Downloads/
  → HTML?        Readability → RSC parser → Jina Reader → Gemini fallback
```

## Skills

Bundles a `librarian` skill for investigating open-source libraries. Combines GitHub cloning, web search, and git operations to produce evidence-backed answers with permalinks. Loaded automatically based on prompt context.
