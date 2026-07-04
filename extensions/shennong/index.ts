import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
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

export default function shennongExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", async (_event, ctx) => {
    if (latestPersistedMode(ctx) !== "shennong") return { skillPaths: [] };
    return { skillPaths: [pmSkillsDir] };
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
