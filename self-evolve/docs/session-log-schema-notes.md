# Session log schema notes (2026-04-23 refresh)

## Sampled sources

Observed with `pi-jsonl-logs` skill workflow plus targeted `jq` extraction:

- Parent session with sidechain artifacts present:
  - `~/.pi/agent/sessions/--home-zshen-personal-pi-config--/2026-04-23T07-26-43-054Z_019db93b-e36e-77ff-9086-f9e6c70bff41.jsonl`
- Recent parent session without subagent records:
  - `~/.pi/agent/sessions/--home-zshen-personal-pi-config--/2026-04-23T08-29-18-965Z_019db975-32f5-7240-8664-29a277abc885.jsonl`
- Linked sidechain outputs found from the first parent session:
  - `/tmp/pi-subagents-1000/home-zshen-personal-pi-config/019db93b-e36e-77ff-9086-f9e6c70bff41/tasks/50e11e63-2603-4cc.output`
  - `/tmp/pi-subagents-1000/home-zshen-personal-pi-config/019db93b-e36e-77ff-9086-f9e6c70bff41/tasks/6b21efae-4496-47c.output`

## Sanitization approach

- Fixtures under `self-evolve/tests/fixtures/` are synthetic, not copied from personal logs.
- Real session ids, agent ids, prompts, result text, output previews, and filesystem paths were replaced with placeholders.
- Structure is preserved only at the schema level: field names, nesting, optionality, and linkage patterns.
- Sidechain paths use fake example roots and must be treated as illustrative only.

## Parent session layout

Observed parent sessions live under:

- `~/.pi/agent/sessions/<cwd-encoded-dir>/<session>.jsonl`
- For this repo, `<cwd-encoded-dir>` was `--home-zshen-personal-pi-config--`

The first record is a `session` header.

## Record kinds actually seen in sampled parent sessions

Across the two sampled parent sessions, these top-level record kinds were present:

- `session`
- `model_change`
- `thinking_level_change`
- `message`
- `custom`
- `custom_message`

Not seen in the sampled runtime data:

- `session_info`

## Required and optional fields by record kind

### `session`

Required in sampled data:

- `type: "session"`
- `id`
- `timestamp`
- `cwd`
- `version`

Optional in sampled data:

- `parentSession`

Notes:

- `parentSession` appeared in the later sample and was absent in the earlier sample.
- Treat the header `cwd` as canonical when present.

### `model_change`

Required in sampled data:

- `type: "model_change"`
- `id`
- `timestamp`
- `provider`
- `modelId`

Observed optionality:

- `parentId` was present and may be `null`

### `thinking_level_change`

Required in sampled data:

- `type: "thinking_level_change"`
- `id`
- `timestamp`
- `thinkingLevel`

Observed optionality:

- `parentId` was present in sampled records

### `message`

All sampled `message` records had these top-level fields:

- `type: "message"`
- `id`
- `parentId`
- `timestamp`
- `message`

#### `message.role == "user"`

Required in sampled data:

- `message.role`
- `message.timestamp`
- `message.content` as an array

Observed content blocks:

- text blocks with `type: "text"`
- text block keys observed: `text`, optional `textSignature`

#### `message.role == "assistant"`

Required in sampled data:

- `message.role`
- `message.timestamp`
- `message.content` as an array
- `message.api`
- `message.provider`
- `message.model`
- `message.stopReason`
- `message.usage`

Observed optional fields:

- `message.responseId`
- `message.errorMessage`

Observed content block kinds:

- `text`
- `thinking`
- `toolCall`

Observed block shapes:

- `text`: `type`, `text`, optional `textSignature`
- `thinking`: `type`, `thinking`, optional `thinkingSignature`
- `toolCall`: `type`, `id`, `name`, `arguments`

Important runtime detail:

- Tool call identifiers live at `content[].id`, not `toolCallId`.
- Tool names live at `content[].name`, not `toolName`.

#### `message.role == "toolResult"`

Required in sampled data:

- `message.role`
- `message.timestamp`
- `message.toolCallId`
- `message.toolName`
- `message.isError`
- `message.content` as an array

Observed optional fields:

- `message.details`

Observed content shape:

- Usually an array of text blocks with `type: "text"` and `text`

## Custom records

### `custom` with `customType: "agent-mode"`

Observed data keys:

- always `mode`
- sometimes `planReviewApproved`
- sometimes `planReviewPending`
- sometimes `planContent`
- sometimes `planTitle`
- sometimes `planTitleSource`

### `custom` with `customType: "subagents:record"`

Observed top-level fields:

- `type`
- `customType`
- `id`
- `parentId`
- `timestamp`
- `data`

Observed `data` keys:

- `id`
- `type`
- `description`
- `status`
- `result`
- `startedAt`
- `completedAt`

Runtime meaning:

- `data.id` is the background subagent id.
- `data.type` is the subagent type.
- `data.result` may inline a final summary and may mention a transcript file path.

### `custom_message` with `customType: "subagent-notification"`

Observed top-level fields:

- `type`
- `customType`
- `id`
- `parentId`
- `timestamp`
- `content`
- `display`
- `details`

Observed `details` keys:

- `id`
- `description`
- `status`
- `toolUses`
- `turnCount`
- `totalTokens`
- `durationMs`
- `outputFile`
- `resultPreview`

Runtime meaning:

- `details.id` matches the subagent id.
- `details.outputFile` points at the ephemeral sidechain transcript when it still exists.

## Linkage rules

### Conversation graph

- Parent log records use top-level `id` and `parentId`.
- The graph spans `model_change`, `thinking_level_change`, `message`, `custom`, and `custom_message` entries.

### Tool call ↔ tool result join

- Assistant `toolCall` blocks expose:
  - `content[].id`
  - `content[].name`
  - `content[].arguments`
- Tool result messages expose:
  - `message.toolCallId`
  - `message.toolName`
  - `message.isError`
  - optional `message.details`

Join rule:

- `message.toolCallId == assistant.content[].id`
- `message.toolName == assistant.content[].name`

### Parent ↔ subagent linkage

Observed runtime signals:

- `custom` / `subagents:record` contains durable summary metadata keyed by `data.id`
- `custom_message` / `subagent-notification` contains `details.id` plus `details.outputFile`
- Sidechain path pattern observed on disk:
  - `/tmp/pi-subagents-{uid}/{encoded-cwd}/{parentSessionId}/tasks/{agentId}.output`

Link rule:

- Resolve sidechain transcript by parent session id + subagent id when `details.outputFile` exists or the pattern resolves on disk.

## Sidechain transcript schema (observed)

The sampled `.output` files did **not** use the same schema as parent session JSONL.

Observed sidechain line shape:

- top-level keys: `agentId`, `cwd`, `isSidechain`, `message`, `timestamp`, `type`
- observed top-level `type` values: `user`, `assistant`
- `message` is an object with its own `role` and content fields

Observed assistant-sidechain message fields:

- `role`
- `content`
- `api`
- `provider`
- `model`
- `usage`
- `stopReason`
- `timestamp`
- optional `errorMessage`

Important runtime note:

- In the sampled current runs, each sidechain file only had two lines (`user`, `assistant`) because the background subagent failed very early.
- That means current sidechain evidence confirms the path/linkage and sidechain-specific wrapper schema, but does **not** prove a long multi-turn child transcript in these particular samples.

## Bad-input behavior to preserve in parser/tests

Fixture expectations for later parser work:

- malformed JSON line: warn and continue line-by-line when possible
- truncated final line / partial JSON object: mark session incomplete
- missing sidechain file: non-fatal; preserve warning/enrichment-missing state
- unknown future record type: preserve raw evidence for bookkeeping, do not crash

## Runtime facts that differ from design notes

These differences should override older assumptions:

1. `custom_message` is present in live parent logs.
   - The design note scoped parent handling around `custom`, but sampled runtime data also emits `custom_message`.
2. `subagent-notification` appeared as `type: "custom_message"`, not as a plain `custom` record.
3. `session_info` was not present in the sampled parent sessions.
4. `session.parentSession` can appear on newer parent-session headers.
5. Sidechain `.output` files use a sidechain wrapper schema (`type: user|assistant`, `isSidechain`, `agentId`, `message`) rather than the parent log's `type: message/custom/...` envelope.
