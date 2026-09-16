import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runWorkflow, type WorkflowSpawnResult } from "../extensions/subagents/src/workflow/runtime.js";

const script = readFileSync(new URL("../workflows/last30days.js", import.meta.url), "utf8");
const args = { topic: "fixture", windowStart: "2026-09-01", windowEnd: "2026-09-16", resolverAgentType: "reader", engineAgentType: "engine", specialistAgentType: "reader", verifierAgentType: "reader", skillDir: "/fixture/skill", memoryDir: "/fixture/output", activeSources: ["reddit"] };
const resolution = {
  interpretation: "fixture", communities: [], searchTerms: ["fixture"], gaps: [], sharedPlan: {
    enginePlan: { intent: "factual", freshness_mode: "strict_recent", cluster_mode: "none", subqueries: [{ label: "fixture", search_query: "fixture", ranking_query: "fixture", sources: ["reddit"], weight: 1 }] },
    broadSubreddits: [], dedicatedSubreddits: [], xHandle: "", xRelatedHandles: [], githubRepos: [], githubUsers: [], tiktokHashtags: [], tiktokCreators: [], instagramCreators: [], trustpilotDomain: "", polymarketKeywords: [], amazonQuery: "", telegramSources: [], competitors: [], notes: [],
  },
};
const engine = { completed: true, rawArtifactPath: "/fixture/output/raw.json", compactEvidence: "fixture", passThroughFooter: "", sourceOutcomes: [], gaps: [], failureReason: "" };
async function run(accepted = true, optionalGap = false, failPhase?: string) {
  const calls: string[] = [];
  const result = await runWorkflow({ script, args, host: {
    async spawnAgent(request): Promise<WorkflowSpawnResult> {
      calls.push(request.phaseTitle ?? "");
      if (request.phaseTitle === failPhase || request.phaseTitle === "Specialists") return { ok: false, error: "fixture unavailable" };
      const value = request.phaseTitle === "Resolve" ? resolution : request.phaseTitle === "Engine" ? engine : request.phaseTitle === "Triage"
        ? { evidenceSufficient: !optionalGap, lanes: optionalGap ? [{ lane: "reddit", reason: "thin", evidencePointer: "raw.json" }] : [] }
        : { accepted, originalEvidenceAccepted: accepted, rawArtifactInspected: true, acceptedAnnotationIds: [], rejectedAnnotations: [], sourceTraceability: "fixture", coverageAssessment: "fixture", gaps: [] };
      return { ok: true, text: JSON.stringify(value) };
    }, abortAgent() {},
  } });
  return { result, calls };
}

it.each([true, false])("last30days declares independent acceptance=%s", async accepted => {
  const { result, calls } = await run(accepted);
  expect(result).toMatchObject({ status: "completed", outcome: { status: accepted ? "succeeded" : "failed" }, value: { accepted } });
  expect(calls).toEqual(["Resolve", "Engine", "Triage", "Verify"]);
});
it("last30days discloses optional specialist gaps without suppressing independent verification", async () => {
  const { result, calls } = await run(true, true);
  expect(result).toMatchObject({ status: "completed", outcome: { status: "partial" }, value: { accepted: true, specialistAnnotations: [{ lane: "reddit", status: "missing" }] } });
  expect(calls).toEqual(["Resolve", "Engine", "Triage", "Specialists", "Verify"]);
});
it.each(["Resolve", "Engine", "Triage", "Verify"])("last30days stops after required %s failure", async phase => {
  const { result, calls } = await run(true, false, phase);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("fixture unavailable");
  expect(calls.at(-1)).toBe(phase);
});
