/**
 * Single unified `lsp` tool registration.
 *
 * 11 operations routed to the right server by file extension. The execution
 * logic lives in `tools/programs.ts` as Effect programs; this module owns the
 * tool schema/description and runs the program with the live `ServerManager`.
 */

import {
  keyHint,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
// @ts-expect-error LSP may miss the repo tsconfig path for this vendored package; runtime/test alias resolves it.
import { Text } from '@earendil-works/pi-tui';
import { Effect } from 'effect';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';

import { toNativeError } from './errors';
import {
  lspToolProgram,
  ServerManager,
  type LspToolParams,
  type ServerManagerService,
} from './tools/programs';
import { LSP_OPERATIONS, type LspOperation } from './types';

export type { ServerManagerService } from './tools/programs';
export { ServerManager } from './tools/programs';

type LspToolResult = AgentToolResult<Record<string, unknown> | undefined> & { isError?: boolean };
type ToolTheme = Pick<Theme, 'fg' | 'bold'>;
type LspRenderOptions = Pick<ToolRenderResultOptions, 'expanded' | 'isPartial'>;
type LspRenderContext = { args?: Partial<LspToolParams>; isError?: boolean };

function styleToolTitle(theme: ToolTheme, text: string): string {
  const bold = theme.bold ? theme.bold(text) : text;
  return theme.fg ? theme.fg('toolTitle', bold) : bold;
}

function styleMuted(theme: ToolTheme, text: string): string {
  return theme.fg ? theme.fg('muted', text) : text;
}


function prefixTreeLines(lines: string[]): string[] {
  return lines.map((line, index) => `${index === lines.length - 1 ? '└─' : '├─'} ${line}`);
}


function truncateForSummary(value: string, maxLength = 120): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}

function getFirstMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function firstMatch(text: string, pattern: RegExp): RegExpExecArray | undefined {
  return pattern.exec(text) ?? undefined;
}

function collectNumberedEntries(text: string, localFirst = false): string[] {
  const entries = Array.from(text.matchAll(/^\d+\.\s+(.+)$/gm)).map((match) =>
    truncateForSummary(stripMarkdown(match[1].trim())),
  );
  const sorted = localFirst
    ? entries.sort((a, b) => Number(a.includes('node_modules')) - Number(b.includes('node_modules')))
    : entries;
  return sorted.slice(0, 3);
}

function collectBodyEntries(text: string): string[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'))
    .slice(0, 3)
    .map((line) => truncateForSummary(stripMarkdown(line)));
}

function formatArgValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}


function renderCallTarget(args: Partial<LspToolParams>): string | undefined {
  const filePath = formatArgValue(args.filePath);
  if (filePath) {
    if (typeof args.line === 'number' && typeof args.character === 'number') {
      return `${filePath}:${args.line}:${args.character}`;
    }
    return filePath;
  }

  const query = formatArgValue(args.query);
  return query ? `"${query}"` : undefined;
}

function renderLspCall(rawArgs: Partial<LspToolParams> | undefined, theme: ToolTheme): Text {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const parts = [formatArgValue(args.operation), renderCallTarget(args)].filter(
    (part): part is string => Boolean(part),
  );
  const suffix = parts.length > 0 ? ` · ${styleMuted(theme, parts.join(' · '))}` : '';
  return new Text(`▸ ${styleToolTitle(theme, 'lsp')}${suffix}`, 0, 0);
}

function getResultText(result: LspToolResult | undefined): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

function entryLabel(entry: string): string {
  return truncateForSummary(
    stripMarkdown(entry)
      .replace(/\s+\[[^\]]+\]/g, '')
      .replace(/\s+\([^)]+\).*$/, '')
      .trim(),
    80,
  );
}

function compactList(entries: string[], total: number): string {
  const labels = entries.slice(0, 3).map(entryLabel).filter(Boolean);
  const more = total > labels.length ? ` +${total - labels.length}` : '';
  return labels.length > 0 ? ` · ${labels.join(', ')}${more}` : more;
}

function collectTopBodyEntries(text: string): string[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim() && line === line.trim() && !line.startsWith('```'))
    .slice(0, 3);
}


function summarizeDiagnostics(firstLine: string): string | undefined {
  let match = firstMatch(firstLine, /^(.+): No diagnostics — all clean ✓$/);
  if (match) return '✓ clean';

  match = firstMatch(firstLine, /^Diagnostics for .+: (.+)$/);
  if (match) return match[1];

  match = firstMatch(firstLine, /^.+: No diagnostics from successful server\(s\): (.+)$/);
  if (match) return `incomplete clean · ${match[1]}`;

  return undefined;
}

function summarizeHover(firstLine: string, text: string): string | undefined {
  if (firstMatch(firstLine, /^Hover at .+:\d+:\d+:$/)) {
    return collectBodyEntries(text)[0] ?? 'hover available';
  }
  if (firstMatch(firstLine, /^No hover information at .+:\d+:\d+$/)) return 'no hover';
  return undefined;
}

function locationNoun(kind: string, count: number): string {
  const lower = kind.toLowerCase();
  if (lower === 'references') return count === 1 ? 'reference' : 'references';
  if (lower === 'definition') return count === 1 ? 'definition' : 'definitions';
  if (lower === 'implementation') return count === 1 ? 'implementation' : 'implementations';
  return lower;
}

function summarizeLocations(firstLine: string, text: string): string | undefined {
  let match = firstMatch(
    firstLine,
    /^(Definition|References|Implementation) for symbol at .+ \((\d+) results?\):$/,
  );
  if (match) {
    const count = Number(match[2]);
    return `${count} ${locationNoun(match[1], count)}${compactList(collectNumberedEntries(text), count)}`;
  }

  match = firstMatch(firstLine, /^No (Definition|References|Implementation) found for symbol at .+$/);
  if (match) return `no ${locationNoun(match[1], 0)}`;

  return undefined;
}

function firstInteger(value: string): number | undefined {
  const match = /\d+/.exec(value);
  return match ? Number(match[0]) : undefined;
}

function summarizeDocumentSymbols(firstLine: string, text: string): string | undefined {
  let match = firstMatch(firstLine, /^Symbols in .+ \(([^)]+)\):$/);
  if (match) {
    const count = firstInteger(match[1]) ?? collectTopBodyEntries(text).length;
    return `${count} ${count === 1 ? 'symbol' : 'symbols'}${compactList(collectTopBodyEntries(text), count)}`;
  }

  if (firstMatch(firstLine, /^No symbols found in .+$/)) return 'no symbols';
  return undefined;
}

function summarizeWorkspaceSymbols(firstLine: string, text: string): string | undefined {
  if (firstMatch(firstLine, /^No workspace symbols matching ".+"$/)) return 'no workspace symbols';

  const match = firstMatch(firstLine, /^Workspace symbols matching ".+" \((\d+)\):$/);
  if (match) {
    const count = Number(match[1]);
    return `${count} workspace ${count === 1 ? 'symbol' : 'symbols'}${compactList(collectNumberedEntries(text), count)}`;
  }

  return undefined;
}

function summarizeCalls(firstLine: string, text: string): string | undefined {
  let match = firstMatch(firstLine, /^Call hierarchy at .+:$/);
  if (match) {
    const entries = collectNumberedEntries(text);
    return `${entries.length} call ${entries.length === 1 ? 'item' : 'items'}${compactList(entries, entries.length)}`;
  }

  match = firstMatch(firstLine, /^Incoming calls to (.+) \((\d+)\):$/);
  if (match) {
    const count = Number(match[2]);
    return `${count} incoming${compactList(collectNumberedEntries(text), count)}`;
  }

  match = firstMatch(firstLine, /^Outgoing calls from (.+) \((\d+)\):$/);
  if (match) {
    const count = Number(match[2]);
    return `${count} outgoing${compactList(collectNumberedEntries(text, true), count)}`;
  }

  if (firstMatch(firstLine, /^No incoming calls to .+$/)) return 'no incoming calls';
  if (firstMatch(firstLine, /^No outgoing calls from .+$/)) return 'no outgoing calls';
  if (firstMatch(firstLine, /^No call hierarchy item at .+$/)) return 'no call hierarchy item';

  return undefined;
}

function summarizeCodeActions(firstLine: string, text: string): string | undefined {
  let match = firstMatch(firstLine, /^Code actions at .+:\d+ \((\d+) available\):$/);
  if (match) {
    const count = Number(match[1]);
    return `${count} ${count === 1 ? 'action' : 'actions'}${compactList(collectNumberedEntries(text), count)}`;
  }

  if (firstMatch(firstLine, /^No code actions available at .+:\d+$/)) return 'no code actions';
  return undefined;
}

function summarizeLspResult(args: Partial<LspToolParams>, text: string): string {
  const firstLine = getFirstMeaningfulLine(text) ?? '';
  return (
    summarizeDiagnostics(firstLine) ??
    summarizeHover(firstLine, text) ??
    summarizeLocations(firstLine, text) ??
    summarizeDocumentSymbols(firstLine, text) ??
    summarizeWorkspaceSymbols(firstLine, text) ??
    summarizeCalls(firstLine, text) ??
    summarizeCodeActions(firstLine, text) ??
    formatArgValue(args.operation) ??
    stripMarkdown(firstLine) ??
    'no output'
  );
}

function compactErrorSummary(text: string): string {
  const firstLine = stripMarkdown(getFirstMeaningfulLine(text) ?? 'unknown error');
  const serverError = /TypeScript Server Error \([^)]+\)/.exec(firstLine)?.[0];
  return `✗ ${serverError ?? truncateForSummary(firstLine, 100)}`;
}

function renderLspResult(
  result: LspToolResult | undefined,
  options: LspRenderOptions,
  theme: ToolTheme,
  context: LspRenderContext = {},
): Text {
  const text = getResultText(result);
  if (options?.expanded) return new Text(text, 0, 0);

  const args = context.args && typeof context.args === 'object' ? context.args : {};
  const isError = Boolean(result?.isError || context.isError);
  const serverFailures = Array.isArray(result?.details?.errors) ? result.details.errors.length : 0;
  const suffix = serverFailures > 0 ? ` · ${serverFailures} server failure${serverFailures === 1 ? '' : 's'}` : '';
  const summary = isError
    ? compactErrorSummary(text)
    : options?.isPartial
      ? `running ${formatArgValue(args.operation) ?? 'lsp'}`
      : `${summarizeLspResult(args, text)}${suffix}`;
  const lines = [summary, keyHint('app.tools.expand', 'to expand full result')];

  return new Text(prefixTreeLines(lines).map((line) => styleMuted(theme, line)).join('\n'), 0, 0);
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerLspTool(pi: ExtensionAPI, mgr: ServerManagerService) {
  pi.registerTool({
    name: 'lsp',
    label: 'LSP',
    description: [
      'Interact with Language Server Protocol servers for code intelligence.',
      '',
      'Supported operations:',
      '  goToDefinition    — find where a symbol is defined',
      '  findReferences    — find all references to a symbol',
      '  hover             — get type info and documentation for a symbol',
      '  diagnostics       — get type errors and lint warnings for a file',
      '  documentSymbol    — get all symbols in a file (with line:column positions)',
      '  workspaceSymbol   — search for symbols across the workspace',
      '  goToImplementation — find implementations of an interface/abstract method',
      '  prepareCallHierarchy — get call hierarchy item at a position',
      '  incomingCalls     — find callers of a function/method (auto-prepares hierarchy)',
      '  outgoingCalls     — find callees of a function/method (auto-prepares hierarchy)',
      '  codeActions       — get quick fixes and refactoring suggestions',
      '',
      'Parameters:',
      '  operation (required) — one of the operations above',
      '  filePath  — file path relative to project root (required for most operations)',
      '  line      — line number, 1-indexed (required for position-based operations)',
      '  character — column number, 1-indexed (required for position-based operations)',
      '  query     — search string (required for workspaceSymbol)',
      '',
      'Tips:',
      '  — Position the character in the middle of the symbol name for best results.',
      '  — Use hover before goToDefinition to quickly check signatures and docs.',
      '  — workspaceSymbol may need a retry if the server is still indexing.',
    ].join('\n'),
    promptSnippet:
      'Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions',
    promptGuidelines: [
      'lsp line and character params are 1-indexed — use the values from the read tool or rg output directly.',
      'lsp `hover` is the fastest way to get a function signature, type params, and doc comment — prefer it over `goToDefinition` for quick type inspection.',
      'lsp `documentSymbol` returns line:column positions for each symbol — use those values directly for follow-up lsp operations.',
      'For lsp position-based operations, place the character in the **middle** of the symbol name, not at the first character.',
      'lsp `incomingCalls` and `outgoingCalls` automatically prepare the call hierarchy — no need to call `prepareCallHierarchy` first.',
      'lsp `workspaceSymbol` may return empty results while the LSP server is still indexing. If it returns nothing, wait a few seconds and retry.',
      'lsp `diagnostics` relies on server-pushed notifications which may be slow for some servers. For compiled languages (Rust, Go, C++), prefer running the compiler directly (e.g. `cargo check`, `go build`) for reliable error checking.',
      'Use lsp for type info, macro-generated symbols, and cross-module navigation. Use rg for simple text search and file discovery — it is faster and needs no server.',
      'lsp servers are auto-detected by file extension. Use /lsp to check status.',
    ],
    parameters: Type.Object({
      operation: StringEnum(LSP_OPERATIONS),
      filePath: Type.Optional(Type.String({ description: 'File path relative to project root' })),
      line: Type.Optional(Type.Number({ description: 'Line number (1-indexed)' })),
      character: Type.Optional(Type.Number({ description: 'Column number (1-indexed)' })),
      query: Type.Optional(Type.String({ description: 'Search query (for workspaceSymbol)' })),
    }),
    renderCall(args, theme) {
      return renderLspCall(args as Partial<LspToolParams>, theme);
    },
    renderResult(result, options, theme, context) {
      return renderLspResult(result as LspToolResult | undefined, options || {}, theme, context);
    },
    async execute(_toolCallId, params) {
      const program = lspToolProgram(params as LspToolParams);
      return Effect.runPromise(
        program.pipe(Effect.provideService(ServerManager, mgr), Effect.mapError(toNativeError)),
      );
    },
  });
}

export type { LspOperation };
