vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentTypes from "../src/agent-types.js";
import { sessionFastPolicies } from "../src/session-fast.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentActivity, AgentRecord } from "../src/types.js";
import { getDisplayName } from "../src/ui/agent-widget.js";
import { FleetList, type FleetUICtx, formatFleetElapsed, formatFleetTokens } from "../src/ui/fleet-list.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
// Kitty-protocol key-RELEASE for ↓ (event type 3) — listeners receive these too.
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const fleets: FleetList[] = [];
afterEach(() => {
  for (const fleet of fleets.splice(0)) fleet.dispose();
  vi.restoreAllMocks();
});

/** A no-op session so a record is "openable" by default (the list hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: () => true,
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  /** The overlay component (a real ConversationViewer) once one is opened. */
  overlayComponent: () => { handleInput(data: string): void } | undefined;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Render the currently-registered below-editor widget at the given width. */
  render: (width?: number, renderTheme?: typeof theme) => string[];
  setStatus: ReturnType<typeof vi.fn<FleetUICtx["setStatus"]>>;
  setEditorText: (t: string) => void;
  /** Whether an overlay has been opened. */
  overlayOpened: () => boolean;
  /** Whether the most recently opened overlay's `done` was invoked (closed). */
  overlayClosed: () => boolean;
  /** Simulate the viewer closing itself (Esc → done); flushes the close microtask. */
  closeOverlay: () => Promise<void>;
  /** The fake `tui` handed to the widget factory; tests set `focusedComponent` on it. */
  widgetTui: { requestRender(): void; focusedComponent?: unknown };
}

function harness(agents: AgentRecord[], activities = new Map<string, AgentActivity>()): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
  let overlayComponent: { handleInput(data: string): void } | undefined;
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const setStatus = vi.fn<FleetUICtx["setStatus"]>();
  const ui: FleetUICtx = {
    setStatus,
    setWidget: (_key, content) => { widgetFactory = content as any; },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    notify: () => {},
    custom: ((factory: any) => {
      opened = true;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => { closed = true; overlayDone = undefined; resolve(r); };
        overlayDone = done;
        // Construct the overlay component so the controller wires viewerClose,
        // and keep it so tests can drive the real ConversationViewer's input.
        overlayComponent = factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const fleet = new FleetList(manager, activities);
  fleets.push(fleet);
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    ui,
    manager,
    setStatus,
    overlayComponent: () => overlayComponent,
    press: (data) => inputHandler?.(data),
    render: (width = 120, renderTheme = theme) => (widgetFactory ? widgetFactory(fakeTui, renderTheme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    closeOverlay: async () => { overlayDone?.(undefined); await Promise.resolve(); },
    widgetTui: fakeTui,
  };
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("prefixes a down-arrow and uses plural 'tokens'", () => {
    expect(formatFleetTokens(13_100)).toBe("↓ 13.1k tokens");
    expect(formatFleetTokens(950)).toBe("↓ 950 tokens");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M tokens");
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("activates on ↓ at an empty prompt, consuming the key", () => {
    const h = harness([makeRecord()]);
    const res = h.press(DOWN);
    expect(res).toEqual({ consume: true });
    // main selected, list active → nav hint shown
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("also activates on ← (matches the '← for agents' hint)", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("does NOT activate when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);          // activate → selection on main (idx 0)
    h.press(DOWN_RELEASE);  // release half of the SAME tap — must be a no-op
    expect(h.render().find(l => l.includes("main"))).toContain("●");
    h.press(DOWN);          // a real second tap → first agent
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    expect(h.render().find(l => l.includes("two"))).toContain("○");
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate → index 0 (main)
    h.press(DOWN); // → 1 (a1)
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    h.press(DOWN); // → 2 (a2)
    h.press(DOWN); // clamp at 2
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("one"))).toContain("○");
  });

  it("↑ above 'main' deactivates (returns to the prompt)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // activate, index 0
    expect(h.press(UP)).toEqual({ consume: true });
    // back to inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("Esc deactivates", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(ESC)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("passes non-nav keys through and cancels navigation", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(RIGHT)).toBeUndefined();
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("ignores all input while disabled and hides the widget", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.render()).toEqual([]);
  });

  it("re-arms the refresh timer when the list is re-shown (toggle off→on)", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager, new Map());
      fleet.setUICtx({
        setStatus: vi.fn(), setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
        notify: () => {}, custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update();          // shows list, arms the timer
      fleet.setEnabled(false); // hides, clears the timer
      fleet.setEnabled(true);  // re-shows — must re-arm the timer
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(250); // a tick should fire and re-read the roster
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList vs other focused components (#123)", () => {
  // pi dispatches terminal input to extension listeners BEFORE the focused
  // component (pi-tui TUI.handleInput), and ctx.ui.select/confirm/input swap
  // the prompt editor out of the editor container while getEditorText() still
  // reads the detached (empty) editor. So while another component owns the
  // keyboard — another extension's selector (rpiv-ask-user-question), pi's own
  // menus, our /agents settings — the list must not consume its keys.

  /** A minimal real Editor — what pi focuses at the prompt (CustomEditor extends it). */
  function realEditor(): Editor {
    const fakeTui = { requestRender: () => {} };
    const theme = { borderColor: (s: string) => s, selectList: {} };
    return new Editor(fakeTui as any, theme as any);
  }

  /** Hand the fleet list its `tui` (happens on first widget render in pi) with the given focus. */
  function focusInHarness(h: Harness, focused: unknown): void {
    h.widgetTui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ↓ from a focused selector (activation)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { kind: "selector" }); // e.g. ExtensionSelectorComponent
    expect(h.press(DOWN)).toBeUndefined(); // must flow through to the selector
  });

  it("does not steal navigation keys from a selector opened while the list was active", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true }); // activate at the prompt
    focusInHarness(h, { kind: "selector" });          // a dialog takes focus
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    // and the list dropped back to its inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("still activates when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("assumes the editor when focus is unknowable (no tui yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    // No render yet → the list has never seen a tui: activation must still work.
    expect(h.press(DOWN)).toEqual({ consume: true });
  });
});

describe("FleetList rendering", () => {
  it("renders main + agent rows with markers, type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    const lines = h.render(120);
    // hint + blank + main + one agent
    expect(lines[0]).toContain("← for agents");
    expect(lines.find(l => l.includes("main"))).toContain("●"); // main selected by default
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("○");
    expect(agentLine).toContain(getDisplayName("general-purpose"));
    expect(agentLine).toContain("↓ 13.1k tokens");
    expect(agentLine).toMatch(/↓ 13\.1k tokens · \d+s/);
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const lines = harness(agents).render();
    const oldIdx = lines.findIndex(l => l.includes("oldest"));
    const newIdx = lines.findIndex(l => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx); // earliest sits above the later one
  });

  it("hides agents that have no session yet (pending)", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({ id: "pending", description: "queued one", status: "queued", session: undefined }),
    ];
    const lines = harness(agents).render();
    expect(lines.some(l => l.includes("running one"))).toBe(true);
    expect(lines.some(l => l.includes("queued one"))).toBe(false);
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 11 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    const lines = h.render(120);
    // 11 agents, cap 8 visible → "↓ 3 more"
    expect(lines.some(l => l.includes("↓ 3 more"))).toBe(true);
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 11 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `a very long agent description number ${i} that keeps going` }));
    const h = harness(agents);
    for (const w of [0, 1, 2, 4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 11 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.press(DOWN); // activate (main)
    // step down to the last agent (11 agents → roster index 11)
    for (let i = 0; i < 11; i++) h.press(DOWN);
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 10"))).toContain("●");
    expect(lines.some(l => l.includes("↑"))).toBe(true); // hidden-above indicator
  });
});

describe("FleetList overlay lifecycle", () => {
  it("Enter on 'main' just deactivates (no overlay)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // active, index 0 (main)
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false); // never opened an overlay
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("keeps the cursor on the viewed agent after closing, even if the list reordered", async () => {
    const fakeSession = { subscribe: () => () => {}, messages: [] };
    const agents = [
      makeRecord({ id: "a1", description: "one", session: fakeSession as any }),
      makeRecord({ id: "a2", description: "two", session: fakeSession as any }),
      makeRecord({ id: "a3", description: "three", session: fakeSession as any }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate (main, idx 0)
    h.press(DOWN); // a1 (idx 1)
    h.press(DOWN); // a2 (idx 2)
    h.press(ENTER); // open a2
    // a1 finishes and drops out while viewing → a2 shifts from idx 2 to idx 1.
    agents.splice(0, 1);
    await h.closeOverlay();
    // Selection follows a2 ("two") to its new position, not whatever is at idx 2 now.
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("three"))).toContain("○");
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");                       // Enter → open composer
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r");                       // Enter → send

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN); // active (main)
    h.press(DOWN); // → the agent
    h.press(ENTER); // opens overlay
    expect(h.overlayOpened()).toBe(true);
    // The agent finishes, well past the linger window...
    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false);                          // viewer stays open
    expect(h.render().some(l => l.includes("the one"))).toBe(true); // and stays listed while viewed
  });

  it("lingers a finished agent in the list, then drops it after the window", () => {
    const recent = makeRecord({ id: "r", description: "recent done", status: "completed", completedAt: Date.now() });
    expect(harness([recent]).render().some(l => l.includes("recent done"))).toBe(true);
    const old = makeRecord({ id: "o", description: "old done", status: "completed", completedAt: Date.now() - 60_000 });
    expect(harness([old]).render().some(l => l.includes("old done"))).toBe(false);
  });
});

function makeActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    activeTools: new Map([["t", "bash"]]), responseText: "ACTIVITY MUST NOT APPEAR",
    turnCount: 5, maxTurns: 30, toolUses: 5,
    lifetimeUsage: { input: 33800, output: 0, cacheWrite: 0 },
    session: { getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 62 } }) },
    ...overrides,
  };
}

function cjkNames(): void {
  const config = agentTypes.getConfig("general-purpose");
  vi.spyOn(agentTypes, "getConfig").mockImplementation(type => ({
    ...config, displayName: type === "jintong" ? "Jintong 金童" : "Wen Chang 文昌",
  }));
}

describe("FleetList detailed rows", () => {
  it("uses live model/thinking/Fast and activity totals, without provider or activity text", () => {
    const session = { ...FAKE_SESSION, model: { provider: "live-provider", id: "gpt-5.6" }, thinkingLevel: "high" } as unknown as NonNullable<AgentRecord["session"]>;
    sessionFastPolicies.set(session, { enabled: true, usingOAuth: false });
    const record = makeRecord({ session, isBackground: true, compactionCount: 2,
      invocation: { modelName: "stale/model", thinking: "low", fast: false } });
    const h = harness([record], new Map([[record.id, makeActivity()]]));
    const row = h.render(240).at(-1)!;
    expect(row).toContain("bg · gpt-5.6:high:fast · ↻5≤30 · ⇲2 · 5 tools · ↓ 33.8k tokens (62%) · 0s");
    expect(row).not.toMatch(/live-provider|stale|ACTIVITY|bash|thinking…/);
    const next = h.render(240).at(-1)!;
    expect(next.slice(0, 6)).not.toBe(row.slice(0, 6)); // spinner advances per render
  });

  it("falls back to the invocation model and preserves unresolved default thinking", () => {
    const record = makeRecord({ invocation: { modelName: "provider/fallback", thinking: "off" } });
    const h = harness([record]);
    expect(h.render(240).at(-1)).toContain("fallback:off");
    record.invocation = { thinkingDefault: true };
    expect(h.render(240).at(-1)).toContain("thinking: default (pending)");
    expect(h.render(240).at(-1)).not.toContain("undefined");
    record.isBackground = false;
    expect(h.render(240).at(-1)).not.toContain("bg ·");
  });

  it.each([
    ["completed", "✓", "done"], ["force_steered", "✓", "steered"],
    ["stopped", "■", "stopped"], ["aborted", "■", "aborted"], ["error", "×", "failed"],
  ] as const)("shows %s vocabulary and freezes elapsed time, without errors", (status, glyph, word) => {
    const record = makeRecord({ status, startedAt: Date.now() - 72000, completedAt: Date.now(),
      error: "SECRET ERROR DETAIL", isBackground: true });
    const row = harness([record]).render(240).at(-1)!;
    expect(row).toContain(`○ ${glyph} `);
    expect(row).toContain(`${word} · bg ·`);
    expect(row).toMatch(/· 72s$/);
    expect(row).not.toContain("SECRET ERROR DETAIL");
  });

  it.each([[69, "dim"], [70, "warning"], [84, "warning"], [85, "error"]] as const)(
    "colors %i%% context as %s", (percent, color) => {
      const record = makeRecord();
      const activity = makeActivity({ session: { getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent },
      }) } });
      const fg = vi.fn((_color: string, text: string) => text);
      harness([record], new Map([[record.id, activity]])).render(240, { ...theme, fg });
      expect(fg).toHaveBeenCalledWith(color, ` (${percent}%)`);
    },
  );

  it("degrades all rows at one tier and measures CJK names in terminal cells", () => {
    cjkNames();
    const description = "0123456789abcdef";
    const record = makeRecord({ type: "jintong", description, isBackground: true, compactionCount: 2,
      invocation: { modelName: "provider/gpt-5.6", thinking: "high" } });
    const second = makeRecord({ id: "second", type: "wenchang", description, compactionCount: 2,
      invocation: record.invocation });
    const h = harness([record, second], new Map([[record.id, makeActivity()], [second.id, makeActivity()]]));
    const wide = h.render(300)[3];
    const fullStats = wide.slice(wide.indexOf("bg ·"));
    const tierStats = [fullStats];
    tierStats.push(tierStats[0].replace("5 tools · ", ""));
    tierStats.push(tierStats[1].replace("↻5≤30 · ⇲2 · ", ""));
    tierStats.push(tierStats[2].replace("gpt-5.6:high · ", ""));
    tierStats.push(tierStats[3].replace(" (62%)", ""));
    const prefixWidth = visibleWidth("  ○ ⠹ Jintong 金童  ");
    expect(visibleWidth("金童")).toBe(4);
    for (let level = 0; level < tierStats.length; level++) {
      const width = prefixWidth + 16 + 1 + visibleWidth(tierStats[level]);
      const lines = h.render(width);
      for (const row of lines.slice(3)) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        expect(row).toContain(description);
        expect(row.includes("5 tools")).toBe(level === 0);
        expect(row.includes("↻5≤30")).toBe(level < 2);
        expect(row.includes("⇲2")).toBe(level < 2);
        expect(row.includes("gpt-5.6:high")).toBe(level < 3);
        expect(row.includes("(62%)")).toBe(level < 4);
      }
      if (level === 3) console.log(`NARROW FLEET ROW (${width} columns):\n${lines[3]}`);
    }
    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      for (const row of h.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  });

  it("drops only the graph agent count at tier four and keeps graph runs above agents", () => {
    const h = harness([makeRecord()]);
    h.fleet.setGraphRunSource(() => [{ id: "graph", name: "deep-research", status: "running",
      doneCount: 3, totalCount: 7, startedAt: Date.now(), tokens: 88200 }], vi.fn());
    h.fleet.update();
    const wide = h.render(240);
    expect(wide[3]).toContain("graph run  deep-research");
    expect(wide[3]).toContain("3/7 agents · 0s · ↓ 88.2k tokens");
    const narrow = h.render(60);
    expect(narrow[3]).not.toContain("3/7 agents");
    expect(narrow[3]).toContain("0s · ↓ 88.2k tokens");
  });
});

describe("FleetList hierarchy, retention and queue", () => {
  it("orders siblings under their parent and keeps nested selection openable", async () => {
    const agents = [
      makeRecord({ id: "later", description: "later root", startedAt: 2 }),
      makeRecord({ id: "last", description: "last child", parentAgentId: "parent", startedAt: 4 }),
      makeRecord({ id: "parent", description: "parent root", startedAt: 1 }),
      makeRecord({ id: "first", description: "first child", parentAgentId: "parent", startedAt: 3 }),
    ];
    const h = harness(agents);
    const rows = h.render(240).slice(3);
    expect(rows.map(row => agents.find(a => row.includes(a.description))?.id)).toEqual(["parent", "first", "last", "later"]);
    expect(rows[1]).toMatch(/^  ○   ├ ⠙ /);
    expect(rows[2]).toMatch(/^  ○   └ ⠙ /);
    h.press(DOWN); h.press(DOWN); h.press(DOWN); h.press(ENTER);
    expect(h.overlayOpened()).toBe(true);
    await h.closeOverlay();
    expect(h.render(240).find(row => row.includes("first child"))).toMatch(/^  ●   ├ /);
    agents.splice(agents.findIndex(a => a.id === "parent"), 1);
    expect(h.render(240).find(row => row.includes("first child"))).toMatch(/^  ● ⠸ /);
  });

  it.each(["completed", "error", "stopped", "aborted", "force_steered"] as const)(
    "retains %s for its full window, and retains a parent while its child is visible", status => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const linger = status === "completed" ? 4000 : 30000;
      const parent = makeRecord({ id: "parent", status, description: "parent row", completedAt: now - linger + 1 });
      const agents = [parent];
      const h = harness(agents);
      expect(h.render(240).some(row => row.includes("parent row"))).toBe(true);
      parent.completedAt = now - linger;
      expect(h.render(240)).toEqual([]);
      agents.push(makeRecord({ id: "child", parentAgentId: "parent", description: "child row" }));
      expect(h.render(240).some(row => row.includes("parent row"))).toBe(true);
    },
  );

  it("shows one non-selectable queued row even without any sessions", () => {
    const agents = [makeRecord({ status: "queued", session: undefined }),
      makeRecord({ id: "q2", status: "queued" }),
      makeRecord({ id: "owned", graphRunId: "graph", status: "queued", session: undefined })];
    const h = harness(agents);
    const lines = h.render();
    expect(lines.at(-1)).toBe("    ◦ 2 queued");
    expect(lines).toHaveLength(4); // hint, blank, main, aggregate queue
    expect(h.setStatus).toHaveBeenLastCalledWith("subagents", "0 running, 2 queued agents");
    expect(h.press(DOWN)).toEqual({ consume: true });
    h.press(DOWN); // queued line cannot take selection from main
    expect(h.render().find(row => row.includes("main"))).toMatch(/^  ● /);
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false);
    agents.unshift(makeRecord({ id: "live" }));
    h.fleet.update();
    h.press(DOWN); h.press(DOWN); h.press(DOWN);
    expect(h.render()[3]).toMatch(/^  ● /);
    expect(h.render().at(-1)).toBe("    ◦ 2 queued");
  });

  it("owns the always-on footer, guards churn, and clears UI, timer and input on dispose", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "fg", isBackground: false }), makeRecord({ id: "bg", isBackground: true }),
        makeRecord({ id: "nested", parentAgentId: "fg" }),
        makeRecord({ id: "owned", graphRunId: "graph" }),
        makeRecord({ id: "q", status: "queued", session: undefined })];
      const h = harness(agents);
      expect(h.setStatus).toHaveBeenLastCalledWith("subagents", "3 running, 1 queued agents");
      h.fleet.setEnabled(false);
      h.fleet.update();
      expect(h.setStatus).toHaveBeenCalledTimes(1);
      agents.splice(1);
      vi.advanceTimersByTime(200);
      expect(h.setStatus).toHaveBeenLastCalledWith("subagents", "1 running agent");
      agents.splice(0);
      h.fleet.update();
      expect(h.setStatus).toHaveBeenLastCalledWith("subagents", undefined);
      h.fleet.dispose();
      expect(h.render()).toEqual([]);
      expect(h.press(DOWN)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
