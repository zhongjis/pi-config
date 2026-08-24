import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestSession,
  says,
  type TestSession,
  when,
} from "./helpers/faux-session.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const EXTENSION = path.resolve(PROJECT_ROOT, "extensions/qol/index.ts");

describe("QOL context compaction integration", () => {
  let t: TestSession;

  afterEach(() => t?.dispose());

  it("requests compaction through the real agent_settled lifecycle", async () => {
    t = await createTestSession({ extensions: [EXTENSION] });
    (t.session as any).getContextUsage = () => ({
      contextWindow: 272_000,
      percent: 117.4,
      tokens: 319_328,
    });

    await t.run(when("Finish normally", [says("Done.")]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(t.events.all.some((event) => event.type === "compaction_start")).toBe(true);
  });
});
