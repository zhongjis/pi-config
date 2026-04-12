type ExtensionAPI = {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (_args: string, ctx: any) => Promise<void> | void;
    },
  ): void;
};

declare function require(name: string): any;
declare const process: any;

const { spawn } = require("node:child_process") as {
  spawn: any;
};

interface ClipboardCommand {
  command: string;
  args: string[];
}

function formatSessionMetadata(
  sessionId: string,
  sessionLogPath?: string,
): string {
  return [
    `use pi-jsonl-logs skill to analyze the following session log based on user request`,
    `session-id: ${JSON.stringify(sessionId)}`,
    `session-log-path: ${sessionLogPath ? JSON.stringify(sessionLogPath) : "null"}`,
  ].join("\n");
}

function uniqueClipboardCommands(
  commands: ClipboardCommand[],
): ClipboardCommand[] {
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

async function copyToClipboard(text: string): Promise<string> {
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

export default function copySessionIdExtension(pi: ExtensionAPI): void {
  pi.registerCommand("session:copy-id", {
    description: "Copy current session ID and session log path to clipboard",
    handler: async (_args: string, ctx: any) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionLogPath = ctx.sessionManager.getSessionFile();
      const payload = formatSessionMetadata(sessionId, sessionLogPath);

      try {
        const backend = await copyToClipboard(payload);
        ctx.ui.notify(
          `Copied session metadata to clipboard via ${backend}`,
          "success",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${payload}\n`);
        ctx.ui.notify(`Clipboard copy failed: ${message}\n${payload}`, "error");
      }
    },
  });
}
