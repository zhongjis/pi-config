import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClipboardCommand {
  command: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function uniqueClipboardCommands(commands: ClipboardCommand[]): ClipboardCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.command}\u0000${command.args.join("\u0000")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getClipboardCommands(): ClipboardCommand[] {
  const commands: ClipboardCommand[] = [];
  const isTermux = Boolean(process.env.TERMUX_VERSION);
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  const isWayland =
    Boolean(process.env.WAYLAND_DISPLAY) ||
    process.env.XDG_SESSION_TYPE === "wayland";

  if (isTermux) {
    commands.push({ command: "termux-clipboard-set", args: [] });
  }

  if (process.platform === "darwin") {
    commands.push({ command: "pbcopy", args: [] });
  }

  if (process.platform === "win32" || isWsl) {
    commands.push({ command: "clip.exe", args: [] });
    commands.push({
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "$input | Set-Clipboard"],
    });
  }

  if (isWayland) {
    commands.push({ command: "wl-copy", args: ["--type", "text/plain"] });
  }

  commands.push({ command: "wl-copy", args: ["--type", "text/plain"] });
  commands.push({ command: "xclip", args: ["-selection", "clipboard"] });
  commands.push({ command: "xsel", args: ["--clipboard", "--input"] });

  return uniqueClipboardCommands(commands);
}

// ---------------------------------------------------------------------------
// Internal runner
// ---------------------------------------------------------------------------

async function runClipboardCommand(
  command: ClipboardCommand,
  text: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";

    child.on("error", reject);
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          detail
            ? `${command.command}: ${detail}`
            : `${command.command} exited with code ${code}`,
        ),
      );
    });

    child.stdin.end(text);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Writes `text` to the system clipboard.
 * Tries each platform-appropriate backend in order.
 * Returns the name of the winning command on success.
 * Throws with all failure messages if every backend fails.
 */
export async function writeClipboard(text: string): Promise<string> {
  const commands = getClipboardCommands();
  if (commands.length === 0) {
    throw new Error("No clipboard backend configured for this environment.");
  }

  const failures: string[] = [];
  for (const command of commands) {
    try {
      await runClipboardCommand(command, text);
      return command.command;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
    }
  }

  throw new Error(`Clipboard copy failed. Tried: ${failures.join("; ")}`);
}
