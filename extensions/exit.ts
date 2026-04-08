/**
 * Exit Command Extension
 *
 * Restores /exit as an alias for /quit.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
