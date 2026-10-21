import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIAGNOSTICS_QUIET_MS, DIAGNOSTICS_SETTLE_MS, LspClient } from '../client';

// Minimal LSP server: publishes per-change diagnostics chosen by marker text.
//   LATE   → empty, then one error 100ms later (the "empty-then-real" race)
//   STALE  → one error for the previous version, then empty for the current one
//   SILENT → nothing (typescript-language-server skips empty-to-empty publishes)
//   other  → empty, without a version
const fakeServerScript = `
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
};
const publish = (uri, diagnostics, version) =>
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics, version } });
const error = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'late error' };
function handle(msg) {
  if (msg.method === 'initialize') return send({ id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
  if (msg.method === 'shutdown') return send({ id: msg.id, result: null });
  if (msg.method === 'exit') return process.exit(0);
  if (msg.method === 'textDocument/didOpen') return publish(msg.params.textDocument.uri, []);
  if (msg.method !== 'textDocument/didChange') return;
  const { uri, version } = msg.params.textDocument;
  const text = msg.params.contentChanges[0].text;
  if (text.includes('LATE')) {
    publish(uri, []);
    setTimeout(() => publish(uri, [error]), 100);
  } else if (text.includes('STALE')) {
    publish(uri, [error], version - 1);
    publish(uri, [], version);
  } else if (!text.includes('SILENT')) {
    publish(uri, []);
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) return;
    const length = Number(buffer.subarray(0, headerEnd).toString('ascii').match(/Content-Length:\\s*(\\d+)/i)[1]);
    const bodyEnd = headerEnd + 4 + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.subarray(headerEnd + 4, bodyEnd).toString('utf8');
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
});
`;

const TIMEOUT_MS = 5_000;

describe('LspClient diagnostics settling after a change', () => {
  let root: string;
  let client: LspClient;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lsp-settle-'));
    client = new LspClient(
      {
        name: 'fake',
        command: process.execPath,
        args: ['-e', fakeServerScript],
        extensions: ['.ts'],
        env: {},
        initializationOptions: {},
      },
      root,
    );
    writeFileSync(join(root, 'a.ts'), 'clean\n');
    await expect(client.getDiagnostics('a.ts', TIMEOUT_MS)).resolves.toEqual([]);
  });

  afterEach(async () => {
    await client.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  async function change(text: string) {
    writeFileSync(join(root, 'a.ts'), text);
    const started = Date.now();
    const diagnostics = await client.getDiagnostics('a.ts', TIMEOUT_MS);
    return { diagnostics, elapsed: Date.now() - started };
  }

  it('accepts an empty publish once it settles instead of waiting for the timeout', async () => {
    const { diagnostics, elapsed } = await change('still clean\n');
    expect(diagnostics).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(DIAGNOSTICS_SETTLE_MS - 50);
    expect(elapsed).toBeLessThan(TIMEOUT_MS / 2);
  });

  it('reports errors that follow an empty publish within the settle window', async () => {
    const { diagnostics } = await change('LATE\n');
    expect(diagnostics.map((d) => d.message)).toEqual(['late error']);
  });

  it('treats silence after a change to a clean file as still clean', async () => {
    const { diagnostics, elapsed } = await change('SILENT\n');
    expect(diagnostics).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(DIAGNOSTICS_QUIET_MS - 50);
    expect(elapsed).toBeLessThan(TIMEOUT_MS / 2);
  });

  it('ignores stale-version diagnostics and trusts a current-version empty publish', async () => {
    const { diagnostics, elapsed } = await change('STALE\n');
    expect(diagnostics).toEqual([]);
    expect(elapsed).toBeLessThan(DIAGNOSTICS_SETTLE_MS);
  });
});
