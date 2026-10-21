/**
 * Diagnostics for successful `edit`/`write` results.
 *
 * Errors only, for the changed file only, capped so a broken file cannot flood
 * the context. A timeout or a partial server failure yields what is available;
 * rejects only when every server failed. Errors that arrive after the result
 * was returned are reported once through a late watch.
 */

import type { Theme, ToolRenderers } from '@earendil-works/pi-coding-agent';

import { renderToolSummary } from '../lib/tool-output.js';
import type { LspClient } from './client';
import { formatDiagnostics } from './formatting';
import { type Diagnostic, DiagnosticSeverity } from './types';

export const EDIT_HOOK_TOOLS = new Set(['edit', 'write']);
// ponytail: fixed budget; make it per-server if a slow server needs more.
export const EDIT_HOOK_TIMEOUT_MS = 3_000;
export const EDIT_HOOK_MAX_ERRORS = 10;
// ponytail: errors later than this (jdtls/metals cold imports) wait for the next
// edit; servers without `version` (typescript-language-server) are trusted until
// the file is edited again. Make it per-server if a slow server needs longer.
export const LATE_ERRORS_WATCH_MS = 10_000;
export const LATE_ERRORS_MESSAGE_TYPE = 'lsp-diagnostics';

/** Presentation data stored as `details.lsp` on an edit/write result. */
export interface LspErrorDetails {
  errors: number;
  /** One-line summaries of the reported (capped) errors. */
  lines: string[];
}

export interface LspErrorReport extends LspErrorDetails {
  /** Model-facing report. */
  text: string;
}

interface ErrorGroup {
  source: string;
  diagnostics: Diagnostic[];
}

const errorsOnly = (diagnostics: Diagnostic[]) =>
  diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);

function summaryLine(d: Diagnostic): string {
  const code = d.code !== undefined ? ` (${d.code})` : '';
  return `L${d.range.start.line + 1}${code} ${d.message.split('\n')[0]}`;
}

function errorReport(filePath: string, groups: ErrorGroup[]): LspErrorReport | null {
  const total = groups.reduce((n, g) => n + g.diagnostics.length, 0);
  if (total === 0) return null;

  let budget = EDIT_HOOK_MAX_ERRORS;
  const shown = groups.map((g) => {
    const diagnostics = g.diagnostics.slice(0, budget);
    budget -= diagnostics.length;
    return { source: g.source, diagnostics };
  });
  const more = total - EDIT_HOOK_MAX_ERRORS;
  const moreText = more > 0 ? `\n\n+${more} more error${more !== 1 ? 's' : ''}` : '';
  return {
    text: `LSP ${formatDiagnostics(filePath, shown)}${moreText}`,
    errors: total,
    lines: shown.flatMap((g) => g.diagnostics.map(summaryLine)),
  };
}

const sourceName = (client: LspClient) => client.config?.name ?? 'lsp';

export async function editDiagnostics(
  clients: LspClient[],
  filePath: string,
  timeoutMs = EDIT_HOOK_TIMEOUT_MS,
): Promise<LspErrorReport | null> {
  // The deadline also covers cold server start; a slow init keeps running in the
  // background, so a later edit finds the server ready.
  const withDeadline = (client: LspClient) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<[]>((resolve) => {
      timer = setTimeout(() => resolve([]), timeoutMs);
    });
    return Promise.race([client.getDiagnostics(filePath, timeoutMs), deadline]).finally(() =>
      clearTimeout(timer),
    );
  };
  const results = await Promise.allSettled(
    clients.map(async (client) => ({
      source: sourceName(client),
      diagnostics: errorsOnly(await withDeadline(client)),
    })),
  );
  const groups = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failure = results.find((r) => r.status === 'rejected');
  if (groups.length === 0 && failure) throw failure.reason;
  return errorReport(filePath, groups);
}

/**
 * Watch `filePath` after a result reported no errors. The first publish with
 * errors calls `onErrors` once; the watch ends then, after `watchMs`, or when
 * the returned cancel function runs.
 */
export function watchLateErrors(
  clients: LspClient[],
  filePath: string,
  onErrors: (report: LspErrorReport) => void,
  watchMs = LATE_ERRORS_WATCH_MS,
): () => void {
  const unsubscribers: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const cancel = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
  for (const client of clients) {
    unsubscribers.push(
      client.onDiagnostics(filePath, (diagnostics) => {
        const report = errorReport(filePath, [
          { source: sourceName(client), diagnostics: errorsOnly(diagnostics) },
        ]);
        if (!report || !active) return;
        cancel();
        onErrors(report);
      }),
    );
  }
  timer = setTimeout(cancel, watchMs);
  timer.unref?.();
  return cancel;
}

type Component = ReturnType<NonNullable<ToolRenderers['renderResult']>>;

/** One-line LSP summary under a result; expanded lists every reported error. */
export function renderLspRow(lsp: LspErrorDetails, expanded: boolean, theme: Theme): Component {
  const header = `⚠ LSP ${lsp.errors} error${lsp.errors !== 1 ? 's' : ''}`;
  if (!expanded) return renderToolSummary([`${header} · ${lsp.lines[0] ?? ''}`], theme);
  const more = lsp.errors - lsp.lines.length;
  return renderToolSummary([header, ...lsp.lines, ...(more > 0 ? [`+${more} more`] : [])], theme);
}

/** Wrap a result renderer so results carrying `details.lsp` gain the LSP row. */
export function withLspRow(base: ToolRenderers): ToolRenderers {
  const inner = base.renderResult;
  if (!inner) return base;
  return {
    ...base,
    renderResult(result, options, theme, context) {
      // The inner renderer reuses `lastComponent`; hand it its own component back,
      // not our wrapper. `state` is shared with renderCall, hence the unique key.
      const state = context.state as { lspInner?: Component };
      const component = inner(result, options, theme, { ...context, lastComponent: state.lspInner });
      state.lspInner = component;
      const lsp = (result.details as { lsp?: LspErrorDetails } | undefined)?.lsp;
      if (!lsp || options.isPartial) return component;
      const row = renderLspRow(lsp, options.expanded, theme);
      // The inner renderer pads its own text by outputPad; align the row with it.
      const pad = ' '.repeat(context.outputPad ?? 0);
      return {
        render: (width: number) => [
          ...component.render(width),
          ...row.render(Math.max(0, width - pad.length)).map((line) => pad + line),
        ],
        invalidate: () => {
          component.invalidate();
          row.invalidate();
        },
      };
    },
  };
}
