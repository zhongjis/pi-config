import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { LspClient } from '../client';
import { lspToolProgram, ServerManager, type ServerManagerService } from '../tools/programs';
import type { Diagnostic } from '../types';

function makeClient(name: string, getDiagnostics: () => Promise<Diagnostic[]>): LspClient {
  return { config: { name }, getDiagnostics } as unknown as LspClient;
}

function makeManager(clients: LspClient[]): ServerManagerService {
  return {
    clientsForFile: () => clients,
    clientForFileWithCapability: () => null,
    anyClient: () => null,
    getRootPath: () => '/repo',
  };
}

function diagnosticsProgram(mgr: ServerManagerService) {
  return lspToolProgram({ operation: 'diagnostics', filePath: 'src/app.ts' }).pipe(
    Effect.provideService(ServerManager, mgr),
  );
}

function runDiagnostics(mgr: ServerManagerService) {
  return Effect.runPromise(diagnosticsProgram(mgr));
}

function runDiagnosticsEither(mgr: ServerManagerService) {
  return Effect.runPromise(diagnosticsProgram(mgr).pipe(Effect.either));
}

describe('diagnostics tool error handling', () => {
  it('returns typed no-capable-server error when no server matches', async () => {
    await expect(runDiagnosticsEither(makeManager([]))).resolves.toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'NoCapableServerError',
        operation: 'diagnostics',
        filePath: 'src/app.ts',
      },
    });
  });

  it('returns typed operation error when all matched servers fail', async () => {
    const mgr = makeManager([
      makeClient('ts-a', async () => {
        throw new Error('server A failed');
      }),
      makeClient('ts-b', async () => {
        throw new Error('server B failed');
      }),
    ]);

    await expect(runDiagnosticsEither(mgr)).resolves.toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'LspOperationError',
        operation: 'diagnostics',
      },
    });
  });

  it('does not report all-clean when some servers fail and successful servers have no diagnostics', async () => {
    const mgr = makeManager([
      makeClient('ts-good', async () => []),
      makeClient('ts-bad', async () => {
        throw new Error('server crashed');
      }),
    ]);

    const result = await runDiagnostics(mgr);
    const text = result.content[0].text;

    expect(text).toContain('src/app.ts: No diagnostics from successful server(s): ts-good');
    expect(text).toContain('Note: ts-bad: LSP diagnostics (ts-bad) failed: server crashed');
    expect(text).not.toContain('No diagnostics — all clean');
    expect(result.details.groups).toEqual([{ source: 'ts-good', count: 0 }]);
    expect(result.details.errors).toHaveLength(1);
  });
});
