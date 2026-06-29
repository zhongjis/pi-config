export const REVIEW_USAGE = "Usage: /codex:review [session]";

export type ReviewMode =
  | { kind: "default" }
  | { kind: "session" }
  | { kind: "invalid"; reason: string };

export type CodexReviewJob = {
  label: string;
  argv: string[];
};

export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export function parseReviewMode(args: string): ReviewMode {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();

  if (!sub) return { kind: "default" };
  if (sub === "session" && parts.length === 1) return { kind: "session" };

  return {
    kind: "invalid",
    reason: `Unknown codex review mode: ${parts.join(" ")}. ${REVIEW_USAGE}`,
  };
}

async function resolveBase(git: GitRunner, cwd: string): Promise<string | null> {
  const tracking = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    cwd,
  );
  if (tracking) return tracking;

  const originHead = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if (originHead) return originHead.replace(/^refs\/remotes\//, "");

  for (const candidate of ["origin/main", "origin/master"]) {
    if (await git(["rev-parse", "--verify", "--quiet", candidate], cwd)) return candidate;
  }
  return null;
}

function withPrompt(argv: string[], prompt?: string): string[] {
  const trimmed = prompt?.trim();
  return trimmed ? [...argv, trimmed] : argv;
}

async function hasBranchChanges(git: GitRunner, cwd: string, base: string): Promise<boolean> {
  const diffNames = await git(["diff", "--name-only", `${base}...HEAD`], cwd);
  return Boolean(diffNames?.trim());
}

async function hasDirtyChanges(git: GitRunner, cwd: string): Promise<boolean> {
  const status = await git(["status", "--porcelain"], cwd);
  return Boolean(status?.trim());
}

export async function planCodexReviewJobs(
  git: GitRunner,
  cwd: string,
  options: { prompt?: string } = {},
): Promise<CodexReviewJob[]> {
  const jobs: CodexReviewJob[] = [];
  const base = await resolveBase(git, cwd);

  if (base && (await hasBranchChanges(git, cwd, base))) {
    jobs.push({
      label: `branch changes vs ${base}`,
      argv: withPrompt(["review", "--base", base], options.prompt),
    });
  }

  if (await hasDirtyChanges(git, cwd)) {
    jobs.push({
      label: "dirty working tree",
      argv: withPrompt(["review", "--uncommitted"], options.prompt),
    });
  }

  if (jobs.length === 0 && !base) {
    throw new Error("Could not determine a base ref and no dirty changes to review.");
  }

  return jobs;
}
