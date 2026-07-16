import { describe, expect, it, vi } from 'vitest';

import { ClientPool } from '../client-pool';
import type { ResolvedServerConfig } from '../types';

type TestClient = {
  id: number;
  shutdown(): Promise<void>;
};

function serverConfig(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: 'typescript-language-server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts'],
    env: {},
    initializationOptions: {},
    ...overrides,
  };
}

function createPool() {
  let nextId = 1;
  const factory = vi.fn((): TestClient => ({
    id: nextId++,
    shutdown: vi.fn(async () => {}),
  }));
  return { pool: new ClientPool<TestClient>(factory), factory };
}

describe('ClientPool', () => {
  it('coalesces concurrent acquisition of the same key', async () => {
    const { pool, factory } = createPool();
    const owners = [pool.createOwner(), pool.createOwner()];

    const [first, second] = await Promise.all(
      owners.map(async (owner) => owner.acquire('/workspace', serverConfig())),
    );

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('isolates different roots and every resolved config field', () => {
    const { pool, factory } = createPool();
    const owner = pool.createOwner();
    const clients = [
      owner.acquire('/workspace', serverConfig()),
      owner.acquire('/other-workspace', serverConfig()),
      owner.acquire('/workspace', serverConfig({ name: 'other-server' })),
      owner.acquire('/workspace', serverConfig({ command: 'other-command' })),
      owner.acquire('/workspace', serverConfig({ args: ['--stdio', '--trace'] })),
      owner.acquire('/workspace', serverConfig({ extensions: ['.tsx'] })),
      owner.acquire('/workspace', serverConfig({ env: { NODE_ENV: 'test' } })),
      owner.acquire('/workspace', serverConfig({ initializationOptions: { diagnostics: true } })),
    ];

    expect(new Set(clients)).toHaveLength(8);
    expect(factory).toHaveBeenCalledTimes(8);
  });

  it('keeps a shared client running when one owner releases it', async () => {
    const { pool } = createPool();
    const parent = pool.createOwner();
    const child = pool.createOwner();
    const config = serverConfig();
    const client = parent.acquire('/workspace', config);
    expect(child.acquire('/workspace', config)).toBe(client);

    const result = await parent.releaseAll();

    expect(client.shutdown).not.toHaveBeenCalled();
    expect(child.existing('/workspace', config)).toBe(client);
    expect(result).toEqual({ released: 1, shared: 1, stopped: 0, failures: 0 });
  });

  it('shuts down a shared client once when its final owner releases it', async () => {
    const { pool } = createPool();
    const first = pool.createOwner();
    const final = pool.createOwner();
    const config = serverConfig();
    const client = first.acquire('/workspace', config);
    final.acquire('/workspace', config);

    await first.releaseAll();
    const result = await final.releaseAll();

    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ released: 1, shared: 0, stopped: 1, failures: 0 });
  });

  it('makes repeated release calls idempotent', async () => {
    const { pool } = createPool();
    const owner = pool.createOwner();
    const client = owner.acquire('/workspace', serverConfig());

    const first = await owner.releaseAll();
    const second = await owner.releaseAll();

    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ released: 1, shared: 0, stopped: 1, failures: 0 });
    expect(second).toEqual({ released: 0, shared: 0, stopped: 0, failures: 0 });
  });

  it('creates a fresh client when reacquired during deferred shutdown', async () => {
    let finishShutdown!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    let nextId = 1;
    const factory = vi.fn(() => ({ id: nextId++, shutdown }));
    const pool = new ClientPool(factory);
    const oldOwner = pool.createOwner();
    const newOwner = pool.createOwner();
    const config = serverConfig();
    const oldClient = oldOwner.acquire('/workspace', config);

    const releasing = oldOwner.releaseAll();
    const freshClient = newOwner.acquire('/workspace', config);
    finishShutdown();
    await releasing;

    expect(freshClient).not.toBe(oldClient);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(newOwner.existing('/workspace', config)).toBe(freshClient);
  });
});
