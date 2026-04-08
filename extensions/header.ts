/**
 * neofetch-header.ts
 *
 * Replaces the default pi startup header with a neofetch-style layout:
 *   - Left column : π block-art mascot (same as built-in, slightly tightened)
 *   - Right column: live session info + condensed keybinding hints
 *
 * What's preserved from the default header:
 *   - Version, model, cwd, git branch
 *   - Resource counts (tools / skills / prompts / extensions) instead of full lists
 *   - Essential keybinding hints (5 instead of 20)
 *
 * Requires `quietStartup: true` in settings.json to suppress the
 * verbose resource listings that would otherwise appear below the header.
 *
 * Install: place in ~/.pi/agent/extensions/neofetch-header.ts
 * Reload:  /reload
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
  VERSION,
  keyHint,
  keyText,
  rawKeyHint,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

// ─── helpers ─────────────────────────────────────────────────────────────────

function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Right-pad a styled string to `targetWidth` visible chars. */
function padToWidth(styled: string, targetWidth: number): string {
  return styled + " ".repeat(Math.max(0, targetWidth - visibleWidth(styled)));
}

// App-specific keybinding actions aren't in the pi-tui `Keybinding` type —
// they're added by the app via declaration merging and registered at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appHint = (action: string, desc: string): string => {
  try {
    return keyHint(action as any, desc);
  } catch {
    return desc;
  }
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appKey = (action: string): string => {
  try {
    return keyText(action as any);
  } catch {
    return action;
  }
};

// ─── left column: π mascot ───────────────────────────────────────────────────

const LOGO_COLS = 18; // visible width of the left column

function buildLogoLines(theme: Theme): string[] {
  const blue = (t: string) => theme.fg("accent", t);
  const dim = (t: string) => theme.fg("dim", t);
  const B = "█";

  const raw = [
    "",
    `  ${blue(B.repeat(14))}`,
    `     ${blue(B.repeat(2))}    ${blue(B.repeat(2))}`,
    `     ${blue(B.repeat(2))}    ${blue(B.repeat(2))}`,
    `     ${blue(B.repeat(2))}    ${blue(B.repeat(2))}`,
    `     ${blue(B.repeat(2))}    ${blue(B.repeat(2))}`,
    "",
  ];

  return raw.map((line) => padToWidth(line, LOGO_COLS));
}

// ─── right column: info ───────────────────────────────────────────────────────

interface HeaderInfo {
  branch: string | null;
  toolCount: number;
  skillCount: number;
  promptCount: number;
  extensionCount: number;
}

function buildInfoLines(
  theme: Theme,
  ctx: Pick<ExtensionContext, "cwd" | "model">,
  info: HeaderInfo,
): string[] {
  const acc = (t: string) => theme.fg("accent", t);
  const dim = (t: string) => theme.fg("dim", t);
  const mut = (t: string) => theme.fg("muted", t);
  const sep = dim("─".repeat(44));

  const label = (k: string) => dim(k.padEnd(8));
  const kv = (key: string, val: string) => `${label(key)}${mut(val)}`;

  // Condensed keybinding hints: interrupt, exit, commands, bash, model
  const dot = dim(" · ");
  const hints1 = [
    appHint("app.interrupt", "interrupt"),
    rawKeyHint(`${appKey("app.clear")} twice`, "exit"),
    appHint("app.exit", "exit (empty)"),
  ].join(dot);
  const hints2 = [
    rawKeyHint("/", "commands"),
    rawKeyHint("!", "bash"),
    appHint("app.model.select", "model"),
    appHint("app.thinking.cycle", "thinking"),
  ].join(dot);

  const counts =
    `${acc(String(info.toolCount))} ${mut("tools")}  ` +
    `${acc(String(info.skillCount))} ${mut("skills")}  ` +
    `${acc(String(info.promptCount))} ${mut("prompts")}  ` +
    `${acc(String(info.extensionCount))} ${mut("extensions")}`;

  return [
    `${acc("pi")}  ${dim("v" + VERSION)}`,
    kv("model", ctx.model?.id ?? "no model"),
    kv("dir", shortenPath(ctx.cwd)),
    kv("branch", info.branch ?? dim("no git")),
    sep,
    counts,
    sep,
    hints1,
    hints2,
  ];
}

// ─── compose: zip left + right into full-width lines ─────────────────────────

function buildHeaderLines(
  theme: Theme,
  ctx: Pick<ExtensionContext, "cwd" | "model">,
  info: HeaderInfo,
  width: number,
): string[] {
  const logo = buildLogoLines(theme);
  const infoLines = buildInfoLines(theme, ctx, info);

  const GUTTER = 2;
  const rows = Math.max(logo.length, infoLines.length);
  const lines: string[] = [""];

  for (let i = 0; i < rows; i++) {
    const left = logo[i] ?? " ".repeat(LOGO_COLS);
    const right = infoLines[i] ?? "";
    lines.push(truncateToWidth(left + " ".repeat(GUTTER) + right, width));
  }

  lines.push("");
  return lines;
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let info: HeaderInfo = {
    branch: null,
    toolCount: 0,
    skillCount: 0,
    promptCount: 0,
    extensionCount: 0,
  };

  async function refreshInfo(cwd: string): Promise<void> {
    // Git branch
    try {
      const r = await pi.exec("git", ["branch", "--show-current"], {
        cwd,
        timeout: 2000,
      });
      info.branch = r.code === 0 ? r.stdout.trim() || null : null;
    } catch {
      info.branch = null;
    }

    // Counts from the pi API (available after extensions are bound, which is before session_start returns)
    const commands = pi.getCommands();
    info.skillCount = commands.filter((c) => c.source === "skill").length;
    info.promptCount = commands.filter((c) => c.source === "prompt").length;
    info.toolCount = pi.getActiveTools().length;

    // Extension count: unique source paths across registered commands + tools
    const extPaths = new Set<string>();
    for (const c of commands.filter((c) => c.source === "extension"))
      extPaths.add(c.sourceInfo.path);
    for (const t of pi.getAllTools()) {
      if (t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk")
        extPaths.add(t.sourceInfo.path);
    }
    info.extensionCount = extPaths.size;
  }

  function installHeader(
    ctx: Pick<ExtensionContext, "cwd" | "model" | "ui" | "hasUI">,
  ): void {
    if (!ctx.hasUI) return;
    // Snapshot cwd + model at install time so the closure is stable.
    // The header is reinstalled on model_select, so model stays current.
    const snap = { cwd: ctx.cwd, model: ctx.model };
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return buildHeaderLines(theme, snap, info, width);
      },
      invalidate() {},
    }));
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    await refreshInfo(ctx.cwd);
    installHeader(ctx);
  });

  // Keep the model line current when the user switches models
  pi.on("model_select", (_event, ctx) => {
    installHeader(ctx);
  });
}
