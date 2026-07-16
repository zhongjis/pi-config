import { describe, expect, it, vi } from 'vitest';

import { registerLspTool, type ServerManagerService } from '../tools';

type RenderableText = { render?: () => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolDefinition = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: PlainTheme, context?: unknown) => RenderableText;
  renderResult?: (
    result: { content?: Array<{ type: 'text'; text: string }>; details?: Record<string, unknown>; isError?: boolean },
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
};

const plainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText): string {
  if (typeof component.render === 'function') return component.render().join('\n');
  return component.text ?? '';
}

function registerTool(): ToolDefinition {
  let registered: ToolDefinition | undefined;
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
  };

  registerLspTool(pi as never, {} as ServerManagerService);
  expect(registered).toBeDefined();
  return registered!;
}

function collapsed(
  tool: ToolDefinition,
  text: string,
  args: Record<string, unknown> = {},
  extra: { isError?: boolean; isPartial?: boolean } = {},
): string {
  return renderText(
    tool.renderResult!(
      { content: [{ type: 'text', text }], details: {}, isError: extra.isError },
      { expanded: false, isPartial: extra.isPartial },
      plainTheme,
      { args, isError: extra.isError },
    ),
  );
}

describe('lsp tool rendering', () => {
  it('renders first-glance calls with full tool name and compact target', () => {
    const tool = registerTool();

    const text = renderText(
      tool.renderCall!(
        { operation: 'hover', filePath: 'extensions/lsp/tools.ts', line: 81, character: 23 },
        plainTheme,
      ),
    );

    expect(text).toBe('▸ lsp · hover · extensions/lsp/tools.ts:81:23');
  });

  it('renders expanded raw output without changing content', () => {
    const tool = registerTool();
    const raw = 'Hover at extensions/lsp/tools.ts:81:23:\n\n```typescript\nfunction example(): void\n```';
    const result = { content: [{ type: 'text' as const, text: raw }], details: {} };

    const expanded = renderText(
      tool.renderResult!(result, { expanded: true, isPartial: false }, plainTheme, {
        args: { operation: 'hover' },
      }),
    );

    expect(expanded).toBe(raw);
    expect(result.content[0].text).toBe(raw);
  });

  it('keeps collapsed hover output glanceable and always shows expand hint', () => {
    const tool = registerTool();
    const raw = 'Hover at extensions/lsp/tools.ts:81:23:\n\n```typescript\n(alias) lspToolProgram(raw: LspToolParams): Effect.Effect<ToolResult, LspExtensionError, ServerManager>\nimport lspToolProgram\n```';

    const text = collapsed(tool, raw, {
      operation: 'hover',
      filePath: 'extensions/lsp/tools.ts',
      line: 81,
      character: 23,
    });

    expect(text).not.toContain('▸ lsp');
    expect(text).toContain('├─ hover: (alias) lspToolProgram(raw: LspToolParams): Effect.Effect<ToolResult, LspExtensionError, ServerManager>');
    expect(text).toContain('└─ app.tools.expand to expand full result');
    expect(text).not.toContain('import lspToolProgram');
  });

  it('summarizes diagnostics and server failures concisely', () => {
    const tool = registerTool();

    const clean = collapsed(tool, 'extensions/lsp/types.ts: No diagnostics — all clean ✓', {
      operation: 'diagnostics',
      filePath: 'extensions/lsp/types.ts',
    });
    expect(clean).toContain('├─ diagnostics: clean');

    const problems = renderText(
      tool.renderResult!(
        {
          content: [{ type: 'text', text: 'Diagnostics for src/app.ts: 2 errors, 1 warning\n\n── tsserver ──\n1. ERROR line 1:1-2\n   broken' }],
          details: { errors: ['eslint: crashed'] },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        { args: { operation: 'diagnostics', filePath: 'src/app.ts' } },
      ),
    );
    expect(problems).toContain('├─ diagnostics: 2 errors, 1 warning · 1 server failure');
  });

  it('summarizes operation outputs as one glance line plus ctrl+o', () => {
    const tool = registerTool();

    expect(collapsed(tool, 'References for symbol at extensions/lsp/tools.ts:81:23 (3 results):\n\n1. extensions/lsp/tools.ts:16:3\n2. extensions/lsp/tools.ts:81:23\n3. extensions/lsp/tools/programs.ts:138:17', { operation: 'findReferences' }))
      .toContain('├─ references: 3 · extensions/lsp/tools.ts:16:3, extensions/lsp/tools.ts:81:23, extensions/lsp/tools/programs.ts:138:17');

    expect(collapsed(tool, 'Symbols in extensions/lsp/tools/programs.ts (14 top-level):\n\ncall (function) line 107:10\nCAPABILITY_MAP (constant) line 73:7\ncleanPath (function) line 89:10', { operation: 'documentSymbol' }))
      .toContain('├─ symbols: 14 · call, CAPABILITY_MAP, cleanPath +11');

    expect(collapsed(tool, 'Workspace symbols matching "clientsForFile" (2):\n\n1. clientsForFile (property) extensions/lsp/tools/programs.ts:44:3\n2. clientsForFile (method) extensions/lsp/index.ts:83:5', { operation: 'workspaceSymbol', query: 'clientsForFile' }))
      .toContain('├─ symbols: 2 workspace · clientsForFile, clientsForFile');

    expect(collapsed(tool, 'No workspace symbols matching "registerLspTool"', { operation: 'workspaceSymbol', query: 'registerLspTool' }))
      .toContain('├─ symbols: no workspace matches');

    const outgoing = collapsed(tool, 'Outgoing calls from lspToolProgram (4):\n\n1. registerTool (method) node_modules/pkg/index.d.ts:1\n2. validate (function) extensions/lsp/tools/programs.ts:118\n3. cleanPath (function) extensions/lsp/tools/programs.ts:89\n4. hover (method) extensions/lsp/client.ts:402', { operation: 'outgoingCalls' });
    expect(outgoing).toContain('├─ outgoing: 4 · validate, cleanPath, hover +1');
    expect(outgoing).not.toContain('registerTool');

    expect(collapsed(tool, 'Code actions at extensions/lsp/tools.ts:28 (4 available):\n\n1. Convert named export to default export [refactor.rewrite.export.default]\n\n2. Move to a new file [refactor.move.newFile]', { operation: 'codeActions' }))
      .toContain('├─ actions: 4 · Convert named export to default export, Move to a new file +2');
  });

  it('renders partial and error states safely', () => {
    const tool = registerTool();

    const partial = renderText(
      tool.renderResult!({ content: [] }, { expanded: false, isPartial: true }, plainTheme, {
        args: { operation: 'workspaceSymbol', query: 'Foo' },
      }),
    );
    expect(partial).toContain('├─ status: running workspaceSymbol');
    expect(partial).toContain('└─ app.tools.expand to expand full result');

    const error = collapsed(
      tool,
      'LSP codeActions (typescript) failed: LSP error 1: <semantic> TypeScript Server Error (5.9.3)\nstack hidden',
      { operation: 'codeActions' },
      { isError: true },
    );
    expect(error).toContain('├─ error: TypeScript Server Error (5.9.3)');
    expect(error).toContain('└─ app.tools.expand to expand full result');
  });
});
