import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfigEffect, scaffoldGlobalConfigEffect } from '../config';
import { CommandResolver, type CommandResolverService } from '../effects/command';
import { FileSystem, type FileSystemService } from '../effects/filesystem';
import { ConfigReadError, ConfigWriteError } from '../errors';

function json(value: unknown): string {
  return JSON.stringify(value);
}

function makeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: { path: string; content: string }[] = [];

  const service: FileSystemService = {
    readTextFile: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        return Effect.fail(new ConfigReadError({ path, cause: new Error('missing') }));
      }
      return Effect.succeed(content);
    },
    fileExists: (path) => Effect.succeed(files.has(path)),
    writeTextFile: (path, content) =>
      Effect.sync(() => {
        files.set(path, content);
        writes.push({ path, content });
      }).pipe(
        Effect.mapError((cause) => new ConfigWriteError({ path, cause })),
      ),
  };

  return { service, writes };
}

const commandResolver: CommandResolverService = {
  resolve: () => Effect.succeed('global'),
};

function runConfig<T>(
  effect: Effect.Effect<T, unknown, FileSystem | CommandResolver>,
  fs: FileSystemService,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(FileSystem, fs),
      Effect.provideService(CommandResolver, commandResolver),
    ),
  );
}

describe('lsp config paths', () => {
  const originalHome = process.env.HOME;
  const home = '/tmp/lsp-test-home';
  const cwd = '/tmp/lsp-test-project';
  const managedPath = join(home, '.pi', 'agent', 'lsp.json');
  const projectPath = join(cwd, '.pi', 'lsp.json');

  beforeEach(() => {
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('merges managed global < project config', async () => {
    const { service } = makeFs({
      [managedPath]: json({
        lsp: {
          typescript: {
            command: ['managed-ts', '--stdio'],
            extensions: ['.ts'],
            env: { FROM_MANAGED: 'yes', SHARED: 'managed' },
          },
          pyright: {
            command: ['pyright-langserver', '--stdio'],
            extensions: ['.py'],
          },
        },
      }),
      [projectPath]: json({
        lsp: {
          typescript: {
            command: ['project-ts'],
            extensions: ['.tsx'],
            env: { FROM_PROJECT: 'yes', SHARED: 'project' },
          },
          pyright: {
            disabled: true,
          },
        },
      }),
    });

    const loaded = await runConfig(loadConfigEffect(cwd), service);

    expect(loaded.globalDisabled).toBe(false);
    expect(loaded.servers.map((server) => server.name)).toEqual(['typescript']);
    expect(loaded.servers[0]).toMatchObject({
      command: 'project-ts',
      args: [],
      extensions: ['.tsx'],
      env: {
        FROM_MANAGED: 'yes',
        FROM_PROJECT: 'yes',
        SHARED: 'project',
      },
    });
  });

  it('lets managed or project lsp:false disable all servers', async () => {
    const managedDisabled = makeFs({
      [managedPath]: json({ lsp: false }),
    });

    await expect(runConfig(loadConfigEffect(cwd), managedDisabled.service)).resolves.toMatchObject({
      globalDisabled: true,
      servers: [],
    });

    const projectDisabled = makeFs({
      [managedPath]: json({
        lsp: { typescript: { command: ['ts-ls'], extensions: ['.ts'] } },
      }),
      [projectPath]: json({ lsp: false }),
    });

    await expect(runConfig(loadConfigEffect(cwd), projectDisabled.service)).resolves.toMatchObject({
      globalDisabled: true,
      servers: [],
    });
  });

  it('scaffolds starter config to managed path only when no config exists', async () => {
    const empty = makeFs();

    await expect(runConfig(scaffoldGlobalConfigEffect(cwd), empty.service)).resolves.toBe(true);
    expect(empty.writes).toHaveLength(1);
    expect(empty.writes[0].path).toBe(managedPath);
    expect(empty.writes[0].content).toContain('typescript-language-server');

    for (const existingPath of [managedPath, projectPath]) {
      const existing = makeFs({ [existingPath]: json({ lsp: {} }) });
      await expect(runConfig(scaffoldGlobalConfigEffect(cwd), existing.service)).resolves.toBe(false);
      expect(existing.writes).toEqual([]);
    }
  });

  it('ignores removed upstream global config path', async () => {
    const removedGlobalPath = join(home, '.pi', 'agent', 'extensions', 'lsp', 'config.json');
    const { service } = makeFs({
      [removedGlobalPath]: json({
        lsp: {
          typescript: {
            command: ['upstream-ts'],
            extensions: ['.upstream'],
          },
        },
      }),
    });

    await expect(runConfig(loadConfigEffect(cwd), service)).resolves.toMatchObject({
      globalDisabled: false,
      servers: [],
    });

    await expect(runConfig(scaffoldGlobalConfigEffect(cwd), service)).resolves.toBe(true);
  });
});
