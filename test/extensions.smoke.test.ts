import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockContext } from "./fixtures/mock-context.js";
import { createMockPi } from "./fixtures/mock-pi.js";

/*
 * vi.mock() calls are hoisted and intercept both ESM imports AND CJS require().
 * The resolve.alias in vitest.config.ts handles most ESM imports, but
 * extensions/session-local/storage.ts uses require("@earendil-works/pi-coding-agent")
 * at the top level, which bypasses Vite's alias. vi.mock() catches both paths.
 */
vi.mock("@earendil-works/pi-coding-agent", () => import("./stubs/pi-coding-agent.js"));
vi.mock("@earendil-works/pi-tui", () => import("./stubs/pi-tui.js"));
vi.mock("@earendil-works/pi-ai", () => import("./stubs/pi-ai.js"));
vi.mock("@earendil-works/pi-agent-core", () => import("./stubs/pi-agent-core.js"));

function discoverExtensionEntries(): string[] {
  const extensionsDir = join(process.cwd(), "extensions");
  const testDir = join(process.cwd(), "test");
  const entries: string[] = [];

  for (const name of readdirSync(extensionsDir)) {
    if (name.startsWith(".")) {
      continue;
    }

    if (name === "lib") {
      continue; // shared utility library, not an extension
    }

    const fullPath = join(extensionsDir, name);
    const stats = statSync(fullPath);

    if (stats.isFile() && name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      entries.push(fullPath);
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    const indexPath = join(fullPath, "index.ts");
    if (existsSync(indexPath)) {
      entries.push(indexPath);
      continue;
    }

    const packagePath = join(fullPath, "package.json");
    if (!existsSync(packagePath)) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const declaredEntries = packageJson.pi?.extensions;
    if (!Array.isArray(declaredEntries)) {
      continue;
    }

    for (const declaredEntry of declaredEntries) {
      if (typeof declaredEntry !== "string") {
        continue;
      }

      const declaredPath = join(fullPath, declaredEntry);
      if (existsSync(declaredPath)) {
        entries.push(declaredPath);
      }
    }
  }

  return entries
    .map((entry) => relative(testDir, entry).split(sep).join("/"))
    .map((entry) => (entry.startsWith(".") ? entry : `./${entry}`))
    .sort();
}

const extensionEntries = discoverExtensionEntries();

const EXPECTED_TOOL_NAMES = [
  "Agent",
  "Task",
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
  "steer_subagent",
  "update_goal",
  "write",
] as const;

let tempHome = "";
let originalHome = process.env.HOME;

describe("extension entrypoints", () => {
  beforeAll(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "panda-harness-home-"));
    process.env.HOME = tempHome;
    const agentDir = join(tempHome, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "boomerang.json"), JSON.stringify({ toolEnabled: true }), "utf8");
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    if (tempHome) {
      await rm(tempHome, { force: true, recursive: true });
    }
  });

  it("discovers top-level extension entrypoints automatically", () => {
    expect(extensionEntries.length).toBeGreaterThan(0);
    expect(new Set(extensionEntries).size).toBe(extensionEntries.length);
  });

  it("locks package names for subagents and tasks", () => {
    const cases: Array<[string, string]> = [
      ["extensions/subagents/package.json", "@tintinweb/pi-subagents"],
      ["extensions/tasks/package.json", "@panda/pi-tasks"],
    ];
    for (const [relPath, expectedName] of cases) {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), relPath), "utf8"));
      expect(pkg.name).toBe(expectedName);
    }
  });

  it("leaves session resume hints to Pi core", async () => {
    const mock = createMockPi();
    const mod = await import("../extensions/qol/index.js");

    mod.default(mock.pi as never);

    expect(mock.lifecycleHandlers.has("session_shutdown")).toBe(false);
  });

  it("locks the exact extension tool registry without executing tools", async () => {
    const mock = createMockPi();

    for (const entry of extensionEntries) {
      const mod = await import(entry);
      const maybePromise = mod.default(mock.pi as never);
      if (maybePromise && typeof maybePromise === "object" && "then" in maybePromise) {
        await maybePromise;
      }
    }

    const registrations = mock.toolRegistrations;
    const rawNames = registrations.map((definition) => definition.name);
    const uniqueNames = [...new Set(rawNames)];

    expect(rawNames).toHaveLength(25);
    expect(uniqueNames).toHaveLength(25);
    expect([...uniqueNames].sort()).toEqual([...EXPECTED_TOOL_NAMES]);

    for (const definition of registrations) {
      expect(mock.tools.get(definition.name)).toBe(definition);
    }
  });

  for (const entry of extensionEntries) {
    it(`loads ${entry} and registers without throwing`, async () => {
      const mock = createMockPi();
      const ctx = createMockContext();
      const mod = await import(entry);

      expect(typeof mod.default).toBe("function");

      const maybePromise = mod.default(mock.pi as never);
      if (maybePromise && typeof maybePromise === "object" && "then" in maybePromise) {
        await maybePromise;
      }

      await mock.fireLifecycle("session_start", {}, ctx);
      await mock.fireLifecycle("session_switch", {}, ctx);
      await mock.fireLifecycle("session_tree", {}, ctx);
      await mock.fireLifecycle("session_shutdown", {}, ctx);

      const registrationCount =
        mock.commands.size +
        mock.flags.size +
        mock.lifecycleHandlers.size +
        mock.providers.size +
        mock.renderers.size +
        mock.shortcuts.size +
        mock.tools.size +
        mock.widgets.size;

      expect(registrationCount).toBeGreaterThan(0);
    });
  }
});
