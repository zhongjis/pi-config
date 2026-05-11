/**
 * Cross-session fallback cache. Parameterized over filename and entry shape.
 *
 * Two cache modes:
 * - Flat: single `FallbackEntry` object (e.g., clauderock — anthropic account
 *   rate limit is global; one flag covers all models).
 * - Keyed: `{ [modelId]: FallbackEntry }` (e.g., opencode-zenfall — Go quotas
 *   are per-model-per-month).
 *
 * Entries older than `ttlMs` are treated as absent on read (auto-expiry).
 *
 * Storage lives under the pi agent dir so it survives restarts.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface FallbackEntry {
	/** ISO timestamp when fallback activated. */
	since: string;
	/** Error message or manual reason that triggered activation. */
	reason: string;
}

export interface FlatFallbackCache {
	/** Read entry; returns undefined if missing, unreadable, or older than TTL. */
	read(): FallbackEntry | undefined;
	/** Persist an entry with `since = now`. */
	write(reason: string): void;
	/** Delete the cache file. */
	clear(): void;
}

export interface KeyedFallbackCache {
	/** Read entry for a key; returns undefined if missing or expired. */
	read(key: string): FallbackEntry | undefined;
	/** Read all entries (expired ones filtered out). */
	readAll(): Record<string, FallbackEntry>;
	/** Persist one entry under a key (merges with existing file). */
	write(key: string, reason: string): void;
	/** Remove one key. */
	clearKey(key: string): void;
	/** Delete the entire cache file. */
	clear(): void;
}

export interface CacheOptions {
	/** Entry TTL in milliseconds. Entries older than this are treated as absent. */
	ttlMs?: number;
}

function getCachePath(filename: string): string {
	return join(getAgentDir(), filename);
}

function isExpired(entry: FallbackEntry | undefined, ttlMs: number | undefined): boolean {
	if (!entry) return true;
	if (!ttlMs) return false;
	const ts = Date.parse(entry.since);
	if (Number.isNaN(ts)) return false;
	return Date.now() - ts > ttlMs;
}

function safeReadJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
}

/**
 * Flat cache: single `FallbackEntry` at the file root. Namespace via `filename`
 * (e.g., `clauderock-state.json`) — two extensions sharing a filename would
 * clobber, so pick a unique name.
 */
export function createFlatFallbackCache(
	filename: string,
	options: CacheOptions = {},
): FlatFallbackCache {
	return {
		read() {
			const data = safeReadJson(getCachePath(filename));
			if (!data || typeof data !== "object") return undefined;
			const entry = data as Partial<FallbackEntry>;
			if (typeof entry.since !== "string" || typeof entry.reason !== "string") return undefined;
			const full: FallbackEntry = { since: entry.since, reason: entry.reason };
			return isExpired(full, options.ttlMs) ? undefined : full;
		},
		write(reason: string) {
			const entry: FallbackEntry = { since: new Date().toISOString(), reason };
			writeFileSync(getCachePath(filename), JSON.stringify(entry, null, 2));
		},
		clear() {
			try {
				unlinkSync(getCachePath(filename));
			} catch {
				// ignore: file may not exist
			}
		},
	};
}

/**
 * Keyed cache: `{ [key]: FallbackEntry }`. Use when failover state is per-model,
 * per-resource, or otherwise partitioned.
 *
 * Read path filters out expired entries but does NOT rewrite the file; call
 * `write` or `clearKey` to actually persist changes.
 */
export function createKeyedFallbackCache(
	filename: string,
	options: CacheOptions = {},
): KeyedFallbackCache {
	function readRaw(): Record<string, FallbackEntry> {
		const data = safeReadJson(getCachePath(filename));
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		const out: Record<string, FallbackEntry> = {};
		for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
			if (v && typeof v === "object") {
				const entry = v as Partial<FallbackEntry>;
				if (typeof entry.since === "string" && typeof entry.reason === "string") {
					out[k] = { since: entry.since, reason: entry.reason };
				}
			}
		}
		return out;
	}

	return {
		read(key: string) {
			const entry = readRaw()[key];
			return isExpired(entry, options.ttlMs) ? undefined : entry;
		},
		readAll() {
			const all = readRaw();
			const out: Record<string, FallbackEntry> = {};
			for (const [k, v] of Object.entries(all)) {
				if (!isExpired(v, options.ttlMs)) out[k] = v;
			}
			return out;
		},
		write(key: string, reason: string) {
			const all = readRaw();
			all[key] = { since: new Date().toISOString(), reason };
			writeFileSync(getCachePath(filename), JSON.stringify(all, null, 2));
		},
		clearKey(key: string) {
			const all = readRaw();
			if (!(key in all)) return;
			delete all[key];
			if (Object.keys(all).length === 0) {
				try {
					unlinkSync(getCachePath(filename));
				} catch {
					// ignore
				}
				return;
			}
			writeFileSync(getCachePath(filename), JSON.stringify(all, null, 2));
		},
		clear() {
			try {
				unlinkSync(getCachePath(filename));
			} catch {
				// ignore
			}
		},
	};
}
