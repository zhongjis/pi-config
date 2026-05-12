# Subagent TUI Rendering Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop multi-subagent TUI blinking while making subagent summary rendering compact, consistent, and testable.

**Architecture:** Add one deep summary-rendering Module for compact subagent status surfaces, plus one small render-scheduling Module to coalesce update bursts. Keep `ConversationViewer` separate because it is a scrollable conversation overlay, not a compact summary surface. Keep current tool/event/result interfaces stable.

**Tech Stack:** TypeScript, Pi extension runtime, `@mariozechner/pi-tui`, Vitest, `@marcfargas/pi-test-harness`.

---

## Evidence

From session `019e1b4c-fefc-739a-83d3-918e5018c747`:

- User requested parallel pings.
- Assistant emitted 13 `Agent` tool calls at `2026-05-12T08:29:57.263Z`.
- Results clustered at `08:30:13.143Z` through `08:30:13.146Z`.
- 5 agents were background/queued, 2 completed foreground despite `run_in_background: true` because their agent config sets `run_in_background: false`, 6 were blocked by delegation policy.
- Current code has multiple render loops/surfaces:
  - `extensions/subagent/src/index.ts` `Agent.renderResult()` formats tool result UI.
  - `extensions/subagent/src/index.ts` message renderer formats `subagent-notification`.
  - `extensions/subagent/src/index.ts` foreground path starts one `setInterval(..., 80)` per foreground call.
  - `extensions/subagent/src/ui/agent-widget.ts` owns persistent widget updates every 250ms.

## File Structure

- Create `extensions/subagent/src/ui/summary-renderer.ts`
  - Pure compact summary renderer Module.
  - Interface takes snapshots, theme, width/surface options.
  - Implementation owns status icons, stats text, activity text, result previews, width truncation.

- Create `extensions/subagent/src/ui/render-scheduler.ts`
  - Coalesces render requests.
  - Interface: request immediate flush, request throttled animation/progress render, dispose.
  - Implementation owns one timer/cadence per surface, not per agent.

- Modify `extensions/subagent/src/ui/agent-widget.ts`
  - Use `summary-renderer.ts` for agent lines.
  - Keep widget lifecycle and setWidget callback here.
  - Use `render-scheduler.ts` or aligned cadence behavior so update bursts do not re-register/churn.

- Modify `extensions/subagent/src/index.ts`
  - Replace duplicated `Agent.renderResult()` formatting with `summary-renderer.ts` adapter calls.
  - Replace `subagent-notification` renderer formatting with `summary-renderer.ts` adapter calls.
  - Replace per-foreground-agent 80ms spinner interval with coalesced scheduler.
  - Preserve public tool params/results/events.

- Leave `extensions/subagent/src/ui/conversation-viewer.ts` unchanged except if tests expose width bug directly in that file.

- Add/modify tests:
  - `extensions/subagent/test/summary-renderer.test.ts`
  - `extensions/subagent/test/render-scheduler.test.ts`
  - `extensions/subagent/test/agent-widget.test.ts`
  - `test/integration/subagent-tui-rendering.integration.test.ts`

---

## Task 1: Pure Summary Renderer

**Files:**
- Create: `extensions/subagent/src/ui/summary-renderer.ts`
- Test: `extensions/subagent/test/summary-renderer.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Cover these cases:

```ts
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  renderAgentSummaryLine,
  renderAgentResultLines,
  renderNotificationLines,
  type AgentSummarySnapshot,
} from "../src/ui/summary-renderer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function base(overrides: Partial<AgentSummarySnapshot> = {}): AgentSummarySnapshot {
  return {
    id: "agent-1",
    displayName: "Jintong 金童",
    description: "Ping jintong",
    status: "running",
    toolUses: 2,
    durationMs: 1200,
    tokens: "󰾆 19.3k",
    turnCount: 3,
    maxTurns: 10,
    modelLabel: "anthropic/claude-haiku-4-5",
    activity: "thinking…",
    ...overrides,
  };
}

describe("subagent summary renderer", () => {
  it("renders compact running summary with consistent stats", () => {
    const line = renderAgentSummaryLine(base(), theme, { width: 80, spinner: "⠋" });
    expect(line).toContain("⠋");
    expect(line).toContain("Jintong 金童");
    expect(line).toContain("⟳ 3≤10");
    expect(line).toContain("󱁤 2");
    expect(line).toContain("󰾆 19.3k");
  });

  it("renders completed result lines without spinner", () => {
    const lines = renderAgentResultLines(base({ status: "completed", resultPreview: "Online and ready." }), theme, { width: 80 });
    expect(lines.join("\n")).toContain("✓");
    expect(lines.join("\n")).toContain("Online and ready.");
    expect(lines.join("\n")).not.toContain("⠋");
  });

  it("renders notification lines for grouped agents", () => {
    const lines = renderNotificationLines([
      base({ status: "completed", resultPreview: "A" }),
      base({ id: "agent-2", displayName: "Wenchang 文昌", description: "Ping wenchang", status: "completed", resultPreview: "B" }),
    ], theme, { width: 80 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Ping jintong");
    expect(lines[1]).toContain("Ping wenchang");
  });

  it.each([40, 80, 120])("keeps visible width <= %i", (width) => {
    const long = base({ description: "x".repeat(200), resultPreview: "y".repeat(200) });
    const lines = [
      renderAgentSummaryLine(long, theme, { width, spinner: "⠋" }),
      ...renderAgentResultLines(long, theme, { width }),
      ...renderNotificationLines([long], theme, { width }),
    ];
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --dir extensions/subagent test -- summary-renderer
```

Expected: fail because `summary-renderer.ts` does not exist.

- [ ] **Step 3: Implement minimal renderer**

Create `summary-renderer.ts` with:

```ts
import { truncateToWidth } from "@mariozechner/pi-tui";

export type SummaryStatus = "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";

export interface SummaryTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface AgentSummarySnapshot {
  id?: string;
  displayName: string;
  description: string;
  status: SummaryStatus;
  toolUses: number;
  durationMs: number;
  tokens?: string;
  turnCount?: number;
  maxTurns?: number;
  modelLabel?: string;
  tags?: string[];
  activity?: string;
  error?: string;
  resultPreview?: string;
}

export interface SummaryRenderOptions {
  width: number;
  spinner?: string;
  expanded?: boolean;
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTurns(turnCount: number, maxTurns?: number): string {
  return maxTurns != null ? `⟳ ${turnCount}≤${maxTurns}` : `⟳ ${turnCount}`;
}

function iconFor(status: SummaryStatus, theme: SummaryTheme, spinner?: string): string {
  if (status === "running") return theme.fg("accent", spinner ?? "●");
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "steered") return theme.fg("warning", "✓");
  if (status === "stopped") return theme.fg("dim", "■");
  if (status === "queued" || status === "background") return theme.fg("muted", "◦");
  return theme.fg("error", "✗");
}

function statsFor(s: AgentSummarySnapshot): string[] {
  const parts: string[] = [];
  if (s.modelLabel) parts.push(s.modelLabel);
  if (s.tags?.length) parts.push(...s.tags);
  if (s.turnCount != null) parts.push(formatTurns(s.turnCount, s.maxTurns));
  if (s.toolUses > 0) parts.push(`󱁤 ${s.toolUses}`);
  if (s.tokens) parts.push(s.tokens);
  if (s.durationMs > 0) parts.push(formatMs(s.durationMs));
  return parts;
}

function statusSuffix(s: AgentSummarySnapshot, theme: SummaryTheme): string {
  if (s.status === "steered") return theme.fg("warning", " turn-limit");
  if (s.status === "stopped") return theme.fg("dim", " stopped");
  if (s.status === "aborted") return theme.fg("warning", " aborted");
  if (s.status === "error") return theme.fg("error", ` error${s.error ? `: ${s.error.slice(0, 60)}` : ""}`);
  return "";
}

export function renderAgentSummaryLine(s: AgentSummarySnapshot, theme: SummaryTheme, opts: SummaryRenderOptions): string {
  const stats = statsFor(s).map((part) => theme.fg("dim", part)).join(theme.fg("dim", " · "));
  const main = `${iconFor(s.status, theme, opts.spinner)} ${theme.bold(s.displayName)}  ${theme.fg("muted", s.description)}`;
  const line = stats ? `${main} ${theme.fg("dim", "·")} ${stats}${statusSuffix(s, theme)}` : `${main}${statusSuffix(s, theme)}`;
  return truncateToWidth(line, opts.width);
}

export function renderAgentResultLines(s: AgentSummarySnapshot, theme: SummaryTheme, opts: SummaryRenderOptions): string[] {
  const lines = [renderAgentSummaryLine(s, theme, opts)];
  if (s.status === "running" && s.activity) {
    lines.push(truncateToWidth(theme.fg("dim", `  ⎿  ${s.activity}`), opts.width));
  } else if (s.resultPreview) {
    const preview = s.resultPreview.split("\n").find((line) => line.trim())?.trim() ?? "";
    if (preview) lines.push(truncateToWidth(theme.fg("dim", `  ⎿  ${preview}`), opts.width));
  }
  return lines;
}

export function renderNotificationLines(snapshots: AgentSummarySnapshot[], theme: SummaryTheme, opts: SummaryRenderOptions): string[] {
  return snapshots.map((snapshot) => {
    const preview = snapshot.resultPreview?.split("\n")[0]?.trim();
    const suffix = preview ? ` ${theme.fg("dim", `⎿ ${preview}`)}` : "";
    return truncateToWidth(`${renderAgentSummaryLine(snapshot, theme, opts)}${suffix}`, opts.width);
  });
}
```

- [ ] **Step 4: Run renderer tests**

```bash
pnpm --dir extensions/subagent test -- summary-renderer
```

Expected: pass.

---

## Task 2: Render Scheduler

**Files:**
- Create: `extensions/subagent/src/ui/render-scheduler.ts`
- Test: `extensions/subagent/test/render-scheduler.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "../src/ui/render-scheduler.js";

describe("RenderScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces many requests in the same tick", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const scheduler = new RenderScheduler(flush, { cadenceMs: 250 });

    for (let i = 0; i < 13; i++) scheduler.request();
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(flush).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("flushes immediate requests once", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const scheduler = new RenderScheduler(flush, { cadenceMs: 250 });

    scheduler.flushNow();
    scheduler.flushNow();
    expect(flush).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("dispose clears pending timer", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const scheduler = new RenderScheduler(flush, { cadenceMs: 250 });

    scheduler.request();
    scheduler.dispose();
    vi.advanceTimersByTime(250);

    expect(flush).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --dir extensions/subagent test -- render-scheduler
```

Expected: fail because `render-scheduler.ts` does not exist.

- [ ] **Step 3: Implement scheduler**

```ts
export interface RenderSchedulerOptions {
  cadenceMs?: number;
}

export class RenderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly flush: () => void,
    private readonly options: RenderSchedulerOptions = {},
  ) {}

  request(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) this.flush();
    }, this.options.cadenceMs ?? 250);
  }

  flushNow(): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
```

- [ ] **Step 4: Run scheduler tests**

```bash
pnpm --dir extensions/subagent test -- render-scheduler
```

Expected: pass.

---

## Task 3: Use Summary Renderer in AgentWidget

**Files:**
- Modify: `extensions/subagent/src/ui/agent-widget.ts`
- Test: `extensions/subagent/test/agent-widget.test.ts`

- [ ] **Step 1: Add widget tests for compact rendering and no registration churn**

Extend existing `AgentWidget render scheduling` tests:

```ts
it("registers widget once and uses requestRender for repeated updates", () => {
  const record = mockRecord({ status: "running", description: "parallel ping" });
  const manager = { listAgents: vi.fn(() => [record]) };
  const widget = new AgentWidget(manager as never, new Map());
  const requestRender = vi.fn();
  const ui = {
    setStatus: vi.fn(),
    setWidget: vi.fn((_key, factory) => {
      if (factory) factory({ terminal: { columns: 80 }, requestRender }, fakeTheme);
    }),
  };

  widget.setUICtx(ui as never);
  widget.update();
  widget.update();
  widget.update();

  expect(ui.setWidget).toHaveBeenCalledTimes(1);
  expect(requestRender.mock.calls.length).toBeLessThanOrEqual(1);
});
```

Use existing test helpers in `agent-widget.test.ts` rather than duplicating if they already exist.

- [ ] **Step 2: Run widget tests**

```bash
pnpm --dir extensions/subagent test -- agent-widget
```

Expected: current behavior likely passes some registration checks, but compact summary expectations fail until renderer integration.

- [ ] **Step 3: Refactor widget line rendering**

Change `AgentWidget` to build `AgentSummarySnapshot` and call `renderAgentSummaryLine()` / `renderAgentResultLines()` for finished/running rows. Preserve:

- `setWidget("agents", callback, { placement: "aboveEditor" })`
- one registration per `UICtx`
- `requestRender()` for subsequent updates
- `MAX_WIDGET_LINES` overflow behavior
- `setStatus("subagents", ...)`

- [ ] **Step 4: Run widget tests**

```bash
pnpm --dir extensions/subagent test -- agent-widget summary-renderer
```

Expected: pass.

---

## Task 4: Use Summary Renderer in index.ts Renderers

**Files:**
- Modify: `extensions/subagent/src/index.ts`
- Test: existing unit tests plus focused integration test in Task 6

- [ ] **Step 1: Run current relevant tests before change**

```bash
pnpm --dir extensions/subagent test -- agent-widget index.session-context
```

Expected: pass before edits.

- [ ] **Step 2: Replace message renderer formatting**

In `pi.registerMessageRenderer<NotificationDetails>("subagent-notification", ...)`, map `NotificationDetails` to `AgentSummarySnapshot[]` and call `renderNotificationLines()`.

Do not change `NotificationDetails` fields.

- [ ] **Step 3: Replace Agent tool result formatting**

In `Agent.renderResult`, map `AgentDetails` to `AgentSummarySnapshot` and call `renderAgentResultLines()`.

Preserve behavior branches:

- no details → raw text
- `running`/partial → spinner + activity
- `background` → background ID message
- terminal statuses → compact summary + optional expanded content

- [ ] **Step 4: Run focused tests**

```bash
pnpm --dir extensions/subagent test -- agent-widget index.session-context
```

Expected: pass.

---

## Task 5: Coalesce Foreground Spinner Updates

**Files:**
- Modify: `extensions/subagent/src/index.ts`
- Use: `extensions/subagent/src/ui/render-scheduler.ts`
- Test: `extensions/subagent/test/render-scheduler.test.ts`; integration in Task 6

- [ ] **Step 1: Add unit assertion for foreground cadence helper if helper is extracted**

If a helper is extracted from `index.ts`, cover it with fake timers. If no helper is extracted, skip this unit test and rely on integration in Task 6.

- [ ] **Step 2: Replace per-agent 80ms interval**

Replace:

```ts
const spinnerInterval = setInterval(() => {
  spinnerFrame++;
  streamUpdate();
}, 80);
```

with a `RenderScheduler` created for the foreground call:

```ts
const foregroundRenderScheduler = new RenderScheduler(() => {
  spinnerFrame++;
  streamUpdate();
}, { cadenceMs: 250 });
```

Use:

- `foregroundRenderScheduler.flushNow()` at start and terminal completion/error.
- `foregroundRenderScheduler.request()` for text/tool/turn progress callbacks.
- `foregroundRenderScheduler.dispose()` in `finally` after `manager.spawnAndWait()`.

- [ ] **Step 3: Preserve immediate state transitions**

Ensure start, completion, error, stopped, aborted still produce final tool result immediately. Only animation/progress deltas are throttled.

- [ ] **Step 4: Run focused tests**

```bash
pnpm --dir extensions/subagent test -- render-scheduler agent-widget agent-runner
```

Expected: pass.

---

## Task 6: Pi Test Harness Regression for Parallel Agents

**Files:**
- Create: `test/integration/subagent-tui-rendering.integration.test.ts`
- Read pattern: `test/integration/subagent-tool-access.integration.test.ts`

- [ ] **Step 1: Write failing integration test**

Use `@marcfargas/pi-test-harness` to load subagent extension and run a playbook with many `Agent` calls in one turn.

Test should assert:

- tool calls complete without throwing
- `setWidget` registration count stays bounded
- render requests stay bounded under parallel spawn burst
- final result still available for background agents

Implementation notes:

- Use temp `PI_CODING_AGENT_DIR` and custom agent files where needed.
- Include at least one agent config with `run_in_background: false` to reproduce mixed foreground/background behavior.
- Intercept/mock UI methods if harness exposes calls; otherwise wrap `ctx.ui.setWidget` in a tiny test extension loaded after subagent to count calls.

- [ ] **Step 2: Run failing integration test**

```bash
pnpm test:integration -- subagent-tui-rendering
```

Expected before fix: excessive render/update count or missing compact behavior assertion.

- [ ] **Step 3: Adjust test to stable harness surface**

If pi-test-harness cannot observe `requestRender` directly, assert closest stable proxy:

- count `setWidget("agents", ...)` calls
- count `setStatus("subagents", ...)` changes
- assert no more than one widget registration per UI context
- assert grouped completion notification appears once for multiple background completions

- [ ] **Step 4: Run integration test after implementation**

```bash
pnpm test:integration -- subagent-tui-rendering
```

Expected: pass.

---

## Task 7: Full Verification

**Files:**
- No new files unless docs need updating after behavior changes.

- [ ] **Step 1: Typecheck subagent extension**

```bash
pnpm --dir extensions/subagent typecheck
```

Expected: pass.

- [ ] **Step 2: Run subagent test suite**

```bash
pnpm --dir extensions/subagent test
```

Expected: pass.

- [ ] **Step 3: Run integration regression**

```bash
pnpm test:integration -- subagent
```

Expected: pass.

- [ ] **Step 4: Run repo typecheck if touched shared test harness or root integration config**

```bash
pnpm lint:typecheck
```

Expected: pass.

- [ ] **Step 5: Manual readback**

Read these changed files and confirm scope:

- `extensions/subagent/src/ui/summary-renderer.ts`
- `extensions/subagent/src/ui/render-scheduler.ts`
- `extensions/subagent/src/ui/agent-widget.ts`
- `extensions/subagent/src/index.ts`
- test files changed/created

Confirm:

- No `ConversationViewer` behavior changed.
- No public Agent tool params changed.
- No `subagents:*` event payload changed.
- No result/detail shapes changed.

---

## Taishang Review Summary

Taishang agreed with the architecture:

- Add shared summary renderer + scheduler.
- Keep `ConversationViewer` separate.
- Best seam: pure summary renderer plus small scheduling adapter, not a new UI framework.
- Main risk: over-throttling foreground progress. Mitigate with immediate flush on start/end/error and throttling only animation/progress deltas.
- Avoid changing `AgentDetails`, `NotificationDetails`, lifecycle events, or tool params.

## Self-Review

- Spec coverage: Plan covers blink fix, compact/consistent rendering, pi-test-harness regression, and separate ConversationViewer.
- Placeholder scan: No TBD/TODO/later placeholders.
- Type consistency: New terms are `AgentSummarySnapshot`, `SummaryTheme`, `RenderScheduler`; later tasks refer to same names.
