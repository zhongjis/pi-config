import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let mockAgentDir = "";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => mockAgentDir,
}));

import {
  LOCAL_HANDOFF_AUTHORITY_URI,
  LOCAL_HANDOFF_BRIEFING_URI,
  LOCAL_PLAN_URI,
  type PlanAuthoritySnapshot,
} from "../src/types.js";
import {
  clearHandoffArtifacts,
  createHandoffAuthorityRecord,
  ensureHandoffParentDirectory,
  getHandoffAuthorityPath,
  getHandoffBriefingPath,
  getHandoffReadiness,
  getPlanPath,
  hashPlanContent,
  markHandoffConsumed,
  readHandoffState,
  writeHandoffAuthority,
  writeHandoffBriefing,
} from "../src/storage.js";

const ctx = {
  sessionManager: {
    getSessionId: () => "session-1",
  },
};

describe("handoff authority storage", () => {
  beforeEach(async () => {
    mockAgentDir = await mkdtemp(join(tmpdir(), "pi-handoff-"));
  });

  afterEach(async () => {
    if (mockAgentDir) {
      await rm(mockAgentDir, { recursive: true, force: true });
    }
  });

  it("stores HANDOFF files alongside the canonical local PLAN", async () => {
    await ensureHandoffParentDirectory(ctx);

    const planContent = "# Example Plan\n\n- Ship the feature\n";
    await writeFile(getPlanPath(ctx), planContent, "utf8");
    await writeHandoffBriefing(ctx, "Human-readable briefing");

    const authority = createHandoffAuthorityRecord({
      handoffId: "handoff-1",
      planHash: hashPlanContent(planContent),
      planTitle: "Example Plan",
      producerMode: "fuxi",
      targetMode: "houtu",
      kickoffPrompt: "Start implementation.",
      createdAt: "2026-04-11T12:00:00.000Z",
    });
    await writeHandoffAuthority(ctx, authority);

    expect(LOCAL_PLAN_URI).toBe("local://PLAN.md");
    expect(LOCAL_HANDOFF_BRIEFING_URI).toBe("local://HANDOFF.md");
    expect(LOCAL_HANDOFF_AUTHORITY_URI).toBe("local://HANDOFF.json");
    expect(getHandoffBriefingPath(ctx)).toContain("/local/session-1/HANDOFF.md");
    expect(getHandoffAuthorityPath(ctx)).toContain("/local/session-1/HANDOFF.json");

    const state = await readHandoffState(ctx);
    expect(state.authority).toEqual(authority);
    expect(state.briefing).toBe("Human-readable briefing");
    expect(state.plan?.planTitle).toBe("Example Plan");
    expect(state.readiness).toMatchObject({
      state: "ready",
      ready: true,
      handoffId: "handoff-1",
      handoffStatus: "pending",
      storedPlanHash: authority.planHash,
      latestPlanHash: authority.planHash,
      planTitle: "Example Plan",
    });

    const persistedJson = await readFile(getHandoffAuthorityPath(ctx), "utf8");
    expect(persistedJson).toContain('"handoffId": "handoff-1"');
    expect(persistedJson).toContain('"planUri": "local://PLAN.md"');
    expect(persistedJson.endsWith("\n")).toBe(true);
  });

  it("reports stale handoffs when HANDOFF.json planHash no longer matches PLAN.md", async () => {
    await ensureHandoffParentDirectory(ctx);

    const originalPlan = "# Example Plan\n\n- Original\n";
    await writeFile(getPlanPath(ctx), originalPlan, "utf8");
    await writeHandoffBriefing(ctx, "Human-readable briefing");
    await writeHandoffAuthority(
      ctx,
      createHandoffAuthorityRecord({
        handoffId: "handoff-2",
        planHash: hashPlanContent(originalPlan),
        planTitle: "Example Plan",
        producerMode: "fuxi",
        targetMode: "houtu",
        kickoffPrompt: "Start implementation.",
      }),
    );

    await writeFile(getPlanPath(ctx), "# Example Plan\n\n- Updated\n", "utf8");

    const state = await readHandoffState(ctx);
    expect(state.freshness).toEqual({
      isStale: true,
      storedPlanHash: hashPlanContent(originalPlan),
      latestPlanHash: hashPlanContent("# Example Plan\n\n- Updated\n"),
    });
    expect(state.readiness).toMatchObject({
      state: "stale",
      ready: false,
      handoffId: "handoff-2",
      handoffStatus: "pending",
      storedPlanHash: hashPlanContent(originalPlan),
      latestPlanHash: hashPlanContent("# Example Plan\n\n- Updated\n"),
    });
  });

  it("treats missing briefing as incomplete and consumed handoffs as not-ready", async () => {
    await ensureHandoffParentDirectory(ctx);

    const planContent = "# Example Plan\n\n- Ship the feature\n";
    await writeFile(getPlanPath(ctx), planContent, "utf8");
    const authority = createHandoffAuthorityRecord({
      handoffId: "handoff-3",
      planHash: hashPlanContent(planContent),
      planTitle: "Example Plan",
      producerMode: "fuxi",
      targetMode: "houtu",
      kickoffPrompt: "Start implementation.",
    });
    await writeHandoffAuthority(ctx, authority);

    const missingBriefing = getHandoffReadiness(authority, statefulPlan(planContent), undefined);
    expect(missingBriefing.readiness).toMatchObject({
      state: "missing",
      ready: false,
      missingResource: "handoff-briefing",
      handoffId: "handoff-3",
    });

    await writeHandoffBriefing(ctx, "Human-readable briefing");
    const consumedAt = "2026-04-11T12:00:00.000Z";
    const consumed = await markHandoffConsumed(ctx, { consumedAt });
    expect(consumed).toMatchObject({
      handoffId: "handoff-3",
      status: "consumed",
      consumedAt,
    });

    const consumedState = await readHandoffState(ctx);
    expect(consumedState.readiness).toMatchObject({
      state: "not-ready",
      ready: false,
      handoffId: "handoff-3",
      handoffStatus: "consumed",
    });

    await clearHandoffArtifacts(ctx);
    const clearedState = await readHandoffState(ctx);
    expect(clearedState.authority).toBeUndefined();
    expect(clearedState.briefing).toBeUndefined();
    expect(clearedState.readiness).toMatchObject({
      state: "missing",
      ready: false,
      missingResource: "handoff-authority",
    });
  });
});

function statefulPlan(content: string): PlanAuthoritySnapshot {
  return {
    path: "/tmp/PLAN.md",
    uri: LOCAL_PLAN_URI,
    content,
    planHash: hashPlanContent(content),
    planTitle: "Example Plan",
  };
}
