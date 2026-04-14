import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Module-level singleton debug state
// ---------------------------------------------------------------------------

let globalDebugEnabled = false;
let debugNamespaces: Set<string> | null = null; // null = all namespaces
let flagRegistered = false;
let commandRegistered = false;

function isDebugActive(namespace: string): boolean {
  if (!globalDebugEnabled) return false;
  if (debugNamespaces === null) return true;
  return debugNamespaces.has(namespace);
}

// ---------------------------------------------------------------------------
// Public init helpers
// ---------------------------------------------------------------------------

/**
 * Reads `PANDA_DEBUG` env var and activates debug mode accordingly.
 * - `"*"` → enable all namespaces
 * - `"ns1,ns2"` → enable only those namespaces
 * Called once at extension load time via `initLib`.
 */
export function initDebugFromEnv(): void {
  const val = process.env.PANDA_DEBUG;
  if (!val) return;
  if (val === "*") {
    globalDebugEnabled = true;
    debugNamespaces = null;
  } else {
    globalDebugEnabled = true;
    debugNamespaces = new Set(val.split(",").map((s) => s.trim()).filter(Boolean));
  }
}

/**
 * Programmatically enable or disable global debug logging.
 */
export function setGlobalDebug(enabled: boolean): void {
  globalDebugEnabled = enabled;
}

/**
 * Registers the `--debug` flag with pi. Idempotent — only registers once.
 */
export function registerDebugFlag(pi: ExtensionAPI): void {
  if (flagRegistered) return;
  flagRegistered = true;
  pi.registerFlag("debug", {
    description: "Enable extension debug logging to session JSONL and console",
    type: "boolean",
    default: false,
  });
}

/**
 * Applies the `--debug` flag value to the global debug state.
 * Call after `registerDebugFlag`.
 */
export function applyDebugFlag(pi: ExtensionAPI): void {
  const val = pi.getFlag("debug");
  if (val === true) setGlobalDebug(true);
}

/**
 * Registers the `/debug` toggle command. Idempotent — only registers once.
 */
export function registerDebugCommand(pi: ExtensionAPI): void {
  if (commandRegistered) return;
  commandRegistered = true;
  pi.registerCommand("debug", {
    description: "Toggle extension debug logging on/off",
    handler: async (_args: string, ctx: ExtensionContext) => {
      setGlobalDebug(!globalDebugEnabled);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Debug logging ${globalDebugEnabled ? "enabled" : "disabled"}`,
          "info",
        );
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface Logger {
  /** Write a structured debug entry to session JSONL + console (when debug active). */
  debug(event: string, data?: unknown): void;
  /** Set or clear the status indicator for this namespace. */
  status(text: string | undefined): void;
  /** Notify via UI or fall back to console. */
  notify(text: string, level?: "info" | "warning" | "error" | "success"): void;
  /** Console log with namespace prefix. */
  console(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Creates a namespaced logger bound to `ctx`.
 * Re-use within a single extension handler is fine; create per-handler for
 * correct leaf IDs.
 */
export function createLogger(ctx: ExtensionContext, namespace: string): Logger {
  return {
    debug(event: string, data?: unknown): void {
      if (!isDebugActive(namespace)) return;

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        const entry = {
          type: "custom" as const,
          customType: "panda:debug",
          id: randomUUID(),
          parentId: ctx.sessionManager.getLeafId(),
          timestamp: new Date().toISOString(),
          data: {
            namespace,
            event,
            ...(data !== undefined && { detail: data }),
          },
        };
        try {
          appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
        } catch {
          // best-effort — never throw from debug logging
        }
      }

      console.debug(`[${namespace}] ${event}`, data);
    },

    status(text: string | undefined): void {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus(namespace, text);
    },

    notify(text: string, level: "info" | "warning" | "error" | "success" = "info"): void {
      if (ctx.hasUI) {
        ctx.ui.notify(text, level);
      } else {
        console.log(`[${namespace}] ${text}`);
      }
    },

    console(message: string, ...args: unknown[]): void {
      console.log(`[${namespace}]`, message, ...args);
    },
  };
}
