import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const EXTRA_TOOLS = ["grep", "find", "ls"];

function hasSavedToolSelection(ctx: ExtensionContext): boolean {
  const branchEntries = ctx.sessionManager.getBranch();

  for (const entry of branchEntries) {
    if (entry.type === "custom" && entry.customType === "tools-config") {
      return true;
    }
  }

  return false;
}

export default function enableExtraTools(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (hasSavedToolSelection(ctx)) {
      return;
    }

    const activeTools = new Set(pi.getActiveTools());
    const allTools = new Set(pi.getAllTools().map((tool) => tool.name));

    let changed = false;
    for (const toolName of EXTRA_TOOLS) {
      if (!allTools.has(toolName) || activeTools.has(toolName)) {
        continue;
      }

      activeTools.add(toolName);
      changed = true;
    }

    if (changed) {
      pi.setActiveTools(Array.from(activeTools));
    }
  });
}
