import { describe, expect, it } from 'vitest';

import type { LspClient } from '../client';
import { editDiagnostics, EDIT_HOOK_MAX_ERRORS } from '../edit-hook';
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

describe('editDiagnostics', () => {
  it('returns null for a clean file and ignores non-error severities', async () => {
    const client = makeClient('ts', async () => [diag(0, DiagnosticSeverity.Warning)]);
    await expect(editDiagnostics([client], 'a.ts')).resolves.toBeNull();
  });

  it('reports only errors', async () => {
    const client = makeClient('ts', async () => [
      diag(0, DiagnosticSeverity.Warning, 'unused'),
      diag(2, DiagnosticSeverity.Error, "Type 'string' is not assignable"),
    ]);
    const text = await editDiagnostics([client], 'a.ts');
    expect(text).toContain('LSP Diagnostics for a.ts: 1 error');
    expect(text).toContain("Type 'string' is not assignable");
    expect(text).not.toContain('unused');
  });

  it('caps errors across servers and counts the rest', async () => {
    const many = Array.from({ length: EDIT_HOOK_MAX_ERRORS }, (_, i) =>
      diag(i, DiagnosticSeverity.Error),
    );
    const text = await editDiagnostics(
      [
        makeClient('a', async () => many),
        makeClient('b', async () => [diag(50, DiagnosticSeverity.Error), diag(51, DiagnosticSeverity.Error)]),
      ],
      'a.ts',
    );
    expect(text).toContain('problem 9');
    expect(text).not.toContain('problem 50');
    expect(text).toContain('+2 more errors');
  });

  it('keeps results from healthy servers when one fails', async () => {
    const text = await editDiagnostics(
      [
        makeClient('broken', async () => {
          throw new Error('spawn failed');
        }),
        makeClient('ok', async () => [diag(0, DiagnosticSeverity.Error, 'real error')]),
      ],
      'a.ts',
    );
    expect(text).toContain('real error');
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
