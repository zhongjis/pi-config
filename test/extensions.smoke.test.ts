import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockContext } from "./fixtures/mock-context.js";
import { createMockPi } from "./fixtures/mock-pi.js";

/*
 * vi.mock() calls are hoisted and intercept both ESM imports AND CJS require().
 * The resolve.alias in vitest.config.ts handles most ESM imports, but
 * extensions/session-local/storage.ts uses require("@mariozechner/pi-coding-agent")
 * at the top level, which bypasses Vite's alias. vi.mock() catches both paths.
 */
vi.mock("@mariozechner/pi-coding-agent", () => import("./stubs/pi-coding-agent.js"));
vi.mock("@mariozechner/pi-tui", () => import("./stubs/pi-tui.js"));
vi.mock("@mariozechner/pi-ai", () => import("./stubs/pi-ai.js"));
vi.mock("@mariozechner/pi-agent-core", () => import("./stubs/pi-agent-core.js"));

function discoverExtensionEntries(): string[] {
  const extensionsDir = join(process.cwd(), "extensions");
  const testDir = join(process.cwd(), "test");
  const entries: string[] = [];

  for (const name of readdirSync(extensionsDir)) {
    if (name.startsWith(".")) {
      continue;
    }

    const fullPath = join(extensionsDir, name);
    const stats = statSync(fullPath);

    if (stats.isFile() && name.endsWith(".ts")) {
      entries.push(fullPath);
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    const indexPath = join(fullPath, "index.ts");
    if (existsSync(indexPath)) {
      entries.push(indexPath);
    }
  }

  return entries
    .map((entry) => relative(testDir, entry).split(sep).join("/"))
    .map((entry) => (entry.startsWith(".") ? entry : `./${entry}`))
    .sort();
}

const extensionEntries = discoverExtensionEntries();

let tempHome = "";
let originalHome = process.env.HOME;

describe("extension entrypoints", () => {
  beforeAll(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "panda-harness-home-"));
    process.env.HOME = tempHome;
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
