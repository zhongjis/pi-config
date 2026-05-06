import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function superpowersExtension(pi: ExtensionAPI) {
  pi.registerCommand("superpowers", {
    description: "Show Superpowers mode and skill package help",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Superpowers skills are installed. Use /mode superpowers or /mode sp to enable the Superpowers guardrail mode.",
        "info",
      );
    },
  });
}
