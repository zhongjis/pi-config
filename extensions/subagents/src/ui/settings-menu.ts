import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { SubagentsSettings } from "../settings.js";

const NUMERIC_IDS = new Set(["maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns"]);

/** Settings presentation and typed input; mutation and persistence stay with activation. */
export function createSettingsMenu(
  snapshot: () => Readonly<Required<SubagentsSettings>>,
  applyValue: (ctx: ExtensionCommandContext, id: string, value: string) => void,
) {
  function buildItems(): SettingItem[] {
    const settings = snapshot();
    const mc = settings.maxConcurrent;
    const dmt = settings.defaultMaxTurns;
    const gt = settings.graceTurns;
    return [
      {
        id: "workflowsEnabled", label: "Agent graphs",
        description: "Opt-in agent graph orchestration. Changes apply on next reload.",
        currentValue: settings.workflowsEnabled ? "on" : "off", values: ["on", "off"],
      },
      {
        id: "maxConcurrent",
        label: "Max concurrency",
        description: "Max concurrent background agents (Enter to type)",
        currentValue: String(mc),
        values: [String(mc)],
      },
      {
        id: "maxConcurrentForeground",
        label: "Foreground concurrency",
        description: "Max concurrent foreground agents (0 = unlimited, Enter to type)",
        currentValue: String(settings.maxConcurrentForeground),
        values: [String(settings.maxConcurrentForeground)],
      },
      {
        id: "reportUsage",
        label: "Report usage",
        description: "Report subagent usage on the next final Agent, graph run, retrieval, or steer result",
        currentValue: settings.reportUsage ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showCost",
        label: "Expanded cost",
        description: "Show per-agent cost only in expanded tool reports",
        currentValue: settings.showCost ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "defaultMaxTurns",
        label: "Default max turns",
        description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
        currentValue: String(dmt),
        values: [String(dmt)],
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        description: "Grace turns after wrap-up steer (Enter to type)",
        currentValue: String(gt),
        values: [String(gt)],
      },
      {
        id: "joinMode",
        label: "Join mode",
        description: "Default join mode for background agents",
        currentValue: settings.defaultJoinMode,
        values: ["smart", "async", "group"],
      },
      {
        id: "scopeModels",
        label: "Scope models",
        description: "Validate subagent models against scoped models (/scoped-models)",
        currentValue: settings.scopeModels ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "disableDefaultAgents",
        label: "Disable defaults",
        description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
        currentValue: settings.disableDefaultAgents ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "outputTranscript",
        label: "Output transcript",
        description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
        currentValue: settings.outputTranscript ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "fleetView",
        label: "Fleet view",
        description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
        currentValue: settings.fleetView ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "widgetMode",
        label: "Widget",
        description: "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
        currentValue: settings.widgetMode,
        values: ["all", "background", "off"],
      },
      {
        id: "toolDescriptionMode",
        label: "Tool description",
        description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
        currentValue: settings.toolDescriptionMode,
        values: ["full", "compact", "custom"],
      },
    ];
  }

  async function showSettings(ctx: ExtensionCommandContext) {
    let list: SettingsList;
    // SettingsList doesn't expose selection; track it for numeric input.
    let currentIndex = 0;
    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();
      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(ctx, id, newValue);
        },
        () => done(undefined as undefined),
      );
      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });
    if (result && NUMERIC_IDS.has(result)) {
      const settings = snapshot();
      const current = result === "maxConcurrentForeground"
        ? String(settings.maxConcurrentForeground)
        : result === "maxConcurrent"
        ? String(settings.maxConcurrent)
        : result === "defaultMaxTurns"
          ? String(settings.defaultMaxTurns)
          : String(settings.graceTurns);
      const label = result === "maxConcurrentForeground"
        ? "Foreground concurrency (0 = unlimited, up to 1024)"
        : result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : "Grace turns (1+)";
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)
          && (result !== "maxConcurrentForeground" || (n >= 0 && n <= 1024))) {
          applyValue(ctx, result, String(n));
          await showSettings(ctx);
          return;
        }
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }
  return showSettings;
}
