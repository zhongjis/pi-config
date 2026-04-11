import {
  CAVEMAN_LEVELS,
  isCavemanLevel,
  type CavemanConfigDefaultLevel,
  type CavemanStatusVisibility,
} from "./config.js";
import { buildInjectedPrompt, loadRuntimePrompt } from "./prompt.js";
import { isTopLevelPersistedSession } from "./session-gate.js";
import {
  clearCavemanState,
  getCavemanConfig,
  getCavemanEffectiveLevel,
  getCavemanSessionLevel,
  restoreCavemanState,
  setCavemanSessionLevel,
  updateRuntimeCavemanConfig,
} from "./state.js";

interface CavemanUi {
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  select(title: string, options: string[]): Promise<string | undefined>;
}

interface CavemanSessionManager {
  getBranch(): Array<{
    type: string;
    customType?: string;
    data?: unknown;
  }>;
  isPersisted?(): unknown;
  getSessionFile?(): unknown;
}

interface CavemanSessionContext {
  hasUI: boolean;
  ui: CavemanUi;
  sessionManager: CavemanSessionManager;
}

interface CavemanCommandContext {
  hasUI: boolean;
  ui: CavemanUi;
}

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface BeforeAgentStartResult {
  systemPrompt: string;
}

interface CommandArgumentCompletion {
  value: string;
  label: string;
}

interface CavemanExtensionApi {
  on(
    event: "session_start",
    handler: (_event: unknown, ctx: CavemanSessionContext) => Promise<void> | void,
  ): void;
  on(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEvent,
      ctx: CavemanSessionContext,
    ) => Promise<BeforeAgentStartResult | void> | BeforeAgentStartResult | void,
  ): void;
  on(
    event: "session_shutdown",
    handler: (_event: unknown, ctx: CavemanSessionContext) => Promise<void> | void,
  ): void;
  registerCommand(
    name: "caveman",
    definition: {
      description: string;
      getArgumentCompletions?: (prefix: string) => CommandArgumentCompletion[] | null;
      handler: (args: string, ctx: CavemanCommandContext) => Promise<void> | void;
    },
  ): void;
  appendEntry(customType: string, data: unknown): void;
}

const ACCEPTED_LEVELS_TEXT = CAVEMAN_LEVELS.join(" | ");
const COMMAND_USAGE = "Usage: /caveman | /caveman <lite|full|ultra> | /caveman config";
const COMMAND_ARGUMENTS: CommandArgumentCompletion[] = [
  ...CAVEMAN_LEVELS.map((level) => ({
    value: level,
    label: `${level} — enable caveman for this session at ${level}`,
  })),
  { value: "config", label: "config — open caveman settings dialog" },
];

export default function cavemanExtension(pi: CavemanExtensionApi): void {
  pi.on("session_start", async (_event: unknown, ctx: CavemanSessionContext) => {
    try {
      const restoredState = restoreCavemanState(ctx);
      loadRuntimePrompt();
      const effectiveLevel = getCavemanEffectiveLevel();

      syncStatus(ctx);

      if (ctx.hasUI && effectiveLevel) {
        if (restoredState.sessionLevel) {
          ctx.ui.notify(`Caveman restored for this session (${effectiveLevel}).`, "info");
        } else if (isCavemanLevel(restoredState.config.defaultLevel)) {
          ctx.ui.notify(`Caveman auto-enabled from config (${effectiveLevel}).`, "info");
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = `Failed to initialize caveman: ${reason}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      throw error instanceof Error ? error : new Error(message);
    }
  });

  pi.registerCommand("caveman", {
    description: "Show caveman status, set the current session level, or open config (/caveman | /caveman <lite|full|ultra> | /caveman config)",
    getArgumentCompletions: (prefix: string): CommandArgumentCompletion[] | null => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const filtered = COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(normalizedPrefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const normalizedArgs = (args || "").trim().toLowerCase();

      if (!normalizedArgs) {
        ctx.ui.notify(formatStatusMessage(), "info");
        return;
      }

      if (normalizedArgs === "config") {
        await openConfigDialog(ctx);
        return;
      }

      if (isCavemanLevel(normalizedArgs)) {
        const result = setCavemanSessionLevel(pi, normalizedArgs);
        syncStatus(ctx);
        ctx.ui.notify(
          result.changed
            ? `Caveman enabled for this session at ${result.level}.`
            : `Caveman already active for this session at ${result.level}.`,
          "info",
        );
        return;
      }

      ctx.ui.notify(`Unknown caveman argument: ${normalizedArgs}\n${COMMAND_USAGE}`, "error");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!isTopLevelPersistedSession(ctx)) {
      return;
    }

    const level = getCavemanEffectiveLevel();
    if (!level) {
      return;
    }

    const injectedPrompt = buildInjectedPrompt(level);
    return {
      systemPrompt: event.systemPrompt
        ? `${event.systemPrompt}\n\n${injectedPrompt}`
        : injectedPrompt,
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("caveman", undefined);
    }
    clearCavemanState();
  });
}

function syncStatus(ctx: { hasUI: boolean; ui: Pick<CavemanUi, "setStatus"> }): void {
  if (!ctx.hasUI) {
    return;
  }

  const config = getCavemanConfig();
  const effectiveLevel = getCavemanEffectiveLevel();
  ctx.ui.setStatus(
    "caveman",
    effectiveLevel && config.statusVisibility === "active"
      ? `CAVEMAN: ${effectiveLevel}`
      : undefined,
  );
}

async function openConfigDialog(ctx: CavemanCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Cannot open /caveman config without interactive UI.", "error");
    return;
  }

  while (true) {
    const config = getCavemanConfig();
    const choice = await ctx.ui.select("Caveman settings", [
      `Default level (current: ${formatConfiguredDefault(config.defaultLevel)})`,
      `Status visibility (current: ${config.statusVisibility})`,
      "Done",
    ]);

    if (!choice || choice === "Done") {
      syncStatus(ctx);
      ctx.ui.notify("Closed caveman settings.", "info");
      return;
    }

    if (choice.startsWith("Default level")) {
      await selectDefaultLevel(ctx);
      continue;
    }

    if (choice.startsWith("Status visibility")) {
      await selectStatusVisibility(ctx);
    }
  }
}

async function selectDefaultLevel(ctx: CavemanCommandContext): Promise<void> {
  const choice = await ctx.ui.select("Caveman default level", [
    "off — do not auto-enable caveman for new sessions",
    ...CAVEMAN_LEVELS.map((level) => `${level} — auto-enable caveman for new sessions at ${level}`),
  ]);

  if (!choice) {
    return;
  }

  const nextDefaultLevel = parseDefaultLevelChoice(choice);
  if (!nextDefaultLevel) {
    ctx.ui.notify(`Unknown caveman config selection.\n${COMMAND_USAGE}`, "error");
    return;
  }

  updateRuntimeCavemanConfig({ defaultLevel: nextDefaultLevel });
  syncStatus(ctx);
  ctx.ui.notify(`Caveman default level set to ${formatConfiguredDefault(nextDefaultLevel)}.`, "info");
}

async function selectStatusVisibility(ctx: CavemanCommandContext): Promise<void> {
  const choice = await ctx.ui.select("Caveman status visibility", [
    "active — show status bar item while caveman is active",
    "hidden — keep caveman active without a status bar item",
  ]);

  if (!choice) {
    return;
  }

  const nextVisibility = parseStatusVisibilityChoice(choice);
  if (!nextVisibility) {
    ctx.ui.notify(`Unknown caveman config selection.\n${COMMAND_USAGE}`, "error");
    return;
  }

  updateRuntimeCavemanConfig({ statusVisibility: nextVisibility });
  syncStatus(ctx);
  ctx.ui.notify(`Caveman status visibility set to ${nextVisibility}.`, "info");
}

function formatStatusMessage(): string {
  const config = getCavemanConfig();
  const sessionLevel = getCavemanSessionLevel();
  const effectiveLevel = getCavemanEffectiveLevel();

  const currentStatus = effectiveLevel
    ? sessionLevel
      ? `${effectiveLevel} (session override)`
      : `${effectiveLevel} (from default config)`
    : "off";

  return [
    `Current level: ${currentStatus}`,
    `Default configured: ${config.defaultLevel === "off" ? "no" : `yes (${config.defaultLevel})`}`,
    `Accepted levels: ${ACCEPTED_LEVELS_TEXT}`,
    COMMAND_USAGE,
  ].join("\n");
}

function formatConfiguredDefault(defaultLevel: CavemanConfigDefaultLevel): string {
  return defaultLevel === "off" ? "off (not configured)" : defaultLevel;
}

function parseDefaultLevelChoice(choice: string): CavemanConfigDefaultLevel | undefined {
  const value = choice.split(" ")[0]?.trim().toLowerCase();
  return value === "off" || isCavemanLevel(value) ? value : undefined;
}

function parseStatusVisibilityChoice(choice: string): CavemanStatusVisibility | undefined {
  const value = choice.split(" ")[0]?.trim().toLowerCase();
  return value === "active" || value === "hidden" ? value : undefined;
}
