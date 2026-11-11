// Unlike the hazard scanner, literal matching preserves empty arguments and shell spelling.
export function literalStages(command: string, pipeline: boolean): string[][] | undefined {
	const stages: string[][] = [[]];
	const literalWordPattern = /(?:[^\s'"\\$`*?[\]{}~#!();&|<>]|'[^']*'|"(?:[^"\\$`]|\\["\\$`])*"|\\[^\n\r]|(?<=[A-Za-z0-9_./^~-])~)+/y;
	let index = 0;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index += 1;
		if (index === command.length) break;
		if (pipeline && command[index] === "|") {
			if (stages.at(-1)?.length === 0) return undefined;
			stages.push([]);
			index += 1;
			continue;
		}
		literalWordPattern.lastIndex = index;
		const match = literalWordPattern.exec(command);
		if (!match) return undefined;
		// Only unquoted, direct executable names enter the inspection fast path.
		if (pipeline && stages.at(-1)?.length === 0 && !/^[a-z][a-z0-9-]*$/.test(match[0])) return undefined;
		stages.at(-1)?.push(match[0].replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/gs,
			(_chunk, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
				single ?? (double === undefined ? escaped ?? "" : double.replace(/\\(["\\$`])/g, "$1"))));
		index = literalWordPattern.lastIndex;
		if (index < command.length && command[index] !== " " && command[index] !== "\t" && !(pipeline && command[index] === "|")) return undefined;
	}
	return stages.at(-1)?.length ? stages : undefined;
}

export function literalWords(command: string): string[] | undefined {
	return literalStages(command, false)?.[0];
}

// ponytail: the only compound shape approved without the classifier; profiles cannot express `||`
// fallbacks, so this stays code-owned for every profile. Add a profile compound form if a second one is needed.
export function isCommandDiscoveryFallback(command: string): boolean {
	return /^[ \t]*command[ \t]+-v[ \t]+[A-Za-z_][A-Za-z0-9_-]*[ \t]+\|\|[ \t]+true[ \t]*$/.test(command);
}
