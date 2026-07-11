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

function managerFor(target: ResumeTargetV1, leaf = target.activeLeafId) {
  return {
    getSessionId: () => target.childSessionId,
    getEntries: () => Array(target.entryCount).fill({}),
    getLeafId: () => leaf,
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
