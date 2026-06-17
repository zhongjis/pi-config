import { appendFileSync } from "node:fs";
import { join } from "node:path";

const warnedKeys = new Set<string>();

/**
 * Sink that receives every emitted `[panda-warn]` line as `(prefix, jsonLine)`.
 * Defaults to `console.warn` so behavior is unchanged unless a file sink is installed.
 */
type WarnSink = (prefix: string, line: string) => void;

const consoleSink: WarnSink = (prefix, line) => {
	console.warn(prefix, line);
};

let sink: WarnSink = consoleSink;

export function pandaWarn(code: string, payload: Record<string, unknown> = {}): void {
	sink("[panda-warn]", JSON.stringify({ code, ts: Date.now(), ...payload }));
}

export function pandaWarnOnce(key: string, code: string, payload: Record<string, unknown> = {}): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	pandaWarn(code, payload);
}

/** Test seam: override the active sink. */
export function setPandaWarnSink(fn: WarnSink): void {
	sink = fn;
}

/** Test seam: restore the default `console.warn` sink. */
export function resetPandaWarnSink(): void {
	sink = consoleSink;
}

let fileSinkInstalled = false;

/**
 * Route `[panda-warn]` telemetry to an append-only `panda-warn.log` under the agent dir
 * instead of the terminal. `console.warn` writes to stderr, which collides with the TUI's
 * stdout ANSI frame and corrupts the render; the file keeps the diagnostics greppable
 * without touching the terminal.
 *
 * `resolveDir` is injected (rather than importing `getAgentDir` here) so this module stays
 * free of the pi-coding-agent dependency. Idempotent and best-effort — never throws from
 * the emit path. Downstream tooling should grep `<agentDir>/panda-warn.log`.
 */
export function installPandaWarnFileSink(resolveDir: () => string): void {
	if (fileSinkInstalled) return;
	fileSinkInstalled = true;
	sink = (prefix, line) => {
		try {
			appendFileSync(join(resolveDir(), "panda-warn.log"), `${prefix} ${line}\n`);
		} catch {
			// best-effort — never throw from telemetry
		}
	};
}
