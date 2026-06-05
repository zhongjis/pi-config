import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModeStateEntry = {
  type?: string;
  customType?: string;
  data?: { mode?: unknown };
};

const baseDir = dirname(fileURLToPath(import.meta.url));

function latestPersistedMode(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries() as ModeStateEntry[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== "agent-mode") continue;
    return typeof entry.data?.mode === "string" ? entry.data.mode : undefined;
  }
  return undefined;
}

export default function superpowersExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", (_event, ctx) => ({
    skillPaths: latestPersistedMode(ctx) === "luban" ? [join(baseDir, "skills")] : [],
  }));
}
