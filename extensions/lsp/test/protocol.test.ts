import { describe, expect, it } from 'vitest';

import { LspConnection } from '../protocol';

const exitingServerScript = `
let buffer = Buffer.alloc(0);

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
}

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.subarray(bodyEnd);
    const message = JSON.parse(body);
    send({ jsonrpc: '2.0', id: message.id, result: message.method });
    setTimeout(() => process.exit(0), 5);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
`;

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

describe('LspConnection process lifecycle', () => {
  it('clears exited child so the connection can respawn', async () => {
    const conn = new LspConnection(process.execPath, ['-e', exitingServerScript]);
    const exits: (number | null)[] = [];
    conn.setExitHandler((code) => {
      exits.push(code);
    });

    try {
      conn.spawn();
      await expect(conn.sendRequest('first', null, 1000)).resolves.toBe('first');
      await waitFor(() => exits.length === 1 && !conn.alive);

      conn.spawn();
      await expect(conn.sendRequest('second', null, 1000)).resolves.toBe('second');
      await waitFor(() => exits.length === 2 && !conn.alive);
    } finally {
      conn.dispose();
    }
  });
});
