/**
 * controller.ts — the herdr-app pane lifecycle: create it, verify it is still
 * ours, close only what we created.
 *
 * Every host CLI call (`herdr-app`) goes through an injected `exec` (pi.exec at runtime, a stub
 * in tests) and every path is an argv array — never a shell string — so a cwd or
 * pane id can never be interpolated into a command. The controller owns exactly
 * one pane at a time, identified by a persisted record plus a sentinel label:
 * before touching a pane it re-reads the label, so a pane the user renamed or
 * repurposed is treated as "not ours" and left alone. Focus is restored to the
 * parent after splitting so the main agent keeps the cursor.
 */

import { isHerdrAppPaneOwned } from "../../../../lib/herdr-app.mjs";
import { splitHerdrAppPane } from "./herdr-app.js";
import { detectPaneHost, type PaneHost } from "../../../../lib/pane-host.js";
import { clearRecord, readRecord, writeRecord } from "./store.js";

/** The slice of `pi.exec` this module needs. */
export type PaneExec = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;

export interface GraphRunPaneControllerOptions {
  exec: PaneExec;
  /** The per-pane state directory (see `paneDirFor`). */
  dir: string;
  /** Which host manages the panes. */
  host: PaneHost;
  /** The pane pi itself runs in — the new pane splits off it. */
  parentPaneId: string;
  cwd: string;
  sessionId: string;
  /** Absolute path to `viewer.mjs`, resolved by the caller. */
  viewerPath: string;
  /** pi's pid, so the viewer can self-terminate when the session ends. */
  ppid: number;
  /** The pane label that identifies the pane as ours. Defaults from the session id. */
  sentinel?: string;
  /** Per-call host CLI timeout. */
  timeoutMs?: number;
}

/** Only inside a herdr-app-managed TUI pane is there a parent pane to split off. */
export function isPaneHostEnabled(env: NodeJS.ProcessEnv, mode: string): boolean {
  return detectPaneHost(env) !== undefined && mode === "tui";
}

export class GraphRunPaneController {
  private readonly options: GraphRunPaneControllerOptions;
  private readonly exec: PaneExec;
  private readonly host: PaneHost;
  private readonly dir: string;
  private readonly sentinel: string;
  private readonly timeoutMs: number;
  /** Dedupe concurrent ensurePane calls so a burst of syncs cannot spawn a pane storm. */
  private ensuring: Promise<void> | undefined;

  constructor(options: GraphRunPaneControllerOptions) {
    this.options = options;
    this.exec = options.exec;
    this.host = options.host;
    this.dir = options.dir;
    this.sentinel = options.sentinel ?? `Agent Graph · ${options.sessionId.slice(0, 8)}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Make sure a pane we own is up. `force` overrides a manual close; without it a
   * `closedByUser` record is honoured and nothing is spawned. A recorded pane is
   * verified before adoption; a gone or repurposed one is forgotten (never
   * closed) and a fresh pane is split in its place.
   */
  ensurePane(force: boolean): Promise<void> {
    // Coalesce: a second caller during an in-flight ensure joins the same work
    // rather than racing it into a duplicate split.
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsurePane(force).finally(() => {
      this.ensuring = undefined;
    });
    return this.ensuring;
  }

  private async doEnsurePane(force: boolean): Promise<void> {
    const record = readRecord(this.dir);
    if (record?.closedByUser && !force) return;

    if (record?.paneId) {
      if (await this.isOursAlive(record.paneId)) {
        // Already up and ours. A forced reopen after a manual close just clears the flag.
        if (record.closedByUser) {
          writeRecord(this.dir, { ...record, closedByUser: false });
        }
        return;
      }
      // Gone, or the user made it theirs. Forget it — do NOT close it.
      clearRecord(this.dir);
    }

    await splitHerdrAppPane(this.options, this.sentinel);
  }

  /** True only when `paneId` still exists AND still carries our sentinel label. */
  private async isOursAlive(paneId: string): Promise<boolean> {
    return isHerdrAppPaneOwned(this.exec, paneId, this.sentinel);
  }

  /** Close only the pane we recorded, best-effort. Never touches any other pane. */
  async closeOwned(): Promise<void> {
    const record = readRecord(this.dir);
    if (!record?.paneId) return;
    if (await this.isOursAlive(record.paneId)) {
      await this.exec(this.host, ["do", "pane.close", "--pane", record.paneId], { timeout: this.timeoutMs });
    }
    clearRecord(this.dir);
  }

  /**
   * Close the pane at the user's request and REMEMBER the close. Unlike
   * `closeOwned` (the dispose path, which clears the record), this keeps the
   * record with `closedByUser` set, so `ensurePane(false)` will not reopen the
   * pane until a detach (`o` in the Agent Monitor or graph panel) forces it. Mirrors the viewer-side `q` close.
   */
  async closeForUser(): Promise<void> {
    const record = readRecord(this.dir);
    if (!record?.paneId) {
      writeRecord(this.dir, { paneId: record?.paneId ?? "", sentinel: this.sentinel, closedByUser: true });
      return;
    }
    writeRecord(this.dir, { ...record, closedByUser: true });
    if (await this.isOursAlive(record.paneId)) {
      await this.exec(this.host, ["do", "pane.close", "--pane", record.paneId], { timeout: this.timeoutMs });
    }
  }

  /**
   * On session start: adopt a still-alive pane we own (e.g. after an extension
   * reload) or clear a record whose pane has gone. Never closes anything — a
   * gone pane is not ours to close, and an alive one we keep.
   */
  async reconcile(): Promise<void> {
    const record = readRecord(this.dir);
    if (record?.closedByUser) return;
    if (!record?.paneId) return;
    if (!await this.isOursAlive(record.paneId)) clearRecord(this.dir);
  }
}
