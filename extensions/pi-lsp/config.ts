/**
 * LSP server configuration loader.
 *
 * Purely config-driven — no built-in servers and no language enabled by
 * default. Users define every server in their config files:
 *
 *   ~/.pi/agent/lsp.json                   (managed global defaults)
 *   .pi/lsp.json                           (project overrides)
 *
 * Project config merges on top of managed global config. `disabled: true`
 * disables a server. `lsp: false` disables all LSP functionality.
 *
 * IO and command resolution are expressed as Effect programs against the
 * FileSystem / CommandResolver services. The `*Effect` functions are the real
 * implementations; the Promise-returning wrappers provide the live services and
 * exist for the imperative call sites (extension entry, commands, tests).
 */

import { Effect } from 'effect';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { CommandResolver } from './effects/command';
import { FileSystem } from './effects/filesystem';
import { makeRuntimeLayer } from './effects/runtime';
import type { ConfigWriteError } from './errors';
import type { LspConfigFile, LspServerUserConfig, ResolvedServerConfig } from './types';

// ── Paths ───────────────────────────────────────────────────────────────────

function homeConfigDir(): string {
  const home = process.platform === 'win32' ? homedir() : (process.env.HOME ?? homedir());
  return join(home, '.pi', 'agent');
}

function globalConfigPath(): string {
  return join(homeConfigDir(), 'lsp.json');
}

function projectConfigPath(cwd: string): string {
  return join(cwd, '.pi', 'lsp.json');
}

/**
 * Starter template scaffolded on first run. Every server is `disabled` so the
 * extension never auto-starts a language server the user did not opt into —
 * TypeScript is just one example among several, not a default.
 */
const STARTER_CONFIG = `{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      "disabled": true
    },
    "pyright": {
      "command": ["pyright-langserver", "--stdio"],
      "extensions": [".py"],
      "disabled": true
    },
    "rust": {
      "command": ["rust-analyzer"],
      "extensions": [".rs"],
      "disabled": true
    },
    "gopls": {
      "command": ["gopls"],
      "extensions": [".go"],
      "disabled": true
    }
  }
}
`;

// ── Effect programs ───────────────────────────────────────────────────────────

/**
 * Scaffold a starter managed global config if no managed or project config
 * exists. Succeeds with `true` when a file was created, `false` otherwise.
 */
export function scaffoldGlobalConfigEffect(
  cwd: string,
): Effect.Effect<boolean, ConfigWriteError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const globalPath = globalConfigPath();

    if (yield* fs.fileExists(globalPath)) return false;
    if (yield* fs.fileExists(projectConfigPath(cwd))) return false;

    yield* fs.writeTextFile(globalPath, STARTER_CONFIG);
    return true;
  });
}

function readJsonFileEffect<T>(path: string): Effect.Effect<T | null, never, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const raw = yield* fs.readTextFile(path).pipe(Effect.either);
    if (raw._tag === 'Left') return null;
    try {
      return JSON.parse(raw.right) as T;
    } catch {
      return null;
    }
  });
}


function resolveServerEffect(
  name: string,
  config: LspServerUserConfig,
  cwd: string,
): Effect.Effect<ResolvedServerConfig | null, never, CommandResolver> {
  return Effect.gen(function* () {
    if (config.disabled) return null;
    if (!config.command || config.command.length === 0) return null;
    if (!config.extensions || config.extensions.length === 0) return null;

    let finalCommand = config.command[0];
    let finalArgs = config.command.slice(1);

    const resolver = yield* CommandResolver;
    const via = yield* resolver.resolve(finalCommand, cwd);
    if (!via) return null;
    if (via === 'npx') {
      finalArgs = ['--yes', finalCommand, ...finalArgs];
      finalCommand = 'npx';
    }

    return {
      name,
      command: finalCommand,
      args: finalArgs,
      extensions: config.extensions,
      env: config.env ?? {},
      initializationOptions: config.initialization ?? {},
    } satisfies ResolvedServerConfig;
  });
}

export interface LoadedConfig {
  servers: ResolvedServerConfig[];
  globalDisabled: boolean;
  errors: string[];
}

export function loadConfigEffect(
  cwd: string,
): Effect.Effect<LoadedConfig, never, FileSystem | CommandResolver> {
  return Effect.gen(function* () {
    const errors: string[] = [];

    const globalConfig = yield* readJsonFileEffect<LspConfigFile>(globalConfigPath());
    const projectConfig = yield* readJsonFileEffect<LspConfigFile>(projectConfigPath(cwd));

    if (globalConfig?.lsp === false || projectConfig?.lsp === false) {
      return { servers: [], globalDisabled: true, errors };
    }

    const globalServers = (typeof globalConfig?.lsp === 'object' ? globalConfig.lsp : {}) as Record<
      string,
      LspServerUserConfig
    >;
    const projectServers = (
      typeof projectConfig?.lsp === 'object' ? projectConfig.lsp : {}
    ) as Record<string, LspServerUserConfig>;

    const allNames = new Set([...Object.keys(globalServers), ...Object.keys(projectServers)]);
    const servers: ResolvedServerConfig[] = [];

    for (const name of allNames) {
      const userConfig: LspServerUserConfig = {
        ...globalServers[name],
        ...projectServers[name],
      };

      // Merge env maps properly (project on top of global).
      if (globalServers[name]?.env || projectServers[name]?.env) {
        userConfig.env = { ...globalServers[name]?.env, ...projectServers[name]?.env };
      }

      const resolved = yield* resolveServerEffect(name, userConfig, cwd);
      if (resolved) servers.push(resolved);
    }

    return { servers, globalDisabled: false, errors };
  });
}

// ── Promise wrappers (live services provided) ────────────────────────────────

export function scaffoldGlobalConfig(cwd: string): Promise<boolean> {
  return Effect.runPromise(
    scaffoldGlobalConfigEffect(cwd).pipe(Effect.provide(makeRuntimeLayer())),
  );
}

export function loadConfig(cwd: string): Promise<LoadedConfig> {
  return Effect.runPromise(loadConfigEffect(cwd).pipe(Effect.provide(makeRuntimeLayer())));
}

/** Find all servers that handle a given file extension. */
export function serversForExtension(
  servers: ResolvedServerConfig[],
  filePath: string,
): ResolvedServerConfig[] {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return servers.filter((s) => s.extensions.includes(ext));
}
