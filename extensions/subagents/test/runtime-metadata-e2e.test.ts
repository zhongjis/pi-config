import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
// Shared tool-output uses the root Pi TUI; the vendored package also has a nested copy.
import { getKeybindings, KeybindingsManager, setKeybindings, visibleWidth } from "../../../node_modules/@earendil-works/pi-tui/dist/index.js";
import { renderAgentToolResult } from "../src/tool-rendering.js";
import type { AgentRecord } from "../src/types.js";
import { agentCall, type PrintModeRun, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

describe("Packet B actual SDK metadata", () => {
  it.each([
    { id: "omitted_thinking_explicit_chain_uses_sdk_default_not_parent", model: "model: faux/faux-1\n" },
    { id: "omitted_thinking_inherited_model_uses_sdk_default_not_parent", model: "" },
  ])("$id", async ({ model }) => {
    for (const defaultThinkingLevel of ["low", undefined]) {
      const cwd = mkdtempSync(join(tmpdir(), "subagents-default-thinking-"));
      let run: PrintModeRun | undefined;
      try {
        mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "agents", "defaults.md"), `---\ndescription: Defaults\n${model}extensions: false\n---\nReport.\n`);
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel }));
        run = await runPrintMode({ cwd, prompt: "Delegate.", reasoning: true, parentThinking: "high",
          respond: routeBySession({
            parentInitial: agentCall({ subagent_type: "defaults", prompt: "Report.", description: "defaults" }),
            subagent: "Done",
          }),
        });
        expect(run.parentSession.thinkingLevel).toBe("high");
        const result = run.parentSession.messages.find((m): m is ToolResultMessage<unknown> => m.role === "toolResult" && m.toolName === "Agent");
        expect(result?.details).toMatchObject({ thinking: defaultThinkingLevel ?? "medium" });
        const id = result?.content.filter((b) => b.type === "text").map((b) => b.text).join("").match(/Agent ID: (\S+)/)?.[1];
        expect(run.manager?.getRecord(id ?? "")).toMatchObject({ session: { thinkingLevel: defaultThinkingLevel ?? "medium" }, invocation: { thinking: defaultThinkingLevel ?? "medium" } });
      } finally {
        try { await run?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
      }
    }
  });
  it("omitted_thinking_background_pending_is_replaced_on_retrieval", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-pending-"));
    let run: PrintModeRun | undefined;
    try {
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "agents", "pending.md"), "---\ndescription: Pending\nextensions: false\n---\nReport.\n");
      run = await runPrintMode({ cwd, prompt: "Delegate.", reasoning: true, parentThinking: "high", respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "pending", prompt: "Report.", description: "pending", run_in_background: true }),
        parentFinal: (ctx) => {
          if (ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "get_subagent_result")) return "Done";
          const first = ctx.messages.find((m): m is ToolResultMessage<unknown> => m.role === "toolResult" && m.toolName === "Agent");
          const id = first?.content.filter((b) => b.type === "text").map((b) => b.text).join("").match(/Agent ID: (\S+)/)?.[1];
          if (!id) throw new Error("Missing Agent ID");
          return { type: "toolCall", id: "retrieve", name: "get_subagent_result", arguments: { agent_id: id, wait: true } };
        },
        subagent: "Done",
      }) });
      const results = run.parentSession.messages.filter((m): m is ToolResultMessage<unknown> => m.role === "toolResult" && ["Agent", "get_subagent_result"].includes(m.toolName));
      expect(results[0]?.details).toMatchObject({ thinking: undefined, tags: expect.arrayContaining(["thinking: default (pending)"]) });
      expect(results[1]?.details).toMatchObject({ thinking: "medium", tags: expect.not.arrayContaining(["thinking: default (pending)"]) });
    } finally {
      try { await run?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
    }
  });

  it.each([false, true])("B01 actual same-parent model and clamped thinking survive retrieval and resume (background=%s)", async (background) => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-metadata-"));
    let run: PrintModeRun | undefined;
    try {
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      const config = join(cwd, ".pi", "agents", "metadata.md");
      writeFileSync(config, "---\ndescription: Metadata\nthinking: high\nprompt_mode: append\nextensions: false\nexclude_extensions: unused-extension\nmax_turns: 1\n---\nReport.\n");
      let phase = 0;
      run = await runPrintMode({ cwd, prompt: "Delegate.", respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "metadata", prompt: "Report.", description: "metadata", run_in_background: background }),
        parentFinal: (ctx) => {
          const first = ctx.messages.find((m): m is ToolResultMessage<unknown> => m.role === "toolResult" && m.toolName === "Agent");
          const text = first?.content.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
          const id = text.match(/Agent ID: (\S+)/)?.[1];
          if (!id) throw new Error("Missing Agent ID");
          if (phase++ === 0) return { type: "toolCall", id: "retrieve", name: "get_subagent_result", arguments: { agent_id: id, wait: true, verbose: true } };
          if (phase === 2) {
            // Resume must describe the retained session, not unrelated current configuration.
            writeFileSync(config, "---\ndescription: Metadata\nmodel: missing/changed\nprompt_mode: append\nthinking: low\n---\nReport.\n");
            return agentCall({ subagent_type: "metadata", prompt: "Continue.", description: "resume", resume: id }, { id: "resume" });
          }
          return "Done";
        },
        subagent: "**ACTUAL_ANSWER**\n\n- 界面 é\n\n```ts\nconst complete = true;\n```",
      }) });
      const results = run.parentSession.messages.filter((m): m is ToolResultMessage<unknown> => m.role === "toolResult" && ["Agent", "get_subagent_result"].includes(m.toolName));
      expect(results).toHaveLength(3);
      const id = results[0]?.content.filter((b) => b.type === "text").map((b) => b.text).join("").match(/Agent ID: (\S+)/)?.[1];
      const record = run.manager?.getRecord(id ?? "") as AgentRecord | undefined;
      if (!record?.session) throw new Error("Missing actual session");
      expect(record.session.model?.id).toBe(run.parentSession.model?.id);
      expect(record.session.thinkingLevel).toBe("off");
      expect(record.invocation?.modelName).toBe("faux/faux-1");
      expect(record.invocation?.thinking).toBe("off");
      expect(record.turnCount).toBe(2);
      expect(record.maxTurns).toBe(1);
      for (const result of results.slice(background ? 1 : 0)) {
        const details = result.details as Record<string, unknown>;
        expect(details.modelName).toBe("faux/faux-1");
        expect(details.thinking).toBe("off");
        expect(details.tags).toContain("twin");
        expect(details.tags).not.toContain("thinking: high");
        expect(details.result).toContain("ACTUAL_ANSWER");
        expect(details.outputFile).toBe(record.outputFile);
      }
      const retrieved = results[1];
      if (!retrieved) throw new Error("Missing retrieval");
      const details = retrieved.details as Record<string, unknown>;
      expect(details.toolUses).toBe(0);
      expect(details.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining("exclude_extensions has no effect")]));
      expect(details.conversation).toContain("ACTUAL_ANSWER");
      const previousPackageDir = process.env.PI_PACKAGE_DIR;
      try {
        process.env.PI_PACKAGE_DIR = fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
        initTheme(undefined, false);
      } finally {
        if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
        else process.env.PI_PACKAGE_DIR = previousPackageDir;
      }
      const previousKeys = getKeybindings();
      try {
        setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }, { "app.tools.expand": "ctrl+e" }));
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        const presentation = { content: retrieved.content, details: retrieved.details };
        const collapsed = renderAgentToolResult(presentation, { expanded: false }, theme);
        const expanded = renderAgentToolResult(presentation, { expanded: true }, theme);
        expect(collapsed.render(120).join("\n")).toContain("ctrl+e");
        const report = expanded.render(120).join("\n");
        expect(report).toContain("exclude_extensions has no effect");
        expect(report).toContain("Artifacts");
        expect(report).toContain("const complete = true;");
        for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
          expect(collapsed.render(width).length).toBeLessThanOrEqual(3);
          for (const component of [collapsed, expanded]) for (const line of component.render(width)) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          }
        }
      } finally { setKeybindings(previousKeys); }
      if (background) {
        const ack = results[0]?.details as Record<string, unknown>;
        expect(ack.thinking).toBeUndefined();
        expect(ack.modelName).toBeUndefined();
      }
    } finally {
      try { await run?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
    }
  });
});
