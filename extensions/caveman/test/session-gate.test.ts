import { describe, expect, it } from "vitest";
import { isTopLevelPersistedSession } from "../session-gate.js";

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
});
