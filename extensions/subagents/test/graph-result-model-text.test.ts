import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { GateRequest } from "../src/graph/gate-handoff.js";
import { graphRunCompletionText, writeGraphResultArtifact } from "../src/graph/notification.js";
import { createGraphResultObserver } from "../src/graph/result-observer.js";
import { createGraphRunTask, type GraphRunTask, graphRunModelText, graphRunResultText } from "../src/graph/task.js";
import { createOutputFilePath } from "../src/output-file.js";

function completed(value: unknown, id = "agr_note"): GraphRunTask {
  const task = createGraphRunTask({ id, script: "", meta: { name: "demo", description: "demo" } });
  task.status = "completed";
  task.value = value;
  task.endTime = task.startTime + 1;
  return task;
}

const feedbackValue = {
  outputs: { answer: "yes", n: 1 },
  feedback: {
    research: {
      reason: "iteration limit",
      partial: true,
      iterations: [{ iteration: 1, tasks: ["round-secret"] }],
      gaps: [{ id: "g", description: "missing" }],
      counters: { iterations: 1, totalItems: 2 },
      exhaustedBounds: ["maxIterations"],
      extra: "drop-me",
    },
  },
};

const feedbackSummary = {
  outputs: feedbackValue.outputs,
  feedback: {
    research: {
      reason: "iteration limit",
      partial: true,
      counters: { iterations: 1, totalItems: 2 },
      gaps: [{ id: "g", description: "missing" }],
      exhaustedBounds: ["maxIterations"],
    },
  },
};

describe("graphRunModelText", () => {
  it("returns compact outputs plus a feedback summary and the artifact path", () => {
    const task = completed(feedbackValue);
    task.resultPath = "/tmp/agr_note.graph-result.txt";
    const text = graphRunModelText(task);
    const [body, link] = text.split("\n\n");
    expect(body).toBe(JSON.stringify(feedbackSummary));
    expect(body).not.toContain("round-secret");
    expect(body).not.toContain("drop-me");
    expect(JSON.parse(body).feedback.research).not.toHaveProperty("iterations");
    expect(link).toBe("Full result with every round: /tmp/agr_note.graph-result.txt");
  });

  it("omits undefined summary fields and appends the save warning when no artifact path exists", () => {
    const task = completed({
      outputs: { answer: "yes" },
      feedback: { research: { reason: "sufficient", partial: false, iterations: [{ secret: "round" }], extra: true } },
    });
    task.resultArtifactError = "Full graph run result could not be saved: EISDIR";
    task.resultPath = "/tmp/full.txt";
    expect(graphRunModelText(task)).toBe(
      `${JSON.stringify({ outputs: { answer: "yes" }, feedback: { research: { reason: "sufficient", partial: false } } })}\n\nFull result with every round: /tmp/full.txt`,
    );
    task.resultPath = undefined;
    expect(graphRunModelText(task)).toBe(
      `${JSON.stringify({ outputs: { answer: "yes" }, feedback: { research: { reason: "sufficient", partial: false } } })}\n\nFull graph run result could not be saved: EISDIR`,
    );
  });

  it("matches graphRunResultText when the value has no plain feedback object", () => {
    for (const value of [{ outputs: { a: 1 }, extra: [1, 2] }, { outputs: { a: 1 }, feedback: ["nope"] }, { a: 1 }, null, 3, ["x"]]) {
      const task = completed(value);
      task.resultPath = "/tmp/ignored.txt";
      expect(graphRunModelText(task)).toBe(graphRunResultText(task));
    }
  });

  it("returns the error, an absent value, or a string as-is", () => {
    const failed = completed(feedbackValue);
    failed.error = "research: boom";
    failed.resultPath = "/tmp/x";
    expect(graphRunModelText(failed)).toBe("research: boom");
    expect(graphRunModelText(failed)).toBe(graphRunResultText(failed));
    expect(graphRunModelText(completed(undefined))).toBe("No output.");
    const text = completed("done");
    text.resultPath = "/tmp/x";
    expect(graphRunModelText(text)).toBe("done");
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function ctxFor(cwd: string, notify?: (message: string, level: string) => void): ExtensionContext {
  return { cwd, hasUI: notify !== undefined, ui: { notify }, sessionManager: { getSessionId: () => "sess" } } as unknown as ExtensionContext;
}

describe("writeGraphResultArtifact", () => {
  it("is idempotent and leaves graphRunCompletionText unchanged", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-model-"));
    tmpDirs.push(cwd);
    const ctx = ctxFor(cwd);
    const fresh = completed("q".repeat(2000));
    const direct = graphRunCompletionText(ctx, fresh);
    const via = completed("q".repeat(2000), "agr_via1");
    writeGraphResultArtifact(ctx, via);
    expect(via.resultPath).toBeDefined();
    expect(readFileSync(via.resultPath as string, "utf-8")).toBe(graphRunResultText(via));
    writeFileSync(via.resultPath as string, "sentinel");
    writeGraphResultArtifact(ctx, via);
    expect(readFileSync(via.resultPath as string, "utf-8")).toBe("sentinel");
    expect(graphRunCompletionText(ctx, via)).toBe(graphRunCompletionText(ctxFor(cwd), completed("q".repeat(2000), "agr_via1")));
    expect(direct).toBe(graphRunCompletionText(ctxFor(cwd), completed("q".repeat(2000))));
    expect(direct).toContain(`<result-file>${fresh.resultPath}</result-file>`);
  });

  it("does not notify again after a failed save, and completion text still carries the warning", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-model-"));
    tmpDirs.push(cwd);
    const tasksDir = dirname(createOutputFilePath(cwd, "agr_fail1", "sess"));
    mkdirSync(join(tasksDir, "agr_fail1.graph-result.txt"));
    const warnings: string[] = [];
    const ctx = ctxFor(cwd, message => warnings.push(message));
    const task = completed("w".repeat(2000), "agr_fail1");
    writeGraphResultArtifact(ctx, task);
    const first = graphRunCompletionText(ctx, task);
    writeGraphResultArtifact(ctx, task);
    expect(warnings).toHaveLength(1);
    expect(graphRunCompletionText(ctx, task)).toBe(first);
    expect(first).toContain(`Warning: ${task.resultArtifactError}`);
    expect(first).not.toContain("<result-file>");
  });
});

describe("graph retrieval text", () => {
  it("returns the feedback summary without rounds and keeps iterations on details.output", async () => {
    const task = completed(feedbackValue, "agr_0123456789ab");
    task.resultPath = "/tmp/agr_0123456789ab.graph-result.txt";
    const result = await createGraphResultObserver(() => task, () => undefined, () => {}, () => {}).retrieve(task.id, false);
    const text = result.content.map(part => part.text ?? "").join("\n");
    expect(text).toContain(JSON.stringify(feedbackSummary));
    expect(text).toContain(task.resultPath ?? "");
    expect(text).not.toContain("round-secret");
    expect(result.details.output).toBe(task.value);
    const output = result.details.output as typeof feedbackValue;
    expect(output.feedback.research.iterations).toEqual([{ iteration: 1, tasks: ["round-secret"] }]);
  });

  it("keeps a non-feedback result identical to graphRunResultText", async () => {
    const task = completed({ answer: "yes", nested: { a: 1 } }, "agr_0123456789ab");
    const result = await createGraphResultObserver(() => task, () => undefined, () => {}, () => {}).retrieve(task.id, false);
    expect(result.content.map(part => part.text ?? "").join("\n")).toBe(
      `Graph: ${task.id}\nExecution: completed\n\n${graphRunResultText(task)}`,
    );
  });

  it("keeps gate retrieval text and does not substitute the model summary", async () => {
    const task = completed(feedbackValue, "agr_0123456789ab");
    task.resultPath = "/tmp/agr_0123456789ab.graph-result.txt";
    const request: GateRequest = {
      gate_id: "g1", revision: "r1", kind: "human_gate", prompt: "Approve?", response_schema: { type: "object" },
    };
    const result = await createGraphResultObserver(() => task, () => request, () => {}, () => {}).retrieve(task.id, false);
    const text = result.content.map(part => part.text ?? "").join("\n");
    expect(text).toContain("resolve_agent_graph_gate");
    expect(text).toContain(JSON.stringify(request));
    expect(text).not.toContain(task.resultPath ?? "");
    expect(text).not.toContain("round-secret");
  });
});
