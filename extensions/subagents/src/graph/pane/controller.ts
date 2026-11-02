/**
 * controller.ts — the Herdr or Orca pane lifecycle: create it, verify it is still
 * ours, close only what we created.
 *
 * Every host CLI call (`herdr` or `orca`) goes through an injected `exec` (pi.exec at runtime, a stub
 * in tests) and every path is an argv array — never a shell string — so a cwd or
 * pane id can never be interpolated into a command. The controller owns exactly
 * one pane at a time, identified by a persisted record plus a sentinel label:
 * before touching a pane it re-reads the label, so a pane the user renamed or
 * repurposed is treated as "not ours" and left alone. It never focuses the pane
 * (`--no-focus`), so it can appear beside a run you are watching without
 * stealing the cursor from the main agent.
 */

import { detectPaneHost, type PaneHost } from "../../../../lib/pane-host.js";
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
  /** Which CLI manages the panes; defaults to Herdr. */
  host?: PaneHost;
  /** The pane (Orca: terminal handle) pi itself runs in — the new pane splits off it. */
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

/** Only inside a Herdr- or Orca-managed TUI pane is there a parent pane to split off. */
export function isPaneHostEnabled(env: NodeJS.ProcessEnv, mode: string): boolean {
  return detectPaneHost(env) !== undefined && mode === "tui";
}

/** POSIX single-quote escaping for arguments typed into the new pane's interactive shell. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Extract the new terminal handle from `orca terminal split --json` output. */
function parseOrcaHandle(stdout: string): string | undefined {
  try {
    const handle = (JSON.parse(stdout) as { result?: { split?: { handle?: unknown } } })?.result?.split?.handle;
    return typeof handle === "string" && handle.length > 0 ? handle : undefined;
  } catch {
    return undefined;
  }
}

/** Orca reports a user- or tool-set pane title as `paneTitle`; the auto `title` is never ours. */
function parseOrcaPaneTitle(stdout: string): string | undefined {
  try {
    const title = (JSON.parse(stdout) as { result?: { terminal?: { paneTitle?: unknown } } })?.result?.terminal?.paneTitle;
    return typeof title === "string" ? title : undefined;
  } catch {
    return undefined;
  }
}

/** Find the terminal carrying `sentinel` in `orca terminal list --json` output. */
function findOrcaHandleByTitle(stdout: string, sentinel: string): string | undefined {
  try {
    const terminals = (JSON.parse(stdout) as { terminals?: unknown })?.terminals;
    if (!Array.isArray(terminals)) return undefined;
    for (const terminal of terminals as Array<{ handle?: unknown; paneTitle?: unknown }>) {
      if (terminal?.paneTitle === sentinel && typeof terminal.handle === "string") return terminal.handle;
    }
  } catch {
    // Unparseable list output reads as "not found".
  }
  return undefined;
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
  private readonly host: PaneHost;
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
    this.host = options.host ?? "herdr";
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
      const paneId = await this.resolveOwned(record.paneId);
      if (paneId !== undefined) {
        // Already up and ours. A forced reopen after a manual close just clears the flag;
        // a re-found Orca handle replaces the stale persisted one.
        if (record.closedByUser || paneId !== record.paneId) {
          writeRecord(this.dir, { ...record, paneId, closedByUser: false });
        }
        return;
      }
      // Gone, or the user made it theirs. Forget it — do NOT close it.
      clearRecord(this.dir);
    }

    await this.split();
  }

  /** True only when `paneId` still exists AND still carries our sentinel label. */
  private async isOursAlive(paneId: string): Promise<boolean> {
    if (this.host === "orca") {
      const res = await this.exec("orca", ["terminal", "show", "--terminal", paneId, "--json"], { timeout: this.timeoutMs });
      return res.code === 0 && parseOrcaPaneTitle(res.stdout) === this.sentinel;
    }
    const res = await this.exec("herdr", ["pane", "get", paneId], { timeout: this.timeoutMs });
    if (res.code !== 0) return false;
    return parsePaneLabel(res.stdout) === this.sentinel;
  }

  /**
   * The id of the live pane that is ours, or undefined. Orca terminal handles are
   * runtime-scoped, so a persisted one is only a hint: when it fails validation the
   * sentinel title is searched for among the live terminals.
   */
  private async resolveOwned(paneId: string): Promise<string | undefined> {
    if (await this.isOursAlive(paneId)) return paneId;
    if (this.host !== "orca") return undefined;
    const res = await this.exec("orca", ["terminal", "list", "--json"], { timeout: this.timeoutMs });
    return res.code === 0 ? findOrcaHandleByTitle(res.stdout, this.sentinel) : undefined;
  }

  private closeArgs(paneId: string): string[] {
    return this.host === "orca" ? ["terminal", "close", "--terminal", paneId] : ["pane", "close", paneId];
  }

  private async split(): Promise<void> {
    if (this.host === "orca") {
      await this.splitOrca();
      return;
    }
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
        `PI_GRAPH_RUN_PANE_DIR=${this.dir}`,
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

  /**
   * Orca: no ratio/cwd/env/no-focus flags exist, so the viewer command carries cwd and
   * env, and focus is handed straight back to the parent. The new pane learns its own
   * handle from `ORCA_TERMINAL_HANDLE`.
   */
  private async splitOrca(): Promise<void> {
    const command = [
      `cd ${shellQuote(this.cwd)} &&`,
      "env",
      `PI_GRAPH_RUN_PANE_DIR=${shellQuote(this.dir)}`,
      "node",
      shellQuote(this.viewerPath),
      "--dir",
      shellQuote(this.dir),
      "--ppid",
      String(this.ppid),
      "--host",
      "orca",
    ].join(" ");
    const res = await this.exec(
      "orca",
      ["terminal", "split", "--terminal", this.parentPaneId, "--direction", "vertical", "--command", command, "--json"],
      { timeout: this.timeoutMs },
    );
    const paneId = res.code === 0 ? parseOrcaHandle(res.stdout) : undefined;
    if (!paneId) return; // Split failed; leave no record so the next sync retries cleanly.

    // Best-effort, like the Herdr path: a failed switch or title still leaves a recorded, closable pane.
    await this.exec("orca", ["terminal", "switch", "--terminal", this.parentPaneId], { timeout: this.timeoutMs });
    await this.exec("orca", ["terminal", "set-pane-title", "--terminal", paneId, "--title", this.sentinel], {
      timeout: this.timeoutMs,
    });
    writeRecord(this.dir, { paneId, sentinel: this.sentinel, closedByUser: false });
  }

  /** Close only the pane we recorded, best-effort. Never touches any other pane. */
  async closeOwned(): Promise<void> {
    const record = readRecord(this.dir);
    if (!record?.paneId) return;
    const paneId = this.host === "orca" ? await this.resolveOwned(record.paneId) : record.paneId;
    if (paneId !== undefined) await this.exec(this.host, this.closeArgs(paneId), { timeout: this.timeoutMs });
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
    const paneId = this.host === "orca" ? await this.resolveOwned(record.paneId) : record.paneId;
    if (paneId !== undefined) await this.exec(this.host, this.closeArgs(paneId), { timeout: this.timeoutMs });
  }

  /**
   * On session start: adopt a still-alive pane we own (e.g. after an extension
   * reload) or clear a record whose pane has gone. Never closes anything — a
   * gone pane is not ours to close, and an alive one we keep.
   */
  async reconcile(): Promise<void> {
    const record = readRecord(this.dir);
    if (!record?.paneId) return;
    const paneId = await this.resolveOwned(record.paneId);
    if (paneId === undefined) clearRecord(this.dir);
    else if (paneId !== record.paneId) writeRecord(this.dir, { ...record, paneId });
  }
}
