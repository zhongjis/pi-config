export type Target = {
  kind: "auto" | "uncommitted" | "base" | "commit";
  ref?: string;
};

export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export function parseTarget(args: string): Target {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();

  if (!sub) return { kind: "auto" };
  if (sub === "uncommitted") return { kind: "uncommitted" };
  if (sub === "base") return { kind: "base", ref: parts[1] };
  if (sub === "commit") return { kind: "commit", ref: parts[1] };

  return { kind: "auto" };
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

export async function resolveCodexArgs(
  target: Target,
  git: GitRunner,
  cwd: string,
): Promise<string[]> {
  switch (target.kind) {
    case "uncommitted":
      return ["review", "--uncommitted"];

    case "base": {
      const ref = target.ref ?? (await resolveBase(git, cwd));
      if (!ref) {
        throw new Error("Could not determine a base ref. Try: /codex:review base <ref>");
      }
      return ["review", "--base", ref];
    }

    case "commit": {
      const ref = target.ref ?? "HEAD";
      return ["review", "--commit", ref];
    }

    case "auto": {
      const status = await git(["status", "--porcelain"], cwd);
      if (status && status.trim()) return ["review", "--uncommitted"];

      const base = await resolveBase(git, cwd);
      if (base) return ["review", "--base", base];

      return ["review", "--commit", "HEAD"];
    }
  }
}
