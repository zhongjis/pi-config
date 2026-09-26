/**
 * conversation-overlay.ts — One opener for the agent conversation overlay.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type HistoryConversation, readHistoryConversation } from "../agent-history.js";
import type { AgentRecord } from "../types.js";
import type { AgentActivity } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import type { FleetUICtx } from "./fleet-list.js";
import type { GraphRunUIContext } from "./graph-run-menu.js";

type MenuUI = Pick<GraphRunUIContext["ui"], "custom" | "notify">;
type FleetUI = Pick<FleetUICtx, "custom" | "notify">;
type OverlayDeps = {
  manager: { abort(id: string): boolean; steer(id: string, message: string): unknown };
  agentActivity: ReadonlyMap<string, AgentActivity>;
};
type OverlayOptions = { onOpen?(close: () => void): void };
/** Call shape both existing `custom` methods accept. Theme types differ between the two UIs. */
type OverlayCall = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => unknown,
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
};

/** Home prefix only at a path-segment boundary: `/home/alice2` is not under `/home/alice`. */
function displayPath(file: string): string {
  const rel = relative(homedir(), file);
  if (rel === "") return "~";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return file;
  return `~${sep}${rel}`;
}

function notifyHistoryFailure(ui: Pick<OverlayCall, "notify">, file: string, failure: Extract<HistoryConversation, { ok: false }>): void {
  const p = displayPath(file);
  if (failure.reason === "missing") {
    ui.notify(`Conversation file is missing: ${p}`, "info");
    return;
  }
  if (failure.reason === "unreadable") {
    ui.notify(
      failure.code ? `Conversation file is unreadable (${failure.code}): ${p}` : `Conversation file is unreadable: ${p}`,
      "warning",
    );
    return;
  }
  ui.notify(`Conversation file is not a Pi session: ${p}`, "warning");
}

function openViewer(
  ui: OverlayCall,
  record: AgentRecord,
  session: AgentSession,
  activity: AgentActivity | undefined,
  onStop: (() => void) | undefined,
  onSteer: ((message: string) => void) | undefined,
  options?: { onOpen?(close: () => void): void },
): Promise<void> {
  // Return ui.custom's promise itself so fleet-list's close handler stays on the same tick.
  return ui.custom<undefined>((tui, theme, keybindings, done) => {
    options?.onOpen?.(() => done(undefined));
    return new ConversationViewer(tui, session, record, activity, theme, done, onStop, keybindings, onSteer);
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
  });
}

export function openConversationOverlay(ui: MenuUI, record: AgentRecord, deps: OverlayDeps, options?: OverlayOptions): Promise<void>;
export function openConversationOverlay(ui: FleetUI, record: AgentRecord, deps: OverlayDeps, options?: OverlayOptions): Promise<void>;
export function openConversationOverlay(
  ui: OverlayCall,
  record: AgentRecord,
  deps: OverlayDeps,
  options?: OverlayOptions,
): Promise<void> {
  const sessionFile = record.sessionFile;
  if (!record.session && sessionFile) {
    return readHistoryConversation(sessionFile).then(loaded => {
      if (!loaded.ok) {
        notifyHistoryFailure(ui, sessionFile, loaded);
        return;
      }
      const session = { messages: loaded.messages, subscribe: () => () => {} } as unknown as AgentSession;
      return openViewer(ui, record, session, undefined, undefined, undefined, options);
    });
  }
  if (!record.session) {
    ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
    return Promise.resolve();
  }
  return openViewer(
    ui,
    record,
    record.session,
    deps.agentActivity.get(record.id),
    () => {
      if (deps.manager.abort(record.id)) ui.notify(`Stopped "${record.description}".`, "info");
    },
    message => { deps.manager.steer(record.id, message); },
    options,
  );
}
