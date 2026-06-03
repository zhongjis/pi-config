const warnedKeys = new Set<string>();

export function pandaWarn(code: string, payload: Record<string, unknown> = {}): void {
	console.warn("[panda-warn]", JSON.stringify({ code, ts: Date.now(), ...payload }));
}

export function pandaWarnOnce(key: string, code: string, payload: Record<string, unknown> = {}): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	pandaWarn(code, payload);
}
