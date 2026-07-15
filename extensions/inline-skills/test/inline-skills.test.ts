import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import inlineSkills from "../index.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type AutocompleteFactory = (current: unknown) => {
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) => Promise<{ items: Array<Record<string, unknown>>; prefix: string } | null>;
  applyCompletion: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: Record<string, unknown>,
    prefix: string,
  ) => { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ) => boolean;
};

interface SkillDef {
  name: string;
  path: string;
}

function makeCommands(defs: SkillDef[]) {
  return defs.map((d) => ({
    name: `skill:${d.name}`,
    source: "skill",
    description: `${d.name} skill`,
    sourceInfo: { path: d.path, source: "local", scope: "user" as const },
  }));
}

function currentStub(
  result: { items: Array<Record<string, unknown>>; prefix: string } | null = null,
) {
  return {
    getSuggestions: async () => result,
    applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
    shouldTriggerFileCompletion: () => true,
  };
}

function createHarness(defs: SkillDef[]) {
  const lifecycle = new Map<string, Handler[]>();
  const appended: Array<{ type: string; data: unknown }> = [];
  let autocompleteFactory: AutocompleteFactory | undefined;

  const pi = {
    getCommands: () => makeCommands(defs),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    appendEntry: (type: string, data: unknown) => {
      appended.push({ type, data });
    },
    on: (event: string, handler: Handler) => {
      const arr = lifecycle.get(event) ?? [];
      arr.push(handler);
      lifecycle.set(event, arr);
    },
    events: { emit: () => {}, on: () => () => {} },
  };

  const ctx = {
    cwd: tmpdir(),
    ui: {
      addAutocompleteProvider: (factory: AutocompleteFactory) => {
        autocompleteFactory = factory;
      },
      notify: () => {},
    },
    sessionManager: { getBranch: () => [] },
  };

  (inlineSkills as unknown as (p: unknown) => void)(pi);

  const fire = async (event: string, payload: unknown = {}, c: unknown = ctx) => {
    let result: unknown;
    for (const handler of lifecycle.get(event) ?? []) {
      result = await handler(payload, c);
    }
    return result;
  };

  return {
    fire,
    getProvider: () => autocompleteFactory,
  };
}

let tddPath = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "inline-skills-test-"));
  const skillDir = join(dir, "tdd");
  mkdirSync(skillDir, { recursive: true });
  tddPath = join(skillDir, "SKILL.md");
  writeFileSync(
    tddPath,
    "---\nname: tdd\ndescription: test\n---\nTDD_BODY_MARKER content here\n",
  );
});

describe("inline-skills ($skill: token)", () => {
  it("injects $skill:<name> token on submit", async () => {
    const h = createHarness([{ name: "tdd", path: tddPath }]);
    await h.fire("session_start");

    const inputRes = (await h.fire("input", {
      source: "user",
      text: "let's use $skill:tdd here",
    })) as { action?: string } | undefined;
    expect(inputRes?.action).toBe("transform");

    const basRes = (await h.fire("before_agent_start", {})) as
      | { message?: { customType?: string; content?: string; details?: { names?: string[] } } }
      | undefined;
    expect(basRes?.message?.customType).toBe("inline-skill");
    expect(basRes?.message?.details?.names).toEqual(["tdd"]);
    expect(basRes?.message?.content).toContain("TDD_BODY_MARKER");
  });

  it("autocomplete shows $skill: label and inserts $skill:<name>", async () => {
    const h = createHarness([{ name: "tdd", path: tddPath }]);
    await h.fire("session_start");

    const factory = h.getProvider();
    expect(typeof factory).toBe("function");
    const provider = factory!(currentStub(null));
    const signal = new AbortController().signal;

    const sugg = await provider.getSuggestions(["$td"], 0, 3, { signal });
    expect(sugg?.items?.[0]).toEqual(
      expect.objectContaining({ value: "$skill:tdd", label: "$skill:tdd" }),
    );

    const applied = provider.applyCompletion(["$td"], 0, 3, sugg!.items[0], "td");
    expect(applied.lines[0]).toBe("$skill:tdd ");
  });

  it("bare $name is not treated as an inline skill", async () => {
    const h = createHarness([{ name: "tdd", path: tddPath }]);
    await h.fire("session_start");

    const inputRes = (await h.fire("input", {
      source: "user",
      text: "use $tdd now",
    })) as { action?: string } | undefined;
    expect(inputRes?.action).toBe("continue");

    const basRes = await h.fire("before_agent_start", {});
    expect(basRes).toBeUndefined();
  });

  it("bare $ opens the full skill list", async () => {
    const h = createHarness([{ name: "tdd", path: tddPath }]);
    await h.fire("session_start");

    const provider = h.getProvider()!(currentStub(null));
    const signal = new AbortController().signal;

    const sugg = await provider.getSuggestions(["$"], 0, 1, { signal });
    const labels = (sugg?.items ?? []).map((i) => i.label);
    expect(labels).toContain("$skill:tdd");
  });

  it("slash context strips native skill entries so $ is the only skill path", async () => {
    const h = createHarness([{ name: "tdd", path: tddPath }]);
    await h.fire("session_start");

    const provider = h.getProvider()!(
      currentStub({
        items: [
          { value: "/help", label: "/help" },
          { value: "skill:tdd", label: "skill:tdd" },
        ],
        prefix: "/",
      }),
    );
    const signal = new AbortController().signal;

    const sugg = await provider.getSuggestions(["/td"], 0, 3, { signal });
    const labels = (sugg?.items ?? []).map((i) => i.label);
    expect(labels).toContain("/help");
    expect(labels).not.toContain("skill:tdd");
    expect(labels).not.toContain("$skill:tdd");
  });

  it("delegates the editor trigger to a mutable slot so /reload refreshes it", () => {
    // Installing the prototype wrapper (guarded to once per process).
    createHarness([{ name: "tdd", path: tddPath }]);

    const proto = CustomEditor.prototype as unknown as {
      handleInput: (data: string) => void;
      inlineSkillsSlashTrigger?: (editor: unknown, data: string) => void;
    };

    // Simulate a reload swapping in a fresh trigger implementation.
    const freshTrigger = vi.fn();
    proto.inlineSkillsSlashTrigger = freshTrigger;

    const fakeEditor = {
      isShowingAutocomplete: () => false,
      state: { cursorLine: 0, cursorCol: 1, lines: ["$"] },
      tryTriggerAutocomplete: vi.fn(),
    };
    proto.handleInput.call(fakeEditor, "$");

    expect(freshTrigger).toHaveBeenCalledWith(fakeEditor, "$");
  });
});
