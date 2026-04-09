My overall recommendation

Do not start by building a generic cross-agent self-improvement platform.
Start with a Pi-only optimization system that is OTel-native from day one, then generalize later.

That gives you:

- a narrow enough wedge to ship,
- a real environment to learn from,
- and a portable telemetry standard for future agents.[1][3][5]

Why your idea is good

Pi is a particularly good substrate because it already has:

- extensions,
- skills,
- prompt templates,
- packages,
- SDK/RPC integration,
- and session files you can persist and replay.

So compared with many agent tools, Pi is unusually modifiable without forking the core product. That makes it
a very good candidate for an “agent improvement OS.”

Also, there are already early proofs of the pieces you want:

- pi-otel-telemetry shows a sensible trace model: session → prompt → turn → tool spans, plus
  token/tool/session metrics.[6]
- pi-autoresearch shows a reusable optimization loop: edit → benchmark → keep/revert → repeat, persisted in
  autoresearch.jsonl and autoresearch.md.[7]

That means you do not need to invent the core pattern from scratch.

────────────────────────────────────────────────────────────────────────────────

The right architecture

### 1) Data plane

This is the instrumentation layer.

Recommendation:

- Pi extension emits OTLP traces/metrics
- OpenTelemetry Collector sits in front
- one backend behind it

Why OTel first:
OpenTelemetry gives you the most future-proof seam if you later want to ingest other agent runtimes, MCP
servers, or agentic tools.[5]
But be careful: the GenAI semantic conventions are still marked Development, so don’t hard-code your whole
internal schema around exact attribute names yet.[5]

### 2) Eval plane

This is where most teams get confused.

Logs are not evals.
Latency, token count, retries, tool errors, and trace depth tell you about behavior. They do not tell you
whether the result was correct.

Your eval plane should have 3 buckets:

- Synthetic smoke evals
  - catches obvious regressions
  - fast, cheap
- Held-out real task evals
  - your most important dataset
  - curated from actual Pi sessions
- Live outcome metrics
  - completion rate
  - human accept/rework
  - time-to-fix
  - escalation rate
  - cost and latency

### 3) Optimization plane

This is where pi-autoresearch fits.

Use it to optimize bounded, measurable things:

- subagent prompt variants,
- workflow presets,
- model routing rules,
- extension enablement/order,
- retry policies,
- benchmark-driven task flows.[7]

Do not start by fully automating open-ended quality optimization.
That is where teams overfit to judge models or synthetic tasks.

### 4) Control plane

This is the missing layer in your draft.

You need versioning for:

- system prompt
- subagent prompts
- enabled extensions + versions
- workflow definitions
- benchmark datasets
- evaluator prompts/rubrics
- model routing config

And you need promotion rules:

- offline replay
- human spot review
- canary
- rollback

Without this, you don’t have “self-improvement.”
You have “random prompt churn.”

────────────────────────────────────────────────────────────────────────────────

Langfuse vs OTel-native backend

### Langfuse

Good idea if you want fast product velocity.
Langfuse supports OpenTelemetry ingestion and is self-hostable as open source, which makes it a solid
candidate if you want tracing + datasets + prompt/eval workflows in one place.[1][2]

### Phoenix

Good idea if you want the cleanest OSS / OTel-first posture.
Phoenix positions itself as OTel-native and lock-in resistant, supports self-hosting, and supports
evaluations on traces.[3][4][9]

### My startup recommendation

If I were advising you on an MVP, I would choose one of these paths:

#### Path A — fastest learning loop

Pi OTEL extension → OTel Collector → Langfuse

Use this if your main goal is:

- prompt/version experimentation,
- dataset building,
- trace inspection,
- and shipping a working internal system quickly.[1][2]

#### Path B — cleanest infra foundation

Pi OTEL extension → OTel Collector → Phoenix

Use this if your main goal is:

- pure OSS,
- OTel portability,
- lower platform opinionation,
- and a more infrastructure-first architecture.[3][4][9]

### What I would not do

- Langfuse + Phoenix + Tempo + SigNoz all at once
- building your own warehouse first
- trying to support every agent runtime in v1

Pick one primary backend.

────────────────────────────────────────────────────────────────────────────────

How I would scope v1

### Start with Pi only

That matches your instinct, and I agree.

### Optimize only 2–3 workflow families first

Example:

1.  Research / web retrieval
2.  Codebase investigation / discovery
3.  Bounded implementation tasks

Why:

- high repetition
- measurable cost/latency
- easier to label quality than “all coding tasks”

### First-class metrics

Use a scorecard, not a single score.

#### Quality

- human accept / reject
- benchmark pass rate
- issue resolved / not resolved
- evaluator score

#### Efficiency

- wall time
- tokens
- dollar cost
- tool count
- retries / dead-ends

#### Reliability

- error rate
- abort rate
- user correction rate
- rollback rate

#### Safety / hygiene

- blocked dangerous commands
- secret exposure incidents
- irrelevant tool use
- bad mutation rate

Rule: quality is a gate, not a tradeable metric.
Only optimize cost/speed after passing the quality floor.

────────────────────────────────────────────────────────────────────────────────

How pi-autoresearch should fit

pi-autoresearch is a strong optimizer engine, not the whole system.[7]

Use it for:

- controlled experiment loops,
- reproducible benchmark runs,
- keeping or discarding changes.

Do not let it become:

- your sole evaluator,
- your source of truth for quality,
- or your production rollout system.

In other words:

- Telemetry system tells you what happened
- Eval system tells you if it was good
- pi-autoresearch searches for better candidates
- Control plane decides what ships

────────────────────────────────────────────────────────────────────────────────

About SWE-bench

Use SWE-bench as one benchmark family, not the core of the platform.

Why:

- it is excellent for real-world code issue resolution,
- it is reproducible,
- and it is respected.[8]

But it is still a coding benchmark, not a full Pi workflow benchmark.
Your system also cares about:

- research quality,
- orchestration quality,
- tool routing,
- extension overhead,
- and human satisfaction.

So I’d do:

- external benchmarks: SWE-bench / similar for legitimacy and comparability[8]
- internal benchmarks: Pi session replay tasks for actual product fit

────────────────────────────────────────────────────────────────────────────────

The biggest risks

1.  Confusing telemetry with eval
2.  Overfitting to synthetic graders
3.  Changing too many variables at once
4.  No version registry
5.  Logging too much sensitive content
6.  Trying to be cross-agent too early

The hardest failure mode is this:

│ you build a very impressive dashboard that proves nothing actually improved.

────────────────────────────────────────────────────────────────────────────────

Best v1 roadmap

### Phase 1 — Instrument

- build/extend Pi OTEL extension
- emit spans for session, prompt, turn, tool, subagent
- attach version metadata for prompts/extensions/models
- send through OTel Collector

### Phase 2 — Evaluate

- collect 50–100 real Pi tasks
- define 3–5 workflow families
- add human labels
- add a small synthetic smoke suite

### Phase 3 — Optimize one workflow

- pick one family only
- run offline replay
- compare candidates
- human review
- canary
- rollback if needed

### Phase 4 — Generalize

- define canonical event schema
- onboard other OTel-capable agents
- keep Pi as reference implementation

────────────────────────────────────────────────────────────────────────────────

Bottom line

Yes, build it.
But build it as:

- Pi-first
- OTel-native
- one backend
- small real-task eval set
- versioned prompts/workflows
- human-reviewed optimization

If you do that, this can become a real startup-grade system.

If you want, next I can turn this into either:

1.  a reference architecture diagram, or
2.  a 90-day MVP build plan with components, schemas, and milestones.

Sources:
[1] Open Source LLM Observability via OpenTelemetry - Langfuse
(https://langfuse.com/docs/opentelemetry/example-opentelemetry-collector)
[2] Self-host Langfuse (Open Source LLM Observability) (https://docs.langfuse.com/self-hosting)
[3] Phoenix OSS - Arize AI (https://arize.com/phoenix-oss/)
[4] Phoenix Self-Hosting Configuration (https://docs.arize.com/phoenix/self-hosting/configuration)
[5] OpenTelemetry Semantic Conventions for Generative AI Systems
(https://opentelemetry.io/docs/specs/semconv/gen-ai/)
[6] mprokopov/pi-otel-telemetry (https://github.com/mprokopov/pi-otel-telemetry)
[7] davebcn87/pi-autoresearch (https://github.com/davebcn87/pi-autoresearch)
[8] SWE-bench Overview (https://www.swebench.com/SWE-bench/)
[9] Running Evals on Traces - Phoenix
(https://arize.com/docs/phoenix/tracing/how-to-tracing/feedback-and-annotations/evaluating-phoenix-traces)
