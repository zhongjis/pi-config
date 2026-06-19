import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export async function preflight(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const cwd = ctx.cwd;

  const versionCheck = await pi.exec("codex", ["--version"], { cwd });
  if (versionCheck.code !== 0) {
    ctx.ui.notify("`codex` not found on PATH — install Codex CLI", "error");
    return false;
  }

  const loginCheck = await pi.exec("codex", ["login", "status"], { cwd });
  if (loginCheck.code !== 0 || !loginCheck.stdout.includes("Logged in")) {
    ctx.ui.notify("Codex not logged in — run: codex login", "error");
    return false;
  }

  const gitCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (gitCheck.code !== 0) {
    ctx.ui.notify("Not inside a git repository", "error");
    return false;
  }

  return true;
}
