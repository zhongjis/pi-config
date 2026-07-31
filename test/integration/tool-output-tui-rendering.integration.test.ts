import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";
import { initTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(__dirname, "../..");
const WIDTHS = [20, 40, 80, 120] as const;
const NATIVE_RESULT_DELEGATES = new Set(["bash", "readonly_bash"]);
const EXPECTED_TOOL_NAMES = [
  "Agent",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "ask",
  "bash",
  "boomerang",
  "codegraph_callees",
  "codegraph_callers",
  "codegraph_explore",
  "codegraph_files",
  "codegraph_impact",
  "codegraph_node",
  "codegraph_search",
  "codegraph_status",
  "codex_review_session_scope",
  "create_goal",
  "get_goal",
  "get_subagent_result",
  "look_at",
  "lsp",
  "open_pr_walkthrough",
  "plan_approve",
  "plan_scaffold",
  "readonly_bash",
  "steer_subagent",
  "update_goal",
  "write",
] as const;

const OWNER_EXTENSIONS = [
  ...[
    "better-bash-tool",
    "readonly-bash",
    "qol",
    "codegraph",
    "lsp",
    "multimodal-look",
    "tasks",
    "goal",
    "modes",
  ].map((name) => resolve(PROJECT_ROOT, "extensions", name, "index.ts")),
  resolve(PROJECT_ROOT, "extensions/subagents-new/src/index.ts"),
  ...["boomerang", "ask", "diff", "second-opinion"].map((name) =>
    resolve(PROJECT_ROOT, "extensions", name, "index.ts"),
  ),
];

type ThemeLike = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

type Renderable = {
  render(width: number): string[];
};

type ToolResultLike = {
  content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  details?: unknown;
  isError?: boolean;
};

type RenderContext = {
  args: Readonly<Record<string, unknown>>;
  toolCallId: string;
  invalidate(): void;
  lastComponent: undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

type ToolDefinitionLike = {
  name: string;
  renderCall?: (args: Readonly<Record<string, unknown>>, theme: ThemeLike, context: RenderContext) => Renderable;
  renderResult?: (
    result: ToolResultLike,
    options: { expanded: boolean; isPartial: boolean },
    theme: ThemeLike,
    context: RenderContext,
  ) => Renderable;
};

type RegisteredToolLike = { definition: ToolDefinitionLike };
type ExtensionRunnerLike = {
  emit(event: { type: "session_shutdown" }): Promise<void> | void;
  getAllRegisteredTools(): RegisteredToolLike[];
  getUIContext(): { theme: ThemeLike };
  hasHandlers(event: "session_shutdown"): boolean;
};
type SessionLike = {
  extensionRunner?: ExtensionRunnerLike;
  getToolDefinition(name: string): ToolDefinitionLike | undefined;
};

type ToolFixture = {
  args: Record<string, unknown>;
  raw: string;
  details: unknown;
};

const FIXTURES: Record<(typeof EXPECTED_TOOL_NAMES)[number], ToolFixture> = {
  Agent: {
    args: { prompt: "Audit renderer output", description: "renderer audit", subagent_type: "juling", skills: ["pi-extensions", "vitest"] },
    raw: "Renderer audit complete.\nRAW31_01",
    details: {
      displayName: "Juling",
      description: "renderer audit",
      subagentType: "juling",
      status: "completed",
      toolUses: 0,
      tokens: "",
      durationMs: 0,
    },
  },
  TaskCreate: { args: { subject: "Renderer audit", description: "Check output" }, raw: "Created task #1: Renderer audit\nRAW31_02", details: {} },
  TaskGet: { args: { taskId: "1" }, raw: "#1 [in_progress] Renderer audit\nRAW31_03", details: {} },
  TaskList: { args: {}, raw: "Tasks: 1 total, 1 in progress\n#1 Renderer audit\nRAW31_04", details: {} },
  TaskOutput: { args: { taskId: "1" }, raw: "Task #1 output\nrenderer line\nRAW31_05", details: {} },
  TaskStop: { args: { taskId: "1" }, raw: "Stopped task #1\nRAW31_06", details: {} },
  TaskUpdate: { args: { taskId: "1", status: "completed" }, raw: "Updated task #1: completed\nRAW31_07", details: {} },
  ask: {
    args: { questions: [{ id: "scope", label: "Scope", prompt: "Which scope?", options: [{ value: "all", label: "All" }] }] },
    raw: "Scope: user selected: 1. All\nRAW31_08",
    details: { questions: [{ id: "scope", label: "Scope", prompt: "Which scope?", options: [{ value: "all", label: "All" }] }], answers: [{ id: "scope", multi: false, wasCustom: false, values: ["all"], labels: ["All"], indices: [1] }], cancelled: false },
  },
  bash: { args: { command: "printf renderer", cwd: "/tmp/render-cwd" }, raw: "renderer output\nRAW31_09", details: {} },
  boomerang: { args: { task: "Review renderer output", rethrow: 2 }, raw: "Boomerang task queued.\nRAW31_10", details: {} },
  codegraph_callees: { args: { symbol: "renderToolSummary" }, raw: "Callees: 2\nrenderToolCall\nRAW31_11", details: {} },
  codegraph_callers: { args: { symbol: "renderToolSummary" }, raw: "Callers: 3\nownerRenderer\nRAW31_12", details: {} },
  codegraph_explore: { args: { query: "tool output renderer" }, raw: "Found renderer symbols.\nRAW31_13", details: {} },
  codegraph_files: { args: { path: "extensions" }, raw: "extensions/\n  lib/tool-output.ts\nRAW31_14", details: {} },
  codegraph_impact: { args: { symbol: "renderToolSummary", depth: 2 }, raw: "Impact radius: 4 symbols\nRAW31_15", details: {} },
  codegraph_node: { args: { symbol: "renderToolSummary", includeCode: true }, raw: "renderToolSummary function\nRAW31_16", details: {} },
  codegraph_search: { args: { query: "renderToolSummary", kind: "function" }, raw: "1 result\nextensions/lib/tool-output.ts\nRAW31_17", details: {} },
  codegraph_status: { args: {}, raw: "CodeGraph ready: 31 tools indexed\nRAW31_18", details: {} },
  codex_review_session_scope: { args: { repos: [PROJECT_ROOT], reason: "renderer audit" }, raw: "Review completed and posted.\nRAW31_19", details: {} },
  create_goal: { args: { objective: "Prove renderer output" }, raw: "Goal created: Prove renderer output\nRAW31_20", details: {} },
  get_goal: { args: {}, raw: "Goal active: Prove renderer output\nRAW31_21", details: {} },
  get_subagent_result: { args: { agent_id: "agent-render-1", wait: false }, raw: "Agent agent-render-1 completed.\nResult: renderer audit complete\nRAW31_22", details: {} },
  look_at: { args: { file_path: "screens/界面.png", goal: "Find renderer status" }, raw: "Renderer status is visible.\nRAW31_23", details: {} },
  lsp: { args: { operation: "diagnostics", filePath: "extensions/render.ts" }, raw: "No diagnostics found.\nRAW31_24", details: {} },
  open_pr_walkthrough: { args: { sidecar_path: "/tmp/review-sidecar.json", head_sha: "0123456789abcdef" }, raw: "- extensions/render.ts:31 — Renderer verified\nRAW31_25", details: {} },
  plan_approve: { args: { variant: "review" }, raw: "Plan approved for handoff.\nRAW31_26", details: {} },
  plan_scaffold: { args: { slug: "renderer-audit", intent: "Prove tool output", create_plan: true }, raw: "Created DRAFT.md and PLAN.md\nNext: review plan\nRAW31_27", details: { artifacts: [{ name: "DRAFT.md", status: "created" }, { name: "PLAN.md", status: "created" }] } },
  readonly_bash: { args: { command: "git status --short", timeout: 5, cwd: "/tmp/render-cwd" }, raw: "clean\nRAW31_28", details: {} },
  steer_subagent: { args: { agent_id: "agent-render-1", message: "Focus on renderer width" }, raw: "Steering message delivered to agent agent-render-1.\nRAW31_29", details: {} },
  update_goal: { args: { status: "completed", note: "Renderer proof complete" }, raw: "Goal updated: completed\nRAW31_30", details: {} },
  write: { args: { path: "/tmp/界面-render.txt", content: "line one\nline two" }, raw: "Wrote 2 lines to /tmp/界面-render.txt\nRAW31_31", details: {} },
};

let testSession: TestSession | undefined;
let tempHome: string | undefined;
let tempCwd: string | undefined;
let originalHome: string | undefined;
let originalPackageDir: string | undefined;
let originalKeybindings: ReturnType<typeof getKeybindings> | undefined;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function contextFor(args: Readonly<Record<string, unknown>>, cwd: string, expanded: boolean, isPartial: boolean, isError: boolean): RenderContext {
  return {
    args,
    toolCallId: "renderer-integration-call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd,
    executionStarted: true,
    argsComplete: true,
    isPartial,
    expanded,
    showImages: false,
    isError,
  };
}

function renderAt(component: Renderable, width: number, label: string): string[] {
  expect(component.render, `${label} must return a real Pi Component`).toBeTypeOf("function");
  const lines = component.render(width);
  for (const line of lines) {
    expect(visibleWidth(line), `${label}: ${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
  }
  return lines;
}

function plainText(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function shutdown(session: TestSession | undefined): Promise<void> {
  const runner = (session?.session as SessionLike | undefined)?.extensionRunner;
  if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown" });
}

afterEach(async () => {
  await shutdown(testSession);
  testSession?.dispose();
  testSession = undefined;
  process.env.HOME = originalHome;
  process.env.PI_PACKAGE_DIR = originalPackageDir;
  if (originalKeybindings) setKeybindings(originalKeybindings);
  originalKeybindings = undefined;
  await Promise.all([
    tempHome ? rm(tempHome, { recursive: true, force: true }) : Promise.resolve(),
    tempCwd ? rm(tempCwd, { recursive: true, force: true }) : Promise.resolve(),
  ]);
  tempHome = undefined;
  tempCwd = undefined;
});

describe("tool output TUI rendering — real Pi integration", () => {
  it("loads and exercises the exact 31 registered renderer pairs without mutation", async () => {
    originalHome = process.env.HOME;
    originalPackageDir = process.env.PI_PACKAGE_DIR;
    tempHome = await mkdtemp(join(tmpdir(), "pi-render-home-"));
    tempCwd = await mkdtemp(join(tmpdir(), "pi-render-cwd-"));
    process.env.HOME = tempHome;
    process.env.PI_PACKAGE_DIR = resolve(PROJECT_ROOT, "node_modules/@earendil-works/pi-coding-agent");
    const agentDir = join(tempHome, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "boomerang.json"), JSON.stringify({ toolEnabled: true }), "utf8");
    initTheme(undefined, false);
    originalKeybindings = getKeybindings();
    setKeybindings(new KeybindingsManager());

    testSession = await createTestSession({
      cwd: tempCwd,
      extensions: OWNER_EXTENSIONS,
      propagateErrors: false,
    });

    const session = testSession.session as SessionLike;
    const runner = session.extensionRunner;
    expect(runner).toBeDefined();
    const registrations = runner!.getAllRegisteredTools();
    const definitions = registrations.map(({ definition }) => definition);
    const rawNames = definitions.map(({ name }) => name);
    const uniqueNames = [...new Set(rawNames)];

    expect(rawNames).toHaveLength(31);
    expect(uniqueNames).toHaveLength(31);
    expect([...uniqueNames].sort()).toEqual([...EXPECTED_TOOL_NAMES]);

    const theme = runner!.getUIContext().theme;
    const configuredExpandKey = plainText(keyHint("app.tools.expand", "details")).replace(/\s+details$/, "");
    expect(configuredExpandKey).not.toBe("");
    let expandHintCount = 0;

    for (const definition of definitions) {
      expect(definition.renderCall, `${definition.name} renderCall`).toBeTypeOf("function");
      expect(definition.renderResult, `${definition.name} renderResult`).toBeTypeOf("function");
      const fixture = FIXTURES[definition.name as keyof typeof FIXTURES];
      expect(fixture, `${definition.name} fixture`).toBeDefined();

      const args = deepFreeze(structuredClone(fixture.args));
      const result = deepFreeze<ToolResultLike>({
        content: [{ type: "text", text: fixture.raw }],
        details: structuredClone(fixture.details),
      });
      const baselineArgs = structuredClone(args);
      const baselineResult = structuredClone(result);

      const call = definition.renderCall!(args, theme, contextFor(args, tempCwd, false, false, false));
      const collapsed = definition.renderResult!(result, { expanded: false, isPartial: false }, theme, contextFor(args, tempCwd, false, false, false));
      const partial = definition.renderResult!(result, { expanded: false, isPartial: true }, theme, contextFor(args, tempCwd, false, true, false));
      const errorResult = deepFreeze<ToolResultLike>({ content: [{ type: "text", text: `Renderer failure.\n${fixture.raw.split("\n").at(-1)}` }], details: structuredClone(fixture.details), isError: true });
      const error = definition.renderResult!(errorResult, { expanded: false, isPartial: false }, theme, contextFor(args, tempCwd, false, false, true));
      const expanded = definition.renderResult!(result, { expanded: true, isPartial: false }, theme, contextFor(args, tempCwd, true, false, false));
      const malformed = deepFreeze<ToolResultLike>({ content: [{ type: "text", text: `Malformed fallback.\n${fixture.raw.split("\n").at(-1)}` }], details: "malformed-details" });
      const absent = deepFreeze<ToolResultLike>({ content: [{ type: "text", text: `Absent fallback.\n${fixture.raw.split("\n").at(-1)}` }] });
      const malformedComponent = definition.renderResult!(malformed, { expanded: false, isPartial: false }, theme, contextFor(args, tempCwd, false, false, false));
      const absentComponent = definition.renderResult!(absent, { expanded: false, isPartial: false }, theme, contextFor(args, tempCwd, false, false, false));

      for (const width of WIDTHS) {
        renderAt(call, width, `${definition.name} call`);
        const collapsedLines = renderAt(collapsed, width, `${definition.name} collapsed`);
        renderAt(partial, width, `${definition.name} partial`);
        renderAt(error, width, `${definition.name} error`);
        const expandedText = renderAt(expanded, width, `${definition.name} expanded`).join("\n");
        renderAt(malformedComponent, width, `${definition.name} malformed`);
        renderAt(absentComponent, width, `${definition.name} absent`);
        expect(expandedText, `${definition.name} complete expanded marker`).toContain(fixture.raw.split("\n").at(-1));
        if (!NATIVE_RESULT_DELEGATES.has(definition.name)) expect(collapsedLines.length, `${definition.name} collapsed row budget at ${width}`).toBeLessThanOrEqual(3);
      }

      const collapsedText = renderAt(collapsed, 120, `${definition.name} configured hint`).map(plainText).join("\n");
      if (!NATIVE_RESULT_DELEGATES.has(definition.name) && /└─ .*?(?:expand|details|diagnostics|full|diff|answer)/i.test(collapsedText)) expandHintCount += 1;
      expect(args, `${definition.name} args mutation`).toEqual(baselineArgs);
      expect(result, `${definition.name} result mutation`).toEqual(baselineResult);

      if (NATIVE_RESULT_DELEGATES.has(definition.name)) {
        expect(session.getToolDefinition(definition.name)?.renderResult, `${definition.name} native delegate identity`).toBe(definition.renderResult);
      }
    }

    expect(expandHintCount).toBe(29);
    const helperSource = await readFile(resolve(PROJECT_ROOT, "extensions/lib/tool-output.ts"), "utf8");
    expect(helperSource).toContain('keyHint("app.tools.expand"');
    expect(helperSource).not.toMatch(/(?:ctrl|alt|shift)\+[a-z]/i);
  });

  it("generates only a caller-selected /tmp v3 session with Agent skills and steering failure", async () => {
    const outputPath = join(tmpdir(), `pi-tool-output-fixture-${process.pid}.jsonl`);
    const generator = resolve(PROJECT_ROOT, "test/fixtures/generate-tool-output-tui-session.mjs");
    await rm(outputPath, { force: true });

    await execFileAsync(process.execPath, [generator, outputPath], { cwd: PROJECT_ROOT });
    const lines = (await readFile(outputPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, cwd: PROJECT_ROOT });
    expect(lines).toContainEqual(expect.objectContaining({
      type: "message",
      message: expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([expect.objectContaining({ type: "toolCall", name: "Agent", arguments: expect.objectContaining({ skills: ["pi-extensions", "vitest"] }) })]),
      }),
    }));
    expect(lines).toContainEqual(expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "toolResult", toolName: "steer_subagent", isError: true }) }));

    await rm(outputPath, { force: true });
  });
});
