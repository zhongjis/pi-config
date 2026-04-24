# Sanitized fixture corpus

All files in this directory are synthetic schema fixtures derived from live-session inspection on 2026-04-23.

## Files

- `parent-clean.sample.jsonl` — clean parent session without subagent artifacts
- `parent-with-sidechain.sample.jsonl` — parent session with `subagents:record` and `subagent-notification`
- `sidechain-present.sample.output` — matching synthetic sidechain transcript for `parent-with-sidechain.sample.jsonl`
- `parent-malformed-truncated.sample.jsonl` — parent session fixture with one malformed line and one truncated final line

## Sanitization rules used

- no real session ids
- no real agent ids
- no raw prompts or personal content
- no real filesystem paths
- values are placeholders unless needed to show schema shape or linkage

## Intended parser expectations

- valid fixture files should parse line-by-line as JSONL
- malformed fixture should trigger warnings, not whole-run failure
- sidechain file presence is optional even when parent session references it
