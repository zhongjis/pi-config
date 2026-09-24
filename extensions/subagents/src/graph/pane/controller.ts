/**
 * controller.ts — the Herdr pane lifecycle: create it, verify it is still ours,
 * close only what we created.
 *
 * Every `herdr` call goes through an injected `exec` (pi.exec at runtime, a stub
 * in tests) and every path is an argv array — never a shell string — so a cwd or
 * pane id can never be interpolated into a command. The controller owns exactly
 * one pane at a time, identified by a persisted record plus a sentinel label:
 * before touching a pane it re-reads the label, so a pane the user renamed or
 * repurposed is treated as "not ours" and left alone. It never focuses the pane
 * (`--no-focus`), so it can appear beside a run you are watching without
 * stealing the cursor from the main agent.
 */

import { clearRecord, type PaneRecord, readRecord, writeRecord } from "./store.js";

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
  /** Per-call herdr timeout. */
  timeoutMs?: number;
}

/** Only inside a Herdr-managed TUI pane is there a parent pane to split off. */
export function isHerdrPaneEnabled(env: NodeJS.ProcessEnv, mode: string): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && mode === "tui";
}

/** Extract the new pane id from `herdr pane split` JSON output. */
function parsePaneId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    const paneId = parsed?.result?.pane?.pane_id;
    return typeof paneId === "string" && paneId.length > 0 ? paneId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a pane's label from `herdr pane get` JSON output. Herdr's field name
 * for the label is checked across the plausible spellings so a version skew does
 * not silently make every pane read as "not ours".
 */
function parsePaneLabel(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: { pane?: { label?: unknown; title?: unknown; name?: unknown } };
    };
    const pane = parsed?.result?.pane;
    const label = pane?.label ?? pane?.title ?? pane?.name;
    return typeof label === "string" ? label : undefined;
  } catch {
    return undefined;
  }
}

export class GraphRunPaneController {
  private readonly exec: PaneExec;
  private readonly dir: string;
  private readonly parentPaneId: string;
  private readonly cwd: string;
  private readonly viewerPath: string;
  private readonly ppid: number;
  private readonly sentinel: string;
  private readonly timeoutMs: number;
  /** Dedupe concurrent ensurePane calls so a burst of syncs cannot spawn a pane storm. */
  private ensuring: Promise<void> | undefined;

  constructor(options: GraphRunPaneControllerOptions) {
    this.exec = options.exec;
    this.dir = options.dir;
    this.parentPaneId = options.parentPaneId;
    this.cwd = options.cwd;
    this.viewerPath = options.viewerPath;
    this.ppid = options.ppid;
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
        if (record.closedByUser) writeRecord(this.dir, { ...record, closedByUser: false });
        return;
      }
      // Gone, or the user made it theirs. Forget it — do NOT close it.
      clearRecord(this.dir);
    }

    await this.split();
  }

  /** True only when `paneId` still exists AND still carries our sentinel label. */
  private async isOursAlive(paneId: string): Promise<boolean> {
    const res = await this.exec("herdr", ["pane", "get", paneId], { timeout: this.timeoutMs });
    if (res.code !== 0) return false;
    return parsePaneLabel(res.stdout) === this.sentinel;
  }

  private async split(): Promise<void> {
    const res = await this.exec(
      "herdr",
      [
        "pane",
        "split",
        "--pane",
        this.parentPaneId,
        "--direction",
        "right",
        "--ratio",
        "0.65",
        "--cwd",
        this.cwd,
        "--env",
        `PI_WF_PANE_DIR=${this.dir}`,
        "--no-focus",
      ],
      { timeout: this.timeoutMs },
    );
    const paneId = res.code === 0 ? parsePaneId(res.stdout) : undefined;
    if (!paneId) return; // Split failed; leave no record so the next sync retries cleanly.

    // Label it so we can recognise it later, then run the viewer in it. Both are
    // best-effort: a rename or run that fails still leaves a recorded, closable pane.
    await this.exec("herdr", ["pane", "rename", paneId, this.sentinel], { timeout: this.timeoutMs });
    await this.exec(
      "herdr",
      ["pane", "run", paneId, "node", this.viewerPath, "--dir", this.dir, "--ppid", String(this.ppid), "--pane", paneId],
      { timeout: this.timeoutMs },
    );

    const next: PaneRecord = { paneId, sentinel: this.sentinel, closedByUser: false };
    writeRecord(this.dir, next);
  }

  /** Close only the pane we recorded, best-effort. Never touches any other pane. */
  async closeOwned(): Promise<void> {
    const record = readRecord(this.dir);
    if (!record?.paneId) return;
    await this.exec("herdr", ["pane", "close", record.paneId], { timeout: this.timeoutMs });
    clearRecord(this.dir);
  }

  /**
   * Close the pane at the user's request and REMEMBER the close. Unlike
   * `closeOwned` (the dispose path, which clears the record), this keeps the
   * record with `closedByUser` set, so `ensurePane(false)` will not reopen the
   * pane until `/workflow-pane` forces it. Mirrors the viewer-side `q` close.
   */
  async closeForUser(): Promise<void> {
    const record = readRecord(this.dir);
    if (!record?.paneId) {
      writeRecord(this.dir, { paneId: record?.paneId ?? "", sentinel: this.sentinel, closedByUser: true });
      return;
    }
    writeRecord(this.dir, { ...record, closedByUser: true });
    await this.exec("herdr", ["pane", "close", record.paneId], { timeout: this.timeoutMs });
  }

  /**
   * On session start: adopt a still-alive pane we own (e.g. after an extension
   * reload) or clear a record whose pane has gone. Never closes anything — a
   * gone pane is not ours to close, and an alive one we keep.
   */
  async reconcile(): Promise<void> {
    const record = readRecord(this.dir);
    if (!record?.paneId) return;
    if (!(await this.isOursAlive(record.paneId))) clearRecord(this.dir);
  }
}
