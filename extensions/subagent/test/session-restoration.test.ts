import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeRuntimeSnapshot, ResumeTargetV1 } from "../src/types.js";
import {
  SessionRestoreError,
  buildRuntimeCompatibilitySnapshot,
  classifyAuthenticatedSuffixRecovery,
  inspectPersistedChildSessionRecovery,
  compareRuntimeCompatibilitySnapshot,
  redactSessionReference,
  restoreAgentSession,
  stableSha256,
  validatePersistedChildSession,
} from "../src/session-restoration.js";

const roots: string[] = [];
const HASH = "0".repeat(64);

function baseRows(root: string): unknown[] {
  return [
    { type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00Z", cwd: root },
    { type: "model_change", id: "model", parentId: null, timestamp: "2026-01-01T00:00:01Z", provider: "p", modelId: "m" },
    { type: "thinking_level_change", id: "think", parentId: "model", timestamp: "2026-01-01T00:00:02Z", thinkingLevel: "off" },
    { type: "message", id: "leaf", parentId: "think", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
  ];
}

function fixture(entries?: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "session-restore-"));
  roots.push(root);
  const file = join(root, "child.jsonl");
  const rows = entries ?? baseRows(root);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const bytes = readFileSync(file);
  const runtime: ResumeRuntimeSnapshot = {
    piVersion: "test", model: { provider: "p", id: "m", api: "api" }, thinkingLevel: "off",
    promptMode: "replace", isolated: true, inheritContext: false,
    systemPromptHash: HASH, resourcePolicyHash: HASH, agentConfigHash: HASH,
    extensionIdentities: [], activeToolNames: ["read"],
  };
  const target: ResumeTargetV1 = {
    version: 1, id: "agent-1", generation: 1, revision: 1, parentSessionId: "parent",
    sessionFile: file, sessionDir: root, childSessionId: "child-1", entryCount: rows.length - 1,
    activeLeafId: (rows.at(-1) as { id?: string })?.id ?? "missing", sessionSha256: stableSha256(bytes),
    type: "probe", description: "probe", cwd: root, isBackground: true, createdAt: 1, updatedAt: 2,
    runtime, state: { status: "completed", resultConsumed: false, notified: false, toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, lifetimeCost: 0, compactionCount: 0 },
  };
  return { root, file, rows, target, runtime };
}

function appendRows(file: string, rows: unknown[]): void {
  writeFileSync(file, `${readFileSync(file, "utf8")}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function managerFor(target: ResumeTargetV1, leaf = target.activeLeafId) {
  return {
    getSessionId: () => target.childSessionId,
    getEntries: () => Array(target.entryCount).fill({}),
    getLeafId: () => leaf,
  };
}

function managerForFile(target: ResumeTargetV1) {
  const entries = () => readFileSync(target.sessionFile, "utf8")
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as { id: string });
  return {
    getSessionId: () => target.childSessionId,
    getEntries: () => entries(),
    getLeafId: () => entries().at(-1)?.id ?? null,
  };
}

async function restoreFixture(overrides: Partial<Parameters<typeof restoreAgentSession>[0]> = {}) {
  const data = fixture();
  const session = { dispose: vi.fn() };
  const open = vi.fn(() => managerFor(data.target));
  const restored = await restoreAgentSession({
    target: data.target,
    runtime: data.runtime,
    sessionManagerOpen: open as never,
    createSession: async () => session as never,
    ...overrides,
  });
  return { ...data, session, open, restored };
}

function expectValidationReason(target: ResumeTargetV1, reason: string) {
  expect(() => validatePersistedChildSession(target)).toThrowError(expect.objectContaining({ reason }));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("strict read-only persisted child session preflight", () => {
  it("validates matching v3 JSONL without changing bytes or file count", () => {
    const { root, file, target } = fixture();
    const before = readFileSync(file);
    const files = readdirSync(root).sort();
    const validated = validatePersistedChildSession(target);
    expect(validated.activeLeafId).toBe("leaf");
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(files);
  });

  it("accepts only a direct well-formed session_info suffix for a completed snapshot", () => {
    const data = fixture();
    const title = {
      type: "session_info", id: "title", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", name: "Completed probe",
    };
    appendRows(data.file, [title]);

    const validated = inspectPersistedChildSessionRecovery(data.target);

    expect(validated).toMatchObject({
      entryCount: data.target.entryCount + 1,
      activeLeafId: "title",
      sessionSha256: stableSha256(readFileSync(data.file)),
      reconciledDescendant: true,
      completionDisposition: "clean",
      classification: {
        outcome: "clean_final_assistant",
        recoverable: true,
        reconstructedResult: "done",
        completionDisposition: "clean",
      },
    });
  });

  it("authenticates the exact stored raw prefix before accepting terminal metadata", () => {
    const data = fixture();
    const tampered = readFileSync(data.file, "utf8").replace('"text":"done"', '"text":"fake"');
    writeFileSync(data.file, tampered);
    appendRows(data.file, [{
      type: "session_info", id: "title", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", name: "Probe",
    }]);

    expectValidationReason(data.target, "session_corrupt_or_unsupported");
  });

  it.each([
    ["malformed session_info", { type: "session_info", id: "suffix", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", name: 7 }],
    ["branched session_info", { type: "session_info", id: "suffix", parentId: "think", timestamp: "2026-01-01T00:00:04Z", name: "Probe" }],
    ["terminal custom", { type: "custom", id: "suffix", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", customType: "agent-mode", data: {} }],
  ] as const)("rejects %s suffixes for completed snapshots", (_name, suffix) => {
    const data = fixture();
    appendRows(data.file, [suffix]);

    expectValidationReason(data.target, "session_corrupt_or_unsupported");
  });

  it("accepts a generation-bounded final assistant suffix without opening or replaying work", () => {
    const data = fixture();
    const open = vi.fn();
    const provider = vi.fn();
    const tool = vi.fn();
    appendRows(data.file, [{
      type: "message", id: "next", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z",
      message: { role: "assistant", content: [{ type: "text", text: "fresh suffix result" }], stopReason: "stop" },
    }]);

    const validated = validatePersistedChildSession(data.target);

    expect(validated.activeLeafId).toBe("next");
    expect(validated.reconciledDescendant).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
  });

  it("rejects missing and empty files", () => {
    const missing = fixture();
    rmSync(missing.file);
    expectValidationReason(missing.target, "session_file_missing");
    const empty = fixture();
    writeFileSync(empty.file, Buffer.alloc(0));
    expectValidationReason(empty.target, "session_corrupt_or_unsupported");
  });

  it("rejects invalid UTF-8, malformed JSONL, and blank JSONL records without mutation", () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from("{bad}\n"), Buffer.from("{}\n\n")]) {
      const data = fixture();
      writeFileSync(data.file, bytes);
      const count = readdirSync(data.root).length;
      expectValidationReason(data.target, "session_corrupt_or_unsupported");
      expect(readFileSync(data.file)).toEqual(bytes);
      expect(readdirSync(data.root)).toHaveLength(count);
    }
  });

  it.each([
    ["bad header", [{ type: "message", version: 3, id: "child-1" }, { type: "message", id: "x", parentId: null, message: { role: "assistant", content: [] } }]],
    ["old version", [{ type: "session", version: 2, id: "child-1" }, { type: "message", id: "x", parentId: null, message: { role: "assistant", content: [] } }]],
    ["future version", [{ type: "session", version: 4, id: "child-1" }, { type: "message", id: "x", parentId: null, message: { role: "assistant", content: [] } }]],
    ["ID mismatch", [{ type: "session", version: 3, id: "other" }, { type: "message", id: "x", parentId: null, message: { role: "assistant", content: [] } }]],
    ["duplicate header", [{ type: "session", version: 3, id: "child-1" }, { type: "session", version: 3, id: "child-1", parentId: null }]],
    ["duplicate IDs", [{ type: "session", version: 3, id: "child-1" }, { type: "message", id: "x", parentId: null, message: { role: "assistant", content: [] } }, { type: "message", id: "x", parentId: null, message: { role: "assistant", content: [] } }]],
    ["dangling parent", [{ type: "session", version: 3, id: "child-1" }, { type: "message", id: "x", parentId: "missing", message: { role: "assistant", content: [] } }]],
    ["cycle", [{ type: "session", version: 3, id: "child-1" }, { type: "message", id: "x", parentId: "y", message: { role: "assistant", content: [] } }, { type: "message", id: "y", parentId: "x", message: { role: "assistant", content: [] } }]],
  ])("rejects %s", (_name, rows) => {
    expectValidationReason(fixture(rows).target, "session_corrupt_or_unsupported");
  });

  it("rejects path escape, symlink escape, nested file, and unavailable cwd", () => {
    const outside = fixture();
    const other = mkdtempSync(join(tmpdir(), "session-outside-"));
    roots.push(other);
    const outsideFile = join(other, "outside.jsonl");
    writeFileSync(outsideFile, readFileSync(outside.file));
    expectValidationReason({ ...outside.target, sessionFile: outsideFile }, "scope_mismatch");

    const linked = fixture();
    const link = join(linked.root, "link.jsonl");
    symlinkSync(outsideFile, link);
    expectValidationReason({ ...linked.target, sessionFile: link }, "scope_mismatch");

    const nested = fixture();
    const nestedDir = join(nested.root, "nested");
    mkdirSync(nestedDir);
    const nestedFile = join(nestedDir, "child.jsonl");
    writeFileSync(nestedFile, readFileSync(nested.file));
    expectValidationReason({ ...nested.target, sessionFile: nestedFile }, "scope_mismatch");

    const cwd = fixture();
    expectValidationReason({ ...cwd.target, cwd: join(cwd.root, "gone") }, "cwd_unavailable");
  });

  it("uses deterministic physical last entry as active leaf", () => {
    const data = fixture();
    expectValidationReason({ ...data.target, activeLeafId: "think" }, "session_corrupt_or_unsupported");
  });
});

describe("active-branch interruption and runtime safety", () => {
  it.each([
    ["trailing user input", { role: "user", content: "continue" }],
    ["trailing tool result", { role: "toolResult", toolCallId: "call-1", content: [] }],
    ["aborted assistant", { role: "assistant", content: [], stopReason: "aborted" }],
    ["errored assistant", { role: "assistant", content: [], stopReason: "error" }],
    ["length-truncated assistant", { role: "assistant", content: [], stopReason: "length" }],
    ["unresolved tool call", { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }], stopReason: "toolUse" }],
    ["provider tool state without call", { role: "assistant", content: [], stopReason: "toolUse" }],
  ])("rejects %s", (_name, message) => {
    const rows = [{ type: "session", version: 3, id: "child-1" }, { type: "message", id: "leaf", parentId: null, message }];
    expectValidationReason(fixture(rows).target, "unsafe_interrupted_operation");
  });

  it("rejects unmatched tool result and tool result without following assistant", () => {
    const rows = [
      { type: "session", version: 3, id: "child-1" },
      { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1" }], stopReason: "toolUse" } },
      { type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "call-1", content: [] } },
    ];
    expectValidationReason(fixture(rows).target, "unsafe_interrupted_operation");
    const unmatched = fixture([{ type: "session", version: 3, id: "child-1" }, { type: "message", id: "r", parentId: null, message: { role: "toolResult", toolCallId: "unknown", content: [] } }]);
    expectValidationReason(unmatched.target, "unsafe_interrupted_operation");
  });

  it("checks only active branch for interruption", () => {
    const data = fixture();
    const rows = baseRows(data.root);
    rows.splice(3, 0, { type: "message", id: "abandoned", parentId: "think", message: { role: "user", content: "unfinished" } });
    const branch = fixture(rows);
    expect(validatePersistedChildSession(branch.target).activeLeafId).toBe("leaf");
  });

  it("rejects active-branch model and thinking incompatibility", () => {
    const model = fixture();
    expect(() => validatePersistedChildSession(model.target, { ...model.runtime, model: { ...model.runtime.model, id: "gone" } }))
      .toThrowError(expect.objectContaining({ reason: "model_unavailable" }));
    const thinking = fixture();
    expect(() => validatePersistedChildSession(thinking.target, { ...thinking.runtime, thinkingLevel: "high" }))
      .toThrowError(expect.objectContaining({ reason: "agent_config_unavailable" }));
  });
});

describe("explicit recovery boundaries", () => {
  function recoveredRows(root: string, interruptedStop: "error" | "aborted" = "error"): unknown[] {
    return [
      { type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00Z", cwd: root },
      { type: "model_change", id: "model", parentId: null, timestamp: "2026-01-01T00:00:01Z", provider: "p", modelId: "m" },
      { type: "thinking_level_change", id: "think", parentId: "model", timestamp: "2026-01-01T00:00:02Z", thinkingLevel: "off" },
      {
        type: "message", id: "interrupted", parentId: "think", timestamp: "2026-01-01T00:00:03Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "interrupted-call", name: "write", arguments: {} }],
          stopReason: interruptedStop,
        },
      },
      { type: "message", id: "boundary", parentId: "interrupted", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: "recover explicitly" } },
      { type: "message", id: "final", parentId: "boundary", timestamp: "2026-01-01T00:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "recovered result" }], stopReason: "stop" } },
    ];
  }

  it.each(["error", "aborted"] as const)("accepts historical %s with its own dangling call only after a user boundary", (stopReason) => {
    const seed = fixture();
    const data = fixture(recoveredRows(seed.root, stopReason));

    const validated = validatePersistedChildSession(data.target);

    expect(validated.activeLeafId).toBe("final");
    expect(validated.completionDisposition).toBe("recovered");
  });

  it("keeps clean terminal branches clean", () => {
    expect(validatePersistedChildSession(fixture().target).completionDisposition).toBe("clean");
  });

  it("does not reset a normal pending call at a later recovery boundary", () => {
    const seed = fixture();
    const rows = recoveredRows(seed.root);
    rows.splice(3, 0, {
      type: "message", id: "normal-call", parentId: "think", timestamp: "2026-01-01T00:00:02Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "normal-pending", name: "write", arguments: {} }], stopReason: "toolUse" },
    });
    (rows[4] as { parentId: string }).parentId = "normal-call";

    expectValidationReason(fixture(rows).target, "unsafe_interrupted_operation");
  });

  it.each([
    ["missing user boundary", (rows: unknown[]) => rows.splice(4, 1)],
    ["length stop", (rows: unknown[]) => {
      const message = (rows[3] as { message: { stopReason: string } }).message;
      message.stopReason = "length";
    }],
    ["empty recovered final", (rows: unknown[]) => {
      const message = (rows[5] as { message: { content: unknown[] } }).message;
      message.content = [];
    }],
  ] as const)("keeps %s unsafe", (_name, mutate) => {
    const seed = fixture();
    const rows = recoveredRows(seed.root);
    mutate(rows);
    if (_name === "missing user boundary") {
      (rows.at(-1) as { parentId: string }).parentId = "interrupted";
    }

    expectValidationReason(fixture(rows).target, "unsafe_interrupted_operation");
  });
});

describe("pure authenticated suffix recovery classification", () => {
  function suffix(rows: readonly unknown[]) {
    return rows as Parameters<typeof classifyAuthenticatedSuffixRecovery>[0];
  }

  it.each([
    ["empty", [], "empty", true, undefined],
    ["metadata only", [{ type: "session_info", id: "title", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", name: "Probe" }], "metadata_only", true, undefined],
    ["clean final assistant", [{ type: "message", id: "a", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "bounded final" }], stopReason: "stop" } }], "clean_final_assistant", true, "bounded final"],
    ["completed tool chain", [
      { type: "message", id: "a", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], stopReason: "toolUse" } },
      { type: "message", id: "r", parentId: "a", timestamp: "2026-01-01T00:00:05Z", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] } },
      { type: "message", id: "f", parentId: "r", timestamp: "2026-01-01T00:00:06Z", message: { role: "assistant", content: [{ type: "text", text: "answer after tool" }], stopReason: "stop" } },
    ], "completed_tool_chain", true, "answer after tool"],
    ["user-only", [{ type: "message", id: "u", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: "continue" } }], "user_only", false, undefined],
    ["pending tool", [{ type: "message", id: "a", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], stopReason: "toolUse" } }], "pending_tool_call", false, undefined],
    ["tool result without final assistant", [
      { type: "message", id: "a", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], stopReason: "toolUse" } },
      { type: "message", id: "r", parentId: "a", timestamp: "2026-01-01T00:00:05Z", message: { role: "toolResult", toolCallId: "call-1", content: [] } },
    ], "tool_result_without_final_assistant", false, undefined],
    ["abnormal stop", [{ type: "message", id: "a", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [], stopReason: "error" } }], "abnormal_assistant_stop", false, undefined],
    ["malformed", [{ type: "message", id: "a", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: "not-array", stopReason: "stop" } }], "malformed", false, undefined],
    ["nonlinear", [{ type: "message", id: "a", parentId: "think", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [], stopReason: "stop" } }], "nonlinear_suffix", false, undefined],
  ] as const)("classifies %s", (_name, rows, outcome, recoverable, reconstructedResult) => {
    const provider = vi.fn();
    const tool = vi.fn();

    const classification = classifyAuthenticatedSuffixRecovery(suffix(rows), "leaf");

    expect(classification).toMatchObject({ outcome, recoverable });
    expect(classification.reconstructedResult).toBe(reconstructedResult);
    expect(provider).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
  });

  it.each([
    ["clean final", [
      { type: "message", id: "final", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "authenticated clean result" }], stopReason: "stop" } },
    ], "clean_final_assistant", "clean", "authenticated clean result"],
    ["recovered completed tool chain", [
      { type: "message", id: "interrupted", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "historical-call" }], stopReason: "error" } },
      { type: "message", id: "boundary", parentId: "interrupted", message: { role: "user", content: "recover" } },
      { type: "message", id: "tool", parentId: "boundary", message: { role: "assistant", content: [{ type: "toolCall", id: "current-call" }], stopReason: "toolUse" } },
      { type: "message", id: "result", parentId: "tool", message: { role: "toolResult", toolCallId: "current-call", content: [] } },
      { type: "message", id: "final", parentId: "result", message: { role: "assistant", content: [{ type: "text", text: "authenticated recovered result" }], stopReason: "stop" } },
    ], "completed_tool_chain", "recovered", "authenticated recovered result"],
  ] as const)("retains a %s across a metadata-only suffix", (_name, prefixRows, outcome, completionDisposition, reconstructedResult) => {
    const metadata = suffix([
      { type: "session_info", id: "title", parentId: "final", timestamp: "2026-01-01T00:00:04Z", name: "Late title" },
    ]);

    const classification = classifyAuthenticatedSuffixRecovery(metadata, "final", suffix(prefixRows));

    expect(classification).toEqual({
      outcome,
      recoverable: true,
      reconstructedResult,
      completionDisposition,
    });
  });
});

describe("recovered suffix classification", () => {
  it("classifies an interrupted assistant followed by an explicit user boundary and final answer as recovered", () => {
    const classification = classifyAuthenticatedSuffixRecovery([
      { type: "message", id: "interrupted", parentId: "leaf", message: { role: "assistant", content: [{ type: "toolCall", id: "own-call" }], stopReason: "error" } },
      { type: "message", id: "boundary", parentId: "interrupted", message: { role: "user", content: "recover" } },
      { type: "message", id: "final", parentId: "boundary", message: { role: "assistant", content: [{ type: "text", text: "authenticated recovered result" }], stopReason: "stop" } },
    ] as Parameters<typeof classifyAuthenticatedSuffixRecovery>[0], "leaf");

    expect(classification).toMatchObject({
      outcome: "clean_final_assistant",
      recoverable: true,
      reconstructedResult: "authenticated recovered result",
      completionDisposition: "recovered",
    });
  });
});

describe("authenticated running descendants", () => {
  it("accepts a direct safe execution descendant and returns its current snapshot", () => {
    const data = fixture();
    data.target.state.status = "running";
    appendRows(data.file, [{
      type: "message", id: "next", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z",
      message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
    }]);

    const validated = validatePersistedChildSession(data.target);

    expect(validated).toMatchObject({
      entryCount: data.target.entryCount + 1,
      activeLeafId: "next",
      sessionSha256: stableSha256(readFileSync(data.file)),
      reconciledDescendant: true,
    });
  });

  it("rejects running descendants with a tampered prefix or nonlinear suffix", () => {
    const tampered = fixture();
    tampered.target.state.status = "running";
    writeFileSync(tampered.file, readFileSync(tampered.file, "utf8").replace('"text":"done"', '"text":"fake"'));
    appendRows(tampered.file, [{
      type: "message", id: "next", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z",
      message: { role: "assistant", content: [], stopReason: "stop" },
    }]);
    expectValidationReason(tampered.target, "session_corrupt_or_unsupported");

    const branched = fixture();
    branched.target.state.status = "running";
    appendRows(branched.file, [{
      type: "message", id: "next", parentId: "think", timestamp: "2026-01-01T00:00:04Z",
      message: { role: "assistant", content: [], stopReason: "stop" },
    }]);
    expectValidationReason(branched.target, "session_corrupt_or_unsupported");
  });

  it("keeps interrupted running descendants unsafe", () => {
    const data = fixture();
    data.target.state.status = "running";
    appendRows(data.file, [{
      type: "message", id: "next", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z",
      message: { role: "user", content: "unfinished" },
    }]);

    expectValidationReason(data.target, "unsafe_interrupted_operation");
  });
});

describe("cooperative restore locking and safe open", () => {
  it("opens only after validation, verifies manager state, binds, and removes owned lock", async () => {
    const data = fixture();
    const order: string[] = [];
    const manager = managerFor(data.target);
    const open = vi.fn(() => { order.push("open"); return manager; });
    const session = { dispose: vi.fn() };
    await restoreAgentSession({
      target: data.target, runtime: data.runtime, sessionManagerOpen: open as never,
      createSession: async () => { order.push("create"); return session as never; },
      bindAndApplyPolicy: async () => { order.push("bind"); },
    });
    expect(order).toEqual(["open", "create", "bind"]);
    expect(readdirSync(data.root)).toEqual(["child.jsonl"]);
  });

  it("reconciles a trusted linear custom entry appended during bind", async () => {
    const data = fixture();
    const manager = managerForFile(data.target);
    const session = { sessionManager: manager, dispose: vi.fn() };

    const restored = await restoreAgentSession({
      target: data.target,
      runtime: data.runtime,
      sessionManagerOpen: (() => manager) as never,
      createSession: async () => session as never,
      bindAndApplyPolicy: async () => appendRows(data.file, [{
        type: "custom", id: "mode", parentId: "leaf", timestamp: "2026-01-01T00:00:04Z",
        customType: "agent-mode", data: { mode: "probe" },
      }]),
    });

    expect(restored).toBe(session);
    expect(manager.getEntries()).toHaveLength(data.target.entryCount + 1);
    expect(manager.getLeafId()).toBe("mode");
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it.each(["prefix mutation", "branched append", "manager-file divergence"] as const)(
    "fails closed and disposes once when bind causes %s",
    async (failure) => {
      const data = fixture();
      const manager = managerForFile(data.target);
      const session = { sessionManager: manager, dispose: vi.fn() };

      await expect(restoreAgentSession({
        target: data.target,
        runtime: data.runtime,
        sessionManagerOpen: (() => manager) as never,
        createSession: async () => session as never,
        bindAndApplyPolicy: async () => {
          if (failure === "prefix mutation") {
            writeFileSync(data.file, readFileSync(data.file, "utf8").replace('"text":"done"', '"text":"fake"'));
          }
          appendRows(data.file, [{
            type: "custom", id: "mode", parentId: failure === "branched append" ? "think" : "leaf",
            timestamp: "2026-01-01T00:00:04Z", customType: "agent-mode", data: { mode: "probe" },
          }]);
          if (failure === "manager-file divergence") manager.getEntries = () => [];
        },
      })).rejects.toEqual(expect.objectContaining({ reason: "runtime_initialization_failed" }));

      expect(session.dispose).toHaveBeenCalledOnce();
    },
  );

  it("rejects a live owner lock before open", async () => {
    const data = fixture();
    writeFileSync(`${data.file}.restore.lock`, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "live" }));
    const open = vi.fn();
    await expect(restoreAgentSession({ target: data.target, runtime: data.runtime, sessionManagerOpen: open as never, createSession: vi.fn() }))
      .rejects.toEqual(expect.objectContaining({ reason: "target_busy" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("removes a dead-PID stale lock, retries once, then opens", async () => {
    const data = fixture();
    writeFileSync(`${data.file}.restore.lock`, JSON.stringify({ pid: 2_147_483_647, createdAt: "2020-01-01T00:00:00Z", token: "stale" }));
    const open = vi.fn(() => managerFor(data.target));
    await restoreAgentSession({ target: data.target, runtime: data.runtime, sessionManagerOpen: open as never, createSession: async () => ({ dispose: vi.fn() }) as never });
    expect(open).toHaveBeenCalledOnce();
    expect(readdirSync(data.root)).toEqual(["child.jsonl"]);
  });

  it("keeps a replacement lock whose owner token does not match", async () => {
    const data = fixture();
    const lockFile = `${data.file}.restore.lock`;
    const replacement = { pid: process.pid, createdAt: new Date().toISOString(), token: "replacement" };
    await restoreAgentSession({
      target: data.target, runtime: data.runtime,
      sessionManagerOpen: (() => managerFor(data.target)) as never,
      createSession: async () => {
        rmSync(lockFile);
        writeFileSync(lockFile, JSON.stringify(replacement));
        return { dispose: vi.fn() } as never;
      },
    });
    expect(JSON.parse(readFileSync(lockFile, "utf8"))).toEqual(replacement);
  });

  it("detects deterministic TOCTOU mutation immediately before open", async () => {
    const data = fixture();
    const open = vi.fn();
    await expect(restoreAgentSession({
      target: data.target, runtime: data.runtime, sessionManagerOpen: open as never, createSession: vi.fn(),
      beforeFinalRevalidation: () => writeFileSync(data.file, `${readFileSync(data.file, "utf8")} `),
    })).rejects.toEqual(expect.objectContaining({ reason: "target_busy" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("disposes on post-open ID, entry, leaf, or hash mismatch before bind", async () => {
    for (const mismatch of ["id", "count", "leaf", "hash"] as const) {
      const data = fixture();
      const manager = managerFor(data.target) as ReturnType<typeof managerFor>;
      if (mismatch === "id") manager.getSessionId = () => "other";
      if (mismatch === "count") manager.getEntries = () => [];
      if (mismatch === "leaf") manager.getLeafId = () => "other";
      const session = { dispose: vi.fn() };
      const bind = vi.fn();
      await expect(restoreAgentSession({
        target: data.target, runtime: data.runtime,
        sessionManagerOpen: (() => manager) as never,
        createSession: async () => {
          if (mismatch === "hash") writeFileSync(data.file, `${readFileSync(data.file, "utf8")} `);
          return session as never;
        },
        bindAndApplyPolicy: bind,
      })).rejects.toEqual(expect.objectContaining({ reason: "runtime_initialization_failed" }));
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(bind).not.toHaveBeenCalled();
    }
  });
});

describe("runtime compatibility", () => {
  it("builds deterministic ordered hashes and redacted references", () => {
    const snapshot = buildRuntimeCompatibilitySnapshot({
      model: { provider: "p", id: "m", api: "api" }, thinkingLevel: "off", promptMode: "replace",
      isolated: true, inheritContext: false, systemPrompt: "system", resourcePolicy: { b: 2, a: 1 },
      agentConfig: { name: "probe" }, extensions: [{ name: "z", content: "z" }, { name: "a", content: "a" }],
      activeToolNames: ["write", "read", "read"],
    });
    expect(snapshot.extensionIdentities.map((item) => item.name)).toEqual(["a", "z"]);
    expect(snapshot.activeToolNames).toEqual(["read", "write"]);
    expect(redactSessionReference("/secret/user/session.jsonl")).toMatch(/^session:[0-9a-f]{12}$/);
    expect(JSON.stringify(snapshot)).not.toContain("/secret");
  });

  it.each(["provider", "id", "api"] as const)("maps model %s mismatch before opening", async (field) => {
    const data = fixture();
    const open = vi.fn();
    const runtime = { ...data.runtime, model: { ...data.runtime.model, [field]: "unavailable" } };
    await expect(restoreAgentSession({ target: data.target, runtime, sessionManagerOpen: open as never, createSession: vi.fn() }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRestoreError>>({ reason: "model_unavailable" }));
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["piVersion", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, piVersion: "other" })],
    ["thinkingLevel", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, thinkingLevel: "high" as const })],
    ["promptMode", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, promptMode: "append" as const })],
    ["isolated", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, isolated: !runtime.isolated })],
    ["inheritContext", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, inheritContext: !runtime.inheritContext })],
    ["systemPromptHash", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, systemPromptHash: "1".repeat(64) })],
    ["resourcePolicyHash", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, resourcePolicyHash: "1".repeat(64) })],
    ["agentConfigHash", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, agentConfigHash: "1".repeat(64) })],
  ] as const)("maps %s mismatch to unavailable agent config before opening", async (_field, mutate) => {
    const data = fixture();
    const open = vi.fn();
    await expect(restoreAgentSession({ target: data.target, runtime: mutate(data.runtime), sessionManagerOpen: open as never, createSession: vi.fn() }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRestoreError>>({ reason: "agent_config_unavailable" }));
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["extension identities", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, extensionIdentities: [{ name: "changed", contentHash: HASH }] })],
    ["active tool names", (runtime: ResumeRuntimeSnapshot) => ({ ...runtime, activeToolNames: ["write"] })],
  ] as const)("maps %s mismatch to incompatible tools/extensions before opening", async (_field, mutate) => {
    const data = fixture();
    const open = vi.fn();
    await expect(restoreAgentSession({ target: data.target, runtime: mutate(data.runtime), sessionManagerOpen: open as never, createSession: vi.fn() }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRestoreError>>({ reason: "tools_extensions_incompatible" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps per-agent single-flight", async () => {
    const data = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = restoreAgentSession({
      target: data.target, runtime: data.runtime,
      sessionManagerOpen: (() => managerFor(data.target)) as never,
      createSession: async () => { await held; return { dispose: vi.fn() } as never; },
    });
    await vi.waitFor(() => expect(readdirSync(data.root)).toContain("child.jsonl.restore.lock"));
    await expect(restoreAgentSession({ target: data.target, runtime: data.runtime, createSession: vi.fn() }))
      .rejects.toEqual(expect.objectContaining({ reason: "target_busy" }));
    release();
    await first;
  });
});
