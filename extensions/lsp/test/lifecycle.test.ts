import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{
    config: unknown;
    rootPath: string;
    isInitialized: boolean;
    shutdown: ReturnType<typeof vi.fn>;
  }>,
  managers: [] as Array<{
    clientsForFile(filePath: string): unknown[];
  }>,
  config: {
    servers: [
      {
        name: 'typescript-language-server',
        command: 'typescript-language-server',
        args: ['--stdio'],
        extensions: ['.ts'],
        env: {},
        initializationOptions: {},
      },
    ],
    globalDisabled: false,
    errors: [],
  },
}));

vi.mock('../client', () => ({
  LspClient: class MockLspClient {
    readonly isInitialized = false;

    constructor(
      readonly config: unknown,
      readonly rootPath: string,
    ) {
      mocks.clients.push(this);
    }

    readonly shutdown = vi.fn(async () => {});
  },
}));

vi.mock('../config', async () => {
  const { Effect } = await import('effect');
  return {
    loadConfigEffect: vi.fn(() => Effect.succeed(mocks.config)),
    scaffoldGlobalConfigEffect: vi.fn(() => Effect.succeed(false)),
    serversForExtension: vi.fn(
      (servers: typeof mocks.config.servers, filePath: string) =>
        servers.filter((server) => filePath.endsWith(server.extensions[0])),
    ),
  };
});

vi.mock('../tools', () => ({
  registerLspTool: vi.fn((_pi: unknown, manager: (typeof mocks.managers)[number]) => {
    mocks.managers.push(manager);
  }),
}));

import lspExtension from '../index';

function activateExtension() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => unknown }>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: never) => unknown }) {
      commands.set(name, command);
    },
  };
  lspExtension(pi as never);

  return {
    async fire(event: string, ctx: unknown) {
      await handlers.get(event)?.({}, ctx);
    },
    async command(name: string, ctx: unknown) {
      await commands.get(name)?.handler('', ctx as never);
    },
  };
}

function sessionContext(cwd = '/workspace') {
  return {
    cwd,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

describe('lsp extension lifecycle', () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.managers.length = 0;
  });

  it('shares one client across activations with the same root and config', async () => {
    const first = activateExtension();
    const second = activateExtension();

    await first.fire('session_start', sessionContext());
    await second.fire('session_start', sessionContext());

    const firstClient = mocks.managers[0].clientsForFile('source.ts')[0];
    const secondClient = mocks.managers[1].clientsForFile('source.ts')[0];

    expect(mocks.clients).toHaveLength(1);
    expect(firstClient).toBe(secondClient);

    await first.fire('session_shutdown', sessionContext());
    await second.fire('session_shutdown', sessionContext());
  });

  it('releases old leases before repeated session_start', async () => {
    const activation = activateExtension();

    await activation.fire('session_start', sessionContext('/workspace-a'));
    const firstClient = mocks.managers[0].clientsForFile('source.ts')[0] as (typeof mocks.clients)[number];

    await activation.fire('session_start', sessionContext('/workspace-b'));

    expect(firstClient.shutdown).toHaveBeenCalledTimes(1);
    const secondClient = mocks.managers[0].clientsForFile('source.ts')[0];
    expect(secondClient).not.toBe(firstClient);

    await activation.fire('session_shutdown', sessionContext('/workspace-b'));
  });

  it('restart releases only the current activation when a client is shared', async () => {
    const parent = activateExtension();
    const child = activateExtension();
    const parentCtx = sessionContext();
    const childCtx = sessionContext();

    await parent.fire('session_start', parentCtx);
    await child.fire('session_start', childCtx);
    const client = mocks.managers[0].clientsForFile('source.ts')[0] as (typeof mocks.clients)[number];
    expect(mocks.managers[1].clientsForFile('source.ts')[0]).toBe(client);

    await parent.command('lsp-restart', parentCtx);

    expect(client.shutdown).not.toHaveBeenCalled();
    expect(parentCtx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining('shared'),
      'info',
    );
    expect(mocks.managers[0].clientsForFile('source.ts')[0]).toBe(client);

    await parent.fire('session_shutdown', parentCtx);
    await child.fire('session_shutdown', childCtx);
  });

  it('reports restart shutdown failures without blocking config reload', async () => {
    const activation = activateExtension();
    const ctx = sessionContext();

    await activation.fire('session_start', ctx);
    const client = mocks.managers[0].clientsForFile('source.ts')[0] as (typeof mocks.clients)[number];
    client.shutdown.mockRejectedValueOnce(new Error('stop failed'));

    await activation.command('lsp-restart', ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining('failed to stop'),
      'warning',
    );
    expect(mocks.managers[0].clientsForFile('source.ts')).toHaveLength(1);

    await activation.fire('session_shutdown', ctx);
  });
});
