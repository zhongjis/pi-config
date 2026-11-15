import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LspClient } from '../client';

// Minimal LSP server whose hover answers with its own pid.
const fakeServerScript = `
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
};
function handle(msg) {
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
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('LspClient idle suspend', () => {
  let root: string;
  let client: LspClient;

  const serverPid = async () =>
    Number((await client.hover('a.ts', { line: 0, character: 0 }))?.contents);

  beforeEach(() => {
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
    await client.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  it('stops an idle server and respawns it on the next request', async () => {
    const first = await serverPid();
    expect(client.isInitialized).toBe(true);

    await until(() => !client.isInitialized && !isAlive(first));

    const second = await serverPid();
    expect(second).not.toBe(first);
    expect(client.isInitialized).toBe(true);
  });

  it('keeps a server that keeps receiving requests', async () => {
    const first = await serverPid();
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS / 2));
      expect(await serverPid()).toBe(first);
    }
  });
});
