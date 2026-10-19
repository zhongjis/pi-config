/** ask — Native file completion and independent $skill: completion. */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

function findFd(): string | undefined {
	const names = process.platform === "win32" ? ["fd.exe", "fdfind.exe", "fd", "fdfind"] : ["fd", "fdfind"];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		for (const name of names) {
			const path = join(dir, name);
			try {
				accessSync(path, constants.X_OK);
				return path;
			} catch {
				continue;
			}
		}
	}
	return undefined;
}

export function createAskAutocompleteProvider(cwd: string, commands: Pick<ReturnType<ExtensionAPI["getCommands"]>[number], "name" | "description" | "source">[]): AutocompleteProvider {
	const files = new CombinedAutocompleteProvider([], cwd, findFd());
	const skills = commands
		.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
		.map((command) => ({ value: `$skill:${command.name.slice("skill:".length)}`, label: command.name.slice("skill:".length), description: command.description }));
	return {
		triggerCharacters: ["@", "$"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const match = lines[cursorLine].slice(0, cursorCol).match(/(?:^|[\s([{,])(\$(?:skill:)?([a-z0-9._/-]*))$/i);
			if (!match) return files.getSuggestions(lines, cursorLine, cursorCol, options);
			const query = match[2].toLowerCase();
			const items = skills.filter((skill) => skill.label.toLowerCase().startsWith(query));
			return items.length ? { items, prefix: match[1] } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$")) return files.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const before = lines[cursorLine].slice(0, cursorCol - prefix.length);
			const insertion = `${item.value} `;
			const updated = [...lines];
			updated[cursorLine] = before + insertion + lines[cursorLine].slice(cursorCol);
			return { lines: updated, cursorLine, cursorCol: before.length + insertion.length };
		},
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => files.shouldTriggerFileCompletion(lines, cursorLine, cursorCol),
	};
}
