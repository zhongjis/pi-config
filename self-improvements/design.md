# Pi Self-Improvement MVP Design

This design is for the smallest useful system we can build now.

It folds in:
- the ideas from `draft.md`
- a detailed `taishang` architecture review
- local inspection of Pi session docs
- local inspection of the repo's `sessions/` data

## 1. Decision summary

### What we should build first
Build an **offline session miner + evaluator** for Pi.

Not a generic multi-agent platform.
Not a live telemetry stack.
Not autonomous prompt mutation.

The first goal is simple:

> turn existing Pi session data into a dataset we can inspect, label, and use to validate one better workflow.

### Should the MVP live in this repo?
**Yes.**

This repo already contains:
- Pi extensions
- Pi config
- session snapshots under `sessions/`
- a `self-improvements/` folder

That is enough for an MVP.

### Should we start with session JSONL or OTel?
**Start with session JSONL.**

Add OTel later when we need:
- real-time metrics
- cross-agent ingestion
- external dashboards
- online monitoring

For the MVP, OTel-first is extra infrastructure.

---

## 2. MVP question

The MVP should answer one question well:

> For one narrow Pi task family, can session-derived data plus light human labeling help us identify and validate a better workflow?

Recommended first task family:
- **Pi config / repo change tasks**

Why:
- we already have a lot of local data
- the work is recurring
- the tool patterns are visible
- outcomes are easier to judge than broad open-ended research tasks

---

## 3. What Pi session data already gives us

Pi session files are already strong enough for offline analysis.

From the docs, sessions are JSONL tree files with:
- a session header
- `message` entries
- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

Important message types include:
- `user`
- `assistant`
- `toolResult`
- `bashExecution`
- `custom`
- summaries

Assistant messages include:
- provider
- model
- token/cost usage
- stop reason
- tool calls

Tool results include:
- tool name
- content
- error flag
- optional tool-specific details

### Tree structure matters
Sessions are not just linear transcripts.
They are trees linked by `id` and `parentId`.

That is valuable because we can analyze:
- the final branch
- alternate branches
- abandoned attempts
- branch depth
- branch summaries
- compactions

### Local sample: repo data is already rich
From a sample of 8 recent session files in `sessions/--home-zshen-personal-pi-config--`:
- `878` message entries
- `358` assistant messages
- `492` tool results
- assistant usage present on `358/358` assistant messages
- tool errors on `24/492` tool results
- `4/8` sessions had branching
- custom entries already exist, including `web-search-results` and `subagents:record`

This is enough to start mining behavior.

### What the session data is good for
It is good for:
- workflow mining
- cost and token analysis
- model/tool usage analysis
- branch/retry analysis
- failure clustering
- building a labeling dataset

### What the session data is not good for by itself
It does **not** give us explicit truth labels such as:
- success vs failure
- user satisfaction
- whether the final answer was accepted
- whether code changes were actually correct
- whether the user had to rework the result later

So the raw data is good enough to start, but not enough to fully automate quality evaluation.

---

## 4. Recommendation: source of truth and derived layers

Keep the architecture simple.

### Source of truth
Use the existing session JSONL files as the source of truth.

For the MVP, analyze the repo-local `sessions/` corpus rather than reaching into `~/.pi/agent/sessions` live.
That makes runs reproducible and easier to debug.

### Derived layers
Build derived data in layers:

1. **Raw sessions**
   - unchanged JSONL session files
2. **Normalized tables**
   - one clean representation for sessions, branches, messages, tool events
3. **Labels**
   - human judgments for sampled branches
4. **Reports**
   - baseline analysis and experiment comparisons

Do not edit raw session files.
Do not stuff analysis state back into them.

---

## 5. Recommended repo layout

Keep the MVP code in this repo under `self-improvements/`.

```text
self-improvements/
  draft.md
  design.md
  README.md                    # later
  schemas/
    normalized.md              # table/field definitions
    labeling.md                # label rubric
  scripts/
    extract_sessions.py        # raw JSONL -> normalized tables
    build_branch_dataset.py    # leaf/branch reconstruction
    sample_for_labeling.py     # select branches for review
    analyze_baseline.py        # baseline metrics/report
    compare_experiment.py      # later
  data/
    raw/                       # optional frozen copies if needed
    derived/
      self_improvement.duckdb
      sessions.parquet
      branches.parquet
      tool_events.parquet
    labels/
      branch_labels.csv
  reports/
    baseline.md
    task-family-config-repo.md
```

### Language choice
For the MVP:
- use **Python** for offline analysis
- keep future Pi runtime hooks in **TypeScript**

Why:
- Python is faster for data munging
- DuckDB/CSV/Parquet workflows are simple
- we do not need to modify Pi runtime yet

If we later add a telemetry extension, that should live under `extensions/` in TypeScript.

---

## 6. MVP architecture

### Component A: session extractor
Input:
- session JSONL files from `sessions/`

Output:
- normalized branch/message/tool tables

Responsibilities:
- parse JSONL
- reconstruct the tree from `id` / `parentId`
- identify branch leaves
- flatten useful fields
- preserve references back to raw session file + entry ids

### Component B: branch dataset builder
The unit of analysis should be the **branch**, not just the raw session file.

Why:
- a session may have multiple leaves
- the final leaf is not always the best attempt
- branch summaries and compactions change context shape

Recommended branch record:
- `session_id`
- `session_file`
- `leaf_entry_id`
- `branch_id` (same as leaf id is fine for MVP)
- `branch_depth`
- `message_count`
- `user_turn_count`
- `assistant_turn_count`
- `tool_call_count`
- `tool_error_count`
- `distinct_tools`
- `provider`
- `model`
- `thinking_level`
- `input_tokens`
- `output_tokens`
- `cost_total`
- `model_change_count`
- `thinking_change_count`
- `compaction_count`
- `custom_entry_types`
- `first_user_text`
- `last_assistant_text`
- `raw_path`

### Component C: tool event table
Create a tool event table to answer:
- which tools dominate each task family?
- which tools fail most?
- which workflows waste time/tokens?

Recommended fields:
- `branch_id`
- `turn_index`
- `tool_name`
- `is_error`
- `content_length`
- `has_details`
- `details_keys`
- `timestamp`

### Component D: labeling set
Human labels are required.

Start small.

Recommended label schema:
- `branch_id`
- `task_family`
- `outcome` (`success`, `partial`, `fail`)
- `rework_needed` (`yes`, `no`)
- `failure_mode` (`tool_error`, `bad_plan`, `wrong_edit`, `stalled`, `unknown`, etc.)
- `notes`

Keep labels in plain CSV first.
Do not build a labeling UI yet.

### Component E: baseline analysis report
The first useful report should answer:
- what task families exist in this corpus?
- what models and thinking levels were used?
- what tools dominate successful vs failed branches?
- what is the token/cost profile?
- what are the top failure modes?

---

## 7. How we should analyze the session data

### Step 1: normalize the raw data
Do not try to analyze JSONL directly in ad hoc scripts forever.

Normalize into at least these logical tables:
- `sessions`
- `entries`
- `branches`
- `messages`
- `tool_events`
- `labels`

A local DuckDB file is enough for MVP.

### Step 2: reconstruct branches
Rules:
- every non-header entry has an `id`
- parents are linked by `parentId`
- leaves are entries with no children
- each leaf defines a branch path back to the root

For MVP, analyze:
- **all leaves**
- the **latest leaf**
- the **deepest leaf**

Do not assume the latest leaf is the best branch.

### Step 3: derive branch-level features
Examples:
- total turns
- assistant stop reasons
- tool mix
- tool error rate
- token and cost totals
- number of retries
- branch depth
- number of model changes
- number of compactions
- subagent usage present or not
- web search usage present or not

### Step 4: sample for labeling
Do not label everything.

Sample 50 to 100 branches.
Stratify by:
- task family guess
- model
- branch depth
- whether tool errors occurred

### Step 5: build the first report
We want to know:
- what a “normal” branch looks like
- what correlates with failure
- what correlates with expensive but low-value runs
- what patterns appear in successful branches

### Step 6: choose one improvement target
Only choose one.

Good first candidates:
- subagent usage policy
- prompt template for repo/config change tasks
- tool routing default
- model routing for a narrow task family

Bad first candidates:
- global prompt rewrite
- cross-agent orchestration
- autonomous self-editing

---

## 8. Step-by-step MVP plan

### Phase 0: freeze scope
Output:
- this design
- one task family definition
- one corpus definition

Steps:
1. Use this repo as the home for the MVP.
2. Use repo-local `sessions/` as the starting corpus.
3. Pick one first task family: **Pi config / repo change tasks**.

### Phase 1: build ingestion
Output:
- normalized data file
- branch table

Steps:
1. Parse all session JSONL files under `sessions/`.
2. Reconstruct trees and leaves.
3. Emit normalized tables into DuckDB or Parquet.
4. Verify counts against raw files.

Acceptance criteria:
- we can answer: how many sessions, leaves, assistant turns, tool results, and tool errors exist?

### Phase 2: build branch dataset
Output:
- one branch-level dataset

Steps:
1. Define one branch per leaf.
2. Compute branch-level metrics.
3. Store a short preview for manual review: first user message, final assistant message, top tools.

Acceptance criteria:
- we can sort branches by cost, depth, tool errors, and model.

### Phase 3: label a small sample
Output:
- `branch_labels.csv`

Steps:
1. Sample 50 to 100 branches.
2. Label them manually.
3. Keep the rubric intentionally small.

Acceptance criteria:
- every sampled branch has `task_family`, `outcome`, and `rework_needed`.

### Phase 4: baseline analysis
Output:
- `reports/baseline.md`

Steps:
1. Compare success vs failure by model.
2. Compare success vs failure by tool error rate.
3. Compare success vs failure by branch depth and tool count.
4. Write the top 5 findings.

Acceptance criteria:
- we can name one likely workflow improvement target with evidence.

### Phase 5: first controlled improvement
Output:
- one experiment spec
- one before/after comparison

Steps:
1. Pick one narrow change.
2. Replay or re-run a small labeled set.
3. Compare against baseline.
4. Keep the change only if quality holds and failure rate does not rise.

Acceptance criteria:
- we can say whether the change helped, hurt, or was neutral.

---

## 9. What we should defer

Not for MVP:
- OpenTelemetry collector/backends
- Langfuse/Phoenix integration
- real-time dashboards
- generic multi-agent ingestion
- automated prompt search
- judge-model-heavy scoring
- custom web labeling UI
- warehouse/streaming infra
- production rollout automation

These are valid later. They are not needed to learn fast now.

---

## 10. Risks and safeguards

### Risk: raw sessions contain sensitive data
Sessions may contain:
- prompts
- file contents
- shell output
- URLs
- secrets accidentally echoed by tools

Safeguards:
- keep MVP local-only
- do not export raw sessions to third-party services
- create a redacted derived layer before sharing anything
- prefer hashes or truncated previews in reports

### Risk: branch analysis is misleading
The most recent branch is not always the best branch.

Safeguards:
- analyze all leaves
- keep branch ids stable
- label best branch and final branch separately if needed later

### Risk: false confidence from unlabeled analytics
Cheap metrics are not quality.

Safeguards:
- require human labels for quality
- use cost and latency as secondary metrics

---

## 11. The first thing to do next

The first concrete build step should be:

> write `extract_sessions.py` and produce one local DuckDB/Parquet dataset from the repo's `sessions/` directory.

That gives us a real substrate for everything else.

After that, the next step is:

> sample 50 to 100 branches and label them.

If those two steps do not produce useful insight, we should stop and rethink before adding telemetry, dashboards, or optimization loops.

---

## 12. Final recommendation

Yes, we can host the MVP here.
Yes, we should start with session data.
Yes, the format is good enough to begin.

But we should use it in the smallest disciplined way:
- session JSONL as source of truth
- branch-level normalization
- light human labeling
- one baseline report
- one narrow improvement experiment

That is the fastest path from idea to evidence.
