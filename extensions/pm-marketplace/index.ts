import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const pmSkillsDir = resolve(extensionDir, "pm-skills");

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

let updateCheckDone = false;

async function checkForUpdates(ctx: ExtensionContext): Promise<void> {
  try {
    const pkgPath = resolve(extensionDir, "package.json");
    let pinned: string;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { piVendor?: { commit?: string } };
      if (!pkg.piVendor?.commit) return;
      pinned = pkg.piVendor.commit;
    } catch {
      return;
    }

    const cachePath = resolve(extensionDir, ".update-check-cache.json");
    try {
      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { lastCheck?: number };
      if (cache.lastCheck && Date.now() - cache.lastCheck < 24 * 60 * 60 * 1000) return;
    } catch {
      // no cache or invalid — proceed
    }

    const remoteHead = await new Promise<string | null>((done) => {
      const child = spawn("git", ["ls-remote", "https://github.com/phuryn/pm-skills.git", "HEAD"]);
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill();
        done(null);
      }, 5000);

      child.on("close", () => {
        clearTimeout(timer);
        const sha = stdout.trim().split(/\s+/)[0] ?? null;
        done(sha || null);
      });

      child.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
    });

    try {
      writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now() }), "utf8");
    } catch {
      // ignore
    }

    if (remoteHead && remoteHead !== pinned) {
      ctx.ui.notify(
        "神農: pm-skills upstream has updates (pinned " +
          pinned.slice(0, 8) +
          " -> remote " +
          remoteHead.slice(0, 8) +
          "). Re-vendor to sync.",
        "info"
      );
    }
  } catch {
    // fail-silent
  }
}

// --- Command discovery at module load time ---

type CommandEntry = {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
};

type AutocompleteItem = { value: string; label: string };

function parseFrontmatter(content: string): { description: string; argumentHint: string; body: string } {
  const parts = content.split(/^---\s*$/m);
  // parts[0] = "" (before opening ---), parts[1] = frontmatter, parts[2+] = body
  if (parts.length >= 3) {
    const fm = parts[1];
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    const hintMatch = fm.match(/^argument-hint:\s*(.+)$/m);
    const description = descMatch ? descMatch[1].trim() : "";
    const argumentHint = hintMatch ? hintMatch[1].trim().replace(/^"|"$/g, "") : "";
    const body = parts.slice(2).join("---").trim();
    return { description, argumentHint, body };
  }
  return { description: "", argumentHint: "", body: content.trim() };
}

// Discover plugin dirs dynamically
let pluginDirs: string[] = [];
try {
  pluginDirs = readdirSync(pmSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
} catch {
  // pmSkillsDir doesn't exist yet
}

// First pass: count filename occurrences for collision detection
const filenameCounts = new Map<string, number>();
for (const pluginDir of pluginDirs) {
  const commandsDir = join(pmSkillsDir, pluginDir, "commands");
  try {
    const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const stem = file.slice(0, -3);
      filenameCounts.set(stem, (filenameCounts.get(stem) ?? 0) + 1);
    }
  } catch {
    // no commands dir
  }
}

// Second pass: build command entries
const pmCommands: CommandEntry[] = [];
for (const pluginDir of pluginDirs) {
  const commandsDir = join(pmSkillsDir, pluginDir, "commands");
  try {
    const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const stem = file.slice(0, -3);
      const collides = (filenameCounts.get(stem) ?? 0) > 1;
      const commandName = collides ? `pm:${pluginDir}:${stem}` : `pm:${stem}`;
      const content = readFileSync(join(commandsDir, file), "utf8");
      const { description, argumentHint, body } = parseFrontmatter(content);
      pmCommands.push({ name: commandName, description, argumentHint, body });
    }
  } catch {
    // no commands dir
  }
}

// Discover skills dirs for resources_discover
const pmSkillsPaths: string[] = pluginDirs.map((d) => join(pmSkillsDir, d, "skills"));

export default function pmMarketplaceExtension(pi: ExtensionAPI) {
  // Register all discovered /pm:* commands
  for (const cmd of pmCommands) {
    const { name, description, argumentHint, body } = cmd;
    pi.registerCommand(name, {
      description,
      argumentHint,
      getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
        const query = prefix.trim().toLowerCase();
        const matches = pmCommands
          .filter((c) => !query || c.name.toLowerCase().includes(query))
          .map((c) => ({ value: c.name, label: c.name }));
        return matches.length > 0 ? matches : null;
      },
      handler: async (args) => {
        pi.sendUserMessage(
          "/mode:shennong " + body + "\n\nUser request: " + (args ?? ""),
          { deliverAs: "followUp" }
        );
      },
    });
  }

  pi.on("resources_discover", async (_event, ctx) => {
    if (latestPersistedMode(ctx) !== "shennong") return { skillPaths: [] };
    return { skillPaths: pmSkillsPaths };
  });

  pi.on("session_start", async () => {
    updateCheckDone = false;
  });

  pi.on("context", async (_event, ctx) => {
    if (latestPersistedMode(ctx) !== "shennong") return;
    if (updateCheckDone) return;
    updateCheckDone = true;
    void checkForUpdates(ctx);
  });
}
