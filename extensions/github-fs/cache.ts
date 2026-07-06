/**
 * Cross-session file cache for rendered github-fs views.
 *
 * Layout under `<agentDir>/github-fs-cache/` (dir 0700, files 0600):
 *   <hash>.md    — rendered markdown the `read` tool consumes
 *   <hash>.json  — { fetchedAt, terminal }
 *
 * The hash key includes the resolved account identity. That is a *consistency*
 * control (don't serve account A's cached 200 when the current resolution
 * picked account B), NOT a trust boundary — all accounts belong to one OS user.
 *
 * Freshness:
 *   - `?refresh=1` → always miss.
 *   - terminal entries (merged/closed) → always hit (immutable, best-effort).
 *   - age < soft TTL → hit; otherwise miss (refetch, overwrite).
 * Entries older than the hard TTL are opportunistically evicted on write.
 *
 * Never writes tokens or secrets — only rendered markdown and timestamps.
 */

declare function require(id: string): any;

const { getAgentDir } = require("@earendil-works/pi-coding-agent") as { getAgentDir: () => string };
const { createHash, randomBytes } = require("node:crypto") as {
  createHash: (algo: string) => { update(data: string): { digest(enc: string): string } };
  randomBytes: (size: number) => { toString(enc: string): string };
};
const { mkdir, writeFile, readFile, rename, stat, readdir, unlink } = require("node:fs/promises") as {
  mkdir: (path: string, options: { recursive?: boolean; mode?: number }) => Promise<void>;
  writeFile: (path: string, data: string, options: { encoding: string; mode?: number }) => Promise<void>;
  readFile: (path: string, encoding: string) => Promise<string>;
  rename: (from: string, to: string) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  readdir: (path: string) => Promise<string[]>;
  unlink: (path: string) => Promise<void>;
};
const { resolve, join } = require("node:path") as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

const CACHE_DIR_NAME = "github-fs-cache";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SOFT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheMeta {
  fetchedAt: number;
  terminal: boolean;
}

export interface GithubCache {
  /** Compute a stable cache key hash from arbitrary structured parts. */
  key(parts: unknown): string;
  /** Return the materialized `.md` path for a hit, or null for a miss. */
  get(key: string, options: { refresh: boolean }): Promise<string | null>;
  /** Write markdown + metadata; return the materialized `.md` path. */
  put(key: string, markdown: string, options: { terminal: boolean }): Promise<string>;
}

export interface CacheOptions {
  /** Override the base agent dir (tests). Defaults to getAgentDir(). */
  agentDir?: string;
  now?: () => number;
}

export function createCache(options: CacheOptions = {}): GithubCache {
  const baseDir = options.agentDir ?? getAgentDir();
  const cacheDir = resolve(baseDir, CACHE_DIR_NAME);
  const now = options.now ?? (() => Date.now());

  const mdPath = (key: string) => join(cacheDir, `${key}.md`);
  const metaPath = (key: string) => join(cacheDir, `${key}.json`);

  async function ensureDir(): Promise<void> {
    await mkdir(cacheDir, { recursive: true, mode: DIR_MODE });
  }

  async function atomicWrite(target: string, data: string): Promise<void> {
    const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, data, { encoding: "utf8", mode: FILE_MODE });
    await rename(temp, target);
  }

  async function readMeta(key: string): Promise<CacheMeta | null> {
    try {
      return JSON.parse(await readFile(metaPath(key), "utf8")) as CacheMeta;
    } catch {
      return null;
    }
  }

  async function evictExpired(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(cacheDir);
    } catch {
      return;
    }
    const cutoff = now() - HARD_TTL_MS;
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const key = name.slice(0, -".json".length);
          const meta = await readMeta(key);
          if (meta && meta.terminal) return; // keep immutable entries
          try {
            const info = await stat(join(cacheDir, name));
            if (info.mtimeMs < cutoff) {
              await unlink(mdPath(key)).catch(() => {});
              await unlink(metaPath(key)).catch(() => {});
            }
          } catch {
            /* ignore */
          }
        }),
    );
  }

  return {
    key(parts) {
      return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
    },

    async get(key, { refresh }) {
      if (refresh) return null;
      const meta = await readMeta(key);
      if (!meta) return null;
      const fresh = meta.terminal || now() - meta.fetchedAt < SOFT_TTL_MS;
      if (!fresh) return null;
      try {
        await stat(mdPath(key)); // ensure the content file still exists
        return mdPath(key);
      } catch {
        return null;
      }
    },

    async put(key, markdown, { terminal }) {
      await ensureDir();
      // Content first, then metadata — a reader that sees metadata always finds content.
      await atomicWrite(mdPath(key), markdown);
      await atomicWrite(metaPath(key), JSON.stringify({ fetchedAt: now(), terminal } satisfies CacheMeta));
      void evictExpired();
      return mdPath(key);
    },
  };
}

/** Whether a fetched item's state means it will never change again. */
export function isTerminalState(state: string | undefined): boolean {
  if (!state) return false;
  const normalized = state.toUpperCase();
  return normalized === "MERGED" || normalized === "CLOSED";
}
