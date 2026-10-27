import { DynamicBorder, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { SubagentsSettings } from "../settings.js";

const NUMERIC_IDS = new Set(["maxConcurrent", "maxConcurrentForeground"]);

/** Settings presentation and typed input; mutation and persistence stay with activation. */
export function createSettingsMenu(
  snapshot: () => Readonly<Required<SubagentsSettings>>,
  applyValue: (ctx: ExtensionCommandContext, id: string, value: string) => void,
) {
  function buildItems(): SettingItem[] {
    const settings = snapshot();
    const mc = settings.maxConcurrent;
    return [
      {
        id: "graphRuntimeTrace", label: "Graph runtime trace",
        description: "Write each graph run's XState event/state log (<runId>.runtime.jsonl) beside its trace. Applies to runs started afterwards.",
        currentValue: settings.graphRuntimeTrace ? "on" : "off", values: ["on", "off"],
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
        id: "outputTranscript",
        label: "Output transcript",
        description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
        currentValue: settings.outputTranscript ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "toolDescriptionMode",
        label: "Tool description",
        description: "agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
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
      container.addChild(new DynamicBorder());
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      container.addChild(new DynamicBorder());
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
        : String(settings.maxConcurrent);
      const label = result === "maxConcurrentForeground"
        ? "Foreground concurrency (0 = unlimited, up to 1024)"
        : "Max concurrency (1+)";
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
