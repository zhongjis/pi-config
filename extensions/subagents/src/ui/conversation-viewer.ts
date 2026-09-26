/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, stripTerminalSequences, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { agentStatusWord, statusMark } from "./agent-monitor.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatMs, formatSessionTokens, formatTokens, getDisplayName, getPromptModeLabel } from "./agent-widget.js";
import { frameOverlay, type OverlayTheme } from "./graph-run-card.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

/** Collapse budgets for verbose blocks. */
const RESULT_HEAD = 6;
const RESULT_TAIL = 3;
const SUMMARY_HEAD = 3;

/** Untrusted message text: drop terminal sequences and every control character except newline and tab. */
function clean(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips.
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function imageLabel(mimeType: unknown): string {
  return typeof mimeType === "string" && mimeType ? `[image: ${clean(mimeType)}]` : "[image]";
}

/**
 * Structural view of a conversation message. The session's real message type is
 * a discriminated union; reinterpreting it through this view keeps every field
 * access typed (no `as any`) while covering the coding-agent custom roles.
 */
interface MsgView {
  role: string;
  content?: unknown;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  tokensBefore?: number;
  summary?: string;
  customType?: string;
  display?: boolean;
}

/** Structural view of one message content block. */
interface BlockView {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  toolName?: string;
  arguments?: unknown;
  input?: unknown;
  mimeType?: string;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** 1s tick while the agent is live so elapsed time updates. */
  private ticker: ReturnType<typeof setInterval> | undefined;

  /** Per-message rendered-line cache, keyed by the message object. Reset on theme change. */
  private lineCache = new WeakMap<object, { width: number; lines: string[] }>();
  /** Last render's content lines and block-start indices — handleInput reads these, never rebuilds. */
  private contentLines: string[] = [];
  private blockStarts: number[] = [];

  /** less-style search state. */
  private searchInput: Input | undefined;
  private searchQuery = "";
  private searchConfirmed = false;
  private searchMatches: number[] = [];
  private searchIndex = 0;
  private searchContentLength = -1;
  private preSearchScroll = 0;
  private preSearchAuto = true;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: OverlayTheme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
    this.startTicker();
  }

  handleInput(data: string): void {
    if (this.closed) return;

    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // While searching, all keys go to the input (Enter/Esc wired in openSearch()).
    if (this.searchInput) {
      this.searchInput.handleInput(data);
      if (this.searchInput) this.updateSearchQuery(this.searchInput.getValue());
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.searchConfirmed) {
        this.clearSearch();
        this.tui.requestRender();
        return;
      }
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    if (matchesKey(data, "/")) {
      this.openSearch();
      return;
    }

    if (this.searchConfirmed && this.searchMatches.length > 0) {
      if (matchesKey(data, "n")) {
        this.stepMatch(1);
        return;
      }
      if (matchesKey(data, "shift+n")) {
        this.stepMatch(-1);
        return;
      }
    }

    if (matchesKey(data, "[")) {
      this.jump(-1);
      return;
    }
    if (matchesKey(data, "]")) {
      this.jump(1);
      return;
    }

    const totalLines = this.contentLines.length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding

    const contentLines = this.buildContentLines(innerW);
    this.contentLines = contentLines;
    this.blockStarts = this.lastBlockStarts;

    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    // Live content can invalidate a running search's match rows.
    if ((this.searchInput || this.searchConfirmed) && this.searchQuery && contentLines.length !== this.searchContentLength) {
      this.recomputeMatches();
    }

    if (this.autoScroll) this.scrollOffset = maxScroll;
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    const visibleStart = this.scrollOffset;
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    const body: string[] = [];
    body.push(this.headerRow());
    const inv = this.invocationLine();
    if (inv) body.push(inv);
    body.push(th.fg("dim", "─".repeat(innerW)));

    const highlight = (this.searchInput || this.searchConfirmed) && this.searchQuery ? this.searchQuery : undefined;
    for (let i = 0; i < viewportHeight; i++) {
      const raw = visible[i] ?? "";
      body.push(highlight ? this.highlightMatches(raw, highlight) : raw);
    }

    const total = contentLines.length;
    const percent = total <= viewportHeight
      ? 100
      : Math.round((Math.min(visibleStart + viewportHeight, total) / total) * 100);
    const readout = `${total} lines · ${percent}%`;

    return frameOverlay(body, width, th, {
      title: "Conversation",
      right: readout,
      footer: this.footerRows(innerW),
    });
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && this.isActive();
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && this.isActive();
  }

  private isActive(): boolean {
    return this.record.status === "running" || this.record.status === "queued";
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  /** Open the less-style incremental search input. */
  private openSearch(): void {
    if (this.composer) return;
    this.preSearchScroll = this.scrollOffset;
    this.preSearchAuto = this.autoScroll;
    this.searchConfirmed = false;
    this.searchQuery = "";
    this.searchMatches = [];
    this.searchIndex = 0;
    const input = new Input({ prompt: "/ " });
    input.focused = true;
    input.onSubmit = (value: string) => {
      if (value.trim().length > 0) {
        this.searchInput = undefined;
        this.searchConfirmed = true;
        this.searchQuery = value;
        this.recomputeMatches();
        this.autoScroll = false;
        this.scrollToCurrentMatch();
      } else {
        this.cancelSearch();
      }
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.cancelSearch();
      this.tui.requestRender();
    };
    this.searchInput = input;
    this.autoScroll = false;
    this.tui.requestRender();
  }

  /** Live query update while typing: recompute matches and scroll to the first at/after top. */
  private updateSearchQuery(query: string): void {
    this.searchQuery = query;
    this.recomputeMatches();
    if (this.searchMatches.length === 0) return;
    const top = this.scrollOffset;
    const target = this.searchMatches.find(m => m >= top) ?? this.searchMatches[0];
    this.searchIndex = this.searchMatches.indexOf(target);
    this.scrollOffset = target;
  }

  private recomputeMatches(): void {
    const needle = this.searchQuery.toLowerCase();
    this.searchMatches = [];
    this.searchContentLength = this.contentLines.length;
    if (!needle) return;
    for (let i = 0; i < this.contentLines.length; i++) {
      if (stripTerminalSequences(this.contentLines[i]).toLowerCase().includes(needle)) {
        this.searchMatches.push(i);
      }
    }
    if (this.searchIndex >= this.searchMatches.length) this.searchIndex = 0;
  }

  private stepMatch(dir: 1 | -1): void {
    const n = this.searchMatches.length;
    if (n === 0) return;
    this.searchIndex = (this.searchIndex + dir + n) % n;
    this.scrollToCurrentMatch();
    this.tui.requestRender();
  }

  private scrollToCurrentMatch(): void {
    const row = this.searchMatches[this.searchIndex];
    if (row === undefined) return;
    const top = this.scrollOffset;
    const vh = this.viewportHeight();
    if (row < top || row >= top + vh) this.scrollOffset = Math.max(0, row - 2);
    this.autoScroll = false;
  }

  /** Cancel search (empty submit / Esc): restore the pre-search scroll position. */
  private cancelSearch(): void {
    this.searchInput = undefined;
    this.searchConfirmed = false;
    this.searchQuery = "";
    this.searchMatches = [];
    this.searchIndex = 0;
    this.scrollOffset = this.preSearchScroll;
    this.autoScroll = this.preSearchAuto;
  }

  /** Clear a confirmed search (Esc): drop matches, keep the current scroll position. */
  private clearSearch(): void {
    this.searchConfirmed = false;
    this.searchQuery = "";
    this.searchMatches = [];
    this.searchIndex = 0;
    this.searchContentLength = -1;
  }

  /** Jump to the previous (-1) or next (1) block start; `]` past the last block goes to the end. */
  private jump(dir: 1 | -1): void {
    this.stopArmed = false;
    const top = this.scrollOffset;
    if (dir < 0) {
      const prev = [...this.blockStarts].reverse().find(s => s < top);
      this.scrollOffset = prev ?? 0;
      this.autoScroll = false;
    } else {
      const next = this.blockStarts.find(s => s > top);
      if (next !== undefined) {
        this.scrollOffset = next;
        this.autoScroll = false;
      } else {
        this.autoScroll = true;
        this.scrollOffset = Math.max(0, this.contentLines.length - this.viewportHeight());
      }
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.lineCache = new WeakMap();
  }

  dispose(): void {
    this.closed = true;
    this.stopTicker();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private startTicker(): void {
    if (this.ticker || !this.isActive()) return;
    this.ticker = setInterval(() => {
      if (this.closed) return;
      if (!this.isActive()) {
        this.stopTicker();
        return;
      }
      this.tui.requestRender();
    }, 1000);
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer or search input each add one row above the footer hint.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer || this.searchInput ? 1 : 0);
  }

  private headerRow(): string {
    const th = this.theme;
    const name = getDisplayName(this.record.type);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const mark = statusMark(this.record);
    const glyph = th.fg(mark.color, mark.glyph);
    const word = th.fg(mark.color, agentStatusWord(this.record.status));

    const parts: string[] = [];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) parts.push(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    parts.push(formatMs((this.record.completedAt ?? Date.now()) - this.record.startedAt));
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage ?? this.record.lifetimeUsage);
    if (tokens > 0) {
      const compactions = this.record.compactionCount || this.countCompactions();
      parts.push(formatSessionTokens(tokens, getSessionContextPercent(this.activity?.session), th, compactions));
    }

    const desc = th.fg("muted", clean(this.record.description));
    const statParts = parts.length > 0
      ? ` ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", parts.join(" · "))}`
      : "";
    return `${glyph} ${word}  ${th.bold(name)}${modeTag}  ${desc}${statParts}`;
  }

  private countCompactions(): number {
    return this.messages().filter(m => m.role === "compactionSummary").length;
  }

  /** The session's messages reinterpreted through the structural view above. */
  private messages(): MsgView[] {
    return this.session.messages as unknown as MsgView[];
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const model = modelName ?? this.lastAssistantModel();
    const parts = model ? [model, ...tags] : [...tags];
    // record.session (the live AgentSession) undefined ⇒ this is read-only history.
    if (this.record.session === undefined) parts.push("history · read-only");
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private lastAssistantModel(): string | undefined {
    const messages = this.messages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && typeof m.model === "string") return m.model;
    }
    return undefined;
  }

  private lastAssistantText(): string {
    const messages = this.messages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") return extractText(Array.isArray(m.content) ? m.content : []).trim();
    }
    return "";
  }

  /** Content lines for the whole conversation, plus streaming. Also records block-start indices. */
  private lastBlockStarts: number[] = [];
  private buildContentLines(width: number): string[] {
    this.lastBlockStarts = [];
    if (width <= 0) return [];
    const th = this.theme;
    const out: string[] = [];
    let needsSeparator = false;

    const pushBlock = (blockLines: string[]) => {
      if (blockLines.length === 0) return;
      if (needsSeparator) out.push(th.fg("dim", "───"));
      this.lastBlockStarts.push(out.length);
      out.push(...blockLines);
      needsSeparator = true;
    };

    for (const msg of this.messages()) {
      pushBlock(this.messageLines(msg, width));
    }
    pushBlock(this.streamingLines(width));

    if (out.length === 0) {
      out.push(th.fg("dim", this.isActive() ? "(waiting for first message...)" : "No messages recorded."));
    }
    return out;
  }

  /** Cached per-message rendering. */
  private messageLines(msg: MsgView, width: number): string[] {
    const cached = this.lineCache.get(msg);
    if (cached && cached.width === width) return cached.lines;
    const lines = this.buildMessageLines(msg, width);
    this.lineCache.set(msg, { width, lines });
    return lines;
  }

  private buildMessageLines(msg: MsgView, width: number): string[] {
    const th = this.theme;
    const out: string[] = [];
    const content = msg.content;
    const blocks: BlockView[] = Array.isArray(content) ? (content as BlockView[]) : [];

    if (msg.role === "user") {
      const text = typeof content === "string" ? content : extractText(blocks as unknown[]);
      const images = blocks.filter(b => b.type === "image");
      if (!text.trim() && images.length === 0) return [];
      out.push(th.fg("accent", "[User]"));
      if (text.trim()) out.push(...this.wrapClean(text.trim(), width));
      for (const img of images) out.push(imageLabel(img.mimeType));
    } else if (msg.role === "assistant") {
      const inner: string[] = [];
      let thinkingLen = 0;
      const textParts: string[] = [];
      const toolCalls: BlockView[] = [];
      for (const c of blocks) {
        if (c.type === "thinking") thinkingLen += String(c.thinking ?? "").length;
        else if (c.type === "text" && c.text) textParts.push(String(c.text));
        else if (c.type === "toolCall") toolCalls.push(c);
      }
      if (thinkingLen > 0) inner.push(th.fg("dim", `(thinking · ${this.thinkingChars(thinkingLen)})`));
      const text = textParts.join("\n").trim();
      if (text) inner.push(...this.wrapClean(text, width));
      for (const tc of toolCalls) {
        const name = String(tc.name ?? tc.toolName ?? "unknown");
        const preview = this.toolPreview(tc.arguments ?? tc.input);
        const label = th.fg("muted", `  [Tool: ${name}]`);
        inner.push(preview ? `${label} ${th.fg("dim", preview)}` : label);
      }
      const stop = msg.stopReason as string | undefined;
      if (stop === "error") {
        for (const l of this.wrapClean(`× error: ${String(msg.errorMessage ?? "unknown error")}`, width)) inner.push(th.fg("error", l));
      } else if (stop === "aborted") {
        inner.push(th.fg("dim", "■ aborted"));
      } else if (stop === "length") {
        inner.push(th.fg("warning", "⚠ stopped at output limit"));
      }
      if (inner.length === 0) return [];
      out.push(th.bold("[Assistant]"));
      out.push(...inner);
    } else if (msg.role === "toolResult") {
      const name = msg.toolName ? `: ${clean(String(msg.toolName))}` : "";
      let label = th.fg("dim", `[Result${name}]`);
      if (msg.isError) label += th.fg("error", " × error");
      out.push(label);
      const text = extractText(blocks as unknown[]);
      const images = blocks.filter(b => b.type === "image");
      const bodyRows = [
        ...(text.trim() ? this.wrapClean(text.trim(), width) : []),
        ...images.map(img => imageLabel(img.mimeType)),
      ];
      if (bodyRows.length === 0) out.push(th.fg("dim", "(no output)"));
      else for (const l of this.headTail(bodyRows)) out.push(th.fg("dim", l));
    } else if (msg.role === "bashExecution") {
      let label = th.fg("muted", `  $ ${clean(String(msg.command ?? ""))}`);
      const exitCode = msg.exitCode as number | undefined;
      if (exitCode !== undefined && exitCode !== 0) label += th.fg("error", ` × exit ${exitCode}`);
      else if (msg.cancelled) label += th.fg("dim", " ■ cancelled");
      out.push(label);
      const output = String(msg.output ?? "");
      if (output.trim()) {
        for (const l of this.headTail(this.wrapClean(output.trim(), width))) out.push(th.fg("dim", l));
      }
    } else if (msg.role === "compactionSummary") {
      out.push(th.fg("muted", `── compacted · ${formatTokens(Number(msg.tokensBefore ?? 0))} summarized ──`));
      const rows = msg.summary ? this.wrapClean(String(msg.summary), width) : [];
      for (const l of this.headOnly(rows)) out.push(th.fg("dim", l));
    } else if (msg.role === "branchSummary") {
      out.push(th.fg("muted", "── branch summary ──"));
      const rows = msg.summary ? this.wrapClean(String(msg.summary), width) : [];
      for (const l of this.headOnly(rows)) out.push(th.fg("dim", l));
    } else if (msg.role === "custom") {
      if (msg.display === false) return [];
      out.push(th.fg("dim", `[${clean(String(msg.customType ?? ""))}]`));
      const text = typeof content === "string" ? content : extractText(blocks as unknown[]);
      const rows = text.trim() ? this.wrapClean(text.trim(), width) : [];
      for (const l of this.headTail(rows)) out.push(th.fg("dim", l));
    } else {
      return [];
    }

    return out.map(l => truncateToWidth(l, width));
  }

  /** Streaming indicator for running agents. Never cached — the live text changes each frame. */
  private streamingLines(width: number): string[] {
    const act = this.activity;
    if (this.record.status !== "running" || !act) return [];
    const th = this.theme;
    const responseText = act.responseText.trim();
    if (act.activeTools.size === 0 && responseText && responseText !== this.lastAssistantText()) {
      const out = [`${th.bold("[Assistant]")} ${th.fg("accent", "▍")}`, ...this.wrapClean(responseText, width)];
      return out.map(l => truncateToWidth(l, width));
    }
    // Finished or empty response text: fall back to tool activity or "thinking…", never the old text.
    const activity = clean(describeActivity(act.activeTools));
    return [truncateToWidth(`${th.fg("accent", "▍ ")}${th.fg("dim", activity)}`, width)];
  }

  private wrapClean(text: string, width: number): string[] {
    return wrapTextWithAnsi(clean(text), width);
  }

  private thinkingChars(n: number): string {
    return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`;
  }

  /** First present string among common preview keys, else first string arg, else compact JSON. */
  private toolPreview(args: unknown): string {
    if (!args || typeof args !== "object") return "";
    const record = args as Record<string, unknown>;
    const preferred = ["command", "path", "file_path", "pattern", "query", "url", "description", "prompt"];
    let value: string | undefined;
    for (const key of preferred) {
      if (typeof record[key] === "string" && record[key]) {
        value = record[key] as string;
        break;
      }
    }
    if (value === undefined) {
      for (const key of Object.keys(record)) {
        if (typeof record[key] === "string") {
          value = record[key] as string;
          break;
        }
      }
    }
    if (value === undefined) {
      if (Object.keys(record).length === 0) return "";
      value = JSON.stringify(record);
    }
    return clean(value).replace(/\s+/g, " ").trim();
  }

  /** Head + ellipsis + tail collapse, matching the result budget. */
  private headTail(rows: string[]): string[] {
    if (rows.length <= RESULT_HEAD + RESULT_TAIL + 1) return rows;
    const omitted = rows.length - RESULT_HEAD - RESULT_TAIL;
    return [...rows.slice(0, RESULT_HEAD), `… +${omitted} lines`, ...rows.slice(rows.length - RESULT_TAIL)];
  }

  /** Head-only collapse for summary blocks. */
  private headOnly(rows: string[]): string[] {
    if (rows.length <= SUMMARY_HEAD) return rows;
    return [...rows.slice(0, SUMMARY_HEAD), `… +${rows.length - SUMMARY_HEAD} lines`];
  }

  /** Wrap each search match in a visible row with inverse video; other rows keep their styling. */
  private highlightMatches(line: string, query: string): string {
    const plain = stripTerminalSequences(line);
    const lower = plain.toLowerCase();
    const needle = query.toLowerCase();
    if (!needle || !lower.includes(needle)) return line;
    let result = "";
    let index = 0;
    for (;;) {
      const found = lower.indexOf(needle, index);
      if (found === -1) {
        result += plain.slice(index);
        break;
      }
      result += plain.slice(index, found) + `\x1b[7m${plain.slice(found, found + needle.length)}\x1b[27m`;
      index = found + needle.length;
    }
    return result;
  }

  private footerRows(innerW: number): string[] {
    const th = this.theme;
    const key = (text: string) => th.fg("text", text);
    const label = (text: string) => th.fg("dim", text);
    const sep = th.fg("dim", " · ");

    if (this.composer) {
      const left = th.fg("accent", "✎ steer");
      const right = `${key("enter")} ${label("send")}${sep}${key("esc")} ${label("cancel")}`;
      return [this.composer.render(innerW)[0] ?? "", this.spread(left, right, innerW)];
    }

    if (this.searchInput) {
      const left = th.fg("accent", "⌕ search");
      const count = this.searchMatches.length;
      const status = count > 0 ? `${count} matches` : "no matches";
      const right = `${label(status)}${sep}${key("enter")} ${label("confirm")}${sep}${key("esc")} ${label("cancel")}`;
      return [this.searchInput.render(innerW)[0] ?? "", this.spread(left, right, innerW)];
    }

    if (this.searchConfirmed) {
      const left = this.searchMatches.length > 0
        ? `${label(`"${this.searchQuery}"`)} ${label(`${this.searchIndex + 1}/${this.searchMatches.length}`)}${sep}${key("n/N")} ${label("next/prev")}`
        : label(`"${this.searchQuery}" no matches`);
      const right = `${label(this.keys.navigationHint())}${sep}${key("esc")} ${label("clear")}`;
      return [this.spread(left, right, innerW)];
    }

    const actions: string[] = [];
    if (this.canSteer()) actions.push(`${key("enter")} ${label("steer")}`);
    if (this.isStoppable()) actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : `${key("x")} ${label("stop")}`);
    const left = actions.join(sep);
    // Scroll hint leads the right group so "esc close" is the only part that truncates first.
    const right = [
      label(this.keys.navigationHint()),
      `${key("[ ]")} ${label("jump")}`,
      `${key("/")} ${label("search")}`,
      `${key("esc")} ${label("close")}`,
    ].join(sep);
    return [this.spread(left, right, innerW)];
  }

  /** Left group, right group, right-aligned; frameOverlay clips the row (right side first). */
  private spread(left: string, right: string, innerW: number): string {
    const gap = Math.max(1, innerW - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + right;
  }
}
