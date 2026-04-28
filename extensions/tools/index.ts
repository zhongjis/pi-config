import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@mariozechner/pi-tui";

interface ToolsState {
  enabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI): void {
  let enabledTools = new Set<string>();
  let allTools: ToolInfo[] = [];

  function persistState() {
    pi.appendEntry<ToolsState>("tools-config", {
      enabledTools: Array.from(enabledTools),
    });
  }

  function applyTools() {
    pi.setActiveTools(Array.from(enabledTools));
  }

  function restoreFromBranch(ctx: ExtensionContext) {
    allTools = pi.getAllTools();

    const branchEntries = ctx.sessionManager.getBranch();
    let savedTools: string[] | undefined;

    for (const entry of branchEntries) {
      if (entry.type !== "custom" || entry.customType !== "tools-config") {
        continue;
      }

      const data = entry.data as ToolsState | undefined;
      if (data?.enabledTools) {
        savedTools = data.enabledTools;
      }
    }

    if (!savedTools) {
      enabledTools = new Set(pi.getActiveTools());
      return;
    }

    const allToolNames = allTools.map((tool) => tool.name);
    enabledTools = new Set(savedTools.filter((toolName) => allToolNames.includes(toolName)));
    applyTools();
  }

  pi.registerCommand("tools", {
    description: "Enable or disable available tools",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("No UI available", "error");
        return;
      }

      allTools = pi.getAllTools();
      enabledTools = new Set(pi.getActiveTools());

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const items: SettingItem[] = allTools.map((tool) => ({
          id: tool.name,
          label: tool.name,
          currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        }));

        const container = new Container();
        container.addChild(
          new (class {
            render(_width: number) {
              return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
            }

            invalidate() {}
          })(),
        );

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            if (newValue === "enabled") {
              enabledTools.add(id);
            } else {
              enabledTools.delete(id);
            }

            applyTools();
            persistState();
          },
          () => {
            done(undefined);
          },
        );

        container.addChild(settingsList);

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });
}
