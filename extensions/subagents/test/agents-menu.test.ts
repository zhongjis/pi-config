import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccessRules } from "../../lib/active-tools.js";
import { parseAgentMarkdown } from "../../lib/agent-frontmatter.js";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { createAgentsMenu } from "../src/ui/agents-menu.js";

const probe: AgentConfig = {
  name: "probe",
  description: "probe",
  extensionRules: parseAccessRules("extensions", "+matrix").rules,
  toolRules: parseAccessRules("tools", "+read, +@matrix").rules,
  delegationRules: parseAccessRules("delegation", "+@all, -writer").rules,
  discoverSkills: true,
  preloadSkills: [],
  systemPrompt: "Probe.",
  promptMode: "replace",
};

/** This session's tool registry, as `pi.getAllTools()` reports it. */
const registry = [
  { name: "read", sourceInfo: { path: "builtin:read" } },
  { name: "bash", sourceInfo: { path: "builtin:bash" } },
  { name: "matrix_a", sourceInfo: { path: "/ext/matrix.ts" } },
  { name: "other_tool", sourceInfo: { path: "/ext/other.ts" } },
];

describe("agents menu access rules", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agents-menu-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-dir"));
    vi.spyOn(process, "cwd").mockReturnValue(join(root, "project"));
    registerAgents(new Map([["probe", probe]]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    registerAgents(new Map());
    rmSync(root, { recursive: true, force: true });
  });

  /** Open Agent types → `agent` → choose `action` in its detail menu (later prompts pick `answers`). */
  async function openDetail(agent: string, action: string, answers: Record<string, (options: string[]) => string> = {}) {
    const titles: string[] = [];
    let listed = false;
    const ui = {
      notify: vi.fn(),
      select: vi.fn(async (title: string, options: string[]) => {
        titles.push(title);
        if (title === "Agents") return titles.length === 1 ? options.find((o) => o.startsWith("Agent types")) : undefined;
        if (answers[title]) return answers[title](options);
        return title.startsWith(`${agent}\n`) ? action : undefined;
      }),
      custom: vi.fn(async () => {
        if (listed) return undefined;
        listed = true;
        return agent;
      }),
    };
    const menu = createAgentsMenu(
      { pi: { getAllTools: () => registry } as never, manager: new AgentManager(), reloadCustomAgents: () => {} },
      new Map(),
      {
        graphRuns: { tasks: new Map(), getRecord: () => undefined, viewAgentConversation: async () => {}, getCtx: () => undefined },
        showSettings: async () => {},
      },
    );
    await menu.showAgentsMenu({ ui } as never);
    return titles;
  }

  it("shows the agent's rules and the tools they resolve to in this session", async () => {
    const titles = await openDetail("probe", "Back");

    expect(titles).toContain("probe\nextensions: +matrix\ntools: +read, +@matrix\ndelegation: +@all, -writer\nresolves here to: read, matrix_a");
  });

  it("ejects normalized access and delegation rules", async () => {
    registerAgents(new Map([["probe", { ...probe, isDefault: true }]]));

    await openDetail("probe", "Eject (export as .md)", {
      "Choose location": (options) => options[1],
    });

    const ejected = readFileSync(join(root, "agent-dir", "agents", "probe.md"), "utf-8");
    const parsed = parseAgentMarkdown(ejected);
    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.extensionRules).toEqual(probe.extensionRules);
    expect(parsed.toolRules).toEqual(probe.toolRules);
    expect(parsed.delegationRules).toEqual([{ sign: "+", selector: "@all" }, { sign: "-", selector: "writer" }]);
  });
});
