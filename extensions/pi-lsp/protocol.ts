/**
 * JSON-RPC over stdio transport for LSP.
 *
 * Handles Content-Length framing, request/response matching, and notification dispatch.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { JsonRpcMessage } from './types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (id: number | string, method: string, params: unknown) => void;

export class LspConnection {
  private process: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private onNotification: NotificationHandler = () => {};
  private onServerRequest: ServerRequestHandler = () => {};
  private onExit: ((code: number | null) => void) | null = null;
  private onStderr: ((text: string) => void) | null = null;
  private disposed = false;

  constructor(
    private command: string,
    private args: string[],
    private options?: { cwd?: string; env?: Record<string, string> },
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────

  spawn(): void {
    if (this.disposed || this.process) return;

    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options?.cwd,
      env: { ...process.env, ...this.options?.env },
      shell: process.platform === 'win32',
    });
    this.process = child;

    child.stdout!.on('data', (chunk: Buffer) => {
      if (this.process !== child) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainBuffer();
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (this.process !== child) return;
      this.onStderr?.(chunk.toString('utf8'));
    });

    child.on('exit', (code) => {
      this.handleProcessExit(child, code);
    });

    child.on('error', (err) => {
      this.handleProcessError(child, err);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending('Connection disposed');

    const child = this.process;
    if (child) {
      this.process = null;
      this.buffer = Buffer.alloc(0);
      child.stdin?.end();
      child.kill();
    }
  }

  private handleProcessExit(child: ChildProcess, code: number | null): void {
    if (this.process !== child) return;
    this.rejectAllPending('Server process exited');
    this.process = null;
    this.buffer = Buffer.alloc(0);
    if (!this.disposed) this.onExit?.(code);
  }

  private handleProcessError(child: ChildProcess, err: Error): void {
    if (this.process !== child) return;
    this.rejectAllPending(`Server process error: ${err.message}`);
    this.process = null;
    this.buffer = Buffer.alloc(0);
    if (!this.disposed) this.onExit?.(null);
  }

  get alive(): boolean {
    return this.process !== null && !this.disposed && this.process.exitCode === null;
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  setNotificationHandler(handler: NotificationHandler): void {
    this.onNotification = handler;
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.onServerRequest = handler;
  }

  setExitHandler(handler: (code: number | null) => void): void {
    this.onExit = handler;
  }

  setStderrHandler(handler: (text: string) => void): void {
    this.onStderr = handler;
  }

  // ── Sending ───────────────────────────────────────────────────────────

  sendRequest(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error('Connection not alive'));

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  sendNotification(method: string, params: unknown): void {
    if (!this.alive) return;
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  sendResponse(id: number | string, result: unknown): void {
    if (!this.alive) return;
    this.writeMessage({ jsonrpc: '2.0', id, result } as unknown as JsonRpcMessage);
  }

  // ── Framing ───────────────────────────────────────────────────────────

  private writeMessage(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    const length = Buffer.byteLength(body, 'utf8');
    const header = `Content-Length: ${length}\r\n\r\n`;
    this.process?.stdin?.write(header + body);
  }

  private drainBuffer(): void {
    const HEADER_DELIMITER = '\r\n\r\n';

    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd === -1) break;

      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip past it
        this.buffer = this.buffer.subarray(headerEnd + HEADER_DELIMITER.length);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + HEADER_DELIMITER.length;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break; // Incomplete body

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    const msg = message as unknown as Record<string, unknown>;

    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id as number);

        if (msg.error) {
          const err = msg.error as { code: number; message: string };
          pending.reject(new Error(`LSP error ${err.code}: ${err.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification or server-initiated request
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        // Server request — needs a response
        this.onServerRequest(msg.id as number, msg.method, msg.params);
      } else {
        // Notification
        this.onNotification(msg.method, msg.params);
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
