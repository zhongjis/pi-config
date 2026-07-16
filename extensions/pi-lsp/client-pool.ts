import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { LspClient } from './client';
import type { ResolvedServerConfig } from './types';

export interface ClientPoolReleaseResult {
  released: number;
  shared: number;
  stopped: number;
  failures: number;
}

export interface ClientPoolOwner<T> {
  acquire(rootPath: string, config: ResolvedServerConfig): T;
  existing(rootPath: string, config: ResolvedServerConfig): T | undefined;
  values(): T[];
  releaseAll(): Promise<ClientPoolReleaseResult>;
}

type PoolEntry<T> = {
  client: T;
  refs: number;
};

type ClientFactory<T> = (config: ResolvedServerConfig, canonicalRoot: string) => T;

function canonicalizeRoot(rootPath: string): string {
  const absolute = resolve(rootPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function clientKey(rootPath: string, config: ResolvedServerConfig): string {
  return stableSerialize([canonicalizeRoot(rootPath), config]);
}

export class ClientPool<T extends { shutdown(): Promise<void> }> {
  private readonly entries = new Map<string, PoolEntry<T>>();

  constructor(private readonly factory: ClientFactory<T>) {}

  createOwner(): ClientPoolOwner<T> {
    const leases = new Map<string, PoolEntry<T>>();

    return {
      acquire: (rootPath, config) => {
        const key = clientKey(rootPath, config);
        const owned = leases.get(key);
        if (owned) return owned.client;

        let entry = this.entries.get(key);
        if (entry) {
          entry.refs += 1;
        } else {
          entry = {
            client: this.factory(config, canonicalizeRoot(rootPath)),
            refs: 1,
          };
          this.entries.set(key, entry);
        }
        leases.set(key, entry);
        return entry.client;
      },
      existing: (rootPath, config) => leases.get(clientKey(rootPath, config))?.client,
      values: () => [...leases.values()].map((entry) => entry.client),
      releaseAll: async () => {
        const owned = [...leases.entries()];
        leases.clear();

        let shared = 0;
        const stopping: PoolEntry<T>[] = [];
        for (const [key, entry] of owned) {
          entry.refs -= 1;
          if (entry.refs > 0) {
            shared += 1;
          } else if (this.entries.get(key) === entry) {
            this.entries.delete(key);
            stopping.push(entry);
          }
        }

        const settled = await Promise.allSettled(
          stopping.map((entry) => entry.client.shutdown()),
        );
        return {
          released: owned.length,
          shared,
          stopped: settled.filter((result) => result.status === 'fulfilled').length,
          failures: settled.filter((result) => result.status === 'rejected').length,
        };
      },
    };
  }
}

const GLOBAL_POOL_SYMBOL = Symbol.for('panda-harness.pi-lsp.client-pool.v1');

export function getGlobalClientPool(): ClientPool<LspClient> {
  const registry = globalThis as Record<PropertyKey, unknown>;
  const existing = registry[GLOBAL_POOL_SYMBOL] as ClientPool<LspClient> | undefined;
  if (existing) return existing;

  const pool = new ClientPool((config, rootPath) => new LspClient(config, rootPath));
  registry[GLOBAL_POOL_SYMBOL] = pool;
  return pool;
}
