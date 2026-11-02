import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { boot } from "./graph-run-registration.fixture.js";

/** A direct tool-context driver with captured wire updates. */
export function presentationHost(settings: Record<string, unknown> = {}) {
  const host = boot(settings);
  const entries = new Map<string, AgentToolResult<unknown>[]>();
  for (const tool of host.tools.values()) {
    const execute = tool.execute;
    tool.execute = (id, params, signal, onUpdate, ctx) => execute(id, params, signal, update => {
      const updates = entries.get(id) ?? [];
      updates.push(update);
      entries.set(id, updates);
      onUpdate?.(update);
    }, ctx);
  }
  const context = (_parent: string, mode: "rpc" | "tui" = "rpc", hasUI = true) => ({
    ...host.ctx, mode, hasUI, executeTool: vi.fn(),
  });
  return { ...host, entries, context };
}

export const launchParams = { subagent_type: "fixture", prompt: "work", description: "inspect the fixture" };

export function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map(part => part.text || "").join("\n");
}
