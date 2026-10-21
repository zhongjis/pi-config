/**
 * Diagnostics appended to successful `edit`/`write` results.
 *
 * Errors only, for the changed file only, capped so a broken file cannot flood
 * the context. A timeout or a partial server failure yields what is available;
 * rejects only when every server failed.
 */

import type { LspClient } from './client';
import { formatDiagnostics } from './formatting';
import { DiagnosticSeverity } from './types';

export const EDIT_HOOK_TOOLS = new Set(['edit', 'write']);
// ponytail: fixed budget; make it per-server if a slow server needs more.
export const EDIT_HOOK_TIMEOUT_MS = 3_000;
export const EDIT_HOOK_MAX_ERRORS = 10;

export async function editDiagnostics(
  clients: LspClient[],
  filePath: string,
  timeoutMs = EDIT_HOOK_TIMEOUT_MS,
): Promise<string | null> {
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
      source: client.config?.name ?? 'lsp',
      diagnostics: (await withDeadline(client)).filter(
        (d) => d.severity === DiagnosticSeverity.Error,
      ),
    })),
  );
  const groups = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failure = results.find((r) => r.status === 'rejected');
  if (groups.length === 0 && failure) throw failure.reason;
  const total = groups.reduce((n, g) => n + g.diagnostics.length, 0);
  if (total === 0) return null;

  let budget = EDIT_HOOK_MAX_ERRORS;
  const shown = groups.map((g) => {
    const diagnostics = g.diagnostics.slice(0, budget);
    budget -= diagnostics.length;
    return { source: g.source, diagnostics };
  });
  const more = total - EDIT_HOOK_MAX_ERRORS;
  return `LSP ${formatDiagnostics(filePath, shown)}${more > 0 ? `\n\n+${more} more error${more !== 1 ? 's' : ''}` : ''}`;
}
