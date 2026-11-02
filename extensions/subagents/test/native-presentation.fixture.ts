import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { boot, required } from "./graph-run-registration.fixture.js";

/** A tool-context driver with Pi's nested-call IDs and captured wire updates. */
export function presentationHost(settings: Record<string, unknown> = {}) {
  const host = boot(settings);
  const entries = new Map<string, AgentToolResult<unknown>[]>();
  const context = (parent: string, mode: "rpc" | "tui" = "rpc", hasUI = true) => ({
    ...host.ctx, mode, hasUI,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      const updates: AgentToolResult<unknown>[] = [];
      entries.set(parent, updates);
      const tool = required(host.tools.get(name));
      const result = await tool.execute(`${parent}/1`, args, undefined, update => updates.push(update), host.ctx);
      // The final tool execution event carries the returned result, not an onUpdate call.
      updates.push({ ...result, content: result.content.flatMap(part => part.type === "text" && part.text !== undefined ? [{ type: "text" as const, text: part.text }] : []), details: result.details });
      return { result, isError: false };
    }),
  });
  return { ...host, entries, context };
}

export const launchParams = { subagent_type: "fixture", prompt: "work", description: "inspect the fixture" };

export function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map(part => part.text || "").join("\n");
}
