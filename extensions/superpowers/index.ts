import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(extensionDir, "skills");
const bootstrapSkillPath = resolve(skillsDir, "using-superpowers", "SKILL.md");
const piToolsMdPath = resolve(extensionDir, "overlay/files/using-superpowers/references/pi-tools.md");

let cachedBootstrap: string | null | undefined;

type ModeStateEntry = {
  type?: string;
  customType?: string;
  data?: { mode?: unknown };
};

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
  let injectBootstrap = true;

  pi.on("resources_discover", async (_event, ctx) => {
    if (latestPersistedMode(ctx) !== "luban") return { skillPaths: [] };
    return { skillPaths: [skillsDir] };
  });

  pi.on("session_start", async () => {
    injectBootstrap = true;
  });

  pi.on("session_compact", async () => {
    injectBootstrap = true;
  });

  pi.on("agent_end", async () => {
    injectBootstrap = false;
  });

  pi.on("context", async (event, ctx) => {
    if (latestPersistedMode(ctx) !== "luban") return;
    if (!injectBootstrap) return;
    if (event.messages.some(messageContainsBootstrap)) return;

    const bootstrap = getBootstrapContent();
    if (!bootstrap) return;

    const bootstrapMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: bootstrap }],
      timestamp: Date.now(),
    };

    const insertAt = firstNonCompactionSummaryIndex(event.messages);
    return {
      messages: [
        ...event.messages.slice(0, insertAt),
        bootstrapMessage,
        ...event.messages.slice(insertAt),
      ],
    };
  });
}

function getBootstrapContent(): string | null {
  if (cachedBootstrap !== undefined) return cachedBootstrap;

  try {
    const skillContent = readFileSync(bootstrapSkillPath, "utf8");
    const body = stripFrontmatter(skillContent);
    cachedBootstrap = `${EXTREMELY_IMPORTANT_MARKER}
${BOOTSTRAP_MARKER}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${body}

${piToolMapping()}
</EXTREMELY_IMPORTANT>`;
    return cachedBootstrap;
  } catch {
    cachedBootstrap = null;
    return null;
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

function piToolMapping(): string {
  return readFileSync(piToolsMdPath, "utf8");
}

function messageContainsBootstrap(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    return (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes(BOOTSTRAP_MARKER)
    );
  });
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
  let index = 0;
  while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
    index += 1;
  }
  return index;
}
