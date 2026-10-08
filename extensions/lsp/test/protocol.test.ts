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

describe('LspConnection process lifecycle', () => {
  it('clears exited child so the connection can respawn', async () => {
    const conn = new LspConnection(process.execPath, ['-e', exitingServerScript]);
    let exitCount = 0;
    let onExit = () => {};
    conn.setExitHandler(() => {
      exitCount += 1;
      onExit();
    });
    const nextExit = () => new Promise<void>((resolve) => {
      onExit = resolve;
    });

    try {
      let exited = nextExit();
      conn.spawn();
      await expect(conn.sendRequest('first', null, 1000)).resolves.toBe('first');
      await exited;
      expect(conn.alive).toBe(false);

      exited = nextExit();
      conn.spawn();
      await expect(conn.sendRequest('second', null, 1000)).resolves.toBe('second');
      await exited;
      expect(conn.alive).toBe(false);
      expect(exitCount).toBe(2);
    } finally {
      conn.dispose();
    }
  });
});
