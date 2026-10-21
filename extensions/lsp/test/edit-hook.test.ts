import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { LspClient } from '../client';
import {
  editDiagnostics,
  EDIT_HOOK_MAX_ERRORS,
  type LspErrorReport,
  watchLateErrors,
  withLspRow,
} from '../edit-hook';
import { DiagnosticSeverity, type Diagnostic } from '../types';

function diag(line: number, severity: DiagnosticSeverity, message = `problem ${line}`): Diagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    severity,
    message,
  };
}

function makeClient(name: string, getDiagnostics: () => Promise<Diagnostic[]>): LspClient {
  return { config: { name }, getDiagnostics } as unknown as LspClient;
}

/** A client whose publishes the test drives through `publish`. */
function makeWatchedClient(name: string) {
  const listeners = new Set<(d: Diagnostic[]) => void>();
  const client = {
    config: { name },
    onDiagnostics: (_path: string, listener: (d: Diagnostic[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as LspClient;
  const publish = (d: Diagnostic[]) => {
    for (const listener of [...listeners]) listener(d);
  };
  return { client, listeners, publish };
}

describe('editDiagnostics', () => {
  it('returns null for a clean file and ignores non-error severities', async () => {
    const client = makeClient('ts', async () => [diag(0, DiagnosticSeverity.Warning)]);
    await expect(editDiagnostics([client], 'a.ts')).resolves.toBeNull();
  });

  it('reports only errors, with one-line summaries for the TUI', async () => {
    const client = makeClient('ts', async () => [
      diag(0, DiagnosticSeverity.Warning, 'unused'),
      { ...diag(2, DiagnosticSeverity.Error, "Type 'string' is not assignable\nmore"), code: 2322 },
    ]);
    const report = await editDiagnostics([client], 'a.ts');
    expect(report?.text).toContain('LSP Diagnostics for a.ts: 1 error');
    expect(report?.text).toContain("Type 'string' is not assignable");
    expect(report?.text).not.toContain('unused');
    expect(report?.errors).toBe(1);
    expect(report?.lines).toEqual(["L3 (2322) Type 'string' is not assignable"]);
  });

  it('caps errors across servers and counts the rest', async () => {
    const many = Array.from({ length: EDIT_HOOK_MAX_ERRORS }, (_, i) =>
      diag(i, DiagnosticSeverity.Error),
    );
    const report = await editDiagnostics(
      [
        makeClient('a', async () => many),
        makeClient('b', async () => [diag(50, DiagnosticSeverity.Error), diag(51, DiagnosticSeverity.Error)]),
      ],
      'a.ts',
    );
    expect(report?.text).toContain('problem 9');
    expect(report?.text).not.toContain('problem 50');
    expect(report?.text).toContain('+2 more errors');
    expect(report?.errors).toBe(EDIT_HOOK_MAX_ERRORS + 2);
    expect(report?.lines).toHaveLength(EDIT_HOOK_MAX_ERRORS);
  });

  it('keeps results from healthy servers when one fails', async () => {
    const report = await editDiagnostics(
      [
        makeClient('broken', async () => {
          throw new Error('spawn failed');
        }),
        makeClient('ok', async () => [diag(0, DiagnosticSeverity.Error, 'real error')]),
      ],
      'a.ts',
    );
    expect(report?.text).toContain('real error');
  });

  it('gives up on a server that never answers within the deadline', async () => {
    const hanging = makeClient('cold', () => new Promise<Diagnostic[]>(() => {}));
    await expect(editDiagnostics([hanging], 'a.ts', 20)).resolves.toBeNull();
  });

  it('rejects when every server failed', async () => {
    const client = makeClient('broken', async () => {
      throw new Error('spawn failed');
    });
    await expect(editDiagnostics([client], 'a.ts')).rejects.toThrow('spawn failed');
  });
});

describe('watchLateErrors', () => {
  it('reports the first publish with errors once, ignoring clean and warning-only publishes', () => {
    const server = makeWatchedClient('ts');
    const onErrors = vi.fn<(report: LspErrorReport) => void>();
    watchLateErrors([server.client], 'a.ts', onErrors);

    server.publish([]);
    server.publish([diag(0, DiagnosticSeverity.Warning)]);
    expect(onErrors).not.toHaveBeenCalled();

    server.publish([diag(1, DiagnosticSeverity.Error, 'late')]);
    server.publish([diag(2, DiagnosticSeverity.Error, 'again')]);
    expect(onErrors).toHaveBeenCalledOnce();
    expect(onErrors.mock.calls[0][0]).toMatchObject({ errors: 1, lines: ['L2 late'] });
    expect(server.listeners.size).toBe(0);
  });

  it('stops on cancel (a new edit) and when the window ends', () => {
    vi.useFakeTimers();
    try {
      const cancelled = makeWatchedClient('ts');
      const onCancelled = vi.fn();
      watchLateErrors([cancelled.client], 'a.ts', onCancelled)();
      cancelled.publish([diag(0, DiagnosticSeverity.Error)]);
      expect(onCancelled).not.toHaveBeenCalled();
      expect(cancelled.listeners.size).toBe(0);

      const expired = makeWatchedClient('ts');
      const onExpired = vi.fn();
      watchLateErrors([expired.client], 'a.ts', onExpired, 1_000);
      vi.advanceTimersByTime(1_000);
      expired.publish([diag(0, DiagnosticSeverity.Error)]);
      expect(onExpired).not.toHaveBeenCalled();
      expect(expired.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withLspRow', () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  type Renderers = Parameters<typeof withLspRow>[0];
  type RenderArgs = Parameters<NonNullable<Renderers['renderResult']>>;

  function setup() {
    const innerComponent = { render: () => ['diff line'], invalidate: vi.fn() };
    const renderResult = vi.fn(() => innerComponent);
    const wrapped = withLspRow({ renderResult } as unknown as Renderers);
    const state: Record<string, unknown> = {};
    const render = (details: unknown, expanded = false, lastComponent?: unknown, outputPad?: number) =>
      wrapped.renderResult!(
        ...([
          { content: [], details },
          { expanded, isPartial: false },
          theme,
          { state, lastComponent, outputPad },
        ] as unknown as RenderArgs),
      );
    return { innerComponent, renderResult, render };
  }

  it('passes results without details.lsp through unchanged', () => {
    const { innerComponent, render } = setup();
    expect(render({ diff: 'x' })).toBe(innerComponent);
  });

  it('appends one collapsed row, and every error when expanded', () => {
    const { render } = setup();
    const lsp = { errors: 12, lines: ['L2 (2322) bad', 'L5 worse'] };
    expect(render({ diff: 'x', lsp }).render(120)).toEqual(['diff line', '└─ ⚠ LSP 12 errors · L2 (2322) bad']);
    expect(render({ diff: 'x', lsp }, true).render(120)).toEqual([
      'diff line',
      '├─ ⚠ LSP 12 errors',
      '├─ L2 (2322) bad',
      '├─ L5 worse',
      '└─ +10 more',
    ]);
  });

  it('indents the row by outputPad to line up with the padded diff', () => {
    const { render } = setup();
    const lines = render({ lsp: { errors: 1, lines: ['L1 x'] } }, false, undefined, 1).render(40);
    expect(lines).toEqual(['diff line', ' └─ ⚠ LSP 1 error · L1 x']);
  });

  it('keeps the padded row within every width', () => {
    const { render } = setup();
    const component = render({ lsp: { errors: 1, lines: ['L1 a long error message'] } }, false, undefined, 1);
    for (const width of [0, 1, 2, 40]) {
      const rowLines = component.render(width).slice(1);
      for (const line of rowLines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("hands the inner renderer its own previous component, not the wrapper", () => {
    const { innerComponent, renderResult, render } = setup();
    const wrapper = render({ lsp: { errors: 1, lines: ['L1 x'] } });
    render({ lsp: { errors: 1, lines: ['L1 x'] } }, false, wrapper);
    const secondContext = (renderResult.mock.calls[1] as unknown[])[3] as { lastComponent: unknown };
    expect(secondContext.lastComponent).toBe(innerComponent);
  });
});
