import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INIT_DEEP_TEMPLATE } from "./init-deep-template.js";
import { INIT_DOX_TEMPLATE } from "./init-dox-template.js";

export default function initExtension(pi: ExtensionAPI): void {
  pi.registerCommand("init-deep", {
    description:
      "Generate hierarchical AGENTS.md documentation for the current project",
    handler: async (args: string, ctx) => {
      const userArgs = args ?? "";
      const instruction = userArgs
        ? `<user-request>${userArgs}</user-request>`
        : "";

      pi.sendMessage(
        {
          content: `<command-instruction>\n${INIT_DEEP_TEMPLATE}\n</command-instruction>\n\n${instruction}`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );

      if (ctx.hasUI) {
        ctx.ui.notify("init-deep started — generating AGENTS.md hierarchy…", "info");
      }
    },
  });

  pi.registerCommand("init-dox", {
    description: "Initialize or migrate project AGENTS.md documentation to DOX",
    handler: async (args: string, ctx) => {
      const userArgs = args ?? "";
      const instruction = userArgs
        ? `<user-request>${userArgs}</user-request>`
        : "";

      pi.sendMessage(
        {
          content: `<command-instruction>\n${INIT_DOX_TEMPLATE}\n</command-instruction>\n\n${instruction}`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );

      if (ctx.hasUI) {
        ctx.ui.notify("init-dox started — initializing DOX guidance…", "info");
      }
    },
  });
}
