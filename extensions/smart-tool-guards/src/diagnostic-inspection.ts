import { literalWords } from "./literal-inspection.js";

// Only offline snapshots: immutable avoids SQLite WAL/SHM creation, but ignores live writers.
const SCHEMA_QUERY = "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;";
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/;

export function isDiagnosticInspection(command: string): boolean {
	if (!/^[ \t]*(journalctl|systemctl|sqlite3)[ \t]/.test(command)) return false;
	const words = literalWords(command);
	if (!words) return false;
	if (words[0] === "sqlite3") {
		return words.length === 7 && words[1] === "-batch" && words[2] === "-readonly" &&
			words[3] === "-init" && words[4] === "/dev/null" &&
			/^file:\/[A-Za-z0-9/_.-]+\?mode=ro&immutable=1$/.test(words[5]) && words[6] === SCHEMA_QUERY;
	}
	if (words[0] === "systemctl") {
		if (words[1] !== "--user" || !UNIT.test(words[3] ?? "")) return false;
		if (words[2] === "status") return words.length === 5 && words[4] === "--no-pager";
		if (words[2] !== "show") return false;
		let pagerDisabled = false;
		let properties = 0;
		for (let index = 4; index < words.length; index += 1) {
			if (words[index] === "--no-pager" && !pagerDisabled) { pagerDisabled = true; continue; }
			if (words[index] !== "-p" || !["ExecStart", "FragmentPath", "ActiveEnterTimestamp"].includes(words[++index])) return false;
			properties += 1;
		}
		return pagerDisabled && properties > 0;
	}
	const seen = new Set<string>();
	for (let index = 1; index < words.length; index += 1) {
		const flag = words[index];
		if (seen.has(flag)) return false;
		seen.add(flag);
		if (flag === "--user" || flag === "--no-pager") continue;
		if (flag === "-u" && UNIT.test(words[++index] ?? "")) continue;
		if (flag === "-n") {
			const count = words[++index];
			if (/^[1-9]\d{0,4}$/.test(count ?? "") && Number(count) <= 10_000) continue;
		}
		return false;
	}
	return ["--user", "--no-pager", "-u", "-n"].every((flag) => seen.has(flag));
}
