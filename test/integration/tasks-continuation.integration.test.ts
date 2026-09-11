import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calls, createTestSession, says, type TestSession, when } from "./helpers/faux-session.js";

const TASKS_EXTENSION = resolve(import.meta.dirname, "../../extensions/tasks/index.ts");
const GOAL_EXTENSION = resolve(import.meta.dirname, "../../extensions/goal/index.ts");
const createTask = () => calls("Task", {
	op: "create",
	tasks: [{ subject: "Verify output", description: "Check the output before finishing." }],
});

function customMessages(session: TestSession) {
	return session.events.messages.filter((message) => message.role === "custom");
}

describe("task finish continuation in real Pi", () => {
	let session: TestSession | undefined;
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(resolve(tmpdir(), "pi-task-nudge-"));
		vi.stubEnv("PI_TASKS", "off");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	});
	afterEach(async () => {
		await session?.session.abort();
		session?.dispose();
		session = undefined;
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("starts another model run after a clean finish and allows task completion", async () => {
		session = await createTestSession({ extensions: [TASKS_EXTENSION] });
		await session.run(when("Create the task and verify the output.", [
			createTask(),
			says("Work stopped before verification."),
			calls("Task", { op: "update", tasks: [{ taskId: "1", status: "in_progress" }] }),
			calls("Task", { op: "update", tasks: [{ taskId: "1", status: "completed" }] }),
			says("Verification finished."),
		]));
		await session.session.waitForIdle();

		expect(session.events.toolResultsFor("Task")).toHaveLength(3);
		expect(session.events.toolResultsFor("Task").every((result) => !result.isError)).toBe(true);
		expect(customMessages(session)).toHaveLength(1);
	});

	it("stops after an unchanged nudged run instead of looping", async () => {
		session = await createTestSession({ extensions: [TASKS_EXTENSION] });
		await session.run(when("Create a task, then attempt the work.", [
			createTask(),
			says("Stopped early."),
			calls("Task", { op: "list" }),
			says("No progress."),
		]));
		await session.session.waitForIdle();

		expect(session.events.toolResultsFor("Task")).toHaveLength(2);
		expect(customMessages(session).filter((message) => !message.display)).toHaveLength(1);
		expect(customMessages(session).filter((message) => message.display)).toHaveLength(1);
	});

	it("preserves the host child-agent exclusion at settlement", async () => {
		session = await createTestSession({
			extensions: [TASKS_EXTENSION],
			systemPrompt: '<active_agent name="worker"/>',
		});
		await session.run(when("Create a task and return to the parent.", [
			createTask(),
			says("Returning control."),
		]));
		await session.session.waitForIdle();

		expect(customMessages(session)).toHaveLength(0);
	});

	it("does not restart a completed Goal with unfinished tasks", async () => {
		session = await createTestSession({ extensions: [TASKS_EXTENSION, GOAL_EXTENSION] });
		await session.run(when("Create a goal and task; finish the goal.", [
			calls("create_goal", { objective: "Check task continuation ownership" }),
			createTask(),
			calls("update_goal", { status: "complete" }),
			says("Goal finished."),
		]));
		await session.session.waitForIdle();

		expect(session.events.toolResultsFor("update_goal")).toHaveLength(1);
		expect(customMessages(session)).toHaveLength(0);
	});
});
