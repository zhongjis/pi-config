import { afterEach, describe, expect, it, vi } from "vitest";
const runAgentMock = vi.fn();
const resumeAgentMock = vi.fn();
vi.mock("./agent-runner.js", () => ({
    runAgent: (...args) => runAgentMock(...args),
    resumeAgent: (...args) => resumeAgentMock(...args),
    getAgentConversation: () => "",
}));
const { AgentManager } = await import("./agent-manager.js");
describe("AgentManager", () => {
    afterEach(() => {
        runAgentMock.mockReset();
        resumeAgentMock.mockReset();
    });
    it("stops a foreground agent when the outer tool signal aborts", async () => {
        const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() };
        runAgentMock.mockImplementation((_ctx, _type, _prompt, options) => {
            return new Promise((resolve) => {
                const finish = () => resolve({
                    responseText: "",
                    session,
                    aborted: false,
                    steered: false,
                });
                if (options.signal?.aborted) {
                    finish();
                    return;
                }
                options.signal?.addEventListener("abort", finish, { once: true });
            });
        });
        const manager = new AgentManager();
        const controller = new AbortController();
        try {
            const recordPromise = manager.spawnAndWait({}, { cwd: process.cwd() }, "general-purpose", "Test prompt", {
                description: "test agent",
                signal: controller.signal,
            });
            expect(manager.listAgents()).toHaveLength(1);
            expect(manager.listAgents()[0]?.status).toBe("running");
            controller.abort();
            const record = await recordPromise;
            expect(record.status).toBe("stopped");
            expect(record.completedAt).toBeTypeOf("number");
            expect(runAgentMock).toHaveBeenCalledOnce();
        }
        finally {
            manager.dispose();
        }
    });
    it("stops immediately when the outer tool signal is already aborted", async () => {
        const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() };
        runAgentMock.mockImplementation((_ctx, _type, _prompt, options) => {
            return new Promise((resolve) => {
                const finish = () => resolve({
                    responseText: "",
                    session,
                    aborted: false,
                    steered: false,
                });
                if (options.signal?.aborted) {
                    finish();
                    return;
                }
                options.signal?.addEventListener("abort", finish, { once: true });
            });
        });
        const manager = new AgentManager();
        const controller = new AbortController();
        controller.abort();
        try {
            const record = await manager.spawnAndWait({}, { cwd: process.cwd() }, "general-purpose", "Test prompt", {
                description: "test agent",
                signal: controller.signal,
            });
            expect(record.status).toBe("stopped");
            expect(record.completedAt).toBeTypeOf("number");
            expect(runAgentMock).not.toHaveBeenCalled();
        }
        finally {
            manager.dispose();
        }
    });
    it("stops a background agent when the outer tool signal aborts", async () => {
        const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() };
        runAgentMock.mockImplementation((_ctx, _type, _prompt, options) => {
            return new Promise((resolve) => {
                const finish = () => resolve({
                    responseText: "",
                    session,
                    aborted: false,
                    steered: false,
                });
                if (options.signal?.aborted) {
                    finish();
                    return;
                }
                options.signal?.addEventListener("abort", finish, { once: true });
            });
        });
        const manager = new AgentManager();
        const controller = new AbortController();
        try {
            const id = manager.spawn({}, { cwd: process.cwd() }, "general-purpose", "Test prompt", {
                description: "background agent",
                signal: controller.signal,
                isBackground: true,
            });
            const record = manager.getRecord(id);
            expect(record.status).toBe("running");
            controller.abort();
            await record.promise;
            expect(record.status).toBe("stopped");
            expect(record.completedAt).toBeTypeOf("number");
            expect(runAgentMock).toHaveBeenCalledOnce();
        }
        finally {
            manager.dispose();
        }
    });
    it("stops a queued background agent when the outer tool signal aborts", () => {
        const manager = new AgentManager(undefined, 0);
        const controller = new AbortController();
        try {
            const id = manager.spawn({}, { cwd: process.cwd() }, "general-purpose", "Test prompt", {
                description: "queued background agent",
                signal: controller.signal,
                isBackground: true,
            });
            const record = manager.getRecord(id);
            expect(record.status).toBe("queued");
            controller.abort();
            expect(record.status).toBe("stopped");
            expect(record.completedAt).toBeTypeOf("number");
            expect(runAgentMock).not.toHaveBeenCalled();
        }
        finally {
            manager.dispose();
        }
    });
});
