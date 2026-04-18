/**
 * Fuxi clearance sequence tests
 *
 * Mirrors prometheus/system-prompt.test.ts structure.
 * Validates that agents/fuxi.md contains the required clearance sequence
 * patterns after the Prometheus-style refactor: TaskCreate-based step
 * registration, direnjie gap check, ask final choice, yanluo loop,
 * and absence of the removed tools.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FUXI_PATH = join(process.cwd(), "agents", "fuxi.md");

function getFuxiPrompt(): string {
  return readFileSync(FUXI_PATH, "utf-8");
}

describe("fuxi.md clearance sequence", () => {
  describe("#given the mandatory plan generation sequence", () => {
    it("#then should require TaskCreate for step registration immediately on trigger", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("TaskCreate");
      expect(prompt).toContain("IMMEDIATELY");
    });

    it("#then should register exactly 7 planning steps", () => {
      const prompt = getFuxiPrompt();
      // The 7 step labels that must be registered as tasks
      expect(prompt).toContain("Consult Di Renjie for gap analysis");
      expect(prompt).toContain("Generate work plan to local://PLAN.md");
      expect(prompt).toContain("Self-review: classify gaps");
      expect(prompt).toContain("Present summary with auto-resolved items");
      expect(prompt).toContain("If decisions needed: wait for user, update plan");
      expect(prompt).toContain("Run plan approval flow (plan_approve tool)");
      expect(prompt).toContain("If high accuracy: Submit to Yan Luo and iterate until OKAY");
    });

    it("#then should require marking tasks in_progress before starting and completed after", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("in_progress");
      expect(prompt).toContain("completed");
      expect(prompt).toContain("TaskUpdate");
    });
  });

  describe("#given the direnjie gap check step", () => {
    it("#then should auto-proceed after direnjie result without asking additional user questions", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("direnjie");
      expect(prompt).toContain("Auto-proceed after result without asking additional user questions");
    });

    it("#then should specify what to send direnjie", () => {
      const prompt = getFuxiPrompt();
      // Direnjie needs: goal, what was discussed, interpretation, research findings
      expect(prompt).toContain("user's goal");
      expect(prompt).toContain("research findings");
      expect(prompt).toContain("questions you should have asked but didn't");
      expect(prompt).toContain("guardrails");
    });
  });

  describe("#given the plan generation step", () => {
    it("#then should save plan to local://PLAN.md", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("local://PLAN.md");
    });

    it("#then should include incremental write protocol for large plans", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("incremental write protocol");
      expect(prompt).toContain("skeleton");
      expect(prompt).toContain("edit");
    });
  });

  describe("#given the final choice presentation", () => {
    it("#then should use /plan:approve command for final choice", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("plan_approve");
    });

    it("#then should present High Accuracy Review and Approve options", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("Approve");
      expect(prompt).toContain("High Accuracy Review");
    });

    it("#then should present post-high-accuracy variant after yanluo", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("variant: \"post-high-accuracy\"");
    });
  });

  describe("#given the high accuracy review path", () => {
    it("#then should run yanluo in a loop until OKAY", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("yanluo");
      expect(prompt).toContain("while (true)");
      expect(prompt).toContain("OKAY");
    });

    it("#then should pass local://PLAN.md to yanluo", () => {
      const prompt = getFuxiPrompt();
      // yanluo invocation uses the plan path
      expect(prompt).toMatch(/yanluo.*local:\/\/PLAN\.md|local:\/\/PLAN\.md.*yanluo/s);
    });

    it("#then should prohibit shortcuts in the loop", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("NO EXCUSES");
      expect(prompt).toContain("NO SHORTCUTS");
    });
  });

  describe("#given removed tools", () => {
    it("#then should not reference gap_review_complete", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("gap_review_complete");
    });

    it("#then should not reference finalize_plan", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("finalize_plan");
    });

    it("#then should not reference exit_plan_mode", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("exit_plan_mode");
    });

    it("#then should not reference high_accuracy_review_complete", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("high_accuracy_review_complete");
    });
  });

  describe("#given extensions frontmatter", () => {
    it("#then should not list removed tools in extensions", () => {
      const prompt = getFuxiPrompt();
      const frontmatterMatch = prompt.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).not.toContain("gap_review_complete");
      expect(frontmatter).not.toContain("finalize_plan");
      expect(frontmatter).not.toContain("exit_plan_mode");
      expect(frontmatter).not.toContain("high_accuracy_review_complete");
    });

    it("#then should list TaskCreate and TaskUpdate in extensions", () => {
      const prompt = getFuxiPrompt();
      const frontmatterMatch = prompt.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).toContain("TaskCreate");
      expect(frontmatter).toContain("TaskUpdate");
    });

    it("#then should list ask in extensions (needed for user interview/clarification)", () => {
      const prompt = getFuxiPrompt();
      const frontmatterMatch = prompt.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      // ask is required for clarifying plan requirements with the user
      expect(frontmatter).toMatch(/\bask\b/);
    });
  });
});
