---
name: agent-graphs
description: Contract for running and authoring typed agent graphs. Use before every `agent_graph` call — running a saved graph or an ad-hoc inline graph, building input, collecting results, answering gates — and when authoring or editing a `.graph.json`, `.graph.yaml`, or inline graph.
---

Every `agent_graph` call runs either a saved graph (`graph: "<name>"`) or an ad-hoc inline graph (`graph: { nodes, edges, outputs }`). Pick the path, follow its steps, then follow the shared steps 3–5.

## 1. Pick the path

- The user wrote `$graph:<name>` or named a saved graph → run that saved graph. Never substitute another graph.
- A saved graph's `description` covers the task → run the saved graph.
- Otherwise → compose an ad-hoc inline graph.

## 2a. Saved graph

1. **Find it.** Resolution roots, highest priority first: `<cwd>/.pi/agent-graphs`, `<cwd>/agent-graphs`, `<cwd>/.agents/agent-graphs`, `~/.pi/agent/agent-graphs` (`install.sh` links the repo portfolio here). The first root that contains the name wins. A `/` in the name maps to a subdirectory (`team/review` → `team/review.graph.json`). The same name as `.graph.json` and `.graph.yaml` in one root is an error. List graphs with their descriptions:

   ```sh
   fd -g '*.graph.json' .pi/agent-graphs agent-graphs .agents/agent-graphs ~/.pi/agent/agent-graphs \
     -X jq -r '"\(input_filename): \(.description // "-")"' 2>/dev/null
   ```

   Saved graphs are `.graph.json`; `.graph.yaml` is the fallback format, so read a YAML graph directly instead of using `jq`. The repo portfolio ships `context-gather.graph.json` and `deep-research.graph.json`; their contracts are in [agent-graphs/AGENTS.md](../../../../agent-graphs/AGENTS.md).

2. **Read its contract:** `jq '{description, inputSchema, outputs}' <name>.graph.json`. Each output is a ValueRef. `$agentGraphOutcome` names the node that declares the outcome; it is not a caller field. An output whose source was skipped, or whose path does not exist, is omitted, not `null`.

3. **Build input** that satisfies `inputSchema`. A direct call does not enforce it: validation only checks that the schema compiles. Two paths check input: a user `$graph:<name>` token makes inline-skills reject a call that fails the schema, and `context-gather`'s `semanticPolicy` requires unique, nonempty `requiredCoverage` IDs before dispatch. Any other wrong input runs and spends. A string `input` is JSON-parsed when it parses. Ask the user only for required values you cannot infer.

   ```ts
   agent_graph({
     graph: "context-gather",
     input: {
       request: "...",
       requiredCoverage: [
         { id: "repository", criterion: "Current repository behavior" },
         { id: "upstream", criterion: "Authoritative upstream contract" },
       ],
     },
   })
   ```

## 2b. Ad-hoc inline graph

1. MUST read [references/authoring.md](references/authoring.md) first. Composing an ad-hoc graph is authoring.
2. **Compose it.** Put variable data in `input` and wire it into prompts with `${name}` placeholders: validation checks wired placeholders, not text baked into a prompt. Reuse a saved graph as a `graph` node instead of copying its nodes. A `graph` node and a `$graph:` token cannot reference an inline graph; to reuse a proven one, save it to a resolution root.

   ```ts
   agent_graph({
     graph: {
       description: "Locate an implementation, then explain it",
       nodes: {
         locate: {
           type: "agent", agent: "chengfeng",
           prompt: "Find the files that implement ${topic}.",
           input: { topic: { path: "$.topic" } },
           outputSchema: { type: "object", required: ["files"], additionalProperties: false,
             properties: { files: { type: "array", items: { type: "string" } } } },
         },
         explain: {
           type: "agent", agent: "chengfeng",
           prompt: "Explain how ${topic} works in these files: ${files}",
           input: { topic: { path: "$.topic" }, files: { node: "locate", path: "$.files" } },
           outputSchema: { type: "object", required: ["summary"], additionalProperties: false,
             properties: { summary: { type: "string" } } },
         },
       },
       edges: [{ from: "locate", to: "explain" }],
       outputs: { files: { node: "locate", path: "$.files" }, summary: { node: "explain", path: "$.summary" } },
     },
     input: { topic: "graph validation" },
   })
   ```

## 3. Run and wait

Shape errors and delegation-policy preflight failures return as tool errors before any spend. Preflight requires every node agent, including agents inside saved subgraphs, to be permitted by the current mode. A valid graph starts immediately; there is no dry run.

The call returns a run ID in the tool text (`Task ID: <id>`). Continue only non-overlapping work, then MUST call `get_agent_result({run_id, wait:true})`. NEVER end the turn, poll, or sleep while the run is active. `wait: true` returns when the run settles or a gate is pending. Supervise the live run in `/agents → Graph runs`.

## 4. Gates

A pending gate includes `gate_id`, `revision`, `kind`, `prompt`, and `response_schema`. MUST use `ask` for the human's choice, then:

```ts
resolve_agent_graph_gate({ run_id, gate_id, revision, response: { approved: true } })
get_agent_result({ run_id, wait: true })
```

Copy `run_id`, `gate_id`, and `revision` exactly. Submit the actual human response; NEVER invent approval. `response` MUST match `response_schema`; decision gates expose `{ approved: boolean }`. Retrieval does not consume a gate. Identical responses are idempotent within the activation; stale or conflicting responses fail. Reload gives pending gates fresh revisions, including nested gates; retrieve again before asking. Cancelling retrieval stops only that wait.

## 5. Read the result

`get_agent_result` text is `Graph: <id>`, `Execution: <status>`, `Outcome: <json>` when declared, then the complete result JSON. `details` is `{kind:"graph", status, gate, output, outcome, error}`.

- **Shape.** Flat `{ <outputName>: value }`, or `{ outputs, feedback }` when the graph has a `bounded_feedback` node (both portfolio graphs). There, read `outputs.*`; `feedback.<nodeKey>.reason` says why gathering stopped ([reasons](references/bounded-feedback.md)).
- **Outcome.** `$agentGraphOutcome` is stripped from outputs and shown as Outcome: `succeeded`, `partial: <reason>`, or `failed: <reason>`. Without one, a completed run shows `Completed`. Execution status and Outcome are independent; trust Outcome for objective success.
- **Execution `failed`.** A node failed outside a fanout or `bounded_feedback` collection. The text body is only the `node: error` list; partial outputs remain in `details.output`. `killed` means stopped.
- **Completion notification.** `<status>` carries the Outcome, `Error: <node errors>`, or `Stopped`. `<summary>` counts completed, failed, and skipped agents. `<result>` is a ~500-character preview. `<result-file>`, present only when the preview overflowed, holds the full text.

On a `partial`/`failed` Outcome, or any failed agent, inspect the failed children and the graph's gap fields, such as `context-gather`'s `unknowns`. Whether a failure matters is graph-specific: `context-gather` folds failed evidence into `unknowns`, so a failure there usually means degraded coverage; failed deterministic-gate children signal a real problem. Depend only on structured outputs, never on agent prose.
