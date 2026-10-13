import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getCurrentTools, type ToolResultMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { agentCall, type PrintModeRun, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

it.each([false, true])("reports native usage once across retrieval and resume (background=%s)", async (background) => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-controls-"));
  let run: PrintModeRun | undefined;
  try {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ reportUsage: true, showCost: true }));
    writeFileSync(join(cwd, ".pi", "agents", "controlled.md"), "---\ndescription: Controlled\nmodel: faux/faux-1\nthinking: high\n---\nReport.\n");
    run = await runPrintMode({
      cwd,
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "controlled", prompt: "Report.", description: "controls", run_in_background: background }),
        parentFinal: (ctx) => {
          const results = ctx.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
          const details = results[0]?.details;
          if (!details || typeof details !== "object" || !("agentId" in details) || typeof details.agentId !== "string") throw new Error("Missing agent ID");
          if (results.length === 2) return agentCall({ subagent_type: "controlled", prompt: "Continue.", description: "resume", resume: details.agentId }, { id: "resume" });
          if (results.length < 5) return { type: "toolCall", id: `retrieve-${results.length}`, name: "get_agent_result", arguments: { run_id: details.agentId, wait: true } };
          return "Done";
        },
        subagent: "Complete",
      }),
    });
    const results = run.parentSession.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
    expect(results).toHaveLength(5);
    const details = results[0]?.details;
    if (!details || typeof details !== "object" || !("agentId" in details) || typeof details.agentId !== "string") throw new Error("Missing agent ID");
    const childStats = run.manager?.getRecord(details.agentId)?.session?.getSessionStats();
    if (!childStats) throw new Error("Missing child session");
    // Faux estimates tokens while streaming. Compare against the child's native
    // ledger, independently of our manager accumulator and reported pool.
    expect(childStats.tokens.total).toBeGreaterThan(0);
    expect(childStats.cost).toBe(0); // Native faux is unpriced; priced deltas are covered by integration fixtures.
    expect(results.reduce((sum, result) => sum + (result.usage?.totalTokens ?? 0), 0)).toBe(childStats.tokens.total);
    expect(results.reduce((sum, result) => sum + (result.usage?.cacheRead ?? 0), 0)).toBe(childStats.tokens.cacheRead);
    expect(results.reduce((sum, result) => sum + (result.usage?.cost.total ?? 0), 0)).toBeCloseTo(childStats.cost);
    expect(results[4]?.usage).toBeUndefined();
    const mainTokens = run.parentSession.messages.reduce((sum, message) => sum + (message.role === "assistant" ? message.usage.totalTokens : 0), 0);
    const mainCost = run.parentSession.messages.reduce((sum, message) => sum + (message.role === "assistant" ? message.usage.cost.total : 0), 0);
    expect(run.parentSession.getSessionStats().tokens.total).toBe(mainTokens + childStats.tokens.total);
    expect(run.parentSession.getSessionStats().cost).toBeCloseTo(mainCost + childStats.cost);
    expect(run.manager?.getLifetimeCost()).toBeCloseTo(childStats.cost);
    expect(results[1]?.details).toMatchObject({ modelName: "faux/faux-1", thinking: "off", requestedThinking: "high", cost: expect.any(Number) });
    expect(results[3]?.details).toMatchObject({ modelName: "faux/faux-1", thinking: "off", requestedThinking: "high", cost: childStats.cost });
    if (background) {
      expect(results[0]?.details).toMatchObject({ modelName: undefined, thinking: undefined });
      expect(results[0]?.details).not.toHaveProperty("requestedThinking");
    }
  } finally {
    try { await run?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});

it("keeps accounting and expanded cost opt-in in a real session", async () => {
  const run = await runPrintMode({
    prompt: "Delegate.",
    respond: routeBySession({
      parentInitial: agentCall({ prompt: "Report.", description: "defaults", isolated: true }),
      subagent: "Complete",
    }),
  });
  try {
    const result = run.parentSession.messages.find((message) => message.role === "toolResult");
    expect(result?.usage).toBeUndefined();
    expect(result?.details).not.toHaveProperty("cost");
    const mainCost = run.parentSession.messages.reduce((sum, message) => sum + (message.role === "assistant" ? message.usage.cost.total : 0), 0);
    expect(run.parentSession.getSessionStats().cost).toBeCloseTo(mainCost);
    const mainTokens = run.parentSession.messages.reduce((sum, message) => sum + (message.role === "assistant" ? message.usage.totalTokens : 0), 0);
    expect(run.parentSession.getSessionStats().tokens.total).toBe(mainTokens);
  } finally { await run.dispose(); }
});

it("waits for a queued background result in the real host", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-queued-result-"));
  const originalHome = process.env.HOME;
  let isolatedHome: string | undefined;
  let run: PrintModeRun | undefined;
  const blocker = Promise.withResolvers<void>();
  const target = Promise.withResolvers<void>();
  const retrievalStarted = Promise.withResolvers<void>();
  const targetStarted = Promise.withResolvers<void>();
  let childCalls = 0;
  let targetId: string | undefined;
  let retrievalReturned = false;
  let unsubscribe: (() => void) | undefined;
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    run = await runPrintMode({
      cwd,
      hold: false,
      prompt: "Delegate.",
      beforeRun: () => { isolatedHome = process.env.HOME; },
      respond: async (ctx) => {
        if (!getCurrentTools(ctx.messages).some((tool) => tool.name === "agent")) {
          if (++childCalls === 1) {
            await blocker.promise;
            return "Blocker complete";
          }
          targetStarted.resolve();
          await target.promise;
          return "Queued execution payload";
        }
        if (targetId) return ctx.messages.some((message) => message.role === "toolResult" && message.toolName === "get_agent_result")
          ? "Retrieved"
          : { type: "toolCall", id: "queued-retrieval", name: "get_agent_result", arguments: { run_id: targetId, wait: true } };
        return ctx.messages.some((message) => message.role === "toolResult") ? "Queued" : ["blocker", "target"].map((description) =>
          agentCall({ prompt: description, description, isolated: true, run_in_background: true }, { id: description }));
      },
    });
    const launch = run.parentSession.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "target");
    const details = launch?.details;
    if (!details || typeof details !== "object" || !("agentId" in details) || typeof details.agentId !== "string") throw new Error("Missing queued agent ID");
    targetId = details.agentId;
    const record = run.manager?.getRecord(targetId);
    if (!record) throw new Error("Missing queued record");
    const executionId = record.executionId;
    let statusAtRetrieval: string | undefined;
    unsubscribe = run.parentSession.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolCallId === "queued-retrieval") {
        statusAtRetrieval = record.status;
        retrievalStarted.resolve();
      }
      if (event.type === "tool_execution_end" && event.toolCallId === "queued-retrieval") retrievalReturned = true;
    });
    const pending = run.parentSession.prompt("Retrieve the queued result.");
    await retrievalStarted.promise;
    await nextTurn();
    expect(statusAtRetrieval).toBe("queued");
    expect(retrievalReturned).toBe(false);
    blocker.resolve();
    await targetStarted.promise;
    await nextTurn();
    expect(retrievalReturned).toBe(false);
    target.resolve();
    await pending;
    await run.manager?.waitForAll();
    const result = run.parentSession.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "queued-retrieval");
    expect(result?.details).toMatchObject({ agentId: targetId, status: "completed", result: "Queued execution payload" });
    expect(record.executionId).toBe(executionId);
    expect(retrievalReturned).toBe(true);
    expect(run.manager?.hasRunning()).toBe(false);
  } finally {
    blocker.resolve();
    target.resolve();
    unsubscribe?.();
    try { await run?.dispose(); } finally {
      rmSync(cwd, { recursive: true, force: true });
      if (isolatedHome && isolatedHome !== originalHome) rmSync(isolatedHome, { recursive: true, force: true });
    }
  }
  expect(process.env.HOME).toBe(originalHome);
  expect(existsSync(cwd)).toBe(false);
  expect(isolatedHome).toBeDefined();
  expect(existsSync(isolatedHome ?? "")).toBe(false);
});

it("returns complete inline results for queued foreground calls in the real host", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-foreground-"));
  let run: PrintModeRun | undefined;
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrentForeground: 1 }));
    run = await runPrintMode({
      cwd,
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: ["one", "two", "three"].map((description) => agentCall({ prompt: description, description, isolated: true }, { id: description })),
        subagent: "Complete",
      }),
    });
    const results = run.parentSession.messages.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "agent");
    expect(results).toHaveLength(3);
    for (const result of results) expect(result.details).toMatchObject({ status: "completed", result: "Complete", toolUses: 0 });
    expect(run.manager?.hasRunning()).toBe(false);
  } finally {
    try { await run?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});
