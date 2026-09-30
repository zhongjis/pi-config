import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createTestSession, says, when, type TestSession } from "./helpers/faux-session.js";

describe("faux-session tool registry mocks", () => {
	const sessions: TestSession[] = [];

	afterEach(() => {
		for (const session of sessions) session.dispose();
		sessions.length = 0;
	});

	it("rejects when an extension rebuilds the tool registry during the turn", async () => {
		const session = await createTestSession({
			mockTools: { bash: "mocked" },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						pi.registerTool({
							name: "registry_rebuild_probe",
							label: "registry rebuild probe",
							description: "Registered during the turn to rebuild the tool registry.",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		});
		sessions.push(session);

		await expect(session.run(when("probe", [says("ok")]))).rejects.toThrow(
			/pi rebuilt the tool registry during the turn so mocks may have been bypassed/,
		);
	});
});
