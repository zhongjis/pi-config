import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DIAGNOSTICS_QUIET_MS, DIAGNOSTICS_SETTLE_MS, LspClient } from '../client';
import type { Diagnostic } from '../types';

// Minimal LSP server: publishes per-change diagnostics chosen by marker text.
//   LATE   → empty, then one error when test/release arrives (the "empty-then-real" race)
//   STALE  → one error for the previous version, then empty for the current one
//   SILENT → nothing for the file; a separate URI acknowledges receipt
//   other  → empty, without a version
const fakeServerScript = `
let buffer = Buffer.alloc(0);
let release;
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
};
const publish = (uri, diagnostics, version) =>
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics, version } });
const error = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'late error' };
function handle(msg) {
  if (msg.method === 'test/release') return release();
  if (msg.method === 'initialize') return send({ id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
  if (msg.method === 'shutdown') return send({ id: msg.id, result: null });
  if (msg.method === 'exit') return process.exit(0);
  if (msg.method === 'textDocument/didOpen') return publish(msg.params.textDocument.uri, []);
  if (msg.method !== 'textDocument/didChange') return;
  const { uri, version } = msg.params.textDocument;
  const text = msg.params.contentChanges[0].text;
  if (text.includes('LATE')) {
    release = () => publish(uri, [error]);
    publish(uri, []);
  } else if (text.includes('STALE')) {
    publish(uri, [error], version - 1);
    publish(uri, [], version);
  } else if (text.includes('SILENT')) {
    publish(uri + '.ack', []);
  } else {
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    try {
      await client.shutdown();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function change(text: string) {
    writeFileSync(join(root, 'a.ts'), text);
    return client.getDiagnostics('a.ts', TIMEOUT_MS);
  }

  function nextPublish(filePath = 'a.ts'): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      const unsubscribe = client.onDiagnostics(filePath, (diagnostics) => {
        unsubscribe();
        resolve(diagnostics);
      });
    });
  }

  it('accepts an empty publish once it settles instead of waiting for the timeout', async () => {
    const published = nextPublish();
    let finalized = false;
    const result = change('still clean\n').then((diagnostics) => {
      finalized = true;
      return diagnostics;
    });
    expect(await published).toEqual([]);

    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS - 1);
    expect(finalized).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(finalized).toBe(true);
    expect(await result).toEqual([]);
  });

  it('reports errors that follow an empty publish within the settle window', async () => {
    const empty = nextPublish();
    let finalized = false;
    const result = change('LATE\n').then((diagnostics) => {
      finalized = true;
      return diagnostics;
    });
    expect(await empty).toEqual([]);
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS - 1);
    expect(finalized).toBe(false);

    const errors = nextPublish();
    client['connection'].sendNotification('test/release', null);
    expect((await errors).map((d) => d.message)).toEqual(['late error']);
    expect((await result).map((d) => d.message)).toEqual(['late error']);
  });

  it('treats silence after a change to a clean file as still clean', async () => {
    const received = nextPublish('a.ts.ack');
    const seen: Diagnostic[][] = [];
    const unsubscribe = client.onDiagnostics('a.ts', (diagnostics) => seen.push(diagnostics));
    let finalized = false;
    const result = change('SILENT\n').then((diagnostics) => {
      finalized = true;
      return diagnostics;
    });
    await received;

    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_QUIET_MS - 1);
    expect(finalized).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(finalized).toBe(true);
    expect(await result).toEqual([]);
    expect(seen).toEqual([]);
    unsubscribe();
  });

  it('ignores stale-version diagnostics and trusts a current-version empty publish', async () => {
    const published = nextPublish();
    const seen: Diagnostic[][] = [];
    const unsubscribe = client.onDiagnostics('a.ts', (diagnostics) => seen.push(diagnostics));
    const result = change('STALE\n');
    expect(await published).toEqual([]);
    expect(await result).toEqual([]);
    expect(seen).toEqual([[]]);
    unsubscribe();
  });

  it('notifies diagnostics listeners of every accepted publish until unsubscribed', async () => {
    const seen: string[][] = [];
    const unsubscribe = client.onDiagnostics('a.ts', (d) => seen.push(d.map((x) => x.message)));
    const empty = nextPublish();
    const result = change('LATE\n');
    await empty;
    const errors = nextPublish();
    client['connection'].sendNotification('test/release', null);
    await errors;
    expect((await result).map((d) => d.message)).toEqual(['late error']);
    expect(seen).toEqual([[], ['late error']]);

    unsubscribe();
    const published = nextPublish();
    const clean = change('still clean\n');
    expect(await published).toEqual([]);
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS);
    expect(await clean).toEqual([]);
    expect(seen).toHaveLength(2);
  });
});
