# Module 1 → Module 2 dashboard contract matrix

## Scope and evidence

This matrix uses only Module 1 contract and implementation that exist today in `self-evolve/`:

- durable JSON export contract in `docs/data-contract.md`
- operator-facing limits in `README.md`
- current parser/metrics code in `src/self_evolve/extractor/`

Module 2 should treat the JSON export as the durable contract. SQLite mirrors the same session data for query convenience, but it does not add new durable fields beyond that export.

## Status labels

| Status | Meaning |
|---|---|
| `already available` | Present directly in the current durable Module 1 contract |
| `derivable` | Safe to compute from current durable Module 1 fields without rereading raw JSONL |
| `requires Module 1 extension` | Not durably present today; Dashboard would need Module 1 to emit it explicitly |
| `dashboard presentation only` | View behavior/copy/styling built in Module 2 from available or missing-state inputs |

## Highest-risk contract gaps

| Gap | Why it matters | Phase 1 effect |
|---|---|---|
| `source` (`user` \| `autoresearch`) is not durably recorded | Session List must show it, and Baseline Comparison ranks candidates by it | **Blocks full Phase 1 readiness** |
| `config_version` is not durably recorded | Session List must show it, and Baseline Comparison caveats/ranking depend on it | **Blocks full Phase 1 readiness** |
| No durable task-similarity signal | Comparison can only say similarity is unknown, not weak/strong from real evidence | Degrades gracefully with explicit caveat |

## Naming resolution

| Dashboard term in Module 2 note | Current Module 1 field | Resolution |
|---|---|---|
| `session timestamp` | `session.started_at` | Use `session.started_at` as the list/detail timestamp |
| `timestamp_started` | `session.started_at` | Same field; rename only in Module 2 labels/view model |
| `timestamp_ended` | `session.ended_at` | Same field; rename only in Module 2 labels/view model |
| `duration_seconds` / `total duration` | `metrics.session_duration_seconds` | Use `metrics.session_duration_seconds` |
| `input_tokens` | `metrics.total_input_tokens` | Module 2 label alias only |
| `output_tokens` | `metrics.total_output_tokens` | Module 2 label alias only |
| `cache_read_tokens` | `metrics.total_cache_read_tokens` | Module 2 label alias only |
| `cache_write_tokens` | `metrics.total_cache_write_tokens` | Module 2 label alias only |
| `cost_usd` / `total cost` | `metrics.total_cost` | Use `metrics.total_cost` as canonical stored field; `cost_usd` is presentation naming only |
| `unknown_record_type_count` | `metrics.unknown_record_count` | Use `metrics.unknown_record_count` |
| `source` (`user` \| `autoresearch`) | no current field | **Do not** reuse `session.source_kind`; that field is extractor provenance (`parent_session_jsonl`), not operator source |
| `config_version` | no current field | No safe alias exists in current contract |

## Session List

| Need | Module 1 field(s) today | Status | Missing-data behavior | Phase 1 effect / notes |
|---|---|---|---|---|
| Session timestamp | `session.started_at` | `already available` | `Not recorded` if absent | Needed for default recency ordering |
| Session ID | `session.session_id` | `already available` | Contract gap if absent | Required identity and row key |
| CWD / project | `session.cwd`; fallback `session.cwd_locator`; optional project label derived from `cwd` basename | `derivable` | `Not recorded` if `cwd` absent; may fall back to encoded locator | Good enough for Phase 1 triage and same-project ranking |
| Source (`user` \| `autoresearch`) | none | `requires Module 1 extension` | Contract gap | Must-show field in Session List; missing today |
| Config version | none | `requires Module 1 extension` | Contract gap | Must-show field in Session List; missing today |
| Total duration | `metrics.session_duration_seconds` | `already available` | `Not recorded` if absent | No extractor change needed |
| Total billed tokens | `metrics.total_billed_tokens` | `already available` | `Not recorded` if absent | No extractor change needed |
| Total cost (`cost_usd` label) | `metrics.total_cost` | `already available` | `Not recorded` if absent | Naming mismatch resolved in Module 2 only |
| Tool success rate | `metrics.tool_success_rate` | `already available` | `Not recorded` when no completed tool results exist | Graceful absence; not a contract gap |
| Error-then-retry count | `metrics.error_then_retry_count` | `already available` | `Not recorded` if absent | Heuristic already documented by Module 1 |
| Incomplete flag | `session.is_incomplete` | `already available` | `Not recorded` if absent | Required triage signal |
| Unknown record type count | `metrics.unknown_record_count` | `already available` | `Not recorded` if absent | Required triage signal |
| `Incomplete` badge trigger | `session.is_incomplete` | `already available` | Hide badge if false; contract gap only if field disappears | Badge copy is Module 2-only; trigger exists today |
| `Extraction Weird` badge trigger | `session.line_counts.malformed`, `metrics.unknown_record_count`, `metrics.warning_count` | `derivable` | Show fewer health cues or `Not recorded`; do not fake zero | Good enough for cautious confidence signaling |
| `Retry Storm` badge trigger | `metrics.error_then_retry_count` plus Dashboard threshold | `derivable` | Hide badge if metric missing; do not infer zero | Threshold is Module 2 policy, not Module 1 schema |
| `Tool Fragile` badge trigger | `metrics.tool_success_rate` plus Dashboard threshold | `derivable` | `Not recorded` if success rate is null | Threshold is Module 2 policy |
| `Slow` badge trigger | `metrics.session_duration_seconds` plus peer/outlier rule | `derivable` | Hide badge if duration missing | Outlier rule is cross-session presentation logic |
| `Expensive` badge trigger | `metrics.total_cost`, `metrics.total_billed_tokens` plus peer/outlier rule | `derivable` | Hide badge if both signals missing | Outlier rule is cross-session presentation logic |
| Sort / filter controls | Existing row fields only | `dashboard presentation only` | Disable filters for unsupported fields such as `source` and `config_version` | No Module 1 change needed for supported filters |
| Open Session Detail action | `session.session_id` | `dashboard presentation only` | Disable action if session identity is invalid | Identity exists today |
| Choose baseline action | `session.session_id` | `dashboard presentation only` | Disable compare until explicit baseline is chosen | Matches note: explicit baseline, no auto-compare |

### Session List readiness call

- **Blocks readiness:** `source`, `config_version`
- **Graceful degradation:** null `tool_success_rate`, missing `cwd`, missing health sub-signals, and unsupported filters can all render as `Not recorded` or disabled controls

## Session Detail

| Need | Module 1 field(s) today | Status | Missing-data behavior | Phase 1 effect / notes |
|---|---|---|---|---|
| Session identity header | `session.session_id`, `session.started_at`, `session.cwd` | `already available` | `Not recorded` for missing timestamp/CWD; contract gap only if `session_id` missing | Enough for detail header |
| Headline KPI: total duration | `metrics.session_duration_seconds` | `already available` | `Not recorded` if absent | No extractor change needed |
| Headline KPI: total billed tokens | `metrics.total_billed_tokens` | `already available` | `Not recorded` if absent | No extractor change needed |
| Headline KPI: total cost | `metrics.total_cost` | `already available` | `Not recorded` if absent | Present as currency label only |
| Headline KPI: time to first tool call | `metrics.time_to_first_tool_call_seconds` | `already available` | `Not recorded` when no valid tool-call timestamp exists | Graceful absence; not a contract gap |
| Token breakdown: input | `metrics.total_input_tokens` | `already available` | `Not recorded` if absent | Alias label only |
| Token breakdown: output | `metrics.total_output_tokens` | `already available` | `Not recorded` if absent | Alias label only |
| Token breakdown: cache read | `metrics.total_cache_read_tokens` | `already available` | `Not recorded` if absent | Alias label only |
| Token breakdown: cache write | `metrics.total_cache_write_tokens` | `already available` | `Not recorded` if absent | Alias label only |
| Tool usage summary: total calls | `metrics.tool_call_count` | `already available` | `Not recorded` if absent | No extractor change needed |
| Tool usage summary: completed results | `metrics.tool_result_count` | `already available` | `Not recorded` if absent | No extractor change needed |
| Tool usage summary: failures | `metrics.tool_error_count` | `already available` | `Not recorded` if absent | No extractor change needed |
| Tool usage summary: success rate | `metrics.tool_success_rate` | `already available` | `Not recorded` when no completed results exist | Graceful absence |
| Retry heuristic count | `metrics.error_then_retry_count` | `already available` | `Not recorded` if absent | Already documented as heuristic |
| Extraction health: incomplete | `session.is_incomplete`, `session.incomplete_reasons` | `already available` | `Not recorded` if absent | Required for confidence messaging |
| Extraction health: malformed line count | `session.line_counts.malformed` | `already available` | `Not recorded` if absent | Available without parser changes |
| Extraction health: unknown record count | `metrics.unknown_record_count` and `session.line_counts.unknown` | `already available` | `Not recorded` if absent | Either field can support detail copy |
| Extraction health: warning count | `metrics.warning_count`, `warnings[]` | `already available` | `Not recorded` if absent | Summary available now |
| Per-turn timing breakdown | `events[].timestamp`, `events[].parent_event_id`, `events[].payload.kind` | `derivable` | `Not recorded` for turns lacking timestamps or parent links | Graceful first-cut detail; not a blocker |
| Per-turn tool call / result joins | `tool_calls[]`, linked event IDs, `events[]` | `derivable` | `Not recorded` for unmatched joins | Graceful first-cut detail; aggregate KPIs still work |
| Per-turn usage / cost if available | assistant `events[].payload.usage.*` | `derivable` | `Not recorded` when usage payload is absent on a turn | Module 1 already preserves assistant usage blocks |
| Tool-by-name breakdown | `tool_calls[].tool_name`, `tool_calls[].is_error` | `derivable` | `Not recorded` when join data is incomplete | Optional detail, not a blocker |
| Extractor-confidence summary/caveat | Built from `is_incomplete`, malformed/unknown counts, warning count | `dashboard presentation only` | Render caution copy from whatever health fields exist; use `Not recorded` for missing subfields | No new durable field required for Phase 1 confidence copy |

### Session Detail readiness call

- **Does not block readiness today:** per-turn timing, per-turn joins, and per-turn usage can all degrade to `Not recorded`
- **Required and already covered:** headline KPIs, tool reliability summary, and extraction-health summary

## Baseline Comparison

| Need | Module 1 field(s) today | Status | Missing-data behavior | Phase 1 effect / notes |
|---|---|---|---|---|
| Selected session identity | `session.session_id`, `session.started_at`, `session.cwd` | `already available` | Disable compare if identity is invalid | Enough to label the selected side |
| Baseline session identity | Same fields on comparison session | `already available` | Disable compare if baseline is missing/invalid | Explicit baseline pick is supported |
| Same-project ranking / display | `session.cwd`; fallback `session.cwd_locator` | `derivable` | If project unknown, compare stays allowed but weaker | Supports candidate ranking rule #1 |
| Healthy extraction-state ranking | `session.is_incomplete`, `session.line_counts.*`, `metrics.warning_count`, `metrics.unknown_record_count` | `derivable` | If health data missing, compare stays weaker | Supports candidate ranking rule #2 |
| Same-source ranking | none | `requires Module 1 extension` | Treat as unknown and show weaker-comparison caveat | Missing today; prevents real same-source ranking |
| Nearby timestamp ranking | `session.started_at` | `already available` | If absent, omit recency hint | Supports candidate ranking rule #4 |
| Nearby config-version ranking | none | `requires Module 1 extension` | Treat as unknown and show config caveat only if operator supplied outside context; otherwise omit | Missing today |
| Delta metric: duration | `metrics.session_duration_seconds` | `already available` | `Not recorded` if either side lacks value | Safe to compare numerically |
| Delta metric: billed tokens | `metrics.total_billed_tokens` | `already available` | `Not recorded` if either side lacks value | Safe to compare numerically |
| Delta metric: total cost | `metrics.total_cost` | `already available` | `Not recorded` if either side lacks value | Use `total_cost` internally, `cost_usd` label in UI |
| Delta metric: tool success rate | `metrics.tool_success_rate` | `already available` | `Not recorded` if either side has null rate | Safe but nullable |
| Delta metric: error-then-retry count | `metrics.error_then_retry_count` | `already available` | `Not recorded` if either side lacks value | Heuristic already documented |
| Delta metric: time to first tool call | `metrics.time_to_first_tool_call_seconds` | `already available` | `Not recorded` if either side lacks value | Safe but nullable |
| Absolute deltas | Numeric fields above | `dashboard presentation only` | `Not recorded` when the underlying metric is missing | Pure view-model math |
| Percent deltas where meaningful | Numeric fields above | `dashboard presentation only` | `Not recorded` when baseline is zero/null or metric is not meaningful for percentages | Pure view-model math |
| Better / worse color treatment | Numeric fields plus Dashboard direction rules | `dashboard presentation only` | Fall back to neutral treatment when direction is ambiguous | Direction rules belong in Module 2 |
| Disabled compare state with no baseline | Explicit baseline selection state | `dashboard presentation only` | Disable action | Required by note and already compatible with current contract |
| Caveat: `Extraction health differs — deltas may reflect parser confidence, not session behavior.` | Derived from extraction-health fields on both sessions | `dashboard presentation only` | Always render when health states differ materially | No Module 1 change needed |
| Caveat: `Config differs — delta may reflect configuration change, not session quality.` | no current field | `requires Module 1 extension` | Today this must render only as unknown/omitted, not as evidence-backed claim | Needs durable `config_version` first |
| Caveat: `Task similarity unknown — metrics may not be directly comparable.` | No similarity field exists today; caveat is triggered by absence of such evidence | `dashboard presentation only` | Render conservative caveat instead of inventing similarity confidence | Graceful fallback, not a blocker |

### Baseline Comparison readiness call

- **Blocks stronger comparison confidence:** `source`, `config_version`
- **Graceful degradation:** unknown task similarity, null numeric metrics, and missing project/timestamp hints can still yield a disabled action or weaker caveat instead of fake certainty

## Graceful degradation vs readiness blockers

| Case | Behavior | Readiness impact |
|---|---|---|
| Missing `source` | Show contract gap; do not invent `user`/`autoresearch`; disable source filter/pill/ranking logic | **Blocks full Phase 1 readiness** |
| Missing `config_version` | Show contract gap; do not infer from model or thinking-level records | **Blocks full Phase 1 readiness** |
| `tool_success_rate` is null because no completed tool results exist | Show `Not recorded` | Graceful |
| `time_to_first_tool_call_seconds` is null | Show `Not recorded` | Graceful |
| One or more per-turn detail rows cannot be reconstructed | Show `Not recorded` in that section | Graceful |
| No explicit baseline selected | Disable comparison action | Graceful and expected |
| No task-similarity evidence exists | Show conservative unknown-similarity caveat | Graceful |
| Missing extraction-health subfield while other health signals exist | Show available signals and `Not recorded` for the missing one | Graceful |

## Recommended contract stance for Module 2

1. Treat `metrics.total_cost` as the stored source of truth and rename it to `cost_usd` only in presentation.
2. Treat `session.started_at` / `session.ended_at` as the canonical timestamps.
3. Do not overload `session.source_kind`; it is extractor provenance, not dashboard `source`.
4. Mark `source` and `config_version` as explicit Module 1 extensions before claiming Phase 1 is fully ready.
5. For everything else in Phase 1, prefer conservative UI behavior: `Not recorded`, disabled compare, or explicit caveat instead of inferred values.
