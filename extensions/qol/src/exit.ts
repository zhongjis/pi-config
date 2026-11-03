/**
 * Exit Command Extension
 *
 * Restores /exit as an alias for /quit. Terminal-only: in RPC mode the client
 * (for example T3 Code) owns the Pi process lifecycle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTuiCommand } from "../../lib/mode.js";

export default function (pi: ExtensionAPI) {
	registerTuiCommand(pi, "exit", {
		description: "Exit pi cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
