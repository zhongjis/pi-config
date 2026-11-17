import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LspClient } from '../client';

// Minimal LSP server whose hover answers with its own pid.
const fakeServerScript = `
let buffer = Buffer.alloc(0);
const held = [];
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
};
function handle(msg) {
  if (msg.method === 'test/release') return reply(held.shift());
  if (msg.method === process.env.HOLD_METHOD) {
    held.push(msg);
    const uri = msg.params.textDocument?.uri ?? msg.params.rootUri + '/a.ts';
    return send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
  }
  reply(msg);
}
function reply(msg) {
  if (msg.method === 'initialize') return send({ id: msg.id, result: { capabilities: { hoverProvider: true } } });
  if (msg.method === 'shutdown') return send({ id: msg.id, result: null });
  if (msg.method === 'exit') return process.exit(0);
  if (msg.method === 'textDocument/hover') return send({ id: msg.id, result: { contents: String(process.pid) } });
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

const IDLE_MS = 150;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

describe('LspClient idle suspend', () => {
  let root: string;
  let client: LspClient;

  const serverPid = async () =>
    Number((await client.hover('a.ts', { line: 0, character: 0 }))?.contents);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    root = mkdtempSync(join(tmpdir(), 'lsp-idle-'));
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
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
      { idleTimeoutMs: IDLE_MS },
    );
  });

  afterEach(async () => {
    try {
      await client.shutdown();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops an idle server and respawns it on the next request', async () => {
    const first = await serverPid();
    expect(client.isInitialized).toBe(true);

    const child = client['connection']['process'];
    if (!child) throw new Error('Server did not spawn');
    const exited = once(child, 'exit');
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await exited;
    expect(client.isInitialized).toBe(false);
    expect(isAlive(first)).toBe(false);

    const second = await serverPid();
    expect(second).not.toBe(first);
    expect(client.isInitialized).toBe(true);
  });

  it('keeps a server that keeps receiving requests', async () => {
    const first = await serverPid();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      expect(await serverPid()).toBe(first);
    }
  });

  it.each([
    { method: 'initialize', count: 1 },
    { method: 'textDocument/hover', count: 1 },
    { method: 'textDocument/hover', count: 2 },
  ])(
    'waits for in-flight $method ($count concurrent) before starting the idle window',
    async ({ method, count }) => {
      client.config.env.HOLD_METHOD = method;
      const requests: Promise<number>[] = [];
      for (let i = 0; i < count; i++) {
        const received = new Promise<void>((resolve) => {
          const unsubscribe = client.onDiagnostics('a.ts', () => {
            unsubscribe();
            resolve();
          });
        });
        requests.push(serverPid());
        await received;
      }
      const child = client['connection']['process'];
      if (!child?.pid) throw new Error('Server did not spawn');
      const exited = once(child, 'exit');
      const completed = expect(Promise.all(requests)).resolves.toEqual(Array(count).fill(child.pid));

      for (const request of requests) {
        await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
        expect(isAlive(child.pid)).toBe(true);
        client['connection'].sendNotification('test/release', null);
        expect(await request).toBe(child.pid);
      }
      await completed;

      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(client.isInitialized).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await exited;
      expect(client.isInitialized).toBe(false);
      expect(isAlive(child.pid)).toBe(false);
    },
  );
});
