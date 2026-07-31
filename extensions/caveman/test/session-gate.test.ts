import { describe, expect, it } from "vitest";
import { isSubagentSession, isTopLevelPersistedSession } from "../session-gate.js";

describe("caveman session gate", () => {
	it("allows persisted sessions with a session file", () => {
		expect(isTopLevelPersistedSession({
			sessionManager: {
				isPersisted: () => true,
				getSessionFile: () => "/tmp/session.jsonl",
			},
		})).toBe(true);
	});

	it("blocks when persistence signals disagree", () => {
		expect(isTopLevelPersistedSession({
			sessionManager: {
				isPersisted: () => true,
				getSessionFile: () => undefined,
			},
		})).toBe(false);
	});

	it("falls back to session file signal when isPersisted is unavailable", () => {
		expect(isTopLevelPersistedSession({
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
			},
		})).toBe(true);
	});

	it("detects subagent sessions by session file path", () => {
		expect(isSubagentSession({
			sessionManager: {
				getSessionFile: () => "/home/u/.pi/agent/subagent-sessions/parent/child.jsonl",
			},
		})).toBe(true);
	});

	it("does not treat top-level session files as subagent sessions", () => {
		expect(isSubagentSession({
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
			},
		})).toBe(false);
	});

	it("returns false when no session file is available", () => {
		expect(isSubagentSession({
			sessionManager: {},
		})).toBe(false);
	});
});
