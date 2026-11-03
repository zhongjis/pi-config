import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdrAppArgv, parseHerdrAppSplit } from "../../lib/herdr-app.mjs";
import { buildPiArgs, classifyLaunchResult, safeErrorText, type HerdrLaunchOptions } from "./core.ts";

/** Once split is submitted, an unknown outcome retains the payload and never retries. */
export async function launchHerdrAppPane(
	pi: Pick<ExtensionAPI, "exec">,
	options: HerdrLaunchOptions,
): Promise<{ readonly kind: "success" | "failed" | "ambiguous"; readonly message?: string }> {
	const argv = herdrAppArgv(options.cwd, ["env", `PI_HERDR_BTW_PAYLOAD=${options.payloadPath}`, "pi", ...buildPiArgs(options)]);
	try {
		const result = await pi.exec("herdr-app", ["do", "pane.split", "--pane", options.parentPaneId ?? "", "--direction", options.split, "--argv", JSON.stringify(argv)], { timeout: 10_000 });
		const outcome = classifyLaunchResult(result);
		if (outcome === "failed") return { kind: "failed", message: safeErrorText(result.stdout, result.stderr) };
		if (outcome === "success" && parseHerdrAppSplit(result.stdout)) return { kind: "success" };
		return { kind: "ambiguous" };
	} catch (error) {
		// The CLI may have reached the app before its transport failed.
		if (error instanceof Error) return { kind: "ambiguous", message: error.message };
		throw error;
	}
}
