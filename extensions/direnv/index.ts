/**
 * Direnv Extension
 *
 * Loads direnv environment variables on session start, then watches
 * .envrc and .direnv/ for changes and reloads only when needed.
 *
 * The bash tool spawns a new process per command (no persistent shell),
 * so the working directory never changes between bash calls. Running
 * direnv after every bash command is therefore unnecessary — file
 * watching is both cheaper and more correct.
 *
 * Requirements:
 *   - direnv installed and in PATH
 *   - .envrc must be allowed (run `direnv allow` in your shell first)
 */

import { exec } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { debounce } from "../lib/utils.js";

/** Debounce before reloading after a file-system event (ms). */
const RELOAD_DEBOUNCE_MS = 300;

type Status = "on" | "blocked" | "error" | "off";

export default function (pi: ExtensionAPI) {
  let watchers: FSWatcher[] = [];
  let activeCtx: ExtensionContext | null = null;
  let activeCwd: string | null = null;
  let sessionVersion = 0;
  let reloadVersion = 0;

  function isStaleContextError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /stale/i.test(message) && /(ctx|context)/i.test(message);
  }

  function deactivateStaleSession(version: number): void {
    if (version !== sessionVersion) return;
    deactivateSession();
  }

  function getUsableActiveContext(
    version: number,
  ): { ctx: ExtensionContext; hasUI: boolean } | null {
    if (version !== sessionVersion) return null;

    const ctx = activeCtx;
    if (!ctx) return null;

    try {
      return { ctx, hasUI: ctx.hasUI };
    } catch (error) {
      if (isStaleContextError(error)) {
        deactivateStaleSession(version);
        return null;
      }

      throw error;
    }
  }

  function withUsableUi(
    version: number,
    update: (ctx: ExtensionContext) => void,
  ): void {
    const usable = getUsableActiveContext(version);
    if (!usable?.hasUI) return;

    try {
      update(usable.ctx);
    } catch (error) {
      if (isStaleContextError(error)) {
        deactivateStaleSession(version);
        return;
      }

      throw error;
    }
  }

  function updateStatus(status: Status, version: number): void {
    withUsableUi(version, (ctx) => {
      if (status === "on" || status === "off") {
        ctx.ui.setStatus("direnv", undefined);
        return;
      }

      const text =
        status === "blocked"
          ? ctx.ui.theme.fg("warning", "direnv:blocked")
          : ctx.ui.theme.fg("error", "direnv:error");
      ctx.ui.setStatus("direnv", text);
    });
  }

  function loadDirenv(cwd: string, version: number): void {
    const requestVersion = ++reloadVersion;

    exec("direnv export json", { cwd }, (error, stdout, stderr) => {
      if (
        version !== sessionVersion ||
        requestVersion !== reloadVersion ||
        cwd !== activeCwd
      ) {
        return;
      }


      if (!getUsableActiveContext(version)) return;
      if (error) {
        const message = (stderr || error.message).toLowerCase();
        updateStatus(
          /allow|blocked|denied|not allowed/.test(message)
            ? "blocked"
            : "error",
          version,
        );
        return;
      }

      if (!stdout.trim()) {
        updateStatus("off", version);
        return;
      }

      try {
        const env = JSON.parse(stdout) as Record<string, string | null>;
        let loadedCount = 0;

        for (const [key, value] of Object.entries(env)) {
          if (value === null) {
            delete process.env[key];
          } else {
            process.env[key] = value;
            loadedCount++;
          }
        }

        updateStatus(loadedCount > 0 ? "on" : "off", version);
      } catch {
        updateStatus("error", version);
      }
    });
  }

  function reloadCurrent(): void {
    if (!activeCwd) return;
    loadDirenv(activeCwd, sessionVersion);
  }

  const debouncedReload = debounce(() => {
    reloadCurrent();
  }, RELOAD_DEBOUNCE_MS);

  function scheduleReload(): void {
    if (!activeCwd) return;
    debouncedReload();
  }

  function startWatchers(cwd: string): void {
    stopWatchers();

    // Watch .envrc — covers edits and direnv allow (which rewrites .envrc state)
    const envrcPath = join(cwd, ".envrc");
    try {
      const w = watch(envrcPath, () => scheduleReload());
      watchers.push(w);
    } catch {
      // .envrc may not exist — that's fine
    }

    // Watch .direnv/ — covers flake rebuilds, nix develop, direnv allow state
    const direnvDir = join(cwd, ".direnv");
    try {
      const w = watch(direnvDir, () => scheduleReload());
      watchers.push(w);
    } catch {
      // .direnv/ may not exist yet — that's fine
    }
  }

  function stopWatchers(): void {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    watchers = [];
    debouncedReload.cancel();
  }

  function activateSession(ctx: ExtensionContext): void {
    sessionVersion++;
    activeCtx = ctx;
    activeCwd = ctx.cwd;
    startWatchers(ctx.cwd);
    loadDirenv(ctx.cwd, sessionVersion);
  }

  function deactivateSession(): void {
    sessionVersion++;
    stopWatchers();
    activeCtx = null;
    activeCwd = null;
  }

  pi.on("session_start", async (_event, ctx) => {
    activateSession(ctx);
  });

  pi.on("session_switch" as "session_start", async (_event, ctx) => {
    activateSession(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    activateSession(ctx);
  });

  pi.on("session_shutdown", async () => {
    deactivateSession();
  });

  pi.registerCommand("direnv", {
    description: "Reload direnv environment variables",
    handler: async (_args, ctx) => {
      activateSession(ctx);
      if (ctx.hasUI) ctx.ui.notify("direnv reloaded", "info");
    },
  });
}
