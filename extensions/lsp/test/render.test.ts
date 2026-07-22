import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-tui', async () =>
  import('../../../node_modules/@earendil-works/pi-tui/dist/index.js'),
);

import { registerLspTool, type ServerManagerService } from '../tools';

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolDefinition = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: PlainTheme, context?: unknown) => RenderableText;
  renderResult?: (
    result: { content?: readonly unknown[]; details?: unknown; isError?: boolean },
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
};

const plainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText, width = 120): string {
  if (typeof component.render === 'function') return component.render(width).join('\n');
  return component.text ?? '';
}

function expectWidthSafe(component: RenderableText): void {
  expect(component.render).toBeTypeOf('function');
  for (const width of [20, 40, 80, 120]) {
    for (const line of component.render!(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
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
  it('renders operation, decisive target, and active project in calls', () => {
    const tool = registerTool();
    const positioned = tool.renderCall!(
      { operation: 'hover', filePath: 'extensions/lsp/界面.ts', line: 81, character: 23 },
      plainTheme,
    );
    const queried = tool.renderCall!(
      { operation: 'workspaceSymbol', query: '\u001b[36mclientsForFile\u001b[0m' },
      plainTheme,
    );

    expect(renderText(positioned)).toContain('▸ lsp · op: hover · path: extensions/lsp/界面.ts:81:23 · project: active');
    expect(renderText(queried)).toContain('op: workspaceSymbol · query: "');
    expect(renderText(queried)).toContain('project: active');
    expectWidthSafe(positioned);
    expectWidthSafe(queried);
  });

  it('preserves frozen raw expansion and handles malformed owner output', () => {
    const tool = registerTool();
    const raw = '\u001b[32m悬停结果\u001b[0m\n\n```typescript\nfunction example(): void\n```';
    const content = Object.freeze([{ type: 'text' as const, text: raw }]);
    const result = Object.freeze({ content, details: Object.freeze({ broken: true }) });
    const expanded = tool.renderResult!(result, { expanded: true }, plainTheme, { args: { operation: 'hover' } });

    expect(expanded.text).toBe(raw);
    expect(result.content[0].text).toBe(raw);
    expectWidthSafe(expanded);

    const malformed = collapsed(tool, 'unexpected LSP owner output\nopaque detail', { operation: 'hover' });
    expect(malformed).toContain('result: unexpected LSP owner output');
  });

  it('summarizes diagnostics and query outputs with terminal state, counts, and highlights', () => {
    const tool = registerTool();
    const clean = collapsed(tool, 'extensions/lsp/types.ts: No diagnostics — all clean ✓', {
      operation: 'diagnostics',
      filePath: 'extensions/lsp/types.ts',
    });
    expect(clean).toContain('status: complete');
    expect(clean).toContain('diagnostics: clean');

    const problems = renderText(
      tool.renderResult!(
        {
          content: [{ type: 'text', text: 'Diagnostics for src/app.ts: 2 errors, 1 warning\n\n── tsserver ──\n1. ERROR line 1:1-2\n   broken' }],
          details: { errors: ['eslint: crashed'] },
        },
        { expanded: false },
        plainTheme,
        { args: { operation: 'diagnostics', filePath: 'src/app.ts' } },
      ),
    );
    expect(problems).toContain('diagnostics: 2 errors, 1 warning · 1 server failure');

    expect(collapsed(tool, 'References for symbol at extensions/lsp/tools.ts:81:23 (3 results):\n\n1. extensions/lsp/tools.ts:16:3\n2. extensions/lsp/tools.ts:81:23\n3. extensions/lsp/tools/programs.ts:138:17', { operation: 'findReferences' }))
      .toContain('references: 3 · extensions/lsp/tools.ts:16:3, extensions/lsp/tools.ts:81:23, extensions/lsp/tools/programs.ts:138:17');
    expect(collapsed(tool, 'Workspace symbols matching "clientsForFile" (2):\n\n1. clientsForFile (property) extensions/lsp/tools/programs.ts:44:3\n2. clientsForFile (method) extensions/lsp/index.ts:83:5', { operation: 'workspaceSymbol' }))
      .toContain('symbols: 2 workspace · clientsForFile, clientsForFile');
    expect(collapsed(tool, 'Outgoing calls from lspToolProgram (4):\n\n1. registerTool (method) node_modules/pkg/index.d.ts:1\n2. validate (function) extensions/lsp/tools/programs.ts:118\n3. cleanPath (function) extensions/lsp/tools/programs.ts:89\n4. hover (method) extensions/lsp/client.ts:402', { operation: 'outgoingCalls' }))
      .toContain('outgoing: 4 · validate, cleanPath, hover +1');
  });

  it('renders operation-specific partial analysis and decisive errors', () => {
    const tool = registerTool();
    const indexing = tool.renderResult!(
      { content: [] },
      { expanded: false, isPartial: true },
      plainTheme,
      { args: { operation: 'workspaceSymbol', query: 'Foo' } },
    );
    expect(renderText(indexing)).toContain('status: running · workspace indexing');

    const analysis = tool.renderResult!(
      { content: [] },
      { expanded: false, isPartial: true },
      plainTheme,
      { args: { operation: 'hover', filePath: 'src/app.ts' } },
    );
    expect(renderText(analysis)).toContain('status: running · hover analysis');

    const error = collapsed(
      tool,
      'LSP codeActions (typescript) failed: LSP error 1: <semantic> TypeScript Server Error (5.9.3)\nstack hidden',
      { operation: 'codeActions' },
      { isError: true },
    );
    expect(error).toContain('error: TypeScript Server Error (5.9.3)');
    expect(error).not.toContain('stack hidden');
  });

  it('keeps ANSI/CJK output safe at 20/40/80/120 columns', () => {
    const tool = registerTool();
    const result = tool.renderResult!(
      { content: [{ type: 'text', text: 'Workspace symbols matching "界面" (2):\n\n1. \u001b[31m界面组件超长名称\u001b[0m (property) src/app.ts:44:3\n2. 客户端界面 (method) src/index.ts:83:5' }] },
      { expanded: false },
      plainTheme,
      { args: { operation: 'workspaceSymbol', query: '界面' } },
    );
    expectWidthSafe(result);
  });
});
